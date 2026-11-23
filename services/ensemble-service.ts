/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams,
  appendMessage, getMessages, markAgentFailed,
} from '../lib/ensemble-registry'
import {
  prepareLocalAgent, spawnLocalAgent, killLocalAgent,
  spawnRemoteAgent as spawnRemote, killRemoteAgent,
  postRemoteSessionCommand, isRemoteSessionReady,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { isSelf, getHostById, getSelfHostId } from '../lib/hosts-config'
import { getRuntime } from '../lib/agent-runtime'
import { pasteAgentInput, serializeAgentInput } from '../lib/agent-input'
import { detectLiveGate, isShellCommand } from '../lib/startup-gates'
import { resolveAgentProgram, resolveAgentProgramDetailed, availableAgentKeys, shellEscape } from '../lib/agent-config'
import { exportObservation, checkMemoryEndpoint, type MemoryExportResult } from '../lib/memory-export'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile, collabMessagesFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted, collabPollerPid,
  collabBridgeResult, collabSessionsFile, ensureCollabDirs,
} from '../lib/collab-paths'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { createTeamWorktree, createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { applyWorkflowCommand, isWorkflowCommand, readBaseline, receiptPrefix } from '../lib/managed-workflow'
import { readEnsembleConfig } from '../lib/ensemble-config'
import { emitEvent, runPlan, type BrainEvent } from '../lib/brain-hooks'
import { replaceTeamAgent, recoverPendingReplacement, stopTeamReplacements } from '../lib/agent-replacement'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
// How long a freshly typed start command may leave the shell in the foreground
// before the agent counts as not started (a wrapper script execs quickly).
const AGENT_START_GRACE_MS = 5_000
const EXPLICIT_DONE_SENTINEL = '<<COLLAB_DONE>>'
const lifecycleWork = new Map<string, Promise<ServiceResult<{ team: EnsembleTeam }>>>()
const acceptanceControllers = new Map<string, AbortController>()

// Telegram notifications: set both env vars to enable, omit to disable
const TELEGRAM_BOT_TOKEN = process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.ENSEMBLE_TELEGRAM_CHAT_ID || ''

// Optional alert hub, enabled by an explicit URL and secret.
const ALERT_HUB_SECRET = process.env.ALERT_HUB_SECRET || ''

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly doneEvents = new Set<string>()
  private readonly deadlineWarnings = new Map<string, number>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog

  constructor() {
    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      markAgentFailed: (teamId, agentName) => markAgentFailed(teamId, agentName),
      replacementEnabled: () => !!readEnsembleConfig().replaceStalledAgents,
      sessionExists: async (name, hostId) => {
        if (hostId && !isSelf(hostId)) {
          const host = getHostById(hostId)
          return host ? isRemoteSessionReady(host.url, name) : undefined
        }
        return getRuntime().sessionExists(name)
      },
      replaceAgent: (team, agent, detail) => replaceTeamAgent(team.id, agent.name, detail, waitForReady),
      onAgentStalled: (team, agent, detail) => teamEvent(team, 'agent_stalled', { agent: agent.name, detail }),
      pollIntervalMs: readEnsembleConfig().replaceStalledAgents ? 20_000 : undefined,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      getRuntime,
      resolveAgentProgram,
      isSelf: (hostId?: string) => isSelf(hostId || ''),
      getHostById,
      postRemoteSessionCommand,
      collabDeliveryFile,
      onTeamUnreachable: (teamId, reason) => this.endUnreachableTeam(teamId, reason),
      passive: true,
    })

    // Warn early about connectivity, but generic CORS OPTIONS responses cannot
    // establish write support. Each export must receive a storage acknowledgement.
    void checkMemoryEndpoint().then(result => {
      if (result.ok) {
        console.log(`[Ensemble] Memory endpoint reachable at ${result.endpoint}; storage is verified on export`)
      } else {
        console.warn(
          `[Ensemble] Memory export UNAVAILABLE at ${result.endpoint}`
          + ` (${result.error || `HTTP ${result.status}`}).`
          + ` Collab outcomes will not be stored. Override with ENSEMBLE_MEMORY_URL.`,
        )
      }
    })

    for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'] as const) {
      process.once(signal, () => this.stop())
    }
  }

  /**
   * A team whose agents are all gone can never finish on its own. End it the
   * normal way so it still produces a summary, rather than leaving it 'active'
   * with a watchdog and a bridge working on a session that no longer exists.
   */
  private async endUnreachableTeam(teamId: string, reason: string): Promise<void> {
    if (this.disbandingTeams.has(teamId)) return
    const team = getTeam(teamId)
    if (!team || team.status !== 'active') return

    this.disbandingTeams.add(teamId)
    try {
      console.warn(`[Ensemble] Team ${teamId} unreachable: ${reason}`)
      appendMessage(teamId, {
        id: uuidv4(),
        teamId,
        from: 'ensemble',
        to: 'team',
        content: `🛑 Team ended by watchdog: ${reason}`,
        type: 'chat',
        timestamp: new Date().toISOString(),
      })
      await disbandTeam(teamId, reason)
    } catch (err) {
      console.error(`[Ensemble] Failed to end unreachable team ${teamId}:`, err)
    } finally {
      this.disbandingTeams.delete(teamId)
    }
  }

  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active' || team.status === 'forming' || team.status === 'completed')

    const activeIds = new Set(teams.map(team => team.id))
    for (const id of this.deadlineWarnings.keys()) {
      if (!activeIds.has(id)) this.deadlineWarnings.delete(id)
    }
    const config = readEnsembleConfig()
    for (const team of teams) {
      if (this.disbandingTeams.has(team.id) || startingTeams.has(team.id) || lifecycleWork.has(team.id)) continue
      this.disbandingTeams.add(team.id)
      try {
        if (team.status === 'completed') {
          await disbandTeam(team.id, team.failureReason, team.workflow?.state === 'DONE' ? 'ok' : undefined)
          continue
        }
        if (team.status === 'forming') {
          await disbandTeam(team.id, 'Service restarted during startup')
          continue
        }
        if (team.workflow) {
          await processManagedTeam(team)
          if (getTeam(team.id)?.status !== 'active') continue
          if (team.workflow.state === 'DONE') {
            await disbandTeam(team.id, undefined, 'ok')
            continue
          }
          if (team.workflow.phaseDeadline && Date.now() >= Date.parse(team.workflow.phaseDeadline)) {
            await disbandTeam(team.id, `Staged deadline expired in ${team.workflow.state}`)
            continue
          }
          if (team.workflow.state === 'WAITING_PLAN' && Date.now() >= Date.parse(team.workflow.startupDeadline)) {
            await disbandTeam(team.id, 'Lead did not acknowledge a plan before the startup deadline')
            continue
          }
        }
        if (config.maxTeamMinutes !== undefined || config.maxIdleMinutes !== undefined) {
          const ageMs = Date.now() - new Date(team.createdAt).getTime()
          const messages = getMessages(team.id)
          const lastActivity = messages.reduce((latest, message) =>
            message.from === 'ensemble' ? latest : Math.max(latest, Date.parse(message.timestamp) || 0),
          Date.parse(team.createdAt))
          const timeLimit = config.maxTeamMinutes !== undefined && ageMs >= config.maxTeamMinutes * 60_000
          const idleLimit = config.maxIdleMinutes !== undefined && Date.now() - lastActivity >= config.maxIdleMinutes * 60_000
          const graceMs = config.graceMinutes * 60_000
          if (timeLimit || idleLimit || this.deadlineWarnings.has(team.id) ||
              messages.some(message => message.from === 'ensemble' && message.content.startsWith('Time is up:'))) {
            let warningAt = this.deadlineWarnings.get(team.id)
            if (warningAt === undefined) {
              const persistedWarning = messages.find(message =>
                message.from === 'ensemble' && message.content.startsWith('Time is up:') &&
                Number.isFinite(Date.parse(message.timestamp)),
              )
              if (persistedWarning) {
                warningAt = Date.parse(persistedWarning.timestamp)
                this.deadlineWarnings.set(team.id, warningAt)
              }
            }
            if (warningAt === undefined) {
              warningAt = Date.now()
              this.deadlineWarnings.set(team.id, warningAt)
              recordSystemMessage(team.id, `Time is up: submit your final report within ${config.graceMinutes} minutes. Limit: ${timeLimit ? 'runtime' : 'inactivity'}.`)
            }
            if (Date.now() >= warningAt + graceMs) {
              this.disbandingTeams.add(team.id)
              try {
                const reason = `team stopped on time limit after ${formatDuration(ageMs)}`
                appendMessage(team.id, {
                  id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
                  content: 'Team ended after its configured deadline and grace period',
                  type: 'chat', timestamp: new Date().toISOString(),
                })
                await disbandTeam(team.id, reason)
              } catch (error) {
                console.error(`[Ensemble] Time-limit disband failed for ${team.id}:`, error)
              } finally {
                this.disbandingTeams.delete(team.id)
                this.deadlineWarnings.delete(team.id)
              }
              continue
            }
          }
        }
        if (!team.workflow) {
          const completed = new Set(getMessages(team.id).filter(message => message.content.trim() === EXPLICIT_DONE_SENTINEL).map(message => message.from))
          for (const agent of team.agents.filter(agent => completed.has(agent.name) && agent.status === 'active')) {
            const key = `${team.id}:${agent.name}`
            if (this.doneEvents.has(key)) continue
            this.doneEvents.add(key)
            teamEvent(team, 'agent_done', { agent: agent.name })
          }
        }
        // Existing teams use the exact sentinel once per original active agent.
        // A late status or a duplicate sentinel cannot reopen a completed turn.
        if (!team.workflow && this.shouldAutoDisband(team)) {
          recordSystemMessage(team.id, 'Auto-disband triggered after all remaining agents sent the completion marker')
          await disbandTeam(team.id, undefined, 'ok')
        }
      } catch (error) {
        console.error(`[Ensemble] Lifecycle check failed for ${team.id}:`, error)
      } finally {
        this.disbandingTeams.delete(team.id)
      }
    }
  }

  private shouldAutoDisband(team: EnsembleTeam): boolean {
    const expected = team.agents.filter(agent => agent.status !== 'replaced' && agent.status !== 'failed')
    const finished = new Set(getMessages(team.id)
      .filter(message => message.content.trim() === EXPLICIT_DONE_SENTINEL)
      .map(message => message.from))
    return expected.length > 0 && expected.every(agent =>
      (agent.status === 'active' || agent.status === 'done') && finished.has(agent.name))
  }

  private stop(): void {
    clearInterval(this.idleCheckTimer)
    this.watchdog.stop()
  }
}

