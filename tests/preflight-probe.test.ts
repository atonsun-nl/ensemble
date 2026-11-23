import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { checkCodexLaunch, resolveExecutable } from '../lib/agent-preflight'

let root: string
let first: string
let second: string
let report: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preflight-'))
  first = path.join(root, 'first')
  second = path.join(root, 'second')
  report = path.join(root, 'called')
  for (const directory of [first, second]) {
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'codex'), `#!/bin/sh
printf '%s\\n' "$0 $*" >> "$CALL_LOG"
case " $* " in
  *' --unsupported '*) exit 2 ;;
esac
case "$1" in
  --version) echo 'codex-cli 9.1';;
  login) echo 'Logged in using ChatGPT';;
  exec) printf '%s\\n' "$SMOKE_OUTPUT"; exit "${'${SMOKE_EXIT:-0}'}";;
esac
`, { mode: 0o755 })
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const flags = ['--model', 'assigned-model', '--config', 'model_reasoning_effort="xhigh"', '--no-alt-screen']
function environment(overrides: Record<string, string> = {}) {
  return { PATH: `${first}:${second}`, CALL_LOG: report, SMOKE_OUTPUT: '7392', ...overrides }
}

it('uses the selected PATH installation and runs the offline checks without invoking exec by default', async () => {
  const env = environment()
  const binary = resolveExecutable('codex', env.PATH, root)
  expect(binary).toBe(path.join(first, 'codex'))
  expect(await checkCodexLaunch([binary, ...flags], env, root)).toContain('ChatGPT')
  const calls = fs.readFileSync(report, 'utf8')
  expect(calls).not.toContain(second)
  expect(calls).not.toContain(' exec ')
  expect(calls).toContain('assigned-model')
})

it('rejects an unsupported interactive flag without sending a provider request', async () => {
  const env = environment()
  await expect(checkCodexLaunch([resolveExecutable('codex', env.PATH, root), '--unsupported'], env, root)).rejects.toThrow('interactive flags')
  expect(fs.readFileSync(report, 'utf8')).not.toContain(' exec ')
})

it.each([{ SMOKE_EXIT: '1', SMOKE_OUTPUT: 'provider rejected the model' }, { SMOKE_EXIT: '0', SMOKE_OUTPUT: 'Reply with only the decimal result of 7391 plus 1' }])('fails closed on an unavailable model or an echoed prompt', async overrides => {
  vi.stubEnv('ENSEMBLE_CODEX_SMOKE_CHECK', '1')
  const env = environment(overrides)
  await expect(checkCodexLaunch([resolveExecutable('codex', env.PATH, root), ...flags], env, root)).rejects.toThrow('configured model')
  const probe = fs.readFileSync(report, 'utf8').split('\n').find(line => line.includes(' exec '))!
  expect(probe).toContain('--model assigned-model --config model_reasoning_effort="xhigh"')
  expect(probe).not.toContain('--no-alt-screen')
  expect(probe).toContain('--sandbox read-only')
})
