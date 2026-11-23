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
