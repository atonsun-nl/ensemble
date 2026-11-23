import { afterEach, expect, it, vi } from 'vitest'
import { isRemoteSessionReady } from '../lib/agent-spawner'

afterEach(() => vi.unstubAllGlobals())

it('distinguishes an absent remote session from a failed status request', async () => {
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce({ status: 503, ok: false })
    .mockResolvedValueOnce({ status: 404, ok: false })
    .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ exists: false }) })
  vi.stubGlobal('fetch', fetchMock)

  expect(await isRemoteSessionReady('http://remote.invalid', 'agent')).toBeUndefined()
  expect(await isRemoteSessionReady('http://remote.invalid', 'agent')).toBeUndefined()
  expect(await isRemoteSessionReady('http://remote.invalid', 'agent')).toBe(false)
  expect(await isRemoteSessionReady('http://remote.invalid', 'agent')).toBe(false)
})

it('requires foreground CLI evidence for strict remote readiness', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ exists: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ exists: true, foregroundCommand: 'bash', output: '›' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ exists: true, foregroundCommand: 'codex', output: '›' }) })
  vi.stubGlobal('fetch', fetchMock)
  expect(await isRemoteSessionReady('http://remote.invalid', 'agent', '›')).toBe(false)
  expect(await isRemoteSessionReady('http://remote.invalid', 'agent', '›')).toBe(false)
  expect(await isRemoteSessionReady('http://remote.invalid', 'agent', '›')).toBe(true)
})

it('detects a remote shell after the startup marker is no longer relevant', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ exists: true, foregroundCommand: 'bash' }),
  }))
  await expect(isRemoteSessionReady('http://remote.invalid', 'agent', { foreground: true })).resolves.toBe(false)
})

it('persists the Maestro ID before starting the wake request', async () => {
  const { spawnRemoteAgent } = await import('../lib/agent-spawner')
  const status = vi.fn()
  const mock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ agent: { id: 'created-id' } }) })
    .mockImplementationOnce(async () => {
      expect(status).toHaveBeenCalledWith('created-id')
      return { ok: false, status: 503 }
    })
  vi.stubGlobal('fetch', mock)
  await expect(spawnRemoteAgent('http://remote.invalid', 'replacing-1', 'codex', '/tmp', undefined, 'team',
    { onCreated: status })).rejects.toThrow('wake failed')
  expect(mock.mock.calls[1][0]).toContain('/created-id/wake')
})
