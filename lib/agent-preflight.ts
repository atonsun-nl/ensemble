import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { readEnsembleConfig } from './ensemble-config'

export function resolveExecutable(command: string, searchPath = '/usr/bin:/bin', cwd = process.cwd()): string {
  const candidates = command.includes(path.sep)
    ? [path.resolve(cwd, command)]
    : searchPath.split(path.delimiter).map(dir => path.resolve(cwd, dir, command))
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Configured CLI binary was not found or is not executable')
}

const checked = new Map<string, { until: number; description: string }>()

export async function checkCodexLaunch(command: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const [binary, ...flags] = command
  const smoke = readEnsembleConfig().codexSmokeCheck
  const run = (args: string[], timeout = 10_000) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      const child = execFile(binary, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => resolve({
          status: !error ? 0 : typeof error.code === 'number' && !error.signal ? error.code : null,
          stdout, stderr,
        }))
      child.stdin?.end()
    })
  // Help on its own exposes the supported flags. A final --help then exercises
  // the interactive parser without opening a TUI or sending a provider request.
  const version = await run(['--version'])
  if (version.status !== 0) throw new Error('Codex version check failed')
  const help = await run(['--help'])
  if (help.status !== 0 || (await run([...flags, '--help'])).status !== 0) {
    throw new Error('Codex interactive flags are incompatible with the configured binary')
  }
  const auth = await run(['login', 'status'])
  const authText = (auth.stdout ?? '') + (auth.stderr ?? '')
  if (auth.status !== 0 && !env.OPENAI_API_KEY && !env.CODEX_API_KEY && !flags.includes('--oss')) {
    throw new Error('Codex authentication check failed')
  }
  const mode = flags.includes('--oss') ? 'local provider' : /chatgpt/i.test(authText) ? 'ChatGPT' : /api key/i.test(authText) || env.OPENAI_API_KEY || env.CODEX_API_KEY ? 'API key' : 'local login'
  const description = `${binary} (${version.stdout?.match(/codex(?:-cli)? [\w.-]+/)?.[0] ?? 'version available'}, ${mode})`
  if (!smoke) return description
  // Carry model/config/profile/provider settings into exec. Interactive
  // approval, terminal, workspace and image flags have separate semantics.
  const values = new Set(['-m', '--model', '-c', '--config', '-p', '--profile', '--local-provider', '--enable', '--disable', '--remote', '--remote-auth-token-env'])
  const toggles = new Set(['--oss', '--strict-config'])
  const probeFlags: string[] = []
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    const key = flag.split('=', 1)[0]
    if (values.has(key)) {
      probeFlags.push(flag)
      if (flag === key) probeFlags.push(flags[++index])
    } else if (toggles.has(key)) probeFlags.push(flag)
  }
  const key = JSON.stringify([binary, fs.statSync(binary).mtimeMs, cwd, probeFlags, mode])
  const cached = checked.get(key)
  if (cached && cached.until > Date.now()) return cached.description
  const probe = await run(['exec', ...probeFlags, '--sandbox', 'read-only', '--skip-git-repo-check',
    'Reply with only the decimal result of 7391 plus 1. Do not use tools.'], 40_000)
  if (probe.status !== 0 || !/^\s*7392\s*$/m.test(probe.stdout ?? '')) {
    throw new Error('Codex smoke check failed for the configured model, flags or authentication mode')
  }
  checked.set(key, { until: Date.now() + 60_000, description })
  return description
}
