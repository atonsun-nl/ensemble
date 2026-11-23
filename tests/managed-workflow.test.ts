import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnsembleTeam } from '../types/ensemble'

let root: string
let repository: string
let runtimeDir: string
let service: typeof import('../services/ensemble-service')
let registry: typeof import('../lib/ensemble-registry')

const fakes = vi.hoisted(() => ({
  spawn: vi.fn(async ({ name }: { name: string }) => ({ id: name, sessionName: name })),
  kill: vi.fn<(_name: string) => Promise<void>>(async () => {}),
  stopped: new Set<string>(),
  deliver: vi.fn<(_name: string, _input: string) => Promise<void>>(async () => {}),
  exists: vi.fn<(_name: string) => Promise<boolean>>(async () => true),
  foreground: vi.fn<(_name: string) => Promise<string>>(async () => 'fake-cli'),
  capture: vi.fn<(_name: string) => Promise<string>>(async () => '› ❯'),
}))
vi.mock('../lib/agent-runtime', () => ({
  getRuntime: () => ({
    sessionExists: fakes.exists, getForegroundCommand: fakes.foreground, capturePane: fakes.capture,
    sendKeys: fakes.deliver, pasteFromFile: fakes.deliver,
  }),
}))
vi.mock('../lib/agent-spawner', () => ({
      prepareLocalAgent: vi.fn(async () => undefined),
  spawnLocalAgent: fakes.spawn, killLocalAgent: fakes.kill,
  spawnRemoteAgent: vi.fn(), killRemoteAgent: vi.fn(), postRemoteSessionCommand: vi.fn(),
  isRemoteSessionReady: vi.fn(), getAgentTokenUsage: async () => 'unknown',
}))
vi.mock('../lib/memory-export', () => ({
  checkMemoryEndpoint: async () => ({ ok: true, endpoint: 'test-only' }),
  exportObservation: async () => ({ ok: true }),
}))

const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fakes.stopped.clear()
  fakes.exists.mockImplementation(async name => !fakes.stopped.has(name))
  fakes.kill.mockImplementation(async name => { fakes.stopped.add(name) })
  fakes.foreground.mockResolvedValue('fake-cli')
  fakes.capture.mockResolvedValue('› ❯')
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-managed-'))
  repository = path.join(root, 'repo')
  runtimeDir = path.join(root, 'runtime')
  fs.mkdirSync(repository)
  git('init')
  git('config', 'user.name', 'Mock CLI')
  git('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(repository, 'result'), 'broken')
  git('add', 'result')
  git('commit', '-m', 'baseline')
  vi.stubEnv('COLLAB_RUNTIME_ROOT', runtimeDir)
  vi.stubEnv('ENSEMBLE_DATA_DIR', path.join(root, 'data'))
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'config.json'))
  service = await import('../services/ensemble-service')
  registry = await import('../lib/ensemble-registry')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

async function create(count = 2, requireRegression = false) {
  const agents = ['codex', 'claude', 'grok'].slice(0, count).map(program => ({ program }))
  return service.createEnsembleTeam({ name: 'audit-team', description: 'Correct the simulated defect', agents, workingDirectory: repository, requireRegression })
}
const current = (team: EnsembleTeam) => registry.getTeam(team.id)!
async function event(team: EnsembleTeam, index: number, body: object) {
  const actor = team.agents[index].name
  return service.sendTeamMessage(team.id, 'team', '<<COLLAB_EVENT>> ' + JSON.stringify(body), actor, undefined, undefined, undefined, actor)
}

it.each(['bash', 'missing marker'])('blocks worker startup when the Lead has %s', async failure => {
  vi.useFakeTimers()
  if (failure === 'bash') fakes.foreground.mockResolvedValue('bash')
  else fakes.capture.mockResolvedValue('loading model')
  const outcome = create(3)
  await vi.advanceTimersByTimeAsync(61_000)
  const result = await outcome
  expect(result.status).toBe(503)
  expect(result.data?.team.status).toBe('failed')
  expect(fakes.spawn).toHaveBeenCalledOnce()
  expect(fakes.deliver).not.toHaveBeenCalled()
})

