import { describe, it, expect } from 'vitest'
import { routeTurn, tailForInsights, withoutAttachments } from './insights'

// The asymmetry here is the point. Misrouting a QUESTION to the payments agent
// is mild — it has account context and answers imperfectly. Misrouting an
// INSTRUCTION to insights is bad: the person asked for a payment, got a
// summary, and nothing was drafted. So these tests weight heavily toward
// "when in doubt, payments".

describe('routeTurn', () => {
  it('sends account questions to insights', () => {
    for (const q of [
      'tell me the insights',
      'give me a summary',
      'how am I doing?',
      'how much have I spent this month?',
      "what's my balance",
      'show me an overview',
      'are we running low?',
    ]) {
      expect(routeTurn(q), q).toBe('insights')
    }
  })

  it('sends instructions to the payments agent', () => {
    for (const q of [
      'pay Acme 1 USDC',
      'schedule a payment to MeatCo every Friday',
      'send 5 USDC to KADOTA',
      'cancel that payment',
      'revoke the limit',
      'add CastleCorp as a payee',
    ]) {
      expect(routeTurn(q), q).toBe('payments')
    }
  })

  it('treats a mixed request as an instruction', () => {
    // "pay X and summarise" is a payment with a pleasantry attached. Routing it
    // to a reporter would silently drop the actual instruction.
    expect(routeTurn('pay MeatCo 1 USDC and give me a summary')).toBe('payments')
    expect(routeTurn('summary please, then schedule the Friday payment')).toBe('payments')
  })

  it('defaults to payments for anything ambiguous', () => {
    for (const q of ['hello', 'MeatCo', 'thanks!', 'what can you do?', '']) {
      expect(routeTurn(q), q).toBe('payments')
    }
  })
})

describe('tailForInsights', () => {
  const history = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
  }))

  it('stays within the endpoint limit of 40', () => {
    expect(tailForInsights(history, 'and MeatCo?').length).toBeLessThanOrEqual(40)
  })

  it('keeps the most RECENT context, which is what a follow-up depends on', () => {
    const out = tailForInsights(history, 'and MeatCo?', 5)
    expect(out).toHaveLength(5)
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'and MeatCo?' })
    expect(out[0].content).toBe('turn 46')
  })

  it('drops empty and non-conversational turns', () => {
    const messy = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'ignored' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(tailForInsights(messy, 'summary?')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'summary?' },
    ])
  })

  it('works from an empty history', () => {
    expect(tailForInsights([], 'insights please')).toEqual([
      { role: 'user', content: 'insights please' },
    ])
  })
})

describe('withoutAttachments', () => {
  it('drops attachments in both casings', () => {
    // Lowercase is ours; capitalised comes from transcripts adopted out of the
    // Go build. Both break the SDK, in the same place, for the same reason.
    const out = withoutAttachments([
      { role: 'user', content: 'pay this', attachments: [{ mediaType: 'application/pdf', data: {} }] },
      { role: 'user', content: 'and this', Attachments: [{ Data: 'JVBER...' }] },
      { role: 'assistant', content: 'drafted' },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'pay this' },
      { role: 'user', content: 'and this' },
      { role: 'assistant', content: 'drafted' },
    ])
  })

  it('leaves an ordinary transcript untouched', () => {
    const clean = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
    expect(withoutAttachments(clean)).toEqual(clean)
  })

  it('survives junk in the array', () => {
    expect(withoutAttachments([null, undefined, 'x'] as unknown[])).toEqual([null, undefined, 'x'])
  })
})
