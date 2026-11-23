/**
 * Agent Runtime Abstraction
 *
 * Consolidates ALL tmux operations behind a single TmuxRuntime class
 * implementing the AgentRuntime interface. Future runtimes (Docker, API-only,
 * direct-process) can be plugged in without touching business logic.
 *
 * Phase 4 of the service-layer refactoring.
 */

import { exec, execFile, execFileSync as nodeExecFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

import { isShellCommand } from './startup-gates'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DiscoveredSession {
  name: string
  windows: number
  createdAt: string
  workingDirectory: string
}

export interface AgentRuntime {
  readonly type: 'tmux' | 'happy' | 'docker' | 'api' | 'direct'

  // Discovery
  listSessions(): Promise<DiscoveredSession[]>

  // Existence / status
  sessionExists(name: string): Promise<boolean>
  getWorkingDirectory(name: string): Promise<string>
  isInCopyMode(name: string): Promise<boolean>
  cancelCopyMode(name: string): Promise<void>

  // Lifecycle
  createSession(name: string, cwd: string, command?: string[]): Promise<void>
  killSession(name: string): Promise<void>
  renameSession(oldName: string, newName: string): Promise<void>

  // I/O
  sendKeys(name: string, keys: string, opts?: { literal?: boolean; enter?: boolean; agentInput?: boolean }): Promise<void>
  pasteFromFile(name: string, filePath: string, opts?: { enterCount?: 1 | 2 }): Promise<void>
  capturePane(name: string, lines?: number): Promise<string>
  /** Name of the process in the pane's foreground ('' when unknown). */
  getForegroundCommand?(name: string): Promise<string>

  // Environment
  setEnvironment(name: string, key: string, value: string): Promise<void>
  unsetEnvironment(name: string, key: string): Promise<void>

  // PTY (returns spawn args for node-pty -- runtime doesn't own the PTY)
  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] }
}

// ---------------------------------------------------------------------------
// Shell guard
// ---------------------------------------------------------------------------

export { isShellCommand }

/**
 * Agent input (prompts, team messages, nudges) landed in a bare shell when the
 * agent CLI had exited: the shell then parsed it as a command, and one
 * apostrophe left the pane stuck on `quote>`. Such input is refused instead.
 */
export class AgentNotRunningError extends Error {
  constructor(sessionName: string, command: string) {
    super(`${sessionName}: no agent running (shell '${command}' in foreground), input not delivered`)
    this.name = 'AgentNotRunningError'
  }
}

// ---------------------------------------------------------------------------
// TmuxRuntime
// ---------------------------------------------------------------------------

export class TmuxRuntime implements AgentRuntime {
  readonly type: AgentRuntime['type'] = 'tmux'

  /** Sanitize a tmux session/buffer name to prevent command injection */
  private sanitizeName(name: string): string {
    // Only allow alphanumeric, hyphens, underscores, dots
    const sanitized = name.replace(/[^a-zA-Z0-9\-_.]/g, '')
    if (!sanitized) throw new Error(`Invalid tmux name after sanitization: "${name}"`)
    return sanitized
  }

  // -- Discovery -----------------------------------------------------------