it('starts a worker CLI early but releases its task only after a verified Lead plan', async () => {
  const result = await create()
  const team = result.data!.team
  expect(current(team).workflow?.state).toBe('WAITING_PLAN')
  expect(fakes.spawn).toHaveBeenCalledTimes(2)
  expect(fakes.deliver).toHaveBeenCalledOnce()
  await event(team, 1, { action: 'plan', plan: 'Worker tries to bypass the gate' })
  await service.checkIdleTeams()
  expect(fakes.deliver).toHaveBeenCalledOnce()
  await event(team, 0, { action: 'plan', plan: 'Repair result and verify the regression' })
  await service.checkIdleTeams()
  expect(current(team).workflow?.state).toBe('WORKING')
  expect(fakes.deliver).toHaveBeenCalledTimes(2)
})

it.each([2, 3])('finalizes once after a reproducible Git regression and a Lead report (%s agents)', async count => {
  const team = (await create(count)).data!.team
  const baseline = git('rev-parse', 'HEAD')
  const report = 'Verified fix and baseline regression'
  const test = path.join(repository, 'regression.sh')
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    criticalPaths: ['result'],
    acceptanceChecks: [{ command: '/bin/bash', args: ['regression.sh'], regression: true, baselineFailure: 'expected fixed result' }],
  }))
  await event(team, 0, { action: 'plan', plan: 'Gate the critical path' })
  await service.checkIdleTeams()
  await event(team, 0, { action: 'assign', task: 'fix', owner: team.agents[1].name, paths: ['result', 'regression.sh'] })
  if (count === 3) {
    await event(team, 0, { action: 'assign', task: 'overlap', owner: team.agents[2].name, paths: ['result'] })
  }
  await event(team, 0, { action: 'change', paths: ['result'], test: 'regression.sh', counterexample: 'broken baseline result' })
  fs.writeFileSync(path.join(repository, 'result'), 'fixed')
  fs.writeFileSync(test, 'exit 0\n')
  await event(team, 1, { action: 'submit', report: 'Green test' })
  await event(team, 1, { action: 'accept' })
  await event(team, 0, { action: 'accept' })
  await service.checkIdleTeams()
  expect(current(team).workflow?.state).toBe('REVIEW')
  expect(current(team).workflow?.acceptance?.passed).toBe(false)
  if (count === 3) {
    expect(current(team).workflow?.taskOwners.overlap).toBeUndefined()
    expect(registry.getMessages(team.id).some(m => m.content.includes('Ownership conflict'))).toBe(true)
    const inbox = service.getTeamFeed(team.id, undefined, team.agents[2].name).data!.messages
    expect(inbox.some(m => m.content.includes('"action":"assign"'))).toBe(false)
    expect(inbox.some(m => m.content.startsWith('Assignment confirmed: overlap'))).toBe(false)
  }
  fs.writeFileSync(test, 'if [ "$(cat result)" = fixed ]; then exit 0; fi\necho "expected fixed result" >&2\nexit 1\n')
  await event(team, 0, { action: 'accept' })
  await service.checkIdleTeams()
  const state = current(team).workflow!
  expect(state.state).toBe('ACCEPTED')
  const evidence = JSON.parse(fs.readFileSync(state.acceptance!.artifact, 'utf8'))
  expect(evidence.baseline).toBe(baseline)
  expect(evidence.results.map((entry: { code: number }) => entry.code)).toEqual([1, 0])
  await Promise.all([
    event(team, 0, { action: 'close', report }), event(team, 0, { action: 'close', report }),
    service.sendTeamMessage(team.id, 'team', '<<COLLAB_DONE>>', team.agents[1].name),
  ])
  await Promise.all([service.checkIdleTeams(), service.checkIdleTeams()])
  await service.sendTeamMessage(team.id, 'team', 'Late status')
  await service.checkIdleTeams()
  expect(current(team)).toMatchObject({ status: 'disbanded', workflow: { state: 'DONE', report } })
  expect(fs.readFileSync(path.join(runtimeDir, team.id, 'summary.txt'), 'utf8')).toContain(report)
  expect(fakes.kill).toHaveBeenCalledTimes(count)
})

