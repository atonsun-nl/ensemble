import fs from 'fs'
import path from 'path'
import { isIP } from 'net'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { normalizeIp } from './ip-address'
import { getEnsembleRegistryDir } from './ensemble-paths'

const digest = (value: string) => createHash('sha256').update(value).digest()

function credentialFile(teamId: string, agent: string): string {
  return path.join(getEnsembleRegistryDir(), 'agent-credentials', digest(teamId).toString('hex'), digest(agent).toString('hex'))
}

export function issueAgentEnvironment(teamId: string, agent: string): Record<string, string> {
  const secret = randomBytes(32).toString('base64url')
  const file = credentialFile(teamId, agent)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, digest(secret), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  const bind = normalizeIp(process.env.ENSEMBLE_HOST || '127.0.0.1')
  const localHost = isIP(bind) === 6 ? `[${bind === '::' ? '::1' : bind}]` : '127.0.0.1'
  return {
    ENSEMBLE_AGENT_TOKEN: `agent.${Buffer.from(agent).toString('base64url')}.${secret}`,
    ENSEMBLE_AGENT_URL: process.env.ENSEMBLE_AGENT_URL || process.env.ENSEMBLE_URL ||
      `http://${localHost}:${process.env.ENSEMBLE_PORT || process.env.ORCHESTRA_PORT || '23000'}`,
  }
}

export function authenticateAgent(teamId: string, authorization?: string): string | undefined {
  const match = authorization?.match(/^Bearer agent\.([a-zA-Z0-9_-]{1,256})\.([a-zA-Z0-9_-]{43})$/)
  if (!match) return
  const agent = Buffer.from(match[1], 'base64url').toString()
  try {
    const expected = fs.readFileSync(credentialFile(teamId, agent))
    if (expected.length === 32 && timingSafeEqual(expected, digest(match[2]))) return agent
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
