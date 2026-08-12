import { describe, it, expect } from 'vitest'
import { renderEmail, inlineMarkdown } from './email-template'

// The reply IS the interface for someone using this by email — they never see
// a screen. So the two failures that matter are: markdown arriving as literal
// asterisks, and the HTML being the only body (a screen reader, a plain-text
// client and a spam filter all read the text part).

const base = {
  reply: 'Paying **Acme** 25 USD today.',
  steps: [
    { type: 'create_scheduled_payments', title: 'Schedule payment', detail: '25 USD · 8/4/2026' },
  ],
  link: 'https://demo.example/?agent=abc',
  agentName: 'Payroll',
}

describe('inlineMarkdown', () => {
  it('renders the bold the agent actually writes', () => {
    expect(inlineMarkdown('pay **25 USD** now')).toContain('<strong>25 USD</strong>')
  })

  it('escapes HTML before doing anything else', () => {
    // An invoice is attacker-influenced text. Bolding it must never mean
    // executing it.
    const out = inlineMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('leaves an unmatched asterisk alone rather than guessing', () => {
    expect(inlineMarkdown('3 * 4 = 12')).toBe('3 * 4 = 12')
  })
})

describe('renderEmail', () => {
  it('sends BOTH bodies, always', () => {
    const { html, text } = renderEmail({ ...base, outcome: { kind: 'none' } })
    expect(html).toContain('<!doctype html>')
    expect(text.length).toBeGreaterThan(0)
  })

  it('leaves no raw markdown in either body', () => {
    const { html } = renderEmail({ ...base, outcome: { kind: 'none' } })
    expect(html).not.toContain('**')
    expect(html).toContain('<strong>Acme</strong>')
  })

  it('carries the plan into both bodies', () => {
    const { html, text } = renderEmail({ ...base, outcome: { kind: 'none' } })
    expect(html).toContain('Schedule payment')
    expect(text).toContain('Schedule payment')
  })

  it('states a refusal and the limits that caused it', () => {
    const { html, text } = renderEmail({
      ...base,
      outcome: {
        kind: 'blocked',
        line: 'Not paid — 25 USD is outside your signed spend limits.',
        limits: 'Your signed spend limits:\n  • anyone — 5 USD per month',
      },
    })
    expect(html).toContain('outside your signed spend limits')
    expect(html).toContain('5 USD per month')
    expect(text).toContain('5 USD per month')
  })

  it('uses inline styles only — mail clients strip style blocks', () => {
    const { html } = renderEmail({ ...base, outcome: { kind: 'paid', line: 'Paid.' } })
    expect(html).not.toContain('<style')
    expect(html).toContain('style="')
  })
})
