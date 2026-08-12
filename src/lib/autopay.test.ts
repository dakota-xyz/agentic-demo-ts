import { describe, it, expect } from 'vitest'
import { verdictFor, describeRule, describeLimits, amountRequested, dropCoveredMandates } from './autopay'

// These tests defend a decision about MONEY, taken with nobody watching. The
// asymmetry is total: refusing to auto-pay costs one click, auto-paying
// something the visitor never authorised costs their money and our credibility.
// So every ambiguous case below asserts "ask a human".

const spend = (amount = '0.70') => ({
  type: 'create_scheduled_payments',
  create_scheduled_payments: { amount, asset: 'USDC', destination_id: 'dest_1' },
})

const newLimit = (rule: Record<string, unknown> = { asset: 'USDC', max_per_tx: '2.00' }) => ({
  type: 'create_mandate',
  create_mandate: { rule },
})

describe('verdictFor', () => {
  it('auto-pays a plan that is only scheduled payments', () => {
    // The agent drafted no mandate, which means it found existing signed
    // authority covering this. Nothing left for a person to add.
    const v = verdictFor([{ actions: [spend()] }])
    expect(v).toEqual({ auto: true, payments: 1 })
  })

  it('counts every payment across every proposal', () => {
    const v = verdictFor([{ actions: [spend(), spend()] }, { actions: [spend()] }])
    expect(v).toEqual({ auto: true, payments: 3 })
  })

  it('refuses when the plan drafts a NEW limit — that needs a signature', () => {
    const v = verdictFor([{ actions: [newLimit(), spend('5.00')] }])
    expect(v.auto).toBe(false)
    expect(v).toMatchObject({ blocker: 'new_limit' })
  })

  it('names the limit it would be granting, so the refusal is actionable', () => {
    const v = verdictFor([{ actions: [newLimit({ asset: 'USDC', max_per_tx: '5.00' })] }])
    expect(v).toMatchObject({ wants: '5.00 USDC per payment' })
  })

  it('refuses setup actions even with no mandate attached', () => {
    // A forged invoice naming a brand-new payee is what BEC looks like. No
    // mandate would cover the new payee anyway — refusing here is the second,
    // independent reason, and the one that does not depend on the agent.
    for (const type of [
      'create_recipient',
      'create_crypto_destination',
      'create_bank_destination',
      'create_auto_account',
    ]) {
      const v = verdictFor([{ actions: [{ type }, spend()] }])
      expect(v, type).toMatchObject({ auto: false, blocker: 'setup', wants: type })
    }
  })

  it('refuses an unrecognised action type rather than ignoring it', () => {
    // A new action added to the platform must not silently become auto-payable
    // just because this file has not heard of it yet.
    expect(verdictFor([{ actions: [{ type: 'create_something_new' }] }])).toMatchObject({
      auto: false,
      blocker: 'setup',
    })
  })

  it('refuses an empty plan', () => {
    expect(verdictFor([])).toMatchObject({ auto: false, blocker: 'nothing_to_do' })
    expect(verdictFor([{ actions: [] }])).toMatchObject({ auto: false, blocker: 'nothing_to_do' })
    expect(verdictFor([{ summary: 'I could not find an amount' }])).toMatchObject({
      auto: false,
      blocker: 'nothing_to_do',
    })
  })

  it('survives junk without ever answering "auto"', () => {
    for (const junk of [[null], [undefined], ['x'], [{ actions: null }], [{ actions: 'nope' }]]) {
      expect(verdictFor(junk as unknown[]).auto, JSON.stringify(junk)).toBe(false)
    }
  })
})

describe('describeRule', () => {
  it('renders a per-payment cap', () => {
    expect(describeRule({ asset: 'USDC', max_per_tx: '2.00' })).toBe('2.00 USDC per payment')
  })

  it('renders a windowed amount cap', () => {
    expect(
      describeRule({ asset: 'USDC', max_per_tx: '2.00', window: 'MONTHLY', max_amount_in_window: '50.00' })
    ).toBe('2.00 USDC per payment, up to 50.00 USDC per month')
  })

  it('renders a count cap, which is the one that quietly runs out', () => {
    expect(describeRule({ asset: 'USDC', max_per_tx: '1.00', max_count_in_window: 1 })).toBe(
      '1.00 USDC per payment, up to 1 payment in total'
    )
    expect(
      describeRule({ asset: 'USDC', max_per_tx: '1.00', window: 'WEEKLY', max_count_in_window: 3 })
    ).toBe('1.00 USDC per payment, up to 3 payments per week')
  })

  it('falls back rather than rendering an empty phrase', () => {
    expect(describeRule({ asset: 'USDC' })).toBe('payments in USDC')
    expect(describeRule(undefined)).toBe('a new spend limit')
  })

  it('treats window NONE as no window, not as a period', () => {
    expect(describeRule({ asset: 'USDC', max_per_tx: '2.00', window: 'NONE' })).toBe(
      '2.00 USDC per payment'
    )
  })
})

