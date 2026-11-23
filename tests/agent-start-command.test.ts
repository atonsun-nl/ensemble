import { afterEach, expect, it, vi } from 'vitest'
import { resolveStartCommand } from '../lib/agent-spawner'
import { buildAgentEnvironment } from '../lib/agent-config'

afterEach(() => vi.unstubAllEnvs())

it('passes a quoted working directory as one argv item', () => {
  const cwd = "/tmp/path with spaces and a 'quote'"
  const command = resolveStartCommand('codex', cwd)
  expect(command.slice(-2)).toEqual(['--cd', cwd])
  expect(command).not.toContain('nocorrect')
})

it('excludes configured and inherited credentials named by unsetEnv', () => {
  vi.stubEnv('GEMINI_API_KEY', 'inherited')
  vi.stubEnv('GOOGLE_API_KEY', 'inherited')
  vi.stubEnv('CLAUDECODE', '1')
  vi.stubEnv('ENSEMBLE_API_TOKEN', 'must-not-reach-agents')
  const env = buildAgentEnvironment('agy')
  expect(env).not.toHaveProperty('GEMINI_API_KEY')
  expect(env).not.toHaveProperty('GOOGLE_API_KEY')
  expect(env).not.toHaveProperty('CLAUDECODE')
  expect(env).not.toHaveProperty('ENSEMBLE_API_TOKEN')
})
