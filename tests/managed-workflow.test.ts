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
  fakes.exists.mockResolvedValue(true)
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

async function create(count = 2) {
  const agents = ['codex', 'claude', 'grok'].slice(0, count).map(program => ({ program }))
  return service.createEnsembleTeam({ name: 'audit-team', description: 'Correct the simulated defect', agents, workingDirectory: repository })
}
const current = (team: EnsembleTeam) => registry.getTeam(team.id)!
async function event(team: EnsembleTeam, index: number, body: object) {
  return service.sendTeamMessage(team.id, 'team', '<<COLLAB_EVENT>> ' + JSON.stringify(body), team.agents[index].name)
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
  const post = (index: number) => service.sendTeamMessage(team.id, recipient, `status ${index}`, team.agents[index % 2].name, `audit-message-${index}`)
  await Promise.all(Array.from({ length: 100 }, (_, index) => post(index)))
  await post(2)
  expect(fakes.deliver).not.toHaveBeenCalled()
  const inbox = () => service.getTeamFeed(team.id, undefined, recipient).data!.messages.filter(m => m.id.startsWith('audit-message-'))
  const queued = inbox()
  expect(queued.map(m => m.id)).toEqual(Array.from({ length: 100 }, (_, index) => `audit-message-${index}`))
  expect(queued.every(m => m.delivery?.[0].status === 'queued')).toBe(true)
  await service.sendTeamMessage(team.id, 'ensemble', '<<COLLAB_RECEIVED>> ' + JSON.stringify(queued.map(m => m.id)), recipient)
  expect(inbox().every(m => m.delivery?.[0].status === 'delivered')).toBe(true)
})