  async listSessions(): Promise<DiscoveredSession[]> {
    try {
      const { stdout } = await execAsync('tmux list-sessions 2>/dev/null || echo ""')
      if (!stdout.trim()) return []

      const lines = stdout.trim().split('\n')
      const results: DiscoveredSession[] = []

      for (const line of lines) {
        const match = line.match(/^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)/)
        if (!match) continue

        const [, name, windows, createdStr] = match
        const normalizedDate = createdStr.trim().replace(/\s+/g, ' ')

        let createdAt: string
        try {
          const parsedDate = new Date(normalizedDate)
          createdAt = isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString()
        } catch {
          createdAt = new Date().toISOString()
        }

        let workingDirectory = ''
        try {
          const sName = this.sanitizeName(name)
          const { stdout: cwdOutput } = await execAsync(
            `tmux display-message -t "${sName}" -p "#{pane_current_path}" 2>/dev/null || echo ""`
          )
          workingDirectory = cwdOutput.trim()
        } catch {
          workingDirectory = ''
        }

        results.push({
          name,
          windows: parseInt(windows, 10),
          createdAt,
          workingDirectory,
        })
      }

      return results
    } catch {
      return []
    }
  }

  // -- Existence / status --------------------------------------------------

  async sessionExists(name: string): Promise<boolean> {
    try {
      const sName = this.sanitizeName(name)
      await execAsync(`tmux has-session -t "=${sName}" 2>/dev/null`)
      return true
    } catch {
      return false
    }
  }

  async getWorkingDirectory(name: string): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execAsync(
        `tmux display-message -t "${sName}" -p "#{pane_current_path}" 2>/dev/null || echo ""`
      )
      return stdout.trim()
    } catch {
      return ''
    }
  }

  async isInCopyMode(name: string): Promise<boolean> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execAsync(
        `tmux display-message -t "${sName}" -p "#{pane_in_mode}"`
      )
      return stdout.trim() === '1'
    } catch {
      return false
    }
  }

  async cancelCopyMode(name: string): Promise<void> {
    try {
      const inCopyMode = await this.isInCopyMode(name)
      if (inCopyMode) {
        const sName = this.sanitizeName(name)
        await execAsync(`tmux send-keys -t "${sName}" q`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    } catch {
      // Ignore
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  async createSession(name: string, cwd: string, command: string[] = []): Promise<void> {
    const sName = this.sanitizeName(name)
    // A new tmux server inherits the client's environment. Keep service
    // credentials out of its global environment as well as the pane command.
    const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMUX', 'TMUX_TMPDIR', 'XDG_RUNTIME_DIR']
    const env = Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
    await execFileAsync('tmux', ['new-session', '-d', '-s', sName, '-c', cwd, ...command], { env })
  }

  async killSession(name: string): Promise<void> {
    const sName = this.sanitizeName(name)
    await execAsync(`tmux kill-session -t "=${sName}"`)
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const sOld = this.sanitizeName(oldName)
    const sNew = this.sanitizeName(newName)
    await execAsync(`tmux rename-session -t "${sOld}" "${sNew}"`)
  }

  // -- I/O -----------------------------------------------------------------

  async sendKeys(
    name: string,
    keys: string,
    opts: { literal?: boolean; enter?: boolean; agentInput?: boolean } = {}
  ): Promise<void> {
    const sName = this.sanitizeName(name)
    const { literal = false, enter = false, agentInput = false } = opts
    if (agentInput) await this.assertAgentInForeground(name)

    if (literal) {
      const escaped = keys.replace(/'/g, "'\\''")
      if (enter) {
        await execAsync(
          `tmux send-keys -t "${sName}" -l '${escaped}' \\; send-keys -t "${sName}" C-m`
        )
      } else {
        await execAsync(`tmux send-keys -t "${sName}" -l '${escaped}'`)
      }
    } else {
      // Non-literal: keys is a raw key sequence (e.g. "C-c", "exit Enter")
      // Validate that keys only contain safe tmux key names (alphanumeric, hyphens, spaces)
      if (!/^[a-zA-Z0-9\-_ "]+$/.test(keys)) {
        throw new Error(`Unsafe tmux key sequence rejected: ${keys.slice(0, 50)}`)
      }
      if (enter) {
        await execAsync(`tmux send-keys -t "${sName}" ${keys} C-m`)
      } else {
        await execAsync(`tmux send-keys -t "${sName}" ${keys}`)
      }
    }
  }

  /** Retry buffer loads only. After a paste attempt the input may already exist. */
  async pasteFromFile(name: string, filePath: string, opts: { enterCount?: 1 | 2 } = {}): Promise<void> {
    const target = this.sanitizeName(name)
    await this.assertAgentInForeground(name)
    const buffer = `orch-${randomUUID()}`
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await execFileAsync('tmux', ['load-buffer', '-b', buffer, filePath])
          break
        } catch (error) {
          if (attempt === 2) throw error
          await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt))
        }
      }
      await this.assertAgentInForeground(name)
      await execFileAsync('tmux', ['paste-buffer', '-p', '-b', buffer, '-t', target])
    } finally {
      await execFileAsync('tmux', ['delete-buffer', '-b', buffer]).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    for (let enter = 0; enter < (opts.enterCount ?? 2); enter++) {
      if (enter) await new Promise(resolve => setTimeout(resolve, 300))
      await this.assertAgentInForeground(name)
      await execFileAsync('tmux', ['send-keys', '-t', target, 'Enter'])
    }
  }

  async getForegroundCommand(name: string): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const { stdout } = await execAsync(
        `tmux display-message -t "${sName}" -p "#{pane_current_command}" 2>/dev/null || echo ""`
      )
      return stdout.trim()
    } catch {
      return ''
    }
  }

  private async assertAgentInForeground(name: string): Promise<void> {
    if (!await this.sessionExists(name)) throw new AgentNotRunningError(name, 'session unavailable')
    const command = await this.getForegroundCommand(name)
    if (!command || isShellCommand(command)) throw new AgentNotRunningError(name, command)
  }

  async capturePane(name: string, lines: number = 2000): Promise<string> {
    try {
      const sName = this.sanitizeName(name)
      const sLines = Math.max(1, Math.min(10000, Math.floor(lines)))
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${sName}" -p -S -${sLines} 2>/dev/null || tmux capture-pane -t "${sName}" -p`,
        { encoding: 'utf8', timeout: 3000, shell: '/bin/bash' }
      )
      return stdout
    } catch {
      return ''
    }
  }

  // -- Environment ---------------------------------------------------------

  async setEnvironment(name: string, key: string, value: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const sKey = key.replace(/[^a-zA-Z0-9_]/g, '')
    const sValue = value.replace(/'/g, "'\\''")
    await execAsync(`tmux set-environment -t "${sName}" ${sKey} '${sValue}'`)
  }

  async unsetEnvironment(name: string, key: string): Promise<void> {
    const sName = this.sanitizeName(name)
    const sKey = key.replace(/[^a-zA-Z0-9_]/g, '')
    await execAsync(`tmux set-environment -t "${sName}" -r ${sKey} 2>/dev/null || true`)
  }

  // -- PTY -----------------------------------------------------------------

  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] } {
    if (socketPath) {
      return { command: 'tmux', args: ['-S', socketPath, 'attach-session', '-t', name] }
    }
    return { command: 'tmux', args: ['attach-session', '-t', name] }
  }
}