const ensembleService = new EnsembleService()

function formatDuration(durationMs: number): string {
  const durationMin = Math.max(0, Math.round(durationMs / 60000))
  return durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`
}

/**
 * Wacht een export af en voert de afhandeling uit. Een fout in die afhandeling
 * (bijvoorbeeld appendMessage die op een schijffout stuit) blijft hierbinnen:
 * zonder deze wrapper was `void promise.then(handler)` zonder `.catch()` een
 * unhandled rejection, en die haalt met de standaardinstelling van Node het
 * hele proces neer.
 */
async function afhandelenExport<T>(exportPromise: Promise<T>, onResult: (result: T) => void): Promise<void> {
  try {
    const result = await exportPromise
    onResult(result)
  } catch (err) {
    console.error('[Ensemble] Afhandeling van de memory-export mislukte:', err)
  }
}

/** A failed export remains visible in logs and the saved team timeline. */
function memoryExportFailureMessage(result: MemoryExportResult): string {
  const permanent = result.failureKind === 'permanent'
  const why = result.error || `HTTP ${result.status}`
  const recovery = result.pendingFile
    ? `Payload bewaard in ${result.pendingFile}; er is geen automatische nieuwe poging.`
    : `Payload niet bewaard${result.parkingError ? `: ${result.parkingError}` : ''}.`
  const action = permanent
    ? ' Controleer de worker-API en ENSEMBLE_MEMORY_URL; volgende exports kunnen ook mislukken.'
    : ' Controleer de bereikbaarheid van de worker.'
  const content = `${permanent ? '❌' : '⚠️'} Kon deze collab niet naar claude-mem schrijven (${result.endpoint}): ${why}. ${recovery}${action}`
  if (permanent) console.error(`[Ensemble] Memory export FAILED: ${content}`)
  else console.warn(`[Ensemble] Memory export failed: ${content}`)
  return content
}

/** Escape special chars for Telegram MarkdownV2 */
function escMd(s: string): string {
  return s.replace(/([_[\]()~`>#+\-=|{}.!*\\])/g, '\\$1')
}

/** Escape HTML voor alert-hub body. */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Post naar de alert-hub. Het geheim ging eerder als `?key=` mee in de argv van
 * een curl-subproces en was daarmee leesbaar in `ps` voor elke andere gebruiker
 * op de machine. De ingebouwde fetch stuurt het als header, die niet in argv
 * terechtkomt. Fire-and-forget zoals de oude spawn ook was: alleen een netwerkfout
 * wordt gelogd, verder wacht niemand hierop.
 */
function postToAlertHub(url: string, secret: string, payload: string): void {
  // Het geheim gaat in de query, want de hub leest het daar en nergens anders
  // (url.searchParams.get("key"), anders 403).
  // Een header lijkt netter maar zou de alerts stil laten wegvallen.
  //
  // Het lek zat dan ook niet in de query zelf maar in het curl-subproces dat
  // deze URL als argv meekreeg, en argv is voor elke andere gebruiker op de
  // machine leesbaar via ps. Met fetch is er geen subproces en dus geen argv.
  const doel = new URL(url)
  doel.searchParams.set('key', secret)

  void fetch(doel, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(5000),
  })
    .then(res => {
      // De oude spawn keek nergens naar, dus een afgewezen sleutel was stil.
      if (!res.ok) {
        console.error(`[Ensemble] Alert-hub weigerde de melding: HTTP ${res.status}`)
      }
    })
    .catch(err => {
      console.error('[Ensemble] Failed to post to alert-hub:', err instanceof Error ? err.name : 'network error')
    })
}

