/**
 * Agent Spawner — Standalone agent lifecycle management for Ensemble
 * Replaces ai-maestro's agent-registry + agents-core-service with a minimal implementation.
 * Handles: tmux session creation, program launching, and session cleanup.
 */

import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { checkCodexLaunch, resolveExecutable } from './agent-preflight'
import { getRuntime } from './agent-runtime'
import { isShellCommand } from './startup-gates'
import { getSelfHostId } from './hosts-config'
import { buildAgentCommandParts, buildAgentEnvironment, resolveAgentProgram, shellEscape } from './agent-config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

export interface SpawnedAgent {
  id: string
  name: string
  program: string
  sessionName: string
  workingDirectory: string
  hostId: string
}

interface PreparedAgent {
  command: string[]
  env: Record<string, string>
}

interface SpawnAgentOptions {
  name: string
  program: string
  workingDirectory: string
  hostId?: string
  prepared?: PreparedAgent
}

/** Compute tmux session name from agent name */
function computeSessionName(agentName: string): string {
  return agentName.replace(/[^a-zA-Z0-9\-_.]/g, '')
}

/** Resolve program name to CLI command, adding runtime flags for cwd handling */
export function resolveStartCommand(program: string, cwd: string): string[] {
  const parts = buildAgentCommandParts(program)
  const normalized = program.toLowerCase()

  if (
    normalized.includes('codex')
    && !parts.some(p => p === '-C' || p === '--cd' || p.startsWith('--cd='))
  ) {
    parts.push('--cd', cwd)
  }

  if (
    normalized.includes('claude')
    && cwd !== REPO_ROOT
    && !parts.some(p => p === '--add-dir' || p.startsWith('--add-dir='))
  ) {
    parts.push('--add-dir', REPO_ROOT)
  }

  return parts
}

export async function prepareLocalAgent(program: string, cwd: string): Promise<PreparedAgent> {
  const env = buildAgentEnvironment(program)
  const command = resolveStartCommand(program, cwd)
  command[0] = resolveExecutable(command[0], env.PATH, cwd)
  if (program.toLowerCase().includes('codex')) {
    const description = await checkCodexLaunch(command, env, cwd)
    console.log(`[Spawner] Codex preflight passed: ${description}`)
  }
  return { command, env }
}

/**
 * Spawn a local agent: create tmux session + start the AI program
 */
export async function spawnLocalAgent(options: SpawnAgentOptions): Promise<SpawnedAgent> {
  const runtime = getRuntime()
  const agentId = uuidv4()
  const sessionName = computeSessionName(options.name)
  const cwd = options.workingDirectory || process.cwd()
  const hostId = options.hostId || getSelfHostId()

  const { env, command: startCommand } = options.prepared ?? await prepareLocalAgent(options.program, cwd)
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-launch-'))
  const launchFile = path.join(launchDir, 'start')
  let started = false
  try {
    const entries = Object.entries(env).map(([key, value]) => `export ${key}=${shellEscape(value)}`)
    fs.writeFileSync(launchFile, [...entries, 'exec 3<&-', `exec ${startCommand.map(shellEscape).join(' ')}`, ''].join('\n'), { mode: 0o600 })
    // Open the private file before unlinking it. The pane command line contains
    // only the file path, and exec leaves no interactive shell after CLI exit.
    await runtime.createSession(sessionName, cwd, [
      '/bin/sh', '-c',
      'exec 3< "$1" || exit 1; /bin/rm -f -- "$1"; /bin/rmdir -- "$2"; exec /usr/bin/env -i TERM="${TERM:-xterm-256color}" /bin/sh /dev/fd/3',
      'ensemble-launch', launchFile, launchDir,
    ])
    started = true
  } finally {
    if (!started) fs.rmSync(launchDir, { recursive: true, force: true })
    else {
      const cleanup = setTimeout(() => fs.rmSync(launchDir, { recursive: true, force: true }), 30_000)
      cleanup.unref()
    }
  }

  console.log(`[Spawner] Agent ${options.name} started in tmux session ${sessionName}`)

  return {
    id: agentId,
    name: options.name,
    program: options.program,
    sessionName,
    workingDirectory: cwd,
    hostId,
  }
}

