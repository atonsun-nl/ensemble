import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { AgentRuntime } from './agent-runtime'

const pendingInputs = new Map<string, Promise<void>>()

/** Serialize input to the same pane, including its submission. */
export async function serializeAgentInput<T>(sessionName: string, input: () => Promise<T>): Promise<T> {
  const previous = pendingInputs.get(sessionName) ?? Promise.resolve()
  const delivery = previous.then(input)
  const tail = delivery.then(() => {}, () => {})
  pendingInputs.set(sessionName, tail)
  try { return await delivery } finally {
    if (pendingInputs.get(sessionName) === tail) pendingInputs.delete(sessionName)
  }
}

export async function pasteAgentInput(
  runtime: Pick<AgentRuntime, 'pasteFromFile'>,
  sessionName: string,
  filePath: string,
  text: string,
  enterCount?: 1 | 2,
): Promise<void> {
  await serializeAgentInput(sessionName, async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temporary = `${filePath}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600 })
      if (enterCount === undefined) await runtime.pasteFromFile(sessionName, temporary)
      else await runtime.pasteFromFile(sessionName, temporary, { enterCount })
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  })
}
