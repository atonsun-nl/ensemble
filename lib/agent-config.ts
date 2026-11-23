/**
 * Agent Config Loader — reads agents.json and provides lookup helpers.
 * Single source of truth for agent-specific behavior across spawner, ensemble, and monitor.
 */

import fs from 'fs'
import { readEnsembleConfig } from './ensemble-config'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentProgram, AgentsConfig } from '../types/agent-program'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let _cache: AgentsConfig | null = null
let _cacheMtimeMs = 0
let _cachePath = ''

function agentsConfigPath(): string {
  return process.env['ENSEMBLE_AGENTS_CONFIG'] || path.join(__dirname, '..', 'agents.json')
}

/**
 * Load agents.json, re-reading it whenever the file changed on disk.
 *
 * It used to be cached for the lifetime of the process, which meant adding an
 * agent did nothing until the service was restarted, without any warning: the
 * unknown name then quietly fell back to claude, so you got a second claude
 * under a different name. Cost on 2026-08-14: a full "successful" smoke test
 * that proved nothing, because the agent under test was never actually running.
 * A stat() per call is cheap enough to not need cleverness here.
 */
export function loadAgentsConfig(): AgentsConfig {
  const configPath = agentsConfigPath()
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs
  } catch {
    // Unreadable now: keep serving the last good config rather than crashing.
    if (_cache) return _cache
  }

  if (_cache && configPath === _cachePath && mtimeMs === _cacheMtimeMs) return _cache

  const raw = fs.readFileSync(configPath, 'utf-8')
  const config = JSON.parse(raw) as AgentsConfig
  for (const [key, agent] of Object.entries(config)) {
    if (agent.pasteEnterCount !== undefined && agent.pasteEnterCount !== 1 && agent.pasteEnterCount !== 2) {
      throw new Error(`Invalid pasteEnterCount for agent "${key}": expected 1 or 2`)
    }
    if (agent.unsetEnv !== undefined && (
      !Array.isArray(agent.unsetEnv)
      || !agent.unsetEnv.every(name => typeof name === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(name) && !/[\r\n]/.test(name))
    )) {
      throw new Error(`Invalid unsetEnv for agent "${key}": expected uppercase environment variable names`)
    }
  }
  _cache = config
  _cacheMtimeMs = mtimeMs
  _cachePath = configPath
  return _cache
}

/** Clear cached config (useful for tests) */
export function clearAgentsConfigCache(): void {
  _cache = null
  _cacheMtimeMs = 0
  _cachePath = ''
}

/** Agent keys that actually exist, for error messages and pickers. */
export function availableAgentKeys(): string[] {
  return Object.keys(loadAgentsConfig())
}

/** Thrown when an explicitly requested agent does not exist. */
export class UnknownAgentError extends Error {
  constructor(public readonly requested: string, public readonly available: string[]) {
    super(`Unknown agent "${requested}". Available: ${available.join(', ')}`)
    this.name = 'UnknownAgentError'
  }
}

export interface AgentResolution {
  agent: AgentProgram
  /** 'exact' and 'substring' are real matches; 'fallback' means we guessed. */
  how: 'exact' | 'substring' | 'fallback'
  requested: string
}

/**
 * Resolve a program string to its AgentProgram, and say HOW it was resolved.
 *
 * The 'fallback' case is the dangerous one: an unknown name silently became
 * claude, so a team meant to hold four independent models could hold two
 * identical ones. For a user who runs collab mainly to have claims verified,
 * that quietly destroys the whole point, because a model then checks itself.
 * Callers decide what to do with it; nobody should have to guess.
 */
export function resolveAgentProgramDetailed(program: string): AgentResolution {
  const config = loadAgentsConfig()
  const p = program.toLowerCase()

  if (config[p]) return { agent: config[p], how: 'exact', requested: program }

  // Substring match (e.g. "claude code" matches "claude")
  for (const [key, agent] of Object.entries(config)) {
    if (p.includes(key)) return { agent, how: 'substring', requested: program }
  }

  const fallback = config['claude'] || {
    name: program,
    command: program.toLowerCase(),
    flags: [],
    readyMarker: '❯',
    inputMethod: 'sendKeys' as const,
    color: 'white',
    icon: '○',
  }
  return { agent: fallback, how: 'fallback', requested: program }
}

/**
 * Resolve a program string (e.g. "codex", "claude code", "claude-code") to its AgentProgram config.
 *
 * With `{ strict: true }` an unknown name throws UnknownAgentError instead of
 * quietly becoming claude. Use strict wherever the user named the agent.
 */
export function resolveAgentProgram(program: string, options: { strict?: boolean } = {}): AgentProgram {
  const resolved = resolveAgentProgramDetailed(program)
  if (options.strict && resolved.how === 'fallback') {
    throw new UnknownAgentError(program, availableAgentKeys())
  }
  return resolved.agent
}

export function shellEscape(token: string): string {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(token)
    ? token
    : `'${token.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the full CLI command for an agent as an array of unescaped tokens.
 * Preferred over buildAgentCommand when passing to execFile/spawn.
 */
export function buildAgentCommandParts(program: string): string[] {
  const agent = resolveAgentProgram(program)
  const envFlags = (process.env['ENSEMBLE_AGENT_FLAGS'] ?? '').trim()

  const envTokens = envFlags ? envFlags.split(/\s+/).filter(Boolean) : []
  const envFlagKeys = new Set(envTokens.filter(token => token.startsWith('-')))
  const defaultTokens: string[] = []

  for (let i = 0; i < agent.flags.length; i++) {
    const token = agent.flags[i]
    if (!token.startsWith('-')) {
      defaultTokens.push(token)
      continue
    }
    if (envFlagKeys.has(token)) {
      if (i + 1 < agent.flags.length && !agent.flags[i + 1].startsWith('-')) i++
      continue
    }
    defaultTokens.push(token)
    if (i + 1 < agent.flags.length && !agent.flags[i + 1].startsWith('-')) {
      defaultTokens.push(agent.flags[++i])
    }
  }

  return [agent.command, ...envTokens, ...defaultTokens]
}

/**
 * Build the full CLI command for an agent as a shell-escaped string.
 */
export function buildAgentCommand(program: string): string {
  return buildAgentCommandParts(program).map(shellEscape).join(' ')
}

const sharedEnvironment = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSH_AUTH_SOCK',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COLLAB_RUNTIME_ROOT', 'ENSEMBLE_URL',
])

export function buildAgentEnvironment(program: string): Record<string, string> {
  const agent = resolveAgentProgram(program)
  const provider = program.toLowerCase()
  const prefixes = [
    ...(provider.includes('codex') ? ['OPENAI_', 'CODEX_API_KEY'] : []),
    ...(/claude|glm/.test(provider) ? ['ANTHROPIC_', 'CLAUDE_CODE_OAUTH_'] : []),
    ...(/grok/.test(provider) ? ['XAI_', 'GROK_'] : []),
    ...(/agy|gemini/.test(provider) ? ['GOOGLE_', 'GEMINI_'] : []),
    'LC_',
  ]
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (sharedEnvironment.has(key) || prefixes.some(prefix => key.startsWith(prefix)))) {
      environment[key] = value
    }
  }
  Object.assign(environment, readEnsembleConfig().agentEnv)
  for (const key of ['CLAUDECODE', 'ENSEMBLE_API_TOKEN', ...(agent.unsetEnv ?? [])]) delete environment[key]
  return environment
}
