import { buildAgentEnvironment } from '../lib/agent-config'
import { checkCodexLaunch, resolveExecutable } from '../lib/agent-preflight'
import { resolveStartCommand } from '../lib/agent-spawner'

const program = process.argv[2] || 'codex'
try {
  const cwd = process.cwd()
  const env = buildAgentEnvironment(program)
  const command = resolveStartCommand(program, cwd)
  command[0] = resolveExecutable(command[0], env.PATH, cwd)
  console.log(await checkCodexLaunch(command, env, cwd))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Codex preflight failed')
  process.exitCode = 1
}