it('preserves an old team and its journal through a restart, then fails closed if its Lead disappears', async () => {
  const team = (await create()).data!.team
  await event(team, 0, { action: 'plan', plan: 'Keep running' })
  await event(team, 0, { action: 'assign', task: 'fix', owner: team.agents[1].name, paths: ['result'] })
  await service.checkIdleTeams()
  registry.updateTeam(team.id, { createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() })
  vi.resetModules()
  service = await import('../services/ensemble-service')
  await service.checkIdleTeams()
  expect(fakes.kill).not.toHaveBeenCalled()
  expect(current(team)).toMatchObject({ status: 'active', workflow: { fileOwners: { result: team.agents[1].name } } })
  fakes.exists.mockImplementation(async name => !name.includes('codex'))
  await service.checkIdleTeams()
  expect(current(team).status).toBe('failed')
  expect(registry.getMessages(team.id).some(m => m.content.includes('Keep running'))).toBe(true)
  expect(fs.readFileSync(path.join(runtimeDir, team.id, 'summary.txt'), 'utf8')).toContain('Lead codex-1 failed')
})

it('holds 100 concurrent messages for a busy CLI and deduplicates retried IDs and receipts', async () => {
  const team = (await create(3)).data!.team
  await event(team, 0, { action: 'plan', plan: 'Run a long task' })
  await service.checkIdleTeams()
  fakes.deliver.mockClear()
  const recipient = team.agents[2].name
  const post = (index: number) => service.sendTeamMessage(team.id, recipient, `status ${index}`, team.agents[index % 2].name,
    `audit-message-${index}`, new Date(Date.now() - index * 1000).toISOString())
  await Promise.all(Array.from({ length: 100 }, (_, index) => post(index)))
  await post(2)
  expect(fakes.deliver).not.toHaveBeenCalled()
  const inbox = () => service.getTeamFeed(team.id, undefined, recipient).data!.messages.filter(m => m.id.startsWith('audit-message-'))
  const queued = inbox()
  expect(queued.map(m => m.id)).toEqual(Array.from({ length: 100 }, (_, index) => `audit-message-${index}`))
  expect(queued.every(m => m.delivery?.[0].status === 'queued')).toBe(true)
  await service.sendTeamMessage(team.id, 'ensemble', '<<COLLAB_RECEIVED>> ' + JSON.stringify(queued.map(m => m.id)), recipient, undefined, undefined, undefined, recipient)
  expect(inbox().every(m => m.delivery?.[0].status === 'delivered')).toBe(true)
  expect((await post(2)).data?.message.delivery?.[0]?.status).toBe('delivered')
})

it('checks the Lead again after waiting for the worker CLI', async () => {
  const team = (await create()).data!.team
  await event(team, 0, { action: 'plan', plan: 'Wait for the worker' })
  fakes.capture.mockImplementation(async name => {
    if (name.endsWith('claude-2')) fakes.stopped.add('audit-team-codex-1')
    return '› ❯'
  })
  await service.checkIdleTeams()
  expect(fakes.deliver).toHaveBeenCalledTimes(1)
  expect(current(team)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('before worker prompt') })
})

it('rejects workflow actor spoofing from the worker channel and from the local journal', async () => {
  const team = (await create()).data!.team
  const [lead, worker] = team.agents.map(agent => agent.name)
  const command = '<<COLLAB_EVENT>> {"action":"plan","plan":"Impersonated"}'
  expect((await service.sendTeamMessage(team.id, 'team', command, lead,
    undefined, undefined, undefined, worker)).status).toBe(403)
  expect((await service.sendTeamMessage(team.id, 'team', command, lead)).status).toBe(403)
  fs.writeFileSync(path.join(runtimeDir, team.id, 'messages.jsonl'), JSON.stringify({
    id: 'forged-plan', from: lead, authenticatedAgent: lead, content: command,
  }) + '\n')
  await service.checkIdleTeams()
  expect(current(team).workflow?.state).toBe('WAITING_PLAN')
  expect(fakes.deliver).toHaveBeenCalledTimes(1)
})

