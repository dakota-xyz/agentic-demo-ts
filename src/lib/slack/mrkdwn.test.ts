import { describe, it, expect } from 'vitest'
import { toMrkdwn } from './mrkdwn'

// Ported from the Go build's tests, including the two cases that were real bugs
// there: a regex backreference RE2 could not express, and a `$1_` replacement
// Go read as a group named "1_", which silently deleted every italic phrase.
// JavaScript has neither limitation — but the CASES are the point, because they
// pin the output shape Slack actually renders.

describe('toMrkdwn', () => {
  it('converts bold from ** to a single asterisk', () => {
    expect(toMrkdwn('pay **Acme** now')).toBe('pay *Acme* now')
  })

  it('keeps italics rather than eating them', () => {
    expect(toMrkdwn('that is _urgent_ today')).toBe('that is _urgent_ today')
  })

  it('rewrites links into Slack angle-bracket form', () => {
    expect(toMrkdwn('see [the docs](https://x.dev/a)')).toBe('see <https://x.dev/a|the docs>')
  })

  it('bolds headings, since Slack has none', () => {
    expect(toMrkdwn('## Payment plan')).toBe('*Payment plan*')
  })

  it('turns list markers into bullets — a leading dash is just a hyphen in Slack', () => {
    expect(toMrkdwn('- one\n- two')).toBe('• one\n• two')
    expect(toMrkdwn('* one\n+ two')).toBe('• one\n• two')
  })

  it('preserves nesting indentation on bullets', () => {
    expect(toMrkdwn('- top\n  - nested')).toBe('• top\n  • nested')
  })

  it('drops horizontal rules, which would render as literal dashes', () => {
    expect(toMrkdwn('a\n\n---\n\nb')).toBe('a\n\n\n\nb')
  })

  it('leaves fenced code untouched, ** included', () => {
    const src = 'before\n```\nnot **bold** here\n```\nafter'
    expect(toMrkdwn(src)).toContain('not **bold** here')
  })

  it('leaves inline code untouched', () => {
    expect(toMrkdwn('run `npm **run** build` now')).toBe('run `npm **run** build` now')
  })

  it('handles a realistic agent reply end to end', () => {
    const reply = [
      '## Drafted for your review',
      '',
      '- Pay **Acme Corp** 1 USDC on ethereum-sepolia',
      '- See [the invoice](https://x.dev/i/1)',
      '',
      'Nothing moves until you _approve_ it.',
    ].join('\n')

    expect(toMrkdwn(reply)).toBe(
      [
        '*Drafted for your review*',
        '',
        '• Pay *Acme Corp* 1 USDC on ethereum-sepolia',
        '• See <https://x.dev/i/1|the invoice>',
        '',
        'Nothing moves until you _approve_ it.',
      ].join('\n')
    )
  })

  it('is a no-op on plain prose', () => {
    expect(toMrkdwn('Nothing special here.')).toBe('Nothing special here.')
  })
})
