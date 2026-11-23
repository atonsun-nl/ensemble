import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { execFile, spawnSync } from 'child_process'
import type { EnsembleTeam, EnsembleMessage, ManagedWorkflow } from '../types/ensemble'
import { readEnsembleConfig } from './ensemble-config'
import { collabRuntimeDir } from './collab-paths'

const commandPrefix = '<<COLLAB_EVENT>> '
export const receiptPrefix = '<<COLLAB_RECEIVED>> '

export function isWorkflowCommand(content: string): boolean {
  return content.startsWith(commandPrefix) || content.startsWith(receiptPrefix) || content.trim() === '<<COLLAB_DONE>>'
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a nonempty string')
  return value.trim()
}

function repoPath(value: unknown, cwd: string): string {
  const raw = text(value)
  if (path.isAbsolute(raw) || raw.includes('\\') || raw.includes('\0')) throw new Error('Use a repository-relative path')
  const normalized = path.posix.normalize(raw).replace(/\/$/, '')
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') ||
      normalized.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('Path leaves the managed repository')
  // A symlink could make two apparently disjoint claims target the same file.
  let ancestor = cwd
  for (const part of normalized.split('/')) {
    ancestor = path.join(ancestor, part)
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Symbolic links cannot be claimed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return normalized
}

function intersects(left: string, right: string): boolean {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}

function git(cwd: string, ...args: string[]): Buffer {
  const result = spawnSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 })
  if (result.status !== 0) throw new Error('Cannot inspect Git state for managed acceptance')
  return result.stdout
}

export function readBaseline(cwd: string): string | undefined {
  try { return git(cwd, 'rev-parse', 'HEAD').toString().trim() } catch { return undefined }
}

function snapshot(cwd: string, baseline: string) {
  const head = git(cwd, 'rev-parse', 'HEAD').toString().trim()
  const diff = git(cwd, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', baseline, '--').toString()
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean)
  const changed = git(cwd, 'diff', '--name-only', '-z', '--no-renames', baseline, '--').toString().split('\0').filter(Boolean)
  const fingerprint = createHash('sha256').update(head).update('\0').update(diff)
  const newFiles = untracked.map(file => {
    const full = path.join(cwd, file)
    const stat = fs.lstatSync(full)
    const contents = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full)
    const digest = createHash('sha256').update(contents).digest('hex')
    fingerprint.update(JSON.stringify([file, stat.mode, digest]))
    return { file, digest }
  })
  return { head, diff, digest: fingerprint.digest('hex'), newFiles, changed: [...changed, ...untracked] }
}

