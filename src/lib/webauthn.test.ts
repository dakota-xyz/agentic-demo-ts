import { describe, it, expect } from 'vitest'
import { assertionSignature, rpIDFrom, type AssertionJSON } from './webauthn'

// The wire shape here is load-bearing: the platform base64-decodes this blob and
// unmarshals it into go-webauthn's CredentialAssertionResponse. Field names are
// that struct's JSON tags, so a rename or a stray null is a silent verification
// failure at signing time — the worst place to find out.

const valid: AssertionJSON = {
  id: 'cred-id',
  rawId: 'cred-id',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJhIjoxfQ',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
  },
}

function decode(blob: string) {
  return JSON.parse(Buffer.from(blob, 'base64').toString('utf8'))
}

describe('assertionSignature', () => {
  it('emits exactly the field names the platform unmarshals', () => {
    const out = decode(assertionSignature(valid))
    expect(Object.keys(out).sort()).toEqual(['id', 'rawId', 'response', 'type'])
    expect(Object.keys(out.response).sort()).toEqual([
      'authenticatorData',
      'clientDataJSON',
      'signature',
    ])
  })

  it('preserves the values verbatim — these are base64url and must not be re-encoded', () => {
    const out = decode(assertionSignature(valid))
    expect(out.response.clientDataJSON).toBe('eyJhIjoxfQ')
    expect(out.response.signature).toBe('c2ln')
    expect(out.rawId).toBe('cred-id')
  })

  it('omits userHandle when absent rather than sending null', () => {
    // The Go struct tags it omitempty; a null would decode to an empty handle
    // rather than to none at all.
    const out = decode(assertionSignature(valid))
    expect('userHandle' in out.response).toBe(false)
  })

  it('includes userHandle when the authenticator provided one', () => {
    const out = decode(assertionSignature({ ...valid, response: { ...valid.response, userHandle: 'dXNlcg' } }))
    expect(out.response.userHandle).toBe('dXNlcg')
  })

  it('treats an explicit null userHandle as absent', () => {
    const out = decode(assertionSignature({ ...valid, response: { ...valid.response, userHandle: null } }))
    expect('userHandle' in out.response).toBe(false)
  })

  it('is valid base64 of valid JSON', () => {
    const blob = assertionSignature(valid)
    expect(blob).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(() => decode(blob)).not.toThrow()
  })

  it('refuses an assertion missing top-level fields, naming them', () => {
    expect(() => assertionSignature({ ...valid, id: '' })).toThrow(/id/)
    expect(() => assertionSignature({ ...valid, rawId: '' })).toThrow(/rawId/)
  })

  it('refuses an assertion missing response fields', () => {
    expect(() =>
      assertionSignature({ ...valid, response: { ...valid.response, signature: '' } })
    ).toThrow(/response fields/)
  })
})

describe('rpIDFrom', () => {
  it.each([
    ['http://localhost:3000', 'localhost'],
    ['https://demo.dakota.xyz', 'demo.dakota.xyz'],
    ['https://demo.dakota.xyz:8443', 'demo.dakota.xyz'],
  ])('%s -> %s', (origin, want) => {
    // The rp id is the bare hostname: including the port makes the credential
    // unusable, and passkeys are scoped to it permanently.
    expect(rpIDFrom(origin)).toBe(want)
  })
})

describe('requestOrigin', () => {
  const make = (h: Record<string, string>) => new Request('https://internal/x', { headers: h })

  it('uses the host the browser asked for, not a configured one', async () => {
    const { requestOrigin } = await import('./origin')
    expect(requestOrigin(make({ host: 'agentic-demo-ts.vercel.app', 'x-forwarded-proto': 'https' })))
      .toBe('https://agentic-demo-ts.vercel.app')
  })

  it('prefers x-forwarded-host, which is what the browser saw', async () => {
    // Behind a proxy, `host` can be an internal name — enrolling a passkey
    // against that would produce an rpID no browser will ever match.
    const { requestOrigin } = await import('./origin')
    expect(requestOrigin(make({
      host: 'internal-lb',
      'x-forwarded-host': 'agentic-demo-ts.vercel.app',
      'x-forwarded-proto': 'https',
    }))).toBe('https://agentic-demo-ts.vercel.app')
  })

  it('keeps localhost on http, since https there has no certificate', async () => {
    const { requestOrigin } = await import('./origin')
    expect(requestOrigin(make({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
  })
})
