import { describe, it, expect, afterEach } from 'vitest'
import { workDomain, emailDomain, parseAllowList, NotWorkAccountError } from './work-domain'

describe('workDomain', () => {
  it('admits a Workspace account and returns its domain', () => {
    expect(workDomain('acme.com', 'cfo@acme.com')).toBe('acme.com')
    expect(workDomain('example.com', 'ada@example.com')).toBe('example.com')
  })

  it('prefers hd over the address, because hd names the organisation', () => {
    // A tenant with several mail domains reports one hd. The org is the lead.
    expect(workDomain('acme.com', 'cfo@acme-eu.com')).toBe('acme.com')
  })

  it('refuses an account with no hd — that is a personal Google account', () => {
    expect(() => workDomain('', 'someone@gmail.com')).toThrow(NotWorkAccountError)
    // Even when the address itself looks corporate: without hd, Google is not
    // telling us this is a Workspace account, and we do not guess.
    expect(() => workDomain(undefined, 'cfo@acme.com')).toThrow(NotWorkAccountError)
  })

  it('refuses a consumer or disposable domain even when hd is present', () => {
    expect(() => workDomain('gmail.com', 'x@gmail.com')).toThrow(NotWorkAccountError)
    expect(() => workDomain('mailinator.com', 'x@mailinator.com')).toThrow(NotWorkAccountError)
  })

  it('normalises case and whitespace — provider noise, not identity', () => {
    expect(workDomain('ACME.com', 'CFO@ACME.com')).toBe('acme.com')
    expect(workDomain('  acme.com  ', 'cfo@acme.com')).toBe('acme.com')
    expect(() => workDomain('GMAIL.COM', 'x@GMAIL.COM')).toThrow(NotWorkAccountError)
  })

  it('carries the domain and a code, which the sign-in screen renders', () => {
    try {
      workDomain('', 'someone@gmail.com')
      throw new Error('expected a refusal')
    } catch (e) {
      expect(e).toBeInstanceOf(NotWorkAccountError)
      const err = e as NotWorkAccountError
      expect(err.domain).toBe('gmail.com')
      expect(err.code).toBe('work_account_required')
      expect(err.message).toContain('work account')
    }
  })
})

describe('the allow-list escape hatch', () => {
  const allow = new Set(['gmail.com', 'friend.dev'])

  it('admits a listed consumer domain', () => {
    expect(workDomain('gmail.com', 'x@gmail.com', allow)).toBe('gmail.com')
  })

  it('admits a listed domain that has no hd at all', () => {
    expect(workDomain('', 'x@friend.dev', allow)).toBe('friend.dev')
  })

  it('does not widen the rule generally', () => {
    expect(() => workDomain('', 'x@yahoo.com', allow)).toThrow(NotWorkAccountError)
  })
})

describe('emailDomain', () => {
  it.each([
    ['a@b.com', 'b.com'],
    ['A@B.COM', 'b.com'],
    ['a+tag@b.co.uk', 'b.co.uk'],
    ['a@sub@b.com', 'b.com'], // last @ wins
    ['noat', ''],
    ['trailing@', ''],
    ['', ''],
  ])('%s -> %s', (input, want) => {
    expect(emailDomain(input)).toBe(want)
  })
})

describe('parseAllowList', () => {
  it('trims, lowercases, strips a leading @, and drops blanks', () => {
    expect(parseAllowList(' Acme.com, @friend.dev ,, ')).toEqual(
      new Set(['acme.com', 'friend.dev'])
    )
  })
  it('treats unset as empty', () => {
    expect(parseAllowList(undefined)).toEqual(new Set())
  })
})

describe('DEMO_ALLOW_ANY_DOMAIN', () => {
  const saved = process.env.DEMO_ALLOW_ANY_DOMAIN
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_ALLOW_ANY_DOMAIN
    else process.env.DEMO_ALLOW_ANY_DOMAIN = saved
  })

  it('admits a personal account when switched on, and still records the domain', () => {
    process.env.DEMO_ALLOW_ANY_DOMAIN = 'true'
    expect(workDomain('', 'someone@gmail.com')).toBe('gmail.com')
    expect(workDomain(undefined, 'x@outlook.com')).toBe('outlook.com')
  })

  it('still prefers hd, which names the organisation rather than the mail domain', () => {
    process.env.DEMO_ALLOW_ANY_DOMAIN = 'true'
    expect(workDomain('acme.com', 'cfo@acme-eu.com')).toBe('acme.com')
  })

  it('only "true" counts — a half-set variable must not open the door', () => {
    for (const v of ['1', 'yes', 'TRUE', '']) {
      process.env.DEMO_ALLOW_ANY_DOMAIN = v
      expect(() => workDomain('', 'someone@gmail.com'), v).toThrow(NotWorkAccountError)
    }
  })

  it('is closed when unset', () => {
    delete process.env.DEMO_ALLOW_ANY_DOMAIN
    expect(() => workDomain('', 'someone@gmail.com')).toThrow(NotWorkAccountError)
  })
})

describe('DEMO_REQUIRE_DOMAIN', () => {
  const savedReq = process.env.DEMO_REQUIRE_DOMAIN
  const savedAny = process.env.DEMO_ALLOW_ANY_DOMAIN
  afterEach(() => {
    if (savedReq === undefined) delete process.env.DEMO_REQUIRE_DOMAIN
    else process.env.DEMO_REQUIRE_DOMAIN = savedReq
    if (savedAny === undefined) delete process.env.DEMO_ALLOW_ANY_DOMAIN
    else process.env.DEMO_ALLOW_ANY_DOMAIN = savedAny
  })

  it('admits only the named domain', () => {
    process.env.DEMO_REQUIRE_DOMAIN = 'example.com'
    expect(workDomain('example.com', 'ada@example.com')).toBe('example.com')
    expect(() => workDomain('acme.com', 'cfo@acme.com')).toThrow(NotWorkAccountError)
    expect(() => workDomain('', 'someone@gmail.com')).toThrow(NotWorkAccountError)
  })

  it('OUTRANKS DEMO_ALLOW_ANY_DOMAIN', () => {
    // The two switches contradict each other and a deployment that named its
    // domain made the stricter statement. If the permissive one won, a stray
    // gmail account would land inside a shared treasury — the whole reason
    // this gate exists.
    process.env.DEMO_REQUIRE_DOMAIN = 'example.com'
    process.env.DEMO_ALLOW_ANY_DOMAIN = 'true'
    expect(() => workDomain('', 'someone@gmail.com')).toThrow(NotWorkAccountError)
    expect(workDomain('example.com', 'ada@example.com')).toBe('example.com')
  })

  it('accepts several domains, and normalises them', () => {
    process.env.DEMO_REQUIRE_DOMAIN = ' Example.com, @partner.io '
    expect(workDomain('example.com', 'a@example.com')).toBe('example.com')
    expect(workDomain('partner.io', 'b@partner.io')).toBe('partner.io')
    expect(() => workDomain('other.com', 'c@other.com')).toThrow(NotWorkAccountError)
  })

  it('unset changes nothing — the public demo keeps its existing rule', () => {
    delete process.env.DEMO_REQUIRE_DOMAIN
    expect(workDomain('acme.com', 'cfo@acme.com')).toBe('acme.com')
    expect(() => workDomain('', 'x@gmail.com')).toThrow(NotWorkAccountError)
  })
})