export async function applyWorkflowCommand(team: EnsembleTeam, workflow: ManagedWorkflow, message: EnsembleMessage, signal?: AbortSignal): Promise<string | undefined> {
  if (!message.content.startsWith(commandPrefix)) return undefined
  const actor = team.agents.find(agent => agent.name === message.from && agent.status === 'active' && (!agent.startup || agent.startup === 'prompt_delivered'))
  if (!actor) throw new Error('Sender is not an active team member')
  const event = JSON.parse(message.content.slice(commandPrefix.length))
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected a workflow event object')
  const lead = actor.name === workflow.lead
  const mustBeLead = () => { if (!lead) throw new Error('Only the Lead may perform this action') }
  const cwd = team.worktreePath || team.workingDirectory || process.cwd()
  if (event.action === 'plan') {
    mustBeLead()
    if (workflow.state !== 'WAITING_PLAN') throw new Error('Team is not waiting for a plan')
    workflow.plan = text(event.plan)
    workflow.state = 'WORKING'
    if (workflow.staged) workflow.phaseDeadline = new Date(Date.now() + (workflow.stagedConfig?.execTimeoutMs ?? 300_000)).toISOString()
    return 'Lead plan acknowledged'
  }
  if (event.action === 'activity' && (event.state === 'idle' || event.state === 'busy')) {
    workflow.activity ??= {}
    workflow.activity[actor.name] = { state: event.state, at: message.timestamp, tool: typeof event.tool === 'string' ? event.tool.slice(0, 100) : undefined }
    return undefined
  }
  if (workflow.state === 'STARTING' || workflow.state === 'WAITING_PLAN' || workflow.state === 'DONE') {
    throw new Error(`Workflow action unavailable in ${workflow.state}`)
  }
  switch (event.action) {
    case 'assign': {
      mustBeLead()
      const owner = team.agents.find(agent => agent.name === event.owner && agent.status === 'active')?.name
      if (!owner) throw new Error('Assignment owner must be an active team member')
      const task = text(event.task)
      if (!Array.isArray(event.paths)) throw new Error('Assignment needs a paths array')
      const paths = event.paths.map((value: unknown) => repoPath(value, cwd))
      const conflicts = Object.entries(workflow.fileOwners).filter(([claimed, by]) =>
        by !== owner && paths.some((requested: string) => intersects(requested, claimed)))
      const other = Object.hasOwn(workflow.taskOwners, task) ? workflow.taskOwners[task] : undefined
      if ((conflicts.length || (other && other !== owner)) && event.takeover !== true) {
        throw new Error(`Ownership conflict for ${task}: ${conflicts.map(([file, by]) => `${file} (${by})`).join(', ') || other}`)
      }
      if (event.takeover === true) text(event.reason)
      if (workflow.state === 'ACCEPTED') workflow.acceptance = undefined
      workflow.state = 'WORKING'
      if (other && other !== owner) {
        for (const [file, previous] of Object.entries(workflow.fileOwners)) {
          if (previous === other && !Object.entries(workflow.taskOwners).some(([key, value]) => key !== task && value === previous)) {
            delete workflow.fileOwners[file]
          }
        }
      }
      for (const [file, previous] of conflicts) {
        delete workflow.fileOwners[file]
        delete workflow.submitted[previous]
      }
      if (other && other !== owner) {
        delete workflow.submitted[other]
        delete workflow.blockers[other]
      }
      workflow.acceptance = undefined
      delete workflow.submitted[owner]
      for (const file of paths) workflow.fileOwners[file] = owner
      Object.defineProperty(workflow.taskOwners, task, { value: owner, enumerable: true, writable: true, configurable: true })
      return `${event.takeover === true ? 'Takeover' : 'Assigned'} ${task} to ${owner} (${paths.join(', ')})${event.takeover === true ? `: ${event.reason}` : ''}`
    }
    case 'release': {
      mustBeLead()
      const task = text(event.task)
      workflow.acceptance = undefined
      if (workflow.state === 'ACCEPTED') workflow.state = 'REVIEW'
      const paths: string[] = Array.isArray(event.paths) ? event.paths.map((value: unknown) => repoPath(value, cwd)) : []
      delete workflow.taskOwners[task]
      for (const file of paths) delete workflow.fileOwners[file]
      return `Released ${task} (${paths.join(', ')})`
    }
    case 'block':
      workflow.blockers[actor.name] = text(event.reason)
      workflow.state = 'BLOCKED'
      workflow.acceptance = undefined
      return `${actor.name} reported a blocker`
    case 'unblock':
      const owner = event.owner === undefined ? actor.name : text(event.owner)
      if (owner !== actor.name) mustBeLead()
      delete workflow.blockers[owner]
      workflow.state = Object.keys(workflow.blockers).length ? 'BLOCKED' : 'WORKING'
      return `${actor.name} cleared a blocker`
    case 'decision':
      mustBeLead()
      workflow.decisions.push(text(event.decision))
      return 'Recorded Lead decision'
    case 'change':
      mustBeLead()
      if (!Array.isArray(event.paths) || !event.paths.length) throw new Error('Change request needs paths')
      workflow.approvedChanges.push({
        paths: event.paths.map((value: unknown) => repoPath(value, cwd)),
        test: repoPath(event.test, cwd), counterexample: text(event.counterexample),
      })
      return 'Approved Lead change request'
    case 'submit':
      if (!lead && !Object.values(workflow.taskOwners).includes(actor.name)) throw new Error('Worker has no assigned task')
      const report = text(event.report)
      if (workflow.submitted[actor.name] === report) return undefined
      workflow.submitted[actor.name] = report
      workflow.acceptance = undefined
      workflow.state = Object.keys(workflow.blockers).length ? 'BLOCKED' : 'REVIEW'
      if (workflow.staged && workflow.state === 'REVIEW' &&
          Object.values(workflow.taskOwners).every(owner => Object.hasOwn(workflow.submitted, owner))) {
        workflow.phaseDeadline = new Date(Date.now() + (workflow.stagedConfig?.verifyTimeoutMs ?? 120_000)).toISOString()
      }
      return `${actor.name} submitted work for review`
    case 'accept':
      mustBeLead()
      if (workflow.state !== 'REVIEW' || Object.keys(workflow.blockers).length) throw new Error('Work is not ready for acceptance')
      if (!Object.values(workflow.taskOwners).every(owner => Object.hasOwn(workflow.submitted, owner))) {
        throw new Error('Assigned work is still missing a submission')
      }
      workflow.acceptance = await checkAcceptance(team, workflow, event.analysisOnly === true, signal)
      if (workflow.acceptance.passed) workflow.state = 'ACCEPTED'
      return workflow.acceptance.passed ? 'Acceptance checks passed' : 'Acceptance checks failed'
    case 'close': {
      mustBeLead()
      if (workflow.state !== 'ACCEPTED' || !workflow.acceptance?.passed) throw new Error('Successful acceptance is required')
      const report = text(event.report)
      if (workflow.baseline && snapshot(cwd, workflow.baseline).digest !== workflow.acceptance.digest) {
        workflow.state = 'REVIEW'
        workflow.acceptance = undefined
        return 'Workflow command rejected: Git state changed after acceptance'
      }
      workflow.report = report
      workflow.phaseDeadline = undefined
      workflow.state = 'DONE'
      return 'Lead filed the final report'
    }
    default: throw new Error('Unknown workflow action')
  }
}

