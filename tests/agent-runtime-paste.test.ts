import { expect, it, vi } from 'vitest'

const { calls, execFileMock } = vi.hoisted(() => {
  const calls: string[][] = []
  const execFileMock = vi.fn((_bin: string, args: string[], callback: (error: Error | null, output: string) => void) => {
    calls.push(args)
    const secondEnter = args[0] === 'send-keys' && calls.filter(call => call[0] === 'send-keys').length === 2
    callback(secondEnter ? new Error('tmux busy') : null, '')
  })
  return { calls, execFileMock }
})
vi.mock('child_process', () => ({ exec: vi.fn(), execFile: execFileMock, execFileSync: vi.fn() }))

import { TmuxRuntime } from '../lib/agent-runtime'

it('reports a failed Enter without replaying a successful paste', async () => {
  const runtime = new TmuxRuntime()
  vi.spyOn(runtime, 'sessionExists').mockResolvedValue(true)
  vi.spyOn(runtime, 'getForegroundCommand').mockResolvedValue('agent')
  await expect(runtime.pasteFromFile('sess', '/tmp/path with spaces.txt')).rejects.toThrow('tmux busy')
  expect(calls.filter(args => args[0] === 'paste-buffer')).toHaveLength(1)
  expect(calls.filter(args => args[0] === 'delete-buffer')).toHaveLength(1)
  expect(calls[0].at(-1)).toBe('/tmp/path with spaces.txt')
})
