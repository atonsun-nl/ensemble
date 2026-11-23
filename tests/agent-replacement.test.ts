import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isShellCommand } from '../lib/startup-gates'
import type { BrainEvent } from '../lib/brain-hooks'
import type { AgentWatchdog } from '../lib/agent-watchdog'

let root: string
let registry: typeof import('../lib/ensemble-registry')
let replace: typeof import('../lib/agent-replacement')['replaceTeamAgent']
let watchdog: AgentWatchdog | undefined
let now: number
const roster = vi.fn()
const health = vi.fn()
const emit = vi.fn(async (_event: BrainEvent) => {})
const spawn = vi.fn(async (_options: { name: string; program: string; workingDirectory: string }) => ({ id: 'replacement-id' }))
const kill = vi.fn(async (_name: string) => {})
const paste = vi.fn(async (_session: string, _file: string) => {})
const sessionExists = vi.fn(async () => false)
const ready = vi.fn(async () => true)
let teamId: string
beforeEach(async () => {
  vi.resetModules()
  root = fs.mkdtempSync(path.resolve('tmp/replacement-'))
  vi.stubEnv('ENSEMBLE_DATA_DIR', path.join(root, 'data'))
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'config.json'))
  vi.stubEnv('COLLAB_RUNTIME_ROOT', path.join(root, 'runtime'))
  vi.stubEnv('ENSEMBLE_AGENTS_CONFIG', path.resolve('agents.json'))
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ replaceStalledAgents: true, maxReplacementsPerTeam: 2, fallbackOrder: ['invalid', 'codex', 'glm', 'mimo', 'gemini'] }))
  roster.mockReset().mockResolvedValue({ glm: { status: 'limit' }, mimo: { status: 'ok' }, gemini: { status: 'ok' } })
  health.mockReset().mockResolvedValue({ warnings: [] })
  sessionExists.mockReset().mockResolvedValue(false)
  emit.mockClear(); spawn.mockClear(); kill.mockClear(); paste.mockReset().mockResolvedValue(undefined); ready.mockReset().mockResolvedValue(true)
  vi.doMock('../lib/brain-hooks', () => ({ runRoster: roster, emitEvent: emit }))
  vi.doMock('../lib/agent-health', () => ({ checkAgentHealth: health }))
  vi.doMock('../lib/agent-spawner', () => ({
    spawnLocalAgent: spawn, killLocalAgent: kill, spawnRemoteAgent: vi.fn(), killRemoteAgent: vi.fn(), postRemoteSessionCommand: vi.fn(),
    findRemoteAgent: vi.fn(), isRemoteSessionReady: vi.fn(), getAgentTokenUsage: vi.fn(async () => 'unknown'),
  }))
  vi.doMock('../lib/agent-runtime', () => ({ isShellCommand, getRuntime: () => ({
    sessionExists, pasteFromFile: paste, sendKeys: vi.fn(async () => {}),
    getForegroundCommand: vi.fn(async () => 'node'),
    capturePane: vi.fn(async () => 'Type your message'),
  }) }))
  vi.doMock('../lib/hosts-config', () => ({ isSelf: vi.fn(() => true), getHostById: vi.fn() }))
  registry = await import('../lib/ensemble-registry')
  replace = (await import('../lib/agent-replacement')).replaceTeamAgent
  const team = registry.createTeam({ name: 'replacement', description: 'Original task', agents: [{ program: 'codex', role: 'reviewer' }], workingDirectory: root, worktree: 'team' })
  teamId = team.id
  team.agents[0].status = 'active'
  team.agents[0].hostId = 'local'
  registry.updateTeam(teamId, { status: 'active', agents: team.agents, worktreePath: path.join(root, 'shared'), worktreeBranch: 'ensemble/example' })
  now = Date.now()
})
afterEach(() => {
  watchdog?.stop(); watchdog = undefined
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const module of ['brain-hooks', 'agent-health', 'agent-spawner', 'agent-runtime', 'hosts-config']) vi.doUnmock(`../lib/${module}`)
  fs.rmSync(root, { recursive: true, force: true })
})
async function watch(exists: boolean) {
  const { AgentWatchdog } = await import('../lib/agent-watchdog')
  watchdog = new AgentWatchdog({
    loadTeams: registry.loadTeams, getMessages: registry.getMessages, appendMessage: registry.appendMessage,
    markAgentFailed: registry.markAgentFailed, replacementEnabled: () => true, sessionExists: async () => exists,
    replaceAgent: (team, agent, detail) => replace(team.id, agent.name, detail, ready),
    onAgentStalled: (team, agent, detail) => { void emit({ event: 'agent_stalled', teamId: team.id, team: team.name, agent: agent.name, detail, ts: new Date(now).toISOString() }) },
    getRuntime: () => ({
    sessionExists, pasteFromFile: paste, sendKeys: vi.fn(async () => {}),
    getForegroundCommand: vi.fn(async () => 'node'),
    capturePane: vi.fn(async () => 'Type your message'),
  }),
    resolveAgentProgram: () => ({ inputMethod: 'pasteFromFile' }), isSelf: () => true,
    getHostById: () => undefined, postRemoteSessionCommand: vi.fn(),
    collabDeliveryFile: () => path.join(root, 'nudge'), now: () => now, nudgeAfterMs: 100, stallAfterMs: 100,
  })
  return watchdog
}
it('replaces a vanished session on its first poll, keeps role and cwd, and emits events', async () => {
  await (await watch(false)).poll()
  const team = registry.getTeam(teamId)!
  expect(team.agents.map(a => [a.program, a.status, a.role])).toEqual([['codex', 'replaced', 'reviewer'], ['mimo', 'active', 'reviewer']])
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ program: 'mimo', workingDirectory: path.join(root, 'shared') }))
  expect(kill).toHaveBeenCalledWith('replacement-codex-1')
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_stalled', agent: 'codex-1' }))
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_replaced', agent: 'codex-1', replacement: 'mimo-2' }))
  expect(registry.getMessages(teamId).some(m => m.content.includes('Replaced codex-1'))).toBe(true)
})
it('replaces after a successful nudge followed by a stall', async () => {
  const w = await watch(true)
  now += 200
  await w.poll()
  expect(spawn).not.toHaveBeenCalled()
  now += 200
  await w.poll()
  expect(spawn).toHaveBeenCalledOnce()
})
it('includes the original task and bounded recent messages', async () => {
  for (let i = 0; i < 25; i++) registry.appendMessage(teamId, { id: `m-${i}`, teamId, from: 'codex-1', to: 'team', type: 'chat', timestamp: new Date(now + i).toISOString(), content: `marker-${i} ${'x'.repeat(1000)}` })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(true)
  const prompt = fs.readFileSync(path.join(root, 'runtime', teamId, 'prompts', 'mimo-2.txt'), 'utf8')
  expect(prompt).toContain('Original task')
  expect(prompt).toContain('marker-24')
  expect(prompt).not.toContain('marker-0 ')
  expect(Buffer.byteLength(prompt)).toBeLessThan(10_000)
})
it('marks failed when the replacement budget is exhausted', async () => {
  registry.updateTeam(teamId, { replacementCount: 2 })
  await (await watch(false)).poll()
  expect(spawn).not.toHaveBeenCalled()
  expect(registry.getTeam(teamId)!.agents[0].status).toBe('failed')
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'agent_failed' }))
})
it('falls back to health only when roster is unavailable, and then to no check', async () => {
  roster.mockResolvedValue(undefined)
  health.mockResolvedValue({ healthy: ['gemini'], warnings: [] })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(true)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ program: 'gemini' }))
  health.mockResolvedValue({ warnings: ['hook unavailable'] })
  expect(await replace(teamId, 'gemini-2', 'gone again', ready)).toBe(true)
  expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ program: 'glm' }))
})
it('does not bypass a valid roster with no healthy candidate', async () => {
  roster.mockResolvedValue({ mimo: { status: 'unknown' }, glm: { status: 'slow' } })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(false)
  expect(health).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})