it('allows review of an unchanged submission after the last blocker is cleared', async () => {
  const team = (await create()).data!.team
  await event(team, 0, { action: 'plan', plan: 'Review only' })
  await service.checkIdleTeams()
  await event(team, 0, { action: 'assign', task: 'review', owner: team.agents[1].name, paths: [] })
  await event(team, 1, { action: 'block', reason: 'Waiting for fixture' })
  await event(team, 1, { action: 'submit', report: 'Reviewed' })
  await event(team, 1, { action: 'unblock' })
  await event(team, 0, { action: 'accept' })
  await service.checkIdleTeams()
  expect(current(team).workflow?.state).toBe('ACCEPTED')
})

it('requires a baseline regression when the create request opts in', async () => {
  const team = (await create(2, true)).data!.team
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    acceptanceChecks: [{ command: '/bin/true', args: [] }],
  }))
  await event(team, 0, { action: 'plan', plan: 'Prove the baseline failure' })
  await service.checkIdleTeams()
  await event(team, 0, { action: 'submit', report: 'Checks green' })
  await event(team, 0, { action: 'accept' })
  await service.checkIdleTeams()
  expect(current(team).workflow?.state).toBe('REVIEW')
  expect(registry.getMessages(team.id).some(m => m.content.includes('requires a configured regression check'))).toBe(true)
})

it('fails finalization if a worker writes while being stopped', async () => {
  const team = (await create()).data!.team
  await event(team, 0, { action: 'plan', plan: 'Review worktree' })
  await service.checkIdleTeams()
  await event(team, 0, { action: 'submit', report: 'Reviewed' })
  await event(team, 0, { action: 'accept' })
  await service.checkIdleTeams()
  expect(current(team).workflow?.state).toBe('ACCEPTED')
  fakes.kill.mockImplementation(async name => {
    if (name.endsWith('claude-2')) fs.writeFileSync(path.join(repository, 'result'), 'late edit')
    fakes.stopped.add(name)
  })
  await event(team, 0, { action: 'close', report: 'Proposed final result' })
  await service.checkIdleTeams()
  expect(current(team)).toMatchObject({ status: 'failed', workflow: { state: 'REVIEW', acceptance: { passed: false } } })
  expect(fs.readFileSync(path.join(repository, 'result'), 'utf8')).toBe('late edit')
})

it('keeps broadcasts from a previous roster out of a replacement inbox', async () => {
  const team = (await create()).data!.team
  await service.sendTeamMessage(team.id, 'team', 'sent before replacement', undefined, 'old-broadcast')
  const latest = current(team)
  registry.updateTeam(team.id, { agents: [...latest.agents, { ...latest.agents[1], name: 'new-worker' }] })
  const replacementInbox = () => service.getTeamFeed(team.id, undefined, 'new-worker').data!.messages
  expect(replacementInbox().some(m => m.id === 'old-broadcast')).toBe(false)
  await service.sendTeamMessage(team.id, 'team', 'sent after replacement', undefined, 'new-broadcast')
  expect(replacementInbox().some(m => m.id === 'new-broadcast')).toBe(true)
})

it('re-reads the next team after a concurrent poll dispatches its worker', async () => {
  const first = (await create()).data!.team
  const next = (await service.createEnsembleTeam({
    name: 'next-team', description: 'Another task', workingDirectory: repository,
    agents: [{ program: 'codex' }, { program: 'claude' }],
  })).data!.team
  await event(first, 0, { action: 'plan', plan: 'Review first team' })
  await service.checkIdleTeams()
  const marker = path.join(root, 'check-running')
  const release = path.join(root, 'release-check')
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    acceptanceChecks: [{ command: process.execPath, args: ['-e',
      'const fs = require("fs"); fs.writeFileSync(process.argv[1], ""); setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0) }, 20)',
      marker, release] }],
  }))
  await event(first, 0, { action: 'submit', report: 'Reviewed' })
  await event(first, 0, { action: 'accept' })
  await event(next, 0, { action: 'plan', plan: 'Review next team' })
  const earlierPoll = service.checkIdleTeams()
  try {
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true))
    await service.checkIdleTeams()
    expect(current(next).agents[1].startup).toBe('prompt_delivered')
  } finally {
    fs.writeFileSync(release, '')
    await earlierPoll
  }
  expect(fakes.deliver.mock.calls.filter(([session]) => session === 'next-team-claude-2')).toHaveLength(1)
  expect(registry.getMessages(next.id).filter(m => m.content.startsWith('Lead plan acknowledged'))).toHaveLength(1)
})