describe('describeLimits', () => {
  it('lists only ACTIVE limits — an unsigned one authorises nothing', () => {
    const out = describeLimits([
      { status: 'active', target_names: ['KADOTA'], rule: { asset: 'USDC', max_per_tx: '2.00' } },
      { status: 'pending', target_names: ['Acme'], rule: { asset: 'USDC', max_per_tx: '900.00' } },
    ])
    expect(out).toContain('KADOTA — 2.00 USDC per payment')
    expect(out).not.toContain('Acme')
  })

  it('says so plainly when there are none', () => {
    expect(describeLimits([])).toBe('You have no signed spend limits yet.')
    expect(describeLimits([{ status: 'expired' }])).toBe('You have no signed spend limits yet.')
  })

  it('describes an untargeted limit as covering any payee', () => {
    expect(describeLimits([{ status: 'active', rule: { asset: 'USDC', max_per_tx: '1.00' } }])).toContain(
      'any payee'
    )
  })
})

describe('amountRequested', () => {
  it('quotes the payment back', () => {
    expect(amountRequested([{ actions: [spend('0.70')] }])).toBe('0.70 USDC')
  })
  it('is empty when the plan schedules nothing', () => {
    expect(amountRequested([{ actions: [newLimit()] }])).toBe('')
    expect(amountRequested([])).toBe('')
  })
})

describe('dropCoveredMandates', () => {
  const standing = (rule: Record<string, unknown>) => ({ status: 'active', rule })
  const planWith = (amount: string, extra: Record<string, unknown> = {}) => [
    {
      actions: [
        { type: 'create_mandate', create_mandate: { rule: { asset: 'USDC', max_per_tx: amount } } },
        {
          type: 'create_scheduled_payments',
          create_scheduled_payments: { amount, asset: 'USDC', network_id: 'ethereum-sepolia', ...extra },
        },
      ],
    },
  ]

  const ANY_10 = standing({
    target_type: 'any',
    asset: 'USDC',
    network_id: 'ethereum-sepolia',
    window: 'MONTHLY',
    max_amount_in_window: '10.00',
    max_per_tx: '2.00',
  })

  it('drops the drafted limit when a standing one covers it, keeping the payment', () => {
    const out = dropCoveredMandates(planWith('1.00'), [ANY_10])
    expect(out.covered).toBe(true)
    const actions = (out.plan[0] as { actions: { type: string }[] }).actions
    expect(actions.map((a) => a.type)).toEqual(['create_scheduled_payments'])
  })

  it('leaves it alone when the payment exceeds the per-payment cap', () => {
    // 5.00 > max_per_tx 2.00 — the visitor genuinely does need to authorise more.
    const out = dropCoveredMandates(planWith('5.00'), [ANY_10])
    expect(out.covered).toBe(false)
    expect((out.plan[0] as { actions: unknown[] }).actions).toHaveLength(2)
  })

  it('will not borrow authority from a limit scoped to one payee', () => {
    // target_type 'recipient' bounds a NAMED payee. Treating it as standing
    // would let a limit for Acme silently cover a payment to anyone.
    const scoped = standing({ target_type: 'recipient', asset: 'USDC', max_per_tx: '10.00' })
    expect(dropCoveredMandates(planWith('1.00'), [scoped]).covered).toBe(false)
  })

  it('will not borrow authority from an unsigned limit', () => {
    const pending = { ...ANY_10, status: 'pending' }
    expect(dropCoveredMandates(planWith('1.00'), [pending]).covered).toBe(false)
  })

  it('refuses on a different asset or network', () => {
    expect(dropCoveredMandates(planWith('1.00', { asset: 'USDT' }), [ANY_10]).covered).toBe(false)
    expect(
      dropCoveredMandates(planWith('1.00', { network_id: 'base-sepolia' }), [ANY_10]).covered
    ).toBe(false)
  })

  it('needs EVERY payment to fit, not just the first', () => {
    const plan = [
      {
        actions: [
          { type: 'create_mandate', create_mandate: { rule: {} } },
          { type: 'create_scheduled_payments', create_scheduled_payments: { amount: '1.00', asset: 'USDC' } },
          { type: 'create_scheduled_payments', create_scheduled_payments: { amount: '9.00', asset: 'USDC' } },
        ],
      },
    ]
    expect(dropCoveredMandates(plan, [ANY_10]).covered).toBe(false)
  })

  it('is a no-op when the agent drafted no limit — the external_only case', () => {
    const plan = [
      { actions: [{ type: 'create_scheduled_payments', create_scheduled_payments: { amount: '1.00', asset: 'USDC' } }] },
    ]
    const out = dropCoveredMandates(plan, [ANY_10])
    expect(out.covered).toBe(false)
    expect(out.plan).toEqual(plan)
  })

  it('does not mutate the plan it was given', () => {
    const plan = planWith('1.00')
    const before = JSON.stringify(plan)
    dropCoveredMandates(plan, [ANY_10])
    expect(JSON.stringify(plan)).toBe(before)
  })

  it('makes the result auto-payable, which is the point', () => {
    const out = dropCoveredMandates(planWith('1.00'), [ANY_10])
    expect(verdictFor(out.plan)).toMatchObject({ auto: true })
  })
})