function sendTelegramSummary(params: {
  task: string
  duration: string
  messageCount: number
  agentSummaries: { name: string; msgs: number; tokens: string }[]
  teamId?: string
}): void {
  // Stabiele dedup-key. teamId indien aangeleverd door caller, anders
  // task-slice + now zodat retries niet dubbel posten.
  const teamKey = params.teamId || `${params.task.slice(0, 40).replace(/\\s+/g, '-')}-${Date.now()}`

  const alertHubUrl = readEnsembleConfig().alertHubUrl
  if (alertHubUrl && ALERT_HUB_SECRET) {
    const agents = params.agentSummaries
    const agentLine = agents.map(a => `${escHtml(a.name)} (${a.msgs}, ${escHtml(a.tokens)})`).join(' + ')
    const hubBody = [
      `<i>${escHtml(params.task.slice(0, 150))}</i>`,
      agentLine,
    ].join('\n')

    const hubPayload = JSON.stringify({
      app: 'ensemble',
      severity: 'low',
      dedup_key: `collab-${teamKey}`,
      title: `\u2728 <b>Collab klaar</b> \u2014 ${escHtml(params.duration)}, ${params.messageCount} msgs`,
      body: hubBody,
    })

    postToAlertHub(alertHubUrl, ALERT_HUB_SECRET, hubPayload)
    return
  }

  // Fallback: directe Telegram als hub-secret niet gezet.
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  const agents = params.agentSummaries
  const agentLine = agents.map(a => `${escMd(a.name)} \\(${a.msgs}, ${escMd(a.tokens)}\\)`).join(' \\+ ')

  const text = [
    `\u2728 *Collab klaar* \u2014 ${escMd(params.duration)}, ${params.messageCount} msgs`,
    escMd(params.task.slice(0, 100)),
    agentLine,
  ].join('\n')

  void fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, parse_mode: 'MarkdownV2', text }),
    signal: AbortSignal.timeout(5000),
  }).then(result => {
    if (!result.ok) console.error(`[Ensemble] Telegram notification failed: HTTP ${result.status}`)
  }).catch(() => console.error('[Ensemble] Telegram notification failed'))
}

async function routeToHost(_program: string, preferredHostId?: string): Promise<string> {
  if (preferredHostId) {
    const host = getHostById(preferredHostId)
    if (host) return preferredHostId
    console.warn(`[Ensemble] Unknown host ${preferredHostId}, falling back to self`)
  }
  return getSelfHostId()
}

export function loadCollabTemplate(templateName?: string): CollabTemplatesFile['templates'][string] | undefined {
  if (!templateName) return undefined
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    const template = data.templates[templateName]
    if (!template) {
      console.warn(`[Ensemble] Unknown template "${templateName}", falling back to default roles`)
      return undefined
    }
    console.log(`[Ensemble] Loaded template "${templateName}" (${template.name})`)
    return template
  } catch (err) {
    console.warn(`[Ensemble] Failed to load templates:`, err)
    return undefined
  }
}

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
  role?: string
  staged?: boolean
}): string {
  const taskPreamble = readEnsembleConfig().taskPreamble
  const template = loadCollabTemplate(params.templateName)
  const scriptsDir = path.join(__dirname, '..', 'scripts')
  const say = `${shellEscape(path.join(scriptsDir, 'team-say.sh'))} ${shellEscape(params.teamId)} ${shellEscape(params.agentName)} team`
  const read = `${shellEscape(path.join(scriptsDir, 'team-read.sh'))} ${shellEscape(params.teamId)} ${shellEscape(params.agentName)}`
  const lead = (params.role ?? (params.agentIndex === 0 ? 'lead' : 'worker')).toLowerCase() === 'lead' || !params.teammateNames.length
  return [
    `You are ${params.agentName}, ${lead ? 'Lead' : 'worker'} of "${params.teamName}".`,
    ...(params.teammateNames.length ? [`Teammates: ${params.teammateNames.join(', ')}.`] : []),
    ...(taskPreamble ? [`Task preamble: ${taskPreamble}`] : []),
    `Task: ${params.description}`,
    template?.roles[params.agentIndex]?.focus || '',
    params.staged ? 'Staged workflow: plan, implement, then review the diff and run the acceptance checks.' : '',
    `Share decisions, actionable findings and blockers with ${say} "message". Read new messages with ${read} at task boundaries, and use --all to review the history. Messages do not request an acknowledgement by default.`,
    'Send a workflow event with team-say and one quoted argument of the form <<COLLAB_EVENT>> followed by a JSON object.',
    lead
      ? [
          'Publish the implementation plan before editing: {"action":"plan","plan":"..."}',
          'After the service acknowledges it, assign each task and its paths: {"action":"assign","task":"...","owner":"agent-name","paths":["path/to/file"]}. Specify takeover:true and reason when transferring a conflicting claim.',
          'Approve critical changes with {"action":"change","paths":["..."],"test":"...","counterexample":"..."}. Record decisions with {"action":"decision","decision":"..."}.',
          'Review the Git diff and submissions. Submit Lead work with {"action":"submit","report":"..."}, request machine acceptance with {"action":"accept"}, and wait for its result. After acceptance passes, file the final report once with {"action":"close","report":"..."}.',
        ].join(' ')
      : 'Read the acknowledged Lead plan and wait for an assignment naming you before editing. Edit only paths assigned to you. When ready for Lead review, send {"action":"submit","report":"Changes, tests and remaining risks"}.',
    `While awaiting a plan acknowledgement, assignment, or review result, keep your turn active and use ${read} --wait. Repeat until the requested workflow event arrives. Workers stay available for review feedback until acceptance. The Lead can end its turn after filing the final report.`,
    'Use {"action":"block","reason":"..."} to raise a blocker and {"action":"unblock"} when it is resolved. Commits require explicit operator policy.',
    'Optionally record a long tool call with {"action":"activity","state":"busy","tool":"tool name"} and send state "idle" at its next safe boundary.',
  ].filter(Boolean).join('\n')
}

