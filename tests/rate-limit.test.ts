import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { promisify } from 'util'
import { forwardedClientIp, normalizeIp } from '../lib/ip-address'
import { execFile, spawnSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// server.ts had `path.startsWith('/api/ensemble/')` as its rate-limit
// exemption, which matches every route this server has: the limit of 100
// per minuut was volledig dode code. De vervangende uitzondering moet alleen
// de routes vrijstellen die pollers echt raken. Dat bleek breder te zijn dan
// alleen de feed-route: cli/monitor.ts poll elke 2s zowel de feed als het
// kale team-detail-endpoint (GET /api/ensemble/teams/:id), en met meer dan
// één open monitor (heel normaal bij meerdere gelijktijdige teams) loopt dat
// samen ruim over de 100/min heen, allemaal vanaf hetzelfde lokale IP.
// collab-poller.sh raakt de feed-route zelf niet: die leest messages.jsonl
// rechtstreeks van schijf en pingt maar één keer per minuut het team-detail-
// endpoint. team-read.sh raakt wel de feed-route, op het tempo van de agent.

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve a test port'))
        return
      }
      const { port } = address
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

async function waitForHealthy(baseUrl: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`)
      if (response.ok) return
    } catch {
      // Server may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Server did not become healthy at ${baseUrl}`)
}

