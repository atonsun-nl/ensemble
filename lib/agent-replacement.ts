import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { availableAgentKeys, resolveAgentProgram, shellEscape } from './agent-config'
import { checkAgentHealth } from './agent-health'
import { emitEvent, runRoster } from './brain-hooks'
import { readEnsembleConfig } from './ensemble-config'
import { getTeam, getMessages, updateTeam, appendMessage } from './ensemble-registry'
import { spawnLocalAgent, killLocalAgent, spawnRemoteAgent, killRemoteAgent, postRemoteSessionCommand, isRemoteSessionReady, findRemoteAgent } from './agent-spawner'
import { getRuntime } from './agent-runtime'
import { issueAgentEnvironment } from './agent-credentials'
import { pasteAgentInput } from './agent-input'
import { isSelf, getHostById } from './hosts-config'
import { collabPromptFile, collabSessionsFile, ensureCollabDirs } from './collab-paths'
import type { EnsembleTeamAgent } from '../types/ensemble'

const replacing = new Set<string>()
const stopping = new Set<string>()

export function stopTeamReplacements(teamId: string): void {
  stopping.add(teamId)
}

export async function replaceTeamAgent(
  teamId: string, agentName: string, detail: string,
  waitForReady: (session: string, program: string, hostId?: string, timeout?: number) => Promise<boolean>,
): Promise<boolean> {
  if (replacing.has(teamId) || stopping.has(teamId)) return false
  replacing.add(teamId)
  let session: string | undefined
  let cleanup: (() => Promise<void>) | undefined
  try {
    const config = readEnsembleConfig()
    const team = getTeam(teamId)
    const old = team?.agents.find(a => a.name === agentName)
    if (!config.replaceStalledAgents || !team || team.status !== 'active' || !old || old.status !== 'active') return false
    if ((team.replacementCount ?? 0) >= (config.maxReplacementsPerTeam ?? 2)) return false
    const candidates = config.fallbackOrder.filter(key => availableAgentKeys().includes(key) && !team.agents.some(a => resolveAgentProgram(a.program) === resolveAgentProgram(key)))
    const roster = await runRoster(config)
    const health = roster === undefined ? await checkAgentHealth(candidates, true, config, 5000) : undefined
    const program = candidates.find(key => roster ? roster[key]?.status === 'ok' : health?.healthy ? health.healthy.includes(key) : true)
    if (!program || stopping.has(teamId) || getTeam(teamId)?.status !== 'active') return false
    const replacement: EnsembleTeamAgent = {
      ...old, agentId: '', name: `${program}-${team.agents.length + 1}`, program, status: 'spawning',
    }
    session = `${team.name}-${replacement.name}`
    const local = !old.hostId || isSelf(old.hostId)
    const host = local ? undefined : getHostById(old.hostId)
    if (!local && !host) return false
    // Persist the attempt before touching the old session. On restart the
    // service can remove a partially started replacement before trying again.
    const pending = { oldAgent: old.name, sessionName: session, hostId: old.hostId }
    updateTeam(teamId, { replacementCount: (team.replacementCount ?? 0) + 1, pendingReplacement: team.workflow ? pending : undefined })
    const cwd = old.worktreePath || (local ? team.worktreePath : undefined) || team.workingDirectory || process.cwd()
    const previousSession = old.sessionName || `${team.name}-${old.name}`
    const recent = getMessages(teamId).slice(-20).map(m => `${m.from}: ${m.content}`).join('\n')
    const context = Buffer.from(recent).subarray(-8000).toString('utf8')
    const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts')
    const workflow = team.workflow
    const deliverNow = !workflow || workflow.lead === old.name
    const environment = workflow ? issueAgentEnvironment(teamId, replacement.name) : undefined
    const managedContext = workflow && {
      state: workflow.state, plan: workflow.plan,
      taskOwners: Object.fromEntries(Object.entries(workflow.taskOwners).map(([key, owner]) => [key, owner === old.name ? replacement.name : owner])),
      fileOwners: Object.fromEntries(Object.entries(workflow.fileOwners).map(([key, owner]) => [key, owner === old.name ? replacement.name : owner])),
      decisions: workflow.decisions, approvedChanges: workflow.approvedChanges, blockers: workflow.blockers,
      acceptance: workflow.acceptance?.passed ? 'previous acceptance invalidated by replacement' : 'pending',
      checks: config.acceptanceChecks ?? [], priorSubmission: workflow.submitted[old.name],
    }
    const prompt = [
      config.taskPreamble || '',
      `You replace failed teammate ${old.name}. Your name is ${replacement.name}, role: ${old.role}.`,
      `Team ID: ${teamId}. Original task: ${team.description}`,
      `Use ${shellEscape(path.join(scripts, "team-say.sh"))} ${teamId} ${replacement.name} team "message" to share progress and ${shellEscape(path.join(scripts, "team-read.sh"))} ${teamId} ${replacement.name} to read the feed.`,
      'You share the working directory with teammates. Preserve their changes and coordinate ownership.',
      managedContext
        ? 'Preserve the existing uncommitted diff. Use team-say with one quoted <<COLLAB_EVENT>> JSON message. For a worker, submit once per revision with {"action":"submit","report":"..."}. For a replacement Lead, publish an updated plan with {"action":"plan","plan":"..."} and wait for acknowledgement before implementation. Review assignments, submit, request accept, then close with a final report.'
        : 'When finished, report your results and send <<COLLAB_DONE>> once.',
      ...(managedContext ? [`Managed workflow context: ${JSON.stringify(managedContext)}`] : []),
      `Recent team messages (context from the previous run):\n${context}`,
    ].join('\n')
    ensureCollabDirs(teamId)
    const promptFile = collabPromptFile(teamId, replacement.name)
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 })
    if (host) {
      await killRemoteAgent(host.url, old.agentId)
      if (workflow && await isRemoteSessionReady(host.url, previousSession) !== false) throw new Error('Previous remote session could not be confirmed stopped')
    } else {
      await killLocalAgent(previousSession)
      if (workflow && await getRuntime().sessionExists(previousSession)) throw new Error('Previous session is still running')
    }
    if (!host) cleanup = () => killLocalAgent(session!)
    const spawned = host
      ? await spawnRemoteAgent(host.url, session, program, cwd, workflow ? undefined : team.description, team.name, {
          environment,
          onCreated: id => {
            cleanup = async () => { await killRemoteAgent(host.url, id) }
            if (workflow) updateTeam(teamId, { pendingReplacement: { ...pending, agentId: id } })
          },
        })
      : await spawnLocalAgent({ name: session, program, workingDirectory: cwd, hostId: old.hostId,
          ...(environment ? { agentEnvironment: environment } : {}),
        })
    if (host) cleanup = async () => { await killRemoteAgent(host.url, spawned.id) }
    if (workflow) updateTeam(teamId, { pendingReplacement: { ...pending, agentId: spawned.id } })
    fs.appendFileSync(collabSessionsFile(teamId), `${session}\n`)
    if (!await waitForReady(session, program, old.hostId, 45_000)) throw new Error('Replacement did not become ready')
    if (stopping.has(teamId) || getTeam(teamId)?.status !== 'active') throw new Error('Team stopped during replacement')
    if (deliverNow) {
      const runtime = getRuntime()
      if (host) await postRemoteSessionCommand(host.url, session, prompt)
      else if (resolveAgentProgram(program).inputMethod === 'pasteFromFile') {
        await pasteAgentInput(runtime, session, promptFile, prompt, resolveAgentProgram(program).pasteEnterCount)
      } else await runtime.sendKeys(session, prompt.replace(/[\r\n]+/g, ' '), { literal: true, enter: true, agentInput: true })
    }
    const current = getTeam(teamId)
    if (stopping.has(teamId) || !current || current.status !== 'active') throw new Error('Team stopped during replacement')
    replacement.agentId = spawned.id
    replacement.sessionName = 'sessionName' in spawned ? String(spawned.sessionName) : session
    replacement.startup = deliverNow ? 'prompt_delivered' : 'cli_ready'
    replacement.status = 'active'
    replacement.startedAt = new Date().toISOString()
    current.agents = current.agents.map(a => a.name === old.name ? { ...a, status: 'replaced' as const } : a)
    current.agents.push(replacement)
    if (current.workflow && managedContext) {
      current.workflow.fileOwners = managedContext.fileOwners
      current.workflow.taskOwners = managedContext.taskOwners
      delete current.workflow.submitted[old.name]
      if (current.workflow.blockers[old.name]) {
        current.workflow.blockers[replacement.name] = current.workflow.blockers[old.name]
        delete current.workflow.blockers[old.name]
      }
      current.workflow.acceptance = undefined
      if (current.workflow.lead === old.name) {
        current.workflow.lead = replacement.name
        current.workflow.state = 'WAITING_PLAN'
        current.workflow.plan = undefined
        current.workflow.startupDeadline = new Date(Date.now() + 120_000).toISOString()
      } else if (current.workflow.plan && !Object.keys(current.workflow.blockers).length) current.workflow.state = 'WORKING'
    }
    updateTeam(teamId, { agents: current.agents, workflow: current.workflow, pendingReplacement: undefined })
    const ts = new Date().toISOString()
    appendMessage(teamId, { id: randomUUID(), teamId, from: 'ensemble', to: 'team', type: 'chat', timestamp: ts, content: `Replaced ${old.name} with ${replacement.name} (${old.role}): ${detail}. Acceptance: ${managedContext?.acceptance ?? 'pending'}` })
    void emitEvent({ event: 'agent_replaced', teamId, team: team.name, ts, agent: old.name, replacement: replacement.name, detail })
    void emitEvent({ event: 'agent_ready', teamId, team: team.name, ts, agent: replacement.name })
    cleanup = undefined
    return true
  } catch (error) {
    appendMessage(teamId, { id: randomUUID(), teamId, from: 'ensemble', to: 'team', type: 'chat', timestamp: new Date().toISOString(),
      content: `Replacement for ${agentName} failed: ${error instanceof Error ? error.message : 'startup failure'}` })
    console.warn(`[Ensemble] Replacement failed for ${agentName}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    try { await cleanup?.() } catch { /* Reconciliation will retry if the candidate remains. */ }
    try {
      const pending = getTeam(teamId)?.pendingReplacement
      if (session && pending?.sessionName === session && await recoverPendingReplacement(teamId, pending)) {
        updateTeam(teamId, { pendingReplacement: undefined })
      }
    } finally { replacing.delete(teamId) }
  }
}


export async function recoverPendingReplacement(
  teamId: string,
  pending: NonNullable<import('../types/ensemble').EnsembleTeam['pendingReplacement']>,
): Promise<boolean> {
  if (pending.hostId && !isSelf(pending.hostId)) {
    const host = getHostById(pending.hostId)
    if (!host) return false
    const id = pending.agentId ?? await findRemoteAgent(host.url, pending.sessionName)
    if (id === undefined) return false
    if (id !== null && await killRemoteAgent(host.url, id) === false) return false
    if (await isRemoteSessionReady(host.url, pending.sessionName) !== false) return false
  } else {
    await killLocalAgent(pending.sessionName)
    if (await getRuntime().sessionExists(pending.sessionName)) return false
  }
  appendMessage(teamId, { id: randomUUID(), teamId, from: 'ensemble', to: 'team', type: 'chat', timestamp: new Date().toISOString(),
    content: `Cleared interrupted replacement for ${pending.oldAgent} (${pending.sessionName})` })
  return true
}
