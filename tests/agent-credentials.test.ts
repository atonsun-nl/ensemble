import fs from 'fs'
import http from 'http'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { issueAgentEnvironment, authenticateAgent } from '../lib/agent-credentials'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-credentials-'))
  vi.stubEnv('ENSEMBLE_DATA_DIR', root)
  vi.stubEnv('ENSEMBLE_AGENT_URL', '')
  vi.stubEnv('ENSEMBLE_URL', '')
  vi.stubEnv('ENSEMBLE_PORT', '23000')
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['::1', '0:0:0:0:0:0:0:1', '::', '0:0:0:0:0:0:0:0'])('uses IPv6 loopback for bind %s', bind => {
  vi.stubEnv('ENSEMBLE_HOST', bind)
  const environment = issueAgentEnvironment('team', 'lead')
  expect(environment.ENSEMBLE_AGENT_URL).toBe('http://[::1]:23000')
  expect(authenticateAgent('team', 'Bearer ' + environment.ENSEMBLE_AGENT_TOKEN)).toBe('lead')
})
it('uses a specific IPv6 bind address when the listener is not on loopback', () => {
  vi.stubEnv('ENSEMBLE_HOST', '2001:0db8:0000:0000:0000:0000:0000:0001')
  expect(issueAgentEnvironment('team', 'lead').ENSEMBLE_AGENT_URL).toBe('http://[2001:db8::1]:23000')
})
it('retains explicit agent and operator URL precedence', () => {
  vi.stubEnv('ENSEMBLE_HOST', '::1')
  vi.stubEnv('ENSEMBLE_URL', 'https://operator.example')
  expect(issueAgentEnvironment('team', 'lead').ENSEMBLE_AGENT_URL).toBe('https://operator.example')
  vi.stubEnv('ENSEMBLE_AGENT_URL', 'https://agents.example')
  expect(issueAgentEnvironment('team', 'lead').ENSEMBLE_AGENT_URL).toBe('https://agents.example')
})
it('uses IPv4 loopback for an IPv4 wildcard bind', () => {
  vi.stubEnv('ENSEMBLE_HOST', '0.0.0.0')
  expect(issueAgentEnvironment('team', 'lead').ENSEMBLE_AGENT_URL).toBe('http://127.0.0.1:23000')
})

it('lets team-say reach an IPv6-only listener using the default agent URL', async () => {
  vi.stubEnv('ENSEMBLE_HOST', '0:0:0:0:0:0:0:1')
  const requests: string[] = []
  const server = http.createServer((request, response) => {
    requests.push(request.url!)
    expect(request.headers.authorization).toBe('Bearer ' + environment.ENSEMBLE_AGENT_TOKEN)
    request.resume()
    request.on('end', () => { response.writeHead(200); response.end('{}') })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '::1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('IPv6 listener did not return a port')
  vi.stubEnv('ENSEMBLE_PORT', String(address.port))
  const environment = issueAgentEnvironment('ipv6-team', 'lead')
  try {
    const result = await promisify(execFile)(path.resolve('scripts/team-say.sh'),
      ['ipv6-team', 'lead', 'team', '<<COLLAB_EVENT>> {"action":"plan","plan":"IPv6 ready"}'], {
        env: { ...process.env, ...environment, COLLAB_RUNTIME_ROOT: root }, timeout: 5000,
      })
    expect(result.stdout).toContain('Sent to team')
    expect(requests).toEqual(['/api/ensemble/teams/ipv6-team'])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
