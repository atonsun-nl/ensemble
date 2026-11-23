import { isIP } from 'net'

export function normalizeIp(ip: string): string {
  if (isIP(ip) !== 6 || ip.includes('%')) return ip
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1)
  const mapped = canonical.match(/^::ffff:([\da-f]+):([\da-f]+)$/i)
  if (!mapped) return canonical
  const [high, low] = mapped.slice(1).map(word => parseInt(word, 16))
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

export function forwardedClientIp(peer: string, forwarded: unknown, trusted: ReadonlySet<string>): string {
  if (!trusted.has(peer) || typeof forwarded !== 'string') return peer
  const chain = forwarded.split(',').map(item => normalizeIp(item.trim()))
  if (!chain.every(ip => isIP(ip))) return peer
  return chain.reverse().find(ip => !trusted.has(ip)) || peer
}
