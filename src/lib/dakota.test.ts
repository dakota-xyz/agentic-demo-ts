import { describe, it, expect, afterEach } from 'vitest'
import { explainError, dakotaEnvironment, isSandbox } from './dakota'
import { APIError } from '@dakota-xyz/ts-sdk'

// A platform validation error is addressed to whoever wrote the REQUEST. The
// person reading it typed "pay QA 1 USD" and has no idea what
// proposals/0/actions/0/create_recipient/name is, nor that "QA" is the problem.

const apiError = (message: string) => new APIError(400, 'validation-error', message)

describe('explainError', () => {
  it('turns a min-length field error into something actionable', () => {
    const out = explainError(
      apiError(
        "Validation Error: Request body validation failed - field 'proposals/0/actions/0/create_recipient/name': minimum string length is 3"
      )
    )
    expect(out).toContain('too short')
    expect(out).toContain('3 characters')
    // No field paths, no array indices.
    expect(out).not.toContain('proposals/0')
  })

  it('names the field for a non-name min-length', () => {
    expect(explainError(apiError("field 'x/y/bank_name': minimum string length is 2"))).toContain(
      '"bank_name" is too short'
    )
  })

  it('handles max length', () => {
    expect(explainError(apiError("field 'a/note': maximum string length is 40"))).toContain(
      'at most 40 characters'
    )
  })

  it('passes an unfamiliar error through UNCHANGED', () => {
    // A wrong guess about an error nobody has seen is worse than a raw one.
    const raw = 'Invalid Request: customer is not onboarded to convert and forward funds'
    expect(explainError(apiError(raw))).toBe(raw)
  })

  it('falls back to the status when there is no message at all', () => {
    expect(explainError(apiError(''))).toContain('400')
  })
})

// The environment is the thing isSandbox() gates the KYB overrides on, so a
// wrong answer here is a sandbox-only override fired against real money. It is
// also easy to break silently: an earlier version folded the default into the
// find() predicate, where `e === name || 'sandbox'` is always truthy and every
// value — production included — resolved to sandbox.

describe('dakotaEnvironment', () => {
  const saved = process.env.DAKOTA_ENV
  afterEach(() => {
    if (saved === undefined) delete process.env.DAKOTA_ENV
    else process.env.DAKOTA_ENV = saved
  })

  it('defaults to sandbox when unset, empty or blank', () => {
    // Blank is the Vercel-dashboard shape: a variable added with no value. It
    // falls back rather than throwing, because the fallback is the safe one.
    delete process.env.DAKOTA_ENV
    expect(dakotaEnvironment()).toBe('sandbox')
    for (const blank of ['', '   ']) {
      process.env.DAKOTA_ENV = blank
      expect(dakotaEnvironment()).toBe('sandbox')
    }
  })

  it('resolves production, and does NOT quietly answer sandbox', () => {
    process.env.DAKOTA_ENV = 'production'
    expect(dakotaEnvironment()).toBe('production')
    expect(isSandbox()).toBe(false)
  })

  it('trims and lowercases', () => {
    process.env.DAKOTA_ENV = ' PRODUCTION '
    expect(dakotaEnvironment()).toBe('production')
  })

  it('refuses every environment that is not sandbox or production', () => {
    // development and local are ours, not a reader's — naming them in a public
    // demo puts an unreachable host one typo away.
    for (const bad of ['development', 'local', 'prod', 'staging']) {
      process.env.DAKOTA_ENV = bad
      expect(() => dakotaEnvironment(), bad).toThrow(/is not a Dakota environment/)
    }
  })

  it('says what it expected, so a typo is self-correcting', () => {
    process.env.DAKOTA_ENV = 'prod'
    expect(() => dakotaEnvironment()).toThrow(/expected sandbox or production/)
  })
})