/**
 * Kill a local agent's tmux session
 */
export async function killLocalAgent(sessionName: string): Promise<void> {
  const runtime = getRuntime()
  try { await runtime.killSession(sessionName) } catch { /* Session may already be gone. */ }
}

/**
 * Spawn a remote agent via Maestro API on another machine
 */
export async function spawnRemoteAgent(
  hostUrl: string,
  agentName: string,
  program: string,
  cwd: string,
  taskDescription?: string,
  teamName?: string,
): Promise<{ id: string }> {
  // Create agent on remote host (15s timeout)
  const createCtrl = new AbortController()
  const createTimer = setTimeout(() => createCtrl.abort(), 15000)
  let createRes: Response
  try {
    createRes = await fetch(`${hostUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        program,
        workingDirectory: cwd,
        taskDescription,
        team: teamName,
      }),
      signal: createCtrl.signal,
    })
  } finally {
    clearTimeout(createTimer)
  }

  if (!createRes.ok) {
    throw new Error(`Remote agent create failed: HTTP ${createRes.status}`)
  }

  const { agent } = await createRes.json()

  // Wake agent on remote host (15s timeout)
  const wakeCtrl = new AbortController()
  const wakeTimer = setTimeout(() => wakeCtrl.abort(), 15000)
  try {
    const wakeRes = await fetch(`${hostUrl}/api/agents/${agent.id}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startProgram: true, sessionIndex: 0 }),
      signal: wakeCtrl.signal,
    })
    if (!wakeRes.ok) {
      throw new Error(`Remote agent wake failed: HTTP ${wakeRes.status}`)
    }
  } finally {
    clearTimeout(wakeTimer)
  }

  return { id: agent.id }
}

/**
 * Kill a remote agent via Maestro API
 */
export async function killRemoteAgent(hostUrl: string, agentId: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    await fetch(`${hostUrl}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killSession: true }),
      signal: ctrl.signal,
    })
  } catch { /* non-fatal */ }
  finally { clearTimeout(timer) }
}

/**
 * Send command to a remote agent's session
 */
export async function postRemoteSessionCommand(
  hostUrl: string,
  sessionName: string,
  command: string,
): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, requireIdle: true, addNewline: true }),
      signal: ctrl.signal,
    })
    if (!response.ok) {
      throw new Error(`Remote session command failed: HTTP ${response.status}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Scrape token usage from an agent's tmux pane output.
 * Best-effort: returns 'unknown' if parsing fails.
 *
 * Claude Code patterns: "NNk tokens", "NN,NNN tokens", "NNN tokens"
 * Codex patterns: "NN% left", "NNk tokens"
 */
export async function getAgentTokenUsage(sessionName: string): Promise<string> {
  try {
    const runtime = getRuntime()
    const output = await runtime.capturePane(sessionName, 100)

    // Claude Code: "123k tokens" or "12,345 tokens" or "1.2k tokens"
    const claudeKMatch = output.match(/(\d+(?:\.\d+)?k)\s*tokens/i)
    if (claudeKMatch) return `~${claudeKMatch[1]} tokens`

    const claudeFullMatch = output.match(/([\d,]+)\s*tokens/i)
    if (claudeFullMatch) return `~${claudeFullMatch[1]} tokens`

    // Codex: "NN% left"
    const codexPctMatch = output.match(/(\d+)%\s*left/i)
    if (codexPctMatch) return `${codexPctMatch[1]}% budget left`

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a remote session exists and is ready
 */
export async function isRemoteSessionReady(hostUrl: string, sessionName: string, readyMarker?: string): Promise<boolean | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const response = await fetch(`${hostUrl}/api/sessions/${encodeURIComponent(sessionName)}/command`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (response.status === 404) return false
    if (!response.ok) return undefined
    const body = await response.json().catch(() => null)
    if (typeof body?.exists !== 'boolean' || !body.exists || readyMarker === undefined) return body?.exists === false ? false : body?.exists === true ? true : undefined
    const foreground = body.foregroundCommand
    return typeof foreground === 'string' && !!foreground && !isShellCommand(foreground) &&
      (body.ready === true || (typeof body.output === 'string' && body.output.includes(readyMarker)))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