it('cleans up a replacement that cannot become ready', async () => {
  ready.mockResolvedValue(false)
  await (await watch(false)).poll()
  expect(kill).toHaveBeenCalledWith('replacement-mimo-2')
  expect(registry.getTeam(teamId)!.agents[0].status).toBe('failed')
})
it('does not leave a new session behind when disband begins during readiness', async () => {
  const { stopTeamReplacements } = await import('../lib/agent-replacement')
  ready.mockImplementation(async () => { stopTeamReplacements(teamId); return true })
  expect(await replace(teamId, 'codex-1', 'gone', ready)).toBe(false)
  expect(kill).toHaveBeenCalledWith('replacement-mimo-2')
  expect(registry.getTeam(teamId)!.agents).toHaveLength(1)
})

function setManagedWorkflow() {
  const team = registry.getTeam(teamId)!
  team.agents[0].role = 'worker'
  registry.updateTeam(teamId, {
    agents: team.agents,
    workflow: {
      state: 'BLOCKED', requireLeadReady: true, lead: 'another-lead', startupDeadline: new Date(now).toISOString(),
      plan: 'Assign result.txt', fileOwners: { 'result.txt': 'codex-1' }, taskOwners: { fix: 'codex-1' },
      blockers: { 'codex-1': 'unverified baseline' }, submitted: {}, approvedChanges: [], handled: [],
      decisions: ['Keep previous edits'],
    },
  })
}

