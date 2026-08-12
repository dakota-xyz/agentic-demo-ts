import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySignature } from './client'

// The endpoint this guards is public by necessity — Slack has to reach it — so
// an unsigned request is not a message, it is an intrusion attempt. Without the
// check, anyone who found the URL could forge "invoice arrived" and have an
// agent draft a payment to an address they chose.
//
// All seven failure modes from the Go build are covered here.

const SECRET = 'test-signing-secret'
const BODY = '{"type":"event_callback","event":{"text":"pay Acme 1 USDC"}}'

function sign(body: string, ts: number, secret = SECRET) {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
}

function headers(ts: number, sig: string): Headers {
  return new Headers({ 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig })
}

describe('verifySignature', () => {
  const saved = process.env.SLACK_SIGNING_SECRET
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SECRET
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    process.env.SLACK_SIGNING_SECRET = saved
  })

  const now = () => Math.floor(Date.now() / 1000)

  it('accepts a genuine request', () => {
    const ts = now()
    expect(verifySignature(headers(ts, sign(BODY, ts)), BODY)).toEqual({ ok: true })
  })

  it('rejects a signature made with the wrong secret', () => {
    const ts = now()
    const res = verifySignature(headers(ts, sign(BODY, ts, 'wrong-secret')), BODY)
    expect(res.ok).toBe(false)
  })

  it('rejects a tampered body — this is the forged-payment case', () => {
    const ts = now()
    const sig = sign(BODY, ts)
    const tampered = BODY.replace('Acme', 'Attacker')
    expect(verifySignature(headers(ts, sig), tampered).ok).toBe(false)
  })

  it('rejects a replay of an old capture', () => {
    const ts = now() - 6 * 60
    expect(verifySignature(headers(ts, sign(BODY, ts)), BODY).ok).toBe(false)
  })

  it('rejects a future timestamp — a clock skewed the other way must not open the window', () => {
    const ts = now() + 6 * 60
    expect(verifySignature(headers(ts, sign(BODY, ts)), BODY).ok).toBe(false)
  })

  it('rejects missing headers', () => {
    expect(verifySignature(new Headers(), BODY).ok).toBe(false)
    expect(verifySignature(headers(now(), ''), BODY).ok).toBe(false)
  })

  it('rejects a non-numeric timestamp', () => {
    const h = new Headers({ 'x-slack-request-timestamp': 'abc', 'x-slack-signature': 'v0=00' })
    expect(verifySignature(h, BODY).ok).toBe(false)
  })

  it('refuses everything when unconfigured, rather than waving requests through', () => {
    delete process.env.SLACK_SIGNING_SECRET
    const ts = now()
    const res = verifySignature(headers(ts, sign(BODY, ts)), BODY)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/not configured/)
  })

  it('does not throw on a signature of a different length', () => {
    // timingSafeEqual throws on a length mismatch; that must read as a
    // rejection, not a 500 that hides an attack.
    const ts = now()
    expect(() => verifySignature(headers(ts, 'v0=short'), BODY)).not.toThrow()
    expect(verifySignature(headers(ts, 'v0=short'), BODY).ok).toBe(false)
  })

  it('accepts a request at the edge of the window', () => {
    const ts = now() - (5 * 60 - 1)
    expect(verifySignature(headers(ts, sign(BODY, ts)), BODY).ok).toBe(true)
  })
})