async function waitForReady(
  sessionName: string, program: string, hostId?: string, maxWait = 60000, strictRemote = true,
): Promise<boolean> {
  const runtime = getRuntime()
  const start = Date.now()
  const agentConfig = resolveAgentProgram(program)
  const readyMarker = agentConfig.readyMarker
  let lastGateName = ''
  let lastGateHandledAt = 0
  while (Date.now() - start < maxWait) {
    try {
      if (hostId && !isSelf(hostId)) {
        const host = getHostById(hostId)
        if (host && await isRemoteSessionReady(host.url, sessionName, strictRemote ? readyMarker : undefined)) {
          console.log(`[Ensemble] ${sessionName} is remotely reachable (${Math.round((Date.now() - start) / 1000)}s)`)
          return true
        }
      } else {
        // A shell in the foreground means the agent CLI is not (or no
        // longer) running. Its prompt may even contain the ready marker
        // (❯), so never treat it as ready and never send keys into it.
        const foreground = runtime.getForegroundCommand
          ? await runtime.getForegroundCommand(sessionName)
          : ''
        if (!foreground || isShellCommand(foreground)) {
          if (Date.now() - start >= AGENT_START_GRACE_MS) {
            console.error(`[Ensemble] ${sessionName}: agent CLI is not running (${foreground} in foreground)`)
            return false
          }
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        const output = await runtime.capturePane(sessionName, 50)
        const gate = detectLiveGate(output)
        if (gate) {
          const now = Date.now()
          if (gate.name !== lastGateName || now - lastGateHandledAt >= 3000) {
            if (gate.keys === 'down-enter') {
              await runtime.sendKeys(sessionName, 'Down', { enter: true, agentInput: true })
            } else {
              await runtime.sendKeys(sessionName, 'Enter', { agentInput: true })
            }
            lastGateName = gate.name
            lastGateHandledAt = now
            console.log(`[Ensemble] Auto-confirmed ${gate.name} in ${sessionName}`)
          }
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        if (readyMarker && output.includes(readyMarker)) {
          console.log(`[Ensemble] ${sessionName} is ready (${Math.round((Date.now() - start) / 1000)}s)`)
          return true
        }
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  console.error(`[Ensemble] ${sessionName} did not become ready within ${maxWait / 1000}s`)
  return false
}


function teamEvent(team: EnsembleTeam, event: BrainEvent['event'], fields: Partial<BrainEvent> = {}): void {
  void emitEvent({ event, teamId: team.id, team: team.name, ts: new Date().toISOString(), ...fields })
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  if (!request || typeof request.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(request.name) ||
      typeof request.description !== 'string' || !request.description.trim() ||
      (request.workingDirectory !== undefined && typeof request.workingDirectory !== 'string') ||
      (request.requireLeadReady !== undefined && typeof request.requireLeadReady !== 'boolean') ||
      (request.stagedConfig !== undefined &&
        (!request.stagedConfig || typeof request.stagedConfig !== 'object' || Array.isArray(request.stagedConfig) ||
          Object.values(request.stagedConfig).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 86_400_000))) ||
      (request.agents !== undefined && (!Array.isArray(request.agents) || request.agents.length > 20 ||
        request.agents.some(agent => !agent || typeof agent.program !== 'string' ||
          (agent.role !== undefined && typeof agent.role !== 'string') ||
          (agent.hostId !== undefined && typeof agent.hostId !== 'string'))))) {
    return { status: 400, error: 'Invalid team request' }
  }
  let plan
  if (!request.agents?.length) {
    plan = await runPlan(request.description)
    if (plan && !plan.agents.every(key => availableAgentKeys().includes(key))) plan = undefined
    request = { ...request, agents: (plan?.agents ?? ['codex', 'claude code']).map((program, i) => ({ program, role: i === 0 ? 'lead' : 'worker' })), templateName: request.templateName || plan?.template }
  }
  const specs = request.agents!
  // Reject unknown agents before creating anything. The caller named these
  // explicitly, so silently substituting claude would hand back a team that
  // looks right and is not: two identical models where two different ones were
  // asked for. Cheaper to fail here than to discover it halfway a review.
  const unknown = specs
    .map(spec => resolveAgentProgramDetailed(spec.program))
    .filter(resolution => resolution.how === 'fallback')
  if (unknown.length > 0) {
    const names = unknown.map(u => `"${u.requested}"`).join(', ')
    return {
      error: `Unknown agent(s): ${names}. Available: ${availableAgentKeys().join(', ')}`,
      status: 400,
    }
  }

  const leadIndexes = specs.flatMap((spec, index) => spec.role?.toLowerCase() === 'lead' ? [index] : [])
  if (leadIndexes.length > 1) return { status: 400, error: 'Specify one Lead' }
  const leadIndex = leadIndexes[0] ?? 0
  request = { ...request, agents: specs.map((spec, index) => ({
    ...spec, role: index === leadIndex ? 'lead' : spec.role || 'worker',
  })) }
  if (loadTeams().some(team => team.name === request.name && ['forming', 'active', 'paused', 'completed'].includes(team.status))) {
    return { status: 409, error: 'An unfinished team already uses that name' }
  }
  const team = createTeam(request)
  startingTeams.add(team.id)
  try {
    const cwd = request.workingDirectory || process.cwd()
    const worktreeMap = new Map<string, WorktreeInfo>()

    if (plan) appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team', type: 'chat', timestamp: new Date().toISOString(),
      content: `Brain plan: ${plan.agents.join(', ')}; template: ${request.templateName || 'default'}; reason: ${plan.reason || 'not provided'}`,
    })
    if (request.worktree === 'team') {
      try {
        const shared = await createTeamWorktree(team.id, cwd)
        team.worktreePath = shared.path
        team.worktreeBranch = shared.branch
        updateTeam(team.id, { worktreePath: shared.path, worktreeBranch: shared.branch })
      } catch (error) {
        updateTeam(team.id, { status: 'failed' })
        return { status: 400, error: error instanceof Error ? error.message : String(error) }
      }
    }

    // Phase 0: Create worktrees for local agents if requested
    if (request.useWorktrees && request.worktree !== 'team') {
      for (let i = 0; i < team.agents.length; i++) {
        const agentSpec = team.agents[i]
        const hostId = specs[i].hostId
          ? (getHostById(specs[i].hostId!) ? specs[i].hostId! : getSelfHostId())
          : getSelfHostId()

        // Only create worktrees for local agents
        if (isSelf(hostId)) {
          try {
            const worktreeInfo = await createWorktree(team.id, agentSpec.name, cwd)
            worktreeMap.set(agentSpec.name, worktreeInfo)
            team.agents[i].worktreePath = worktreeInfo.path
            team.agents[i].worktreeBranch = worktreeInfo.branch
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `🌳 Worktree created for ${agentSpec.name}: ${worktreeInfo.branch}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`[Ensemble] Failed to create worktree for ${agentSpec.name}:`, message)
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `⚠️ Worktree creation failed for ${agentSpec.name}: ${message}. Using shared directory.`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    // Sessies die dit team echt heeft. Postcheck, rescue en cleanup bepaalden dit
    // eerder met een tmux-scan op de vorm van de sessienaam, waardoor het ene
    // team de sessies van het andere meepakte. agentName hieronder is de ENE
    // plek waar de sessienaam ontstaat; het register bewaart die letterlijk in
    // plaats van 'm elders opnieuw samen te stellen uit team.name + agent.name.
    ensureCollabDirs(team.id)
    fs.mkdirSync(collabRuntimeDir(team.id), { recursive: true })
    fs.writeFileSync(path.join(collabRuntimeDir(team.id), '.managed-workflow'), '')

    const requireLeadReady = request.requireLeadReady ?? team.agents.length > 1
    const lead = team.agents[leadIndex]
    team.workflow = {
      state: 'STARTING', requireLeadReady, lead: lead.name, staged: request.staged, stagedConfig: request.stagedConfig,
      startupDeadline: new Date(Date.now() + (request.stagedConfig?.planTimeoutMs ?? 120_000)).toISOString(),
      baseline: readBaseline(team.worktreePath || cwd),
      fileOwners: {}, taskOwners: {}, submitted: {}, blockers: {}, decisions: [], approvedChanges: [], handled: [],
    }
    updateTeam(team.id, { workflow: team.workflow, agents: team.agents })
    const ordered = [leadIndex, ...team.agents.map((_, index) => index).filter(index => index !== leadIndex)]
    const launches = await Promise.all(team.agents.map(async (agent, index) => {
      const hostId = await routeToHost(agent.program, specs[index].hostId)
      const workingDirectory = team.worktreePath || worktreeMap.get(agent.name)?.path || cwd
      const prepared = isSelf(hostId) ? await prepareLocalAgent(agent.program, workingDirectory) : undefined
      return { hostId, workingDirectory, prepared }
    })).catch(error => {
      recordSystemMessage(team.id, `Preflight failed: ${error instanceof Error ? error.message : 'configured CLI unavailable'}`)
      return undefined
    })
    if (!launches) {
      await disbandTeam(team.id, 'Assigned CLI preflight failed')
      return { status: 503, error: 'Assigned CLI preflight failed', data: { team: getTeam(team.id) ?? team } }
    }
    for (const index of ordered) {
      if (lifecycleWork.has(team.id) || getTeam(team.id)?.status !== 'forming') break
      const agent = team.agents[index]
      const { hostId, workingDirectory, prepared } = launches[index]
      const name = `${team.name}-${agent.name}`
      try {
        if (isSelf(hostId)) {
          if (team.worktreePath) {
            agent.worktreePath = team.worktreePath
            agent.worktreeBranch = team.worktreeBranch
          }
          const spawned = await spawnLocalAgent({ name, program: agent.program, workingDirectory, hostId, ...(prepared ? { prepared } : {}) })
          agent.agentId = spawned.id
          agent.sessionName = spawned.sessionName || name
        } else {
          const host = getHostById(hostId)
          if (!host) throw new Error('Configured remote host is unavailable')
          // Do not send the task description through Maestro before the plan gate.
          const spawned = await spawnRemote(host.url, name, agent.program, cwd, undefined, team.name)
          agent.agentId = spawned.id
          agent.sessionName = name
        }
        agent.hostId = hostId
        agent.status = 'active'
        agent.startup = 'session_created'
        agent.startedAt = new Date().toISOString()
        fs.appendFileSync(collabSessionsFile(team.id), `${agent.sessionName}\n`)
        updateTeam(team.id, { agents: team.agents })
        if (!await waitForReady(agent.sessionName, agent.program, hostId, undefined, requireLeadReady)) throw new Error('CLI did not signal ready')
        agent.startup = 'cli_ready'
        updateTeam(team.id, { agents: team.agents })
        teamEvent(team, 'agent_ready', { agent: agent.name })
        if (lifecycleWork.has(team.id) || getTeam(team.id)?.status !== 'forming') throw new Error('Team stopped during startup')
        if (agent === lead || !requireLeadReady) await deliverInitialPrompt(team, agent, request.templateName)
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Agent startup failed'
        if (agent.agentId) await stopAgent(team, agent)
        agent.status = 'failed'
        updateTeam(team.id, { agents: team.agents })
        teamEvent(team, 'agent_failed', { agent: agent.name, detail })
        recordSystemMessage(team.id, `Failed to start ${agent.name}: ${detail}`)
        if (agent === lead) {
          await disbandTeam(team.id, `Lead ${agent.name} could not start: ${detail}`)
          return { status: 503, error: 'Lead startup failed', data: { team: getTeam(team.id) ?? team } }
        }
      }
    }
    if (getTeam(team.id)?.status !== 'forming') {
      await Promise.all(team.agents.filter(agent => agent.status === 'active').map(agent => stopAgent(team, agent)))
      return { status: 409, error: 'Team stopped during startup' }
    }
    team.status = 'active'
    team.workflow.state = 'WAITING_PLAN'
    team.workflow.startupDeadline = new Date(Date.now() + (request.stagedConfig?.planTimeoutMs ?? 120_000)).toISOString()
    team.templateName = request.templateName
    updateTeam(team.id, team)
    teamEvent(team, 'team_started', { agents: team.agents.map(agent => agent.program), cwd: team.worktreePath || cwd, branch: team.worktreeBranch })
    return { data: { team }, status: 201 }
  } finally {
    startingTeams.delete(team.id)
  }
}

const startingTeams = new Set<string>()

function recordSystemMessage(teamId: string, content: string): void {
  appendMessage(teamId, { id: uuidv4(), teamId, from: 'ensemble', to: 'team', content, type: 'chat', timestamp: new Date().toISOString() })
}

async function stopAgent(team: EnsembleTeam, agent: EnsembleTeam['agents'][number]): Promise<void> {
  if (agent.hostId && !isSelf(agent.hostId)) {
    const host = getHostById(agent.hostId)
    if (host && agent.agentId) await killRemoteAgent(host.url, agent.agentId)
  } else await killLocalAgent(agent.sessionName || `${team.name}-${agent.name}`)
}

async function deliverInitialPrompt(team: EnsembleTeam, agent: EnsembleTeam['agents'][number], templateName?: string): Promise<void> {
  const sessionName = agent.sessionName || `${team.name}-${agent.name}`
  const runtime = getRuntime()
  const prompt = buildPromptPreview({
    teamId: team.id, teamName: team.name, description: team.description, agentName: agent.name,
    teammateNames: team.agents.filter(other => other !== agent && other.status !== 'failed').map(other => other.name),
    agentIndex: team.agents.indexOf(agent), role: agent.role, templateName, staged: team.workflow?.staged,
  })
  const promptFile = collabPromptFile(team.id, agent.name)
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 })
  if (agent.hostId && !isSelf(agent.hostId)) {
    const host = getHostById(agent.hostId)
    if (!host) throw new Error('Configured remote host is unavailable')
    await postRemoteSessionCommand(host.url, sessionName, prompt)
  } else {
    const config = resolveAgentProgram(agent.program)
    if (config.inputMethod === 'pasteFromFile') await pasteAgentInput(runtime, sessionName, promptFile, prompt, config.pasteEnterCount)
    else await runtime.sendKeys(sessionName, prompt.replace(/[\r\n]+/g, ' '), { literal: true, enter: true, agentInput: true })
  }
  agent.startup = 'prompt_delivered'
  updateTeam(team.id, { agents: team.agents })
}

async function processManagedTeam(team: EnsembleTeam): Promise<void> {
  let workflow = team.workflow!
  if (workflow.state === 'DONE') return
  const processed = new Set(workflow.handled)
  for (const message of getMessages(team.id)) {
    if (processed.has(message.id) || !message.content.startsWith('<<COLLAB_EVENT>> ')) continue
    const candidate = structuredClone(workflow)
    let response: string | undefined
    const controller = new AbortController()
    acceptanceControllers.set(team.id, controller)
    try {
      response = await applyWorkflowCommand(team, candidate, message, controller.signal)
      workflow = candidate
    } catch (error) {
      response = `Workflow command rejected: ${error instanceof Error ? error.message : 'invalid event'}`
    } finally {
      acceptanceControllers.delete(team.id)
    }
    workflow.handled.push(message.id)
    const latest = getTeam(team.id)
    if (!latest || latest.status !== 'active' || latest.workflow?.lead !== workflow.lead || lifecycleWork.has(team.id)) return
    team.workflow = workflow
    updateTeam(team.id, { workflow })
    if (response) recordSystemMessage(team.id, response)
    if (team.workflow.state === 'DONE') return
  }
  if (!await reconcileManagedAgents(team) || !workflow.plan) return
  for (const agent of team.agents) {
    if (agent.startup !== 'cli_ready' || agent.status !== 'active' || agent.name === workflow.lead) continue
    if (getTeam(team.id)?.status !== 'active' || lifecycleWork.has(team.id)) return
    try {
      if (!await waitForReady(agent.sessionName || `${team.name}-${agent.name}`, agent.program, agent.hostId, 5000, workflow.requireLeadReady)) throw new Error('Worker CLI is no longer ready')
      await deliverInitialPrompt(team, agent, team.templateName)
    } catch (error) {
      await stopAgent(team, agent)
      agent.status = 'failed'
      updateTeam(team.id, { agents: team.agents })
      recordSystemMessage(team.id, `Worker ${agent.name} could not receive its prompt: ${error instanceof Error ? error.message : 'delivery failed'}`)
    }
  }
}

async function reconcileManagedAgents(team: EnsembleTeam): Promise<boolean> {
  const workflow = team.workflow!
  if (team.pendingReplacement) {
    if (!await recoverPendingReplacement(team.id, team.pendingReplacement)) {
      await disbandTeam(team.id, 'Could not confirm shutdown of a partially started replacement')
      return false
    }
    updateTeam(team.id, { pendingReplacement: undefined })
  }
  // Resolve the Lead before attempting worker recovery or issuing prompts.
  const agents = team.agents.filter(agent => agent.status === 'active')
  agents.sort((a, b) => Number(b.name === workflow.lead) - Number(a.name === workflow.lead))
  if (!agents.some(agent => agent.name === workflow.lead)) {
    await disbandTeam(team.id, 'The Lead is unavailable')
    return false
  }
  for (const agent of agents) {
    const session = agent.sessionName || `${team.name}-${agent.name}`
    const remote = agent.hostId && !isSelf(agent.hostId)
    const host = remote ? getHostById(agent.hostId) : undefined
    const exists = remote
      ? host ? await isRemoteSessionReady(host.url, session) : undefined
      : await getRuntime().sessionExists(session)
    if (getTeam(team.id)?.status !== 'active' || lifecycleWork.has(team.id)) return false
    if (exists === undefined && agent.name === workflow.lead) return false
    let reason = exists === false ? 'session disappeared' : undefined
    if (!remote && exists) {
      const foreground = await getRuntime().getForegroundCommand?.(session)
      if (foreground && isShellCommand(foreground)) reason = 'CLI exited to a shell'
    }
    if (!reason || (agent.name !== workflow.lead && workflow.submitted[agent.name])) continue
    if (agent.name === workflow.lead) {
      // Once workers have entered implementation their shells cannot be
      // reliably frozen across runtimes. Terminate and keep the worktree.
      if (workflow.state === 'WAITING_PLAN' && !agents.some(other =>
          other !== agent && other.startup === 'prompt_delivered') &&
          await replaceTeamAgent(team.id, agent.name, reason, waitForReady)) return false
      await disbandTeam(team.id, `Lead ${agent.name} failed: ${reason}`)
      return false
    }
    if (await replaceTeamAgent(team.id, agent.name, reason, waitForReady)) return false
    if (getTeam(team.id)?.status !== 'active' || lifecycleWork.has(team.id)) return false
    if (exists) await stopAgent(team, agent)
    agent.status = 'failed'
    if (!workflow.submitted[agent.name]) {
      workflow.blockers[agent.name] = reason
      workflow.state = 'BLOCKED'
    }
    updateTeam(team.id, { agents: team.agents, workflow })
    recordSystemMessage(team.id, `Worker ${agent.name} failed: ${reason}. Lead can take over its assignment.`)
  }
  return true
}

export function getEnsembleTeam(teamId: string): ServiceResult<{ team: EnsembleTeam; messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { team, messages: getTeamFeed(teamId).data?.messages ?? [] }, status: 200 }
}

export function listEnsembleTeams(): ServiceResult<{ teams: EnsembleTeam[] }> {
  return { data: { teams: loadTeams() }, status: 200 }
}

export async function checkIdleTeams(): Promise<void> {
  await ensembleService.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string, recipient?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  const messages = getMessages(teamId)
  const receipts = new Map<string, Map<string, string>>()
  for (const message of messages) {
    if (!message.content.startsWith(receiptPrefix)) continue
    try {
      const ids: unknown = JSON.parse(message.content.slice(receiptPrefix.length))
      if (!Array.isArray(ids)) continue
      for (const id of ids) {
        if (typeof id !== 'string') continue
        if (!receipts.has(id)) receipts.set(id, new Map())
        const readers = receipts.get(id)!
        if (!readers.has(message.from)) readers.set(message.from, message.timestamp)
      }
    } catch { /* Ignore malformed read receipts. */ }
  }
  return {
    status: 200,
    data: { messages: messages.filter(message =>
      !message.content.startsWith(receiptPrefix) &&
      (!since || message.timestamp > since) &&
      (!recipient || (message.from !== recipient && (message.to === recipient || message.to === 'team')))
    ).map(message => {
      const readers = receipts.get(message.id)
      const queued = message.delivery ?? (team.workflow ? team.agents
        .filter(agent => agent.name !== message.from && (message.to === 'team' || message.to === agent.name))
        .map(agent => ({ recipient: agent.name, status: 'queued' as const, at: message.timestamp, method: 'pull' as const })) : undefined)
      if (!queued) return message
      return { ...message, delivery: queued.map(delivery => {
        const at = readers?.get(delivery.recipient)
        if (at && delivery.method === 'pull') return { ...delivery, status: 'delivered' as const, at }
        if (delivery.method === 'pane' && delivery.status === 'queued' && !pushing.has(`${teamId}:${message.id}`)) {
          return { ...delivery, status: 'failed' as const, reason: 'Delivery interrupted or unconfirmed' }
        }
        return delivery
      }) }
    }) },
  }
}

const pushing = new Map<string, Promise<unknown>>()

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string, priority?: 'normal' | 'urgent',
): Promise<ServiceResult<{ message: EnsembleMessage }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  if (typeof content !== 'string' || !content.trim() || typeof to !== 'string' ||
      (from !== undefined && typeof from !== 'string') ||
      (existingId !== undefined && typeof existingId !== 'string')) {
    return { error: 'Invalid message', status: 400 }
  }
  const sender = from || 'user'
  const id = existingId || uuidv4()
  const key = `${teamId}:${id}`
  const original = existingId ? getMessages(teamId).find(message => message.id === existingId) : undefined
  if (original && (original.from !== sender || original.to !== to || original.content !== content)) {
    return { error: 'Message id is already in use', status: 409 }
  }
  if (original?.delivery) {
    await pushing.get(key)
    return { status: 200, data: { message: getMessages(teamId).find(message => message.id === id) ?? original } }
  }
  const timestamp = new Date().toISOString()
  const recipients = (team.status === 'active' || (team.status === 'forming' && !!team.workflow)) &&
    (!isWorkflowCommand(content) || (!!team.workflow && !content.startsWith(receiptPrefix)))
    ? team.agents.filter(agent => agent.status === 'active' && agent.name !== sender && (to === 'team' || to === agent.name))
    : []
  const message: EnsembleMessage = {
    id, teamId, from: sender, to, content, type: 'chat',
    timestamp: original?.timestamp || (team.workflow ? timestamp :
      (existingTimestamp && Number.isFinite(Date.parse(existingTimestamp)) ? existingTimestamp : timestamp)),
    priority: priority === 'urgent' ? 'urgent' : 'normal',
    delivery: recipients.map(agent => ({ recipient: agent.name, status: 'queued', at: timestamp, method: team.workflow ? 'pull' : 'pane' })),
  }
  appendMessage(teamId, message)
  if (team.workflow || !recipients.length) return { data: { message }, status: 200 }

  const work = Promise.all(recipients.map((agent, index) => {
    const session = agent.sessionName || `${team.name}-${agent.name}`
    const deliver = async () => {
      const delivery = message.delivery![index]
      try {
        if (getTeam(teamId)?.status !== 'active') throw new Error('Team stopped')
        const input = `[Team message from ${sender}]: ${content}`
        if (agent.hostId && !isSelf(agent.hostId)) {
          const host = getHostById(agent.hostId)
          if (!host) throw new Error('Configured remote host is unavailable')
          await postRemoteSessionCommand(host.url, session, input)
        } else {
          const runtime = getRuntime()
          for (let attempt = 0; !await runtime.sessionExists(session); attempt++) {
            if (attempt >= 2) throw new Error('Session unavailable')
            await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt))
          }
          const file = collabDeliveryFile(teamId, session)
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
          const temporary = `${file}.${uuidv4()}.tmp`
          try {
            fs.writeFileSync(temporary, input, { mode: 0o600 })
            const count = resolveAgentProgram(agent.program).pasteEnterCount
            if (count === undefined) await runtime.pasteFromFile(session, temporary)
            else await runtime.pasteFromFile(session, temporary, { enterCount: count })
          } finally { fs.rmSync(temporary, { force: true }) }
        }
        delivery.status = 'delivered'
      } catch (error) {
        delivery.status = 'failed'
        delivery.reason = error instanceof Error && error.name === 'AgentNotRunningError' ? 'CLI not running' : 'Transport unavailable or delivery unconfirmed'
        if (error instanceof Error && error.name === 'AgentNotRunningError') markAgentFailed(teamId, agent.name)
      }
      delivery.at = new Date().toISOString()
    }
    return serializeAgentInput(`${agent.hostId || ''}:${session}`, deliver)
  })).then(() => appendMessage(teamId, message))
  pushing.set(key, work)
  try { await work } finally { pushing.delete(key) }
  return { data: { message }, status: 200 }
}

/**
 * Write a summary file for a disbanded team — used by auto-disband and can be
 * picked up by the background watcher in the Claude Code session.
 * Mirrors the format from cli/monitor.ts disbandTeam().
 */
/**
 * Summary for a run that produced no agent messages at all.
 *
 * Written so a failed run is distinguishable from one that is still going. It
 * reports what the team was asked to do, who was supposed to do it, and the best
 * diagnosis available, including the ensemble-side errors that are usually the
 * actual cause (a failed prompt injection or a session that never came up).
 */
async function writeFailureSummary(
  team: EnsembleTeam,
  messages: EnsembleMessage[],
  failureReason?: string,
): Promise<void> {
  const duration = formatDuration(Date.now() - new Date(team.createdAt).getTime())
  const errors = messages
    .filter(m => m.from === 'ensemble' && /❌|⚠️|🛑|failed|error/i.test(m.content))
    .slice(-5)
    .map(m => `  ${m.timestamp?.slice(11, 19) || '--:--:--'}  ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`)

  const stoppedOnTimeLimit = failureReason?.startsWith('team stopped on time limit') ?? false
  const roster = team.agents.map(a => `${a.name} (${a.program}, ${a.status})`).join(', ') || 'none'
  const lines = [
    `Task: ${team.description || 'unknown'}`,
    `Duration: ${duration}`,
    `Messages: 0`,
    ...(team.worktreePath ? [`Worktree: ${team.worktreePath}`, `Branch: ${team.worktreeBranch}`] : []),
    `Full transcript: ${collabMessagesFile(team.id)}`,
    '',
    stoppedOnTimeLimit ? `RUN STOPPED: ${failureReason}` : 'RUN FAILED: no agent ever posted a message.',
    failureReason ? `Reason: ${failureReason}` : '',
    `Agents: ${roster}`,
    '',
    errors.length
      ? `Last ensemble-side errors:\n${errors.join('\n')}`
      : stoppedOnTimeLimit ? 'No agent messages were recorded before the time limit.'
      : 'No ensemble-side errors were recorded, which points at prompt delivery:\n' +
        `  the agents started but never received their prompt. Retry with:\n` +
        `  scripts/collab-rescue.sh ${team.id}`,
  ].filter(Boolean)

  const summaryFile = collabSummaryFile(team.id)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(summaryFile, lines.join('\n') + '\n')
  console.log(`[Ensemble] Failure summary written to ${summaryFile}`)
}

export async function writeDisbandSummary(
  teamId: string,
  options: { failureReason?: string } = {},
): Promise<void> {
  const team = getTeam(teamId)
  if (!team) return

  const messages = getMessages(teamId)
  const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user' && !m.content.startsWith(receiptPrefix))

  // A run without agent messages used to return here and write nothing at all,
  // so the caller was left with an empty runtime dir and no explanation. That is
  // the worst possible outcome: silence that looks identical to "still working".
  // Write a short failure summary instead, with whatever diagnosis we have.
  if (agentMsgs.length === 0) {
    await writeFailureSummary(team, messages, options.failureReason)
    return
  }

  const now = new Date()
  const createdAt = new Date(team.createdAt)
  const durationMs = now.getTime() - createdAt.getTime()
  const duration = formatDuration(durationMs)

  const agents = [...new Set(agentMsgs.map(m => m.from))]

  // Scrape token usage from each agent's tmux pane (best-effort)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = agent.sessionName || `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  const cleanContent = (s: string) => s.replace(/\/tmp\/ensemble[-\w]*/g, '').trim()

  const summaryText = agents.map(agent => {
    const msgs = agentMsgs
      .filter(m => m.from === agent)
      .map(m => ({ ...m, content: cleanContent(m.content) }))
      .filter(m => m.content && m.content !== EXPLICIT_DONE_SENTINEL)
    const tokens = tokenUsageMap[agent] || 'unknown'
    // Pick the top 3 longest substantive messages — these almost always
    // contain the recommendation, rationale, build list, or concrete
    // conclusions that matter. Fall back to first/last if <3 total.
    const ranked = [...msgs].sort((a, b) => b.content.length - a.content.length).slice(0, 3)
    const keyMsgs = ranked.length
      ? ranked
          .map((m, i) => `  [${i + 1}] (${m.content.length} chars)\n    ${m.content.slice(0, 1200).replace(/\n/g, '\n    ')}`)
          .join('\n')
      : '  (no substantive messages)'
    return `${agent} (${msgs.length} msgs, tokens: ${tokens})\nKey messages:\n${keyMsgs}`
  }).join('\n\n')

  const summaryFile = collabSummaryFile(teamId)
  const transcriptPointer = collabMessagesFile(teamId)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(
    summaryFile,
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\nFull transcript: ${transcriptPointer}`
      + (team.worktreePath ? `\nWorktree: ${team.worktreePath}\nBranch: ${team.worktreeBranch}` : '')
      + (options.failureReason ? `\nReason: ${options.failureReason}` : '')
      + (team.workflow?.report ? `\n\nLead's final report\n${team.workflow.report}` : '')
      + (team.workflow?.acceptance ? `\nAcceptance evidence: ${team.workflow.acceptance.artifact}` : '')
      + `\n\n${summaryText}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
}

export function disbandTeam(teamId: string, failureReason?: string, finishStatus?: 'ok' | 'failed' | 'stopped'): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const pending = lifecycleWork.get(teamId)
  if (pending) return pending
  const finalization = finalizeTeam(teamId, failureReason, finishStatus).finally(() => lifecycleWork.delete(teamId))
  lifecycleWork.set(teamId, finalization)
  return finalization
}

async function finalizeTeam(teamId: string, failureReason?: string, finishStatus?: 'ok' | 'failed' | 'stopped'): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  if (team.status === 'disbanded' || team.status === 'failed') return { data: { team }, status: 200 }
  stopTeamReplacements(teamId)
  acceptanceControllers.get(teamId)?.abort()
  updateTeam(teamId, { status: 'completed', failureReason })

  // Write summary before killing sessions so the Claude Code session can present it
  await writeDisbandSummary(teamId, failureReason ? { failureReason } : {})
  if (team.pendingReplacement && await recoverPendingReplacement(teamId, team.pendingReplacement)) {
    updateTeam(teamId, { pendingReplacement: undefined })
  }

  // Scrape token usage BEFORE killing sessions (tmux panes disappear on kill)
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = agent.sessionName || `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  for (const agent of team.agents) {
    if (agent.status === 'active' || (agent.status === 'failed' && agent.sessionName)) {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `${agent.name} has left #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      try {
        await stopAgent(team, agent)
      } catch { /* session may already be gone */ }
    }
  }

  const agentsWithWorktrees = team.agents.filter(
    a => a.status !== 'replaced' && a.worktreePath && a.worktreeBranch && (!a.hostId || isSelf(a.hostId))
  )
  if (!team.workflow && team.worktree !== 'team' && agentsWithWorktrees.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000))

    const firstWorktree = agentsWithWorktrees[0].worktreePath!
    const worktreesDir = path.dirname(firstWorktree)
    const basePath = path.dirname(worktreesDir)

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const clean = (() => {
        try { return execFileSync('git', ['status', '--porcelain'], { cwd: worktreeInfo.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '' }
        catch { return false }
      })()
      const merged = (() => {
        try { execFileSync('git', ['merge-base', '--is-ancestor', worktreeInfo.branch, 'HEAD'], { cwd: basePath, stdio: 'ignore' }); return true }
        catch { return false }
      })()
      if (clean && merged) await destroyWorktree(worktreeInfo, basePath)
    }
  }

  const updated = updateTeam(teamId, {
    status: (team.workflow && failureReason && !failureReason.startsWith('team stopped on time limit')) ? 'failed' : 'disbanded',
    failureReason,
    ...(finishStatus === 'ok' && team.workflow ? {
      agents: team.agents.map(agent => agent.status === 'active' ? { ...agent, status: 'done' as const } : agent),
    } : {}),
    completedAt: new Date().toISOString(),
  })

  const finishedMessages = getMessages(teamId)
  const remaining = team.agents.filter(a => a.status !== 'failed' && a.status !== 'replaced')
  const allDone = remaining.length > 0 && remaining.every(a => [...finishedMessages].reverse().find(m => m.from === a.name)?.content.trim() === EXPLICIT_DONE_SENTINEL)
  teamEvent(team, 'team_finished', { status: finishStatus ?? (failureReason ? (failureReason.startsWith('team stopped on time limit') ? 'stopped' : 'failed') : allDone ? 'ok' : 'stopped'), durationS: Math.max(0, (Date.now() - Date.parse(team.createdAt)) / 1000), branch: team.worktreeBranch, cwd: team.worktreePath || team.workingDirectory, detail: failureReason })

  // Soft cleanup: remove ephemeral files, keep messages/summary/log, write .finished marker
  try {
    // The feed poller started by collab-launch.sh also stops on the .finished
    // marker, but only on its next tick; kill it here so a disband never leaves
    // a loop behind (on 2026-09-01 sixteen of them had outlived their teams).
    const pollerPidFile = collabPollerPid(teamId)
    if (fs.existsSync(pollerPidFile)) {
      const pollerPid = parseInt(fs.readFileSync(pollerPidFile, 'utf8').trim(), 10)
      if (pollerPid > 0) {
        try { process.kill(pollerPid, 'SIGTERM') } catch { /* already gone */ }
      }
      fs.unlinkSync(pollerPidFile)
    }
    const deliveryDir = path.join(collabRuntimeDir(teamId), 'delivery')
    if (fs.existsSync(deliveryDir)) fs.rmSync(deliveryDir, { recursive: true, force: true })
    for (const f of [collabBridgeResult(teamId), collabBridgePosted(teamId)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    fs.writeFileSync(collabFinishedMarker(teamId), new Date().toISOString())
  } catch { /* non-fatal cleanup */ }

  // Optional: save session summary to claude-mem
  try {
    const messages = getMessages(teamId)
    const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
    if (agentMessages.length > 0) {
      const durationMs = updated!.completedAt && team.createdAt
        ? new Date(updated!.completedAt).getTime() - new Date(team.createdAt).getTime()
        : 0
      const duration = formatDuration(durationMs)

      // Build a concise summary with token usage
      const agents = [...new Set(agentMessages.map(m => m.from))]
      const summaryParts = agents.map(agent => {
        const msgs = agentMessages.filter(m => m.from === agent)
        const first = msgs[0]?.content.slice(0, 300) || ''
        const last = msgs[msgs.length - 1]?.content.slice(0, 500) || ''
        const tokens = tokenUsageMap[agent] || 'unknown'
        return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n  Start: ${first}\n  Eind: ${last}`
      })

      sendTelegramSummary({
        task: team.description || 'unknown',
        duration,
        messageCount: agentMessages.length,
        agentSummaries: agents.map(agent => ({
          name: agent,
          msgs: agentMessages.filter(m => m.from === agent).length,
          tokens: tokenUsageMap[agent] || '?',
        })),
        teamId: team.id,
      })

      // Detect the working directory as project hint
      const cwdMatch = team.description.match(/workingDirectory[:\s]*([^\s,}]+)/)
      const project = process.env.ENSEMBLE_PROJECT
        || (cwdMatch ? cwdMatch[1].split('/').pop() : undefined)
        || 'ensemble'

      void afhandelenExport(
        exportObservation(
          {
            title: `Collab: ${team.description.slice(0, 80)}`,
            subtitle: `${agents.join(' + ')} — ${duration}, ${agentMessages.length} messages`,
            type: 'discovery',
            narrative: `Team "${team.name}" (${duration}):\nTask: ${team.description.slice(0, 200)}\n\n${summaryParts.join('\n\n')}`,
            project,
          },
          collabRuntimeDir(teamId),
        ),
        result => {
          if (result.ok) return
          const content = memoryExportFailureMessage(result)
          appendMessage(teamId, {
            id: uuidv4(), teamId, from: 'ensemble', to: 'team',
            content,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        },
      )
    }
  } catch { /* non-fatal */ }

  return { data: { team: updated! }, status: 200 }
}

/**
 * Internals exposed for tests only. The completion check is pure, so it can be
 * verified against the actual messages that once ended a team too early.
 */
export const __testing = {
  afhandelenExport,
  memoryExportFailureMessage,
  postToAlertHub,
}