it('reassigns managed ownership only after shutdown and preserves the working tree', async () => {
  setManagedWorkflow()
  const workspace = path.join(root, 'shared')
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'result.txt'), 'uncommitted work')
  expect(await replace(teamId, 'codex-1', 'CLI exited', ready)).toBe(true)
  expect(kill.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0])
  expect(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8')).toBe('uncommitted work')
  expect(registry.getTeam(teamId)?.workflow).toMatchObject({
    fileOwners: { 'result.txt': 'mimo-2' }, taskOwners: { fix: 'mimo-2' },
    blockers: { 'mimo-2': 'unverified baseline' }, decisions: ['Keep previous edits'],
  })
})

it('refuses managed replacement while the previous session can still write', async () => {
  setManagedWorkflow()
  sessionExists.mockResolvedValue(true)
  expect(await replace(teamId, 'codex-1', 'CLI exited', ready)).toBe(false)
  expect(spawn).not.toHaveBeenCalled()
  expect(registry.getTeam(teamId)?.workflow?.fileOwners['result.txt']).toBe('codex-1')
})

it('keeps a replacement worker at CLI-ready while the team awaits a Lead plan', async () => {
  setManagedWorkflow()
  const { workflow } = registry.getTeam(teamId)!
  registry.updateTeam(teamId, { workflow: { ...workflow!, state: 'WAITING_PLAN', plan: undefined, blockers: {} } })
  expect(await replace(teamId, 'codex-1', 'CLI exited before the plan', ready)).toBe(true)
  expect(paste).not.toHaveBeenCalled()
  expect(registry.getTeam(teamId)).toMatchObject({
    agents: [{ status: 'replaced' }, { name: 'mimo-2', startup: 'cli_ready' }],
    workflow: { state: 'WAITING_PLAN' },
  })
})

it('finds and deletes an interrupted remote candidate that had no local ID yet', async () => {
  const spawner = await import('../lib/agent-spawner')
  const hosts = await import('../lib/hosts-config')
  vi.mocked(hosts.isSelf).mockReturnValue(false)
  vi.mocked(hosts.getHostById).mockReturnValue({ id: 'remote', name: 'Remote', url: 'http://maestro.invalid' })
  vi.mocked(spawner.findRemoteAgent).mockResolvedValue('found-id')
  vi.mocked(spawner.killRemoteAgent).mockResolvedValue(true)
  vi.mocked(spawner.isRemoteSessionReady).mockResolvedValue(false)
  const { recoverPendingReplacement } = await import('../lib/agent-replacement')
  expect(await recoverPendingReplacement(teamId, {
    oldAgent: 'codex-1', sessionName: 'replacement-mimo-2', hostId: 'remote',
  })).toBe(true)
  expect(spawner.findRemoteAgent).toHaveBeenCalledWith('http://maestro.invalid', 'replacement-mimo-2')
  expect(spawner.killRemoteAgent).toHaveBeenCalledWith('http://maestro.invalid', 'found-id')
})

