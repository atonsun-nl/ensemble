import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

// Model Grok's documented active-turn input: Enter queues the draft; another
// Enter on the empty composer sends it now and cancels the running turn.
const ui = vi.hoisted(() => ({
  buffers: new Map<string, string>(), draft: '', queued: [] as string[], interruptions: 0, pasted: [] as string[],
}))
vi.mock('child_process', () => ({
  exec: vi.fn((_command: string, callback: (error: Error | null, stdout: string) => void) => callback(null, 'grok')),
  execFile: vi.fn((_binary: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
    if (args[0] === 'load-buffer') ui.buffers.set(args[2], fs.readFileSync(args[3], 'utf8'))
    if (args[0] === 'paste-buffer' && args.at(-1) === 'grok-team-grok-3') {
      const text = ui.buffers.get(args[args.indexOf('-b') + 1])!
      ui.pasted.push(text)
      ui.draft += text
    }
    if (args[0] === 'delete-buffer') ui.buffers.delete(args[2])
    if (args[0] === 'send-keys' && args[2] === 'grok-team-grok-3') {
      if (ui.draft) { ui.queued.push(ui.draft); ui.draft = '' }
      else if (ui.queued.length) { ui.interruptions++; ui.queued.shift() }
    }
    callback(null, '')
  }),
  execFileSync: vi.fn(), spawn: vi.fn(),
}))

let root: string
let team: EnsembleTeam
let messages: EnsembleMessage[]
let service: typeof import('../services/ensemble-service')

beforeEach(async () => {
  root = fs.mkdtempSync(path.resolve('tmp/grok-delivery-'))
  vi.stubEnv('COLLAB_RUNTIME_ROOT', root)
  vi.stubEnv('ENSEMBLE_CONFIG', path.join(root, 'absent.json'))
  vi.stubEnv('ENSEMBLE_AGENTS_CONFIG', path.resolve('agents.json'))
  vi.useFakeTimers()
  vi.resetModules()
  Object.assign(ui, { buffers: new Map<string, string>(), draft: '', queued: [], interruptions: 0, pasted: [] })
  messages = []
  team = {
    id: 'grok-team', name: 'grok-team', description: 'Fix a defect', status: 'active',
    agents: [
      { agentId: '1', name: 'codex-1', program: 'codex', role: 'lead', status: 'active', hostId: 'local' },
      { agentId: '2', name: 'agy-2', program: 'agy', role: 'member', status: 'active', hostId: 'local' },
      { agentId: '3', name: 'grok-3', program: 'grok', role: 'member', status: 'active', hostId: 'local' },
    ],
    createdBy: 'test', createdAt: new Date().toISOString(), feedMode: 'live',
  }
  vi.doMock('../lib/ensemble-registry', () => ({
    loadTeams: () => [], getTeam: () => team, getMessages: () => messages, markAgentFailed: vi.fn(),
    appendMessage: (_id: string, message: EnsembleMessage) => messages.push(message),
  }))
  vi.doMock('../lib/hosts-config', () => ({ isSelf: () => true, getHostById: () => undefined }))
  vi.doMock('../lib/agent-watchdog', () => ({ AgentWatchdog: class { stop() {} } }))
  vi.doMock('../lib/memory-export', () => ({
    checkMemoryEndpoint: async () => ({ ok: true, endpoint: 'disabled-in-test' }),
  }))
  const { getRuntime } = await import('../lib/agent-runtime')
  vi.spyOn(getRuntime(), 'sessionExists').mockResolvedValue(true)
  vi.spyOn(getRuntime() as import('../lib/agent-runtime').TmuxRuntime, 'getForegroundCommand').mockResolvedValue('grok')
  service = await import('../services/ensemble-service')
})

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const name of ['ensemble-registry', 'hosts-config', 'agent-watchdog', 'memory-export']) {
    vi.doUnmock(`../lib/${name}`)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['codex-1', 'agy-2'])('queues a message from %s without cancelling Grok', async sender => {
  const delivery = service.sendTeamMessage(team.id, 'team', 'Please check reconnects', sender)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await delivery).status).toBe(200)
  expect(ui.interruptions).toBe(0)
  expect(ui.queued).toHaveLength(1)
  expect(ui.queued[0]).toContain('Please check reconnects')
  expect(messages.some(m => m.from === sender && m.content === 'Please check reconnects')).toBe(true)
})