async function checkAcceptance(team: EnsembleTeam, workflow: ManagedWorkflow, analysisOnly: boolean, signal?: AbortSignal): Promise<NonNullable<ManagedWorkflow['acceptance']>> {
  const config = readEnsembleConfig()
  const cwd = team.worktreePath || team.workingDirectory || process.cwd()
  if (team.agents.some(agent => agent.worktreePath && agent.worktreePath !== cwd && agent.status !== 'replaced')) {
    for (const agent of team.agents) {
      if (!agent.worktreePath || agent.worktreePath === cwd || agent.status === 'replaced') continue
      const head = git(agent.worktreePath, 'rev-parse', 'HEAD').toString().trim()
      if (git(agent.worktreePath, 'status', '--porcelain').length) {
        throw new Error(`Integrate and clean ${agent.name}'s worktree before acceptance`)
      }
      try { git(cwd, 'merge-base', '--is-ancestor', head, 'HEAD') }
      catch { throw new Error(`Integrate ${agent.name}'s committed work into the review branch before acceptance`) }
    }
  }
  const checks = config.acceptanceChecks ?? []
  const baseline = workflow.baseline
  const before = baseline ? snapshot(cwd, baseline) : { head: '', digest: '', diff: '', changed: [], newFiles: [] }
  if (!baseline && !checks.length && !analysisOnly) throw new Error('Configure acceptanceChecks or explicitly accept an analysis-only result')
  if (checks.some(check => check.regression) && !baseline) throw new Error('Regression checks require a Git baseline')
  if (before.changed.length && !checks.length) throw new Error('Configure acceptanceChecks before accepting code changes')
  if (baseline && before.head !== baseline && !config.allowAgentCommits) throw new Error('Agent commits are disabled by policy')
  const criticalPaths = (config.criticalPaths ?? []).map(file => repoPath(file, cwd))
  for (const file of before.changed) {
    if (!Object.keys(workflow.fileOwners).some(claim => file === claim || file.startsWith(claim + '/'))) {
      throw new Error(`Changed path has no registered owner: ${file}`)
    }
    if (!criticalPaths.some(critical => intersects(critical, file))) continue
    if (!workflow.approvedChanges.some(change =>
      change.paths.some(approved => file === approved || file.startsWith(approved + '/')) &&
      checks.some(check => check.regression && repoPath(check.args[0], cwd) === change.test))) throw new Error(`Critical path needs an approved change request and a regression check: ${file}`)
  }
  const results: Array<{ command: string; args: string[]; phase: string; code: number | null; stdout: string; stderr: string }> = []
  const run = (check: typeof checks[number], phase: string, directory: string) =>
    new Promise<{ code: number | null; output: string }>(resolve => {
      execFile(check.command, check.args, {
        cwd: directory, signal, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, CI: 'true' },
      }, (error, stdout, stderr) => {
        const code = !error ? 0 : typeof error.code === 'number' && !error.signal ? error.code : null
        results.push({ command: check.command, args: check.args, phase, code, stdout, stderr })
        resolve({ code, output: stdout + '\n' + stderr })
      })
    })
  let passed = true
  if (baseline && checks.some(check => check.regression)) {
    const scratch = fs.mkdtempSync(path.join(collabRuntimeDir(team.id), 'baseline-'))
    const tree = path.join(scratch, 'tree')
    try {
      git(cwd, 'worktree', 'add', '--detach', tree, baseline)
      for (const check of checks.filter(candidate => candidate.regression)) {
        // Keep the same test on both revisions. The operator lists its
        // repository-relative entry point as the first argument.
        const entry = repoPath(check.args[0], cwd)
        const target = path.join(tree, entry)
        repoPath(entry, tree)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(cwd, entry), target)
        signal?.throwIfAborted()
        const result = await run(check, 'baseline', tree)
        if (!check.baselineFailure || result.code !== 1 || !result.output.includes(check.baselineFailure)) passed = false
      }
    } finally {
      if (fs.existsSync(tree)) git(cwd, 'worktree', 'remove', '--force', tree)
      fs.rmdirSync(scratch)
    }
  }
  for (const check of checks) {
    signal?.throwIfAborted()
    if ((await run(check, 'candidate', cwd)).code !== 0) passed = false
  }
  signal?.throwIfAborted()
  if (baseline && snapshot(cwd, baseline).digest !== before.digest) passed = false
  const artifact = path.join(collabRuntimeDir(team.id), `acceptance-${randomUUID()}.json`)
  fs.writeFileSync(artifact, JSON.stringify({ baseline, ...before, passed, results }, null, 2), { mode: 0o600 })
  return { head: before.head, diff: before.diff, digest: before.digest, passed, artifact }
}