it.each(['local', 'remote'])('accepts the new %s Lead plan while its prompt is still being delivered', async host => {
  setManagedWorkflow()
  const before = registry.getTeam(teamId)!
  const spawner = await import('../lib/agent-spawner')
  if (host === 'remote') {
    const hosts = await import('../lib/hosts-config')
    vi.mocked(hosts.isSelf).mockReturnValue(false)
    vi.mocked(hosts.getHostById).mockReturnValue({ id: 'remote', name: 'Remote', url: 'http://maestro.invalid' })
    before.agents[0].hostId = 'remote'
    vi.mocked(spawner.isRemoteSessionReady).mockResolvedValue(false)
    vi.mocked(spawner.spawnRemoteAgent).mockResolvedValue({ id: 'replacement-id' })
  }
  registry.updateTeam(teamId, { agents: before.agents, workflow: {
    ...before.workflow!, lead: 'codex-1', state: 'WAITING_PLAN', plan: undefined,
  } })
  const service = await import('../services/ensemble-service')
  const submitPlan = async () => {
    const during = registry.getTeam(teamId)!
    expect(during.workflow?.lead).toBe('mimo-2')
    expect(during.pendingReplacement?.agentId).toBe('replacement-id')
    const response = await service.sendTeamMessage(teamId, 'team',
      '<<COLLAB_EVENT>> {"action":"plan","plan":"Replacement plan"}',
      'mimo-2', 'first-replacement-plan', undefined, undefined, 'mimo-2')
    expect(response.status).toBe(200)
  }
  if (host === 'remote') vi.mocked(spawner.postRemoteSessionCommand).mockImplementationOnce(submitPlan)
  else paste.mockImplementationOnce(submitPlan)
  expect(await replace(teamId, 'codex-1', 'Lead exited', ready)).toBe(true)
  const current = registry.getTeam(teamId)!
  expect(current.agents[1].startup).toBe('prompt_delivered')
  const firstPlan = registry.getMessages(teamId).find(message => message.id === 'first-replacement-plan')!
  const { applyWorkflowCommand } = await import('../lib/managed-workflow')
  await applyWorkflowCommand(current, current.workflow!, firstPlan)
  expect(current.workflow?.plan).toBe('Replacement plan')
})

it('queues a durable assignment confirmation for the replacement worker inbox', async () => {
  setManagedWorkflow()
  const previous = registry.getTeam(teamId)!
  registry.updateTeam(teamId, { agents: [...previous.agents, {
    agentId: 'lead-id', name: 'another-lead', program: 'claude', role: 'lead', hostId: 'local',
    status: 'active', startup: 'prompt_delivered',
  }] })
  expect(await replace(teamId, 'codex-1', 'Worker exited', ready)).toBe(true)
  const notices = registry.getTeam(teamId)!.workflow!.pendingNotices!
  expect(notices).toHaveLength(1)
  expect(notices[0].content).toContain('Assignment takeover confirmed: fix to mimo-3 (result.txt)')
  // Restarting the service flushes persisted notices through its normal lifecycle.
  sessionExists.mockResolvedValue(true)
  const service = await import('../services/ensemble-service')
  await service.checkIdleTeams()
  const inbox = service.getTeamFeed(teamId, undefined, 'mimo-3').data!.messages
  expect(inbox.filter(message => message.id === notices[0].id)).toHaveLength(1)
  expect(inbox.find(message => message.id === notices[0].id)?.delivery).toContainEqual(
    expect.objectContaining({ recipient: 'mimo-3', status: 'queued', method: 'pull' }))
  await service.checkIdleTeams()
  expect(registry.getMessages(teamId).filter(message => message.id === notices[0].id)).toHaveLength(1)
})

it('marks a registered replacement failed when prompt delivery fails', async () => {
  setManagedWorkflow()
  const before = registry.getTeam(teamId)!
  registry.updateTeam(teamId, { workflow: { ...before.workflow!, lead: 'codex-1' } })
  paste.mockRejectedValueOnce(new Error('paste failed'))
  expect(await replace(teamId, 'codex-1', 'Lead exited', ready)).toBe(false)
  expect(registry.getTeam(teamId)!.agents[1].status).toBe('failed')
  expect(kill).toHaveBeenCalledWith('replacement-mimo-2')
})
