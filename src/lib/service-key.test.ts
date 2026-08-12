import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { serviceKey } from './service-key'

// The cache lives on globalThis so a warm lambda derives once. Tests have to
// clear it, or the first salt would win for the whole file.
const g = globalThis as unknown as { serviceKey?: unknown }

describe('serviceKey', () => {
  const saved = process.env.DEMO_KEY_SALT
  beforeEach(() => {
    g.serviceKey = undefined
  })
  afterEach(() => {
    process.env.DEMO_KEY_SALT = saved
    g.serviceKey = undefined
  })

  it('refuses to derive without a salt, rather than inventing a key', () => {
    delete process.env.DEMO_KEY_SALT
    expect(() => serviceKey()).toThrow(/DEMO_KEY_SALT/)
  })

  it('is deterministic across derivations', () => {
    // Load-bearing: a redeploy MUST derive the same key. A different one would
    // leave every existing wallet's signer group referencing a key the platform
    // has never seen, orphaning the whole tenancy.
    process.env.DEMO_KEY_SALT = 'salt-one'
    const first = serviceKey().publicKey
    g.serviceKey = undefined
    const second = serviceKey().publicKey
    expect(second).toBe(first)
  })

  it('derives a different key from a different salt', () => {
    process.env.DEMO_KEY_SALT = 'salt-one'
    const a = serviceKey().publicKey
    g.serviceKey = undefined
    process.env.DEMO_KEY_SALT = 'salt-two'
    const b = serviceKey().publicKey
    expect(b).not.toBe(a)
  })

  it('produces a base64 PKIX P-256 public key the platform will accept', () => {
    process.env.DEMO_KEY_SALT = 'salt-one'
    const { publicKey } = serviceKey()
    expect(publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const der = Buffer.from(publicKey, 'base64')
    // 91 bytes is the fixed length of an SPKI-wrapped uncompressed P-256 point.
    expect(der.length).toBe(91)
  })

  it('signs, and the signature verifies against the derived public key', () => {
    process.env.DEMO_KEY_SALT = 'salt-one'
    const { signer, publicKey } = serviceKey()
    const sig = signer.sign(new TextEncoder().encode('{"a":1}'))
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(signer.publicKeyBase64()).toBe(publicKey)
  })
})
