import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { expect, it, vi } from 'vitest'
import { spawnLocalAgent } from '../lib/agent-spawner'
import { getRuntime } from '../lib/agent-runtime'

const has = (binary: string) => {
  try { return execFileSync('/bin/sh', ['-c', 'command -v "$1"', '_', binary], { encoding: 'utf8' }).trim() }
  catch { return '' }
}
const realTmux = has('tmux')
const shells = ['bash', 'zsh'].filter(has)

it.skipIf(!realTmux).each(shells)('launches through tmux with %s configured and keeps credentials out of the pane', async shell => {
  const root = fs.mkdtempSync('/tmp/ensemble-spawn-')
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-S', path.join(root, 'socket'), '-f', '/dev/null', ...args], { encoding: 'utf8' })
  const output = path.join(root, 'received.json')
  const exit = path.join(root, 'exit')
  const probe = path.join(root, 'probe.cjs')
  const config = path.join(root, 'config.json')
  const agents = path.join(root, 'agents.json')
  const secret = "spaces ' quotes \" double $HOME $(false) `false`; literal"
  try {
    fs.writeFileSync(config, JSON.stringify({ agentEnv: { PROBE_SECRET: secret, CLAUDECODE: '1' } }))
    fs.writeFileSync(agents, JSON.stringify({ probe: { name: 'Probe', command: process.execPath, flags: [probe] } }))
    fs.writeFileSync(probe, `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ secret: process.env.PROBE_SECRET, removed: !process.env.CLAUDECODE, tty: !!process.stdin.isTTY })); setInterval(() => { if (fs.existsSync(${JSON.stringify(exit)})) process.exit(3) }, 50)`)
    fs.writeFileSync(path.join(root, 'tmux'), `#!/bin/sh\nexec "${realTmux}" -S "${path.join(root, 'socket')}" -f /dev/null "$@"\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
    vi.stubEnv('SHELL', has(shell))
    vi.stubEnv('ENSEMBLE_API_TOKEN', 'service-token-never-enters-tmux')
    vi.stubEnv('ENSEMBLE_CONFIG', config)
    vi.stubEnv('ENSEMBLE_AGENTS_CONFIG', agents)
    const { sessionName } = await spawnLocalAgent({ name: 'environment-probe', program: 'probe', workingDirectory: root })
    for (let attempt = 0; attempt < 60 && !fs.existsSync(output); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ secret, removed: true, tty: true })
    expect(tmux('show-environment', '-g')).not.toContain('service-token-never-enters-tmux')
    expect(tmux('capture-pane', '-p', '-t', sessionName)).not.toContain(secret)
    expect(tmux('display-message', '-p', '-t', sessionName, '#{pane_start_command}')).not.toContain(secret)
    fs.writeFileSync(exit, '')
    for (let attempt = 0; attempt < 60 && await getRuntime().sessionExists(sessionName); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    await expect(getRuntime().sendKeys(sessionName, 'unexpected shell input', { literal: true, agentInput: true })).rejects.toThrow('no agent running')
  } finally {
    try { tmux('kill-server') } catch { /* The last session may have exited. */ }
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