// ---------------------------------------------------------------------------
// Singleton + factory
// ---------------------------------------------------------------------------

let defaultRuntime: AgentRuntime = new TmuxRuntime()

export function getRuntime(): AgentRuntime {
  return defaultRuntime
}

export function setRuntime(r: AgentRuntime): void {
  defaultRuntime = r
}

// ---------------------------------------------------------------------------
// Sync helpers for lib/agent-registry.ts (uses execSync, can't be async)
// ---------------------------------------------------------------------------

function sanitizeNameSync(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9\-_.]/g, '')
  if (!sanitized) throw new Error(`Invalid tmux name after sanitization: "${name}"`)
  return sanitized
}

export function sessionExistsSync(name: string, socketPath?: string): boolean {
  try {
    const sName = sanitizeNameSync(name)
    const args = socketPath
      ? ['-S', socketPath, 'has-session', '-t', sName]
      : ['has-session', '-t', sName]
    nodeExecFileSync('tmux', args, { timeout: 2000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function killSessionSync(name: string): void {
  try {
    const sName = sanitizeNameSync(name)
    nodeExecFileSync('tmux', ['kill-session', '-t', sName], { encoding: 'utf-8', stdio: 'ignore' })
  } catch {
    // Session may not exist
  }
}

export function renameSessionSync(oldName: string, newName: string): void {
  const sOld = sanitizeNameSync(oldName)
  const sNew = sanitizeNameSync(newName)
  nodeExecFileSync('tmux', ['rename-session', '-t', sOld, sNew], { encoding: 'utf-8' })
}