describe('rate limiting', () => {
  const originalEnv = { ...process.env }
  const token = 'an-isolated-test-bearer-with-32-chars'
  const runtime = {
    getForegroundCommand: vi.fn(async () => 'agent'),
    capturePane: vi.fn(async () => '>'),
    sendKeys: vi.fn(async () => {}),
    pasteFromFile: vi.fn(async () => {}),
    createSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
  }

  let tempRoot: string
  let port: number
  let baseUrl: string
  let teamId: string
  const agentEnvironments: Record<string, Record<string, string>> = {}
  const operatorHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ratelimit-'))
    port = await getFreePort()
    baseUrl = `http://127.0.0.1:${port}`

    process.env.ENSEMBLE_DATA_DIR = tempRoot
    process.env.ENSEMBLE_PORT = String(port)
    process.env.ENSEMBLE_HOST = '0.0.0.0'
    process.env.ENSEMBLE_ALLOW_EXTERNAL = '1'
    process.env.ENSEMBLE_API_TOKEN = token
    process.env.ENSEMBLE_TRUSTED_PROXIES = '0000:0000:0000:0000:0000:ffff:7f00:0001'
    process.env.COLLAB_RUNTIME_ROOT = path.join(tempRoot, 'runtime')
    process.env.ENSEMBLE_URL = baseUrl

    vi.resetModules()
    vi.doMock('../lib/agent-spawner', () => ({
      prepareLocalAgent: vi.fn(async () => undefined),
      spawnLocalAgent: vi.fn(async ({ name, program, workingDirectory, hostId, agentEnvironment }) => {
        agentEnvironments[name] = agentEnvironment
        return { id: `${name}-id`, name, program, sessionName: name, workingDirectory, hostId }
      }),
      killLocalAgent: vi.fn(async () => {}),
      spawnRemoteAgent: vi.fn(async () => ({ id: 'remote-agent-id' })),
      killRemoteAgent: vi.fn(async () => {}),
      postRemoteSessionCommand: vi.fn(async () => {}),
      isRemoteSessionReady: vi.fn(async () => true),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => runtime),
    }))
    vi.doMock('../lib/agent-config', () => ({
      shellEscape: (value: string) => value,
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
      resolveAgentProgramDetailed: vi.fn((program: string) => ({
        agent: { command: program, readyMarker: '>', inputMethod: 'sendKeys' },
        how: 'exact',
        requested: program,
      })),
      availableAgentKeys: vi.fn(() => ['claude', 'codex']),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(() => ({ id: 'local', url: baseUrl })),
      getSelfHostId: vi.fn(() => 'local'),
    }))

    await import('../server')
    await waitForHealthy(baseUrl)

    const createRes = await fetch(`${baseUrl}/api/ensemble/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'rate-limit-team',
        description: 'test',
        agents: [{ program: 'codex', role: 'lead' }, { program: 'claude', role: 'worker' }, { program: 'grok', role: 'worker' }],
        workingDirectory: process.cwd(),
      }),
    })
    const created = await createRes.json()
    teamId = created.team.id
  })

  afterAll(async () => {
    process.env = originalEnv
    fs.rmSync(tempRoot, { recursive: true, force: true })
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('rejects unauthenticated create, message and stop requests', async () => {
    for (const [method, target] of [
      ['POST', '/api/ensemble/teams'],
      ['POST', `/api/ensemble/teams/${teamId}`],
      ['POST', `/api/ensemble/teams/${teamId}/disband`],
      ['DELETE', `/api/ensemble/teams/${teamId}`],
    ]) {
      const result = await fetch(baseUrl + target, { method, headers: { 'X-Forwarded-For': '127.0.0.1' } })
      expect(result.status).toBe(401)
      expect(await result.text()).not.toContain(token)
    }
  })

  it('binds an agent key to one inbox and denies operator actions and claimed Lead identity', async () => {
    const worker = agentEnvironments['rate-limit-team-claude-2']
    const header = { 'Content-Type': 'application/json', Authorization: `Bearer ${worker.ENSEMBLE_AGENT_TOKEN}` }
    const operatorPost = async (to: string, content: string, id: string) => fetch(`${baseUrl}/api/ensemble/teams/${teamId}`, {
      method: 'POST', headers: operatorHeaders, body: JSON.stringify({ to, content, id }),
    })
    expect(worker.ENSEMBLE_AGENT_URL).toBe(baseUrl)
    expect(worker).not.toHaveProperty('ENSEMBLE_API_TOKEN')
    expect((await operatorPost('claude-2', 'worker only', 'worker-mail')).status).toBe(200)
    expect((await operatorPost('codex-1', 'lead only', 'lead-mail')).status).toBe(200)
    const inbox = `${baseUrl}/api/ensemble/teams/${teamId}/feed?recipient=codex-1`
    expect((await fetch(inbox)).status).toBe(401)
    const fed = await fetch(inbox, { headers: header })
    const messages = (await fed.json()).messages
    expect(fed.status).toBe(200)
    expect(messages.map((message: { id: string }) => message.id)).toEqual(['worker-mail'])
    for (const action of ['plan', 'accept', 'close']) {
      const result = await fetch(`${baseUrl}/api/ensemble/teams/${teamId}`, {
        method: 'POST', headers: header, body: JSON.stringify({ from: 'codex-1', content: '<<COLLAB_EVENT>> ' + JSON.stringify({ action }) }),
      })
      expect(result.status).toBe(403)
    }
    for (const [method, target] of [
      ['POST', '/api/ensemble/teams'], ['POST', `/api/ensemble/teams/${teamId}/disband`],
      ['DELETE', `/api/ensemble/teams/${teamId}`],
      ['GET', '/api/ensemble/teams/another-team/feed'],
    ]) {
      expect((await fetch(baseUrl + target, { method, headers: header })).status).toBe(401)
    }
  })

  it('replays the same ID after a read without acknowledgement and hides it after --ack', async () => {
    const route = `${baseUrl}/api/ensemble/teams/${teamId}`
    const payload = JSON.stringify({ id: 'explicit-ack', to: 'claude-2', content: 'Process at a safe point' })
    const post = () => fetch(route, { method: 'POST', headers: operatorHeaders, body: payload })
    expect((await post()).status).toBe(200)
    const read = (args: string[] = []) => promisify(execFile)(path.resolve('scripts/team-read.sh'), [teamId, 'claude-2', ...args], {
      env: { ...process.env, ...agentEnvironments['rate-limit-team-claude-2'], ENSEMBLE_API_TOKEN: '' },
      timeout: 5000,
    })
    expect((await read()).stdout).toContain('[explicit-ack]')
    expect((await read()).stdout).toContain('[explicit-ack]')
    await read(['--ack', 'explicit-ack'])
    expect((await read()).stdout).not.toContain('[explicit-ack]')
    const replay = await post()
    expect((await replay.json()).message.delivery[0].status).toBe('delivered')
  })

  it('accepts and acknowledges a boundary ID and rejects longer or empty IDs before enqueueing', async () => {
    const route = `${baseUrl}/api/ensemble/teams/${teamId}`
    const post = (id: string) => fetch(route, {
      method: 'POST', headers: operatorHeaders, body: JSON.stringify({ id, to: 'claude-2', content: 'Boundary message' }),
    })
    expect((await post('x'.repeat(257))).status).toBe(400)
    expect((await post('')).status).toBe(400)
    const id = 'x'.repeat(256)
    expect((await post(id)).status).toBe(200)
    const ack = await fetch(route, {
      method: 'POST', headers: { ...operatorHeaders, Authorization:
        `Bearer ${agentEnvironments['rate-limit-team-claude-2'].ENSEMBLE_AGENT_TOKEN}` },
      body: JSON.stringify({ to: 'ensemble', content: '<<COLLAB_RECEIVED>> ' + JSON.stringify([id]) }),
    })
    expect(ack.status).toBe(200)
    expect((await (await post(id)).json()).message.delivery[0].status).toBe('delivered')
    const inbox = (await (await fetch(route + '/feed', { headers: operatorHeaders })).json()).messages
    expect(inbox.some((message: { id: string }) => message.id === 'x'.repeat(257))).toBe(false)
  })

  it('queues 100 authenticated messages while keeping the operator IP budget separate', async () => {
    const route = `${baseUrl}/api/ensemble/teams/${teamId}`
    const credentials = (agent: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentEnvironments[`rate-limit-team-${agent}`].ENSEMBLE_AGENT_TOKEN}`,
    })
    const send = (index: number) => fetch(route, {
      method: 'POST', headers: credentials(index % 2 ? 'claude-2' : 'codex-1'),
      body: JSON.stringify({ id: `concurrent-${index}`, to: 'grok-3', content: `message ${index}` }),
    })
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => send(index)))
    expect(responses.every(response => response.ok)).toBe(true)
    expect((await send(1)).ok).toBe(true)
    const read = async () => {
      const response = await fetch(route + '/feed', { headers: credentials('grok-3') })
      expect(response.ok).toBe(true)
      return (await response.json()).messages.map((message: { id: string }) => message.id)
    }
    const order = await read()
    expect(new Set(order).size).toBe(100)
    expect(await read()).toEqual(order)
  })

  it('feed en team-detail blijven vrij, de lijst-route niet', async () => {
    // Ruim over de 100/min: precies wat twee open monitors + een agent die
    // team-read.sh draait, samen op hetzelfde lokale IP produceren.
    let pollersRateLimited = false
    for (let i = 0; i < 110; i++) {
      const [feedRes, teamRes] = await Promise.all([
        fetch(`${baseUrl}/api/ensemble/teams/${teamId}/feed`, { headers: operatorHeaders }),
        fetch(`${baseUrl}/api/ensemble/teams/${teamId}`, { headers: operatorHeaders }),
      ])
      if (feedRes.status === 429 || teamRes.status === 429) pollersRateLimited = true
    }
    expect(pollersRateLimited, 'feed en team-detail zijn poll-doelen en moeten vrij blijven').toBe(false)

    // De lijst-route is geen poll-doel (alleen `ensemble team list` en de
    // team-picker raken hem, eenmalig) en moet dus wél gelimiteerd blijven.
    let listRateLimited = false
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${baseUrl}/api/ensemble/teams`, { headers: { ...operatorHeaders, 'X-Forwarded-For': `192.0.2.${i + 1}, 198.51.100.11` } })
      if (res.status === 429) { listRateLimited = true; break }
    }
    expect(listRateLimited, 'de lijst-route moet na 100 GETs alsnog een 429 geven').toBe(true)
  })
})

it('refuses external bind without both opt-in and a token', () => {
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ENSEMBLE_HOST: '0.0.0.0', ENSEMBLE_ALLOW_EXTERNAL: '1', ENSEMBLE_API_TOKEN: '' },
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('External bind requires')
})

it('canonicalizes IPv6 proxy hops before comparing the forwarded chain', () => {
  const trusted = new Set(['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::2'].map(normalizeIp))
  expect(forwardedClientIp('2001:db8::1', '192.0.2.27, 2001:db8:0:0:0:0:0:2', trusted)).toBe('192.0.2.27')
  expect(forwardedClientIp('2001:db8::3', '192.0.2.27', trusted)).toBe('2001:db8::3')
  expect(normalizeIp('::ffff:7f00:1')).toBe('127.0.0.1')
})