it('preserves both messages arriving together without an empty-composer Enter', async () => {
  const delivery = Promise.all([
    service.sendTeamMessage(team.id, 'grok-3', 'Check reconnects', 'codex-1'),
    service.sendTeamMessage(team.id, 'grok-3', 'Check heartbeat', 'agy-2'),
  ])
  await vi.advanceTimersByTimeAsync(5_000)
  await delivery
  expect(ui.interruptions).toBe(0)
  expect(ui.queued).toHaveLength(2)
  expect(ui.queued[0]).toContain('Check reconnects')
  expect(ui.queued[1]).toContain('Check heartbeat')
  expect(ui.pasted).toEqual(ui.queued)
})

it('queues a watchdog reminder without cancelling Grok', async () => {
  const { AgentWatchdog } = await vi.importActual<typeof import('../lib/agent-watchdog')>('../lib/agent-watchdog')
  const { getRuntime } = await import('../lib/agent-runtime')
  const { resolveAgentProgram } = await import('../lib/agent-config')
  const watchdog = new AgentWatchdog({
    loadTeams: () => [{ ...team, agents: [team.agents[2]] }],
    getMessages: () => messages,
    appendMessage: (_id, message) => messages.push(message),
    getRuntime, resolveAgentProgram, isSelf: () => true, getHostById: () => undefined,
    postRemoteSessionCommand: async () => {},
    collabDeliveryFile: () => path.join(root, 'watchdog.txt'),
    now: () => Date.parse(team.createdAt) + 91_000,
  })
  try {
    const reminder = watchdog.poll()
    await vi.advanceTimersByTimeAsync(2_000)
    await reminder
    expect(ui.interruptions).toBe(0)
    expect(ui.queued).toHaveLength(1)
    expect(ui.queued[0]).toContain('Are you still working?')
  } finally { watchdog.stop() }
})

it('serializes 100 pane inputs and does not paste a retried message twice', async () => {
  const post = (id: number) => service.sendTeamMessage(team.id, 'grok-3', `status ${id}`, id % 2 ? 'agy-2' : 'codex-1', `msg-${id}`)
  const work = Promise.all([...Array.from({ length: 100 }, (_, index) => post(index)), post(10)])
  await vi.advanceTimersByTimeAsync(105_000)
  await work
  expect(ui.queued.map(text => Number(text.split('status ')[1]))).toEqual(Array.from({ length: 100 }, (_, index) => index))
  expect(ui.pasted).toEqual(ui.queued)
  expect(ui.interruptions).toBe(0)
})

it('reconnects before pasting and reports a permanently missing pane without replaying the ID', async () => {
  const { getRuntime } = await import('../lib/agent-runtime')
  const exists = vi.mocked(getRuntime().sessionExists)
  exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const work = service.sendTeamMessage(team.id, 'grok-3', 'reconnect', 'codex-1', 'reconnect')
  await vi.advanceTimersByTimeAsync(2000)
  expect((await work).data?.message.delivery?.[0].status).toBe('delivered')
  exists.mockResolvedValue(false)
  const unavailable = service.sendTeamMessage(team.id, 'grok-3', 'missing', 'codex-1', 'missing')
  await vi.advanceTimersByTimeAsync(2000)
  expect((await unavailable).data?.message.delivery?.[0].status).toBe('failed')
  exists.mockResolvedValue(true)
  await service.sendTeamMessage(team.id, 'grok-3', 'missing', 'codex-1', 'missing')
  expect(ui.queued).toHaveLength(1)
})
