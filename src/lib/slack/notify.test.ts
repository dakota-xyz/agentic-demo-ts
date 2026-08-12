import { describe, it, expect } from 'vitest'
import { threadForPayment } from './notify'
import type { User, AgentRef } from '../store'

// The bug this pins: a settlement arrives long after the conversation, carrying
// only a payment id. Announce it in the agent's LAST thread and the moment two
// requests are in flight, both receipts land in whichever conversation spoke
// most recently. Nothing looks broken — the amount is right, the payment is
// real, and it is answering the wrong question.

const agent = (lastThreadTs?: string): AgentRef => ({
  id: 'agent-1',
  name: 'Accounts payable',
  signerId: 'signer-1',
  createdAt: '2026-07-31T00:00:00Z',
  slack: { channelId: 'C123', channelName: 'invoices', lastThreadTs },
})

const user = (paymentThreads?: Record<string, string>): User => ({
  email: 'ada@example.com',
  name: 'ada',
  domain: 'example.com',
  paymentThreads,
})

describe('threadForPayment', () => {
  it('uses the thread that ASKED for that payment', () => {
    const u = user({ 'pay-1': 'thread-A', 'pay-2': 'thread-B' })
    expect(threadForPayment(u, agent('thread-B'), 'pay-1')).toBe('thread-A')
    expect(threadForPayment(u, agent('thread-B'), 'pay-2')).toBe('thread-B')
  })

  it('keeps two in-flight requests apart — the exact reported bug', () => {
    // Both payments exist; thread-B spoke most recently. pay-1 must still
    // report into thread-A.
    const u = user({ 'pay-1': 'thread-A', 'pay-2': 'thread-B' })
    const a = agent('thread-B')
    const first = threadForPayment(u, a, 'pay-1')
    const second = threadForPayment(u, a, 'pay-2')
    expect(first).not.toBe(second)
    expect(first).toBe('thread-A')
  })

  it('does NOT fall back to the last thread for an unmapped payment', () => {
    // This used to return thread-B, and that was the mess: a payment made in
    // the browser or by email has no thread, so its settlement was announced in
    // whichever Slack conversation had spoken most recently — one that had
    // asked for something else entirely.
    //
    // Undefined now means "do not announce at all" — see the settlement cron.
    expect(threadForPayment(user({}), agent('thread-B'), 'legacy-pay')).toBeUndefined()
  })

  it('claims no thread for a payment that never came from Slack', () => {
    // Undefined is the signal to say NOTHING. A payment made in the app or by
    // email is not the channel's business — announcing it there is noise about
    // something nobody in the room asked for.
    expect(threadForPayment(user({}), agent(undefined), 'pay-9')).toBeUndefined()
  })

  it('does not crash on a payment with no id, and claims no thread for it', () => {
    expect(
      threadForPayment(user({ 'pay-1': 'thread-A' }), agent('thread-B'), undefined)
    ).toBeUndefined()
  })
})
