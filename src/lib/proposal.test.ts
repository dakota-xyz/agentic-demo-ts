import { describe, it, expect } from 'vitest'
import { toMrkdwn } from './slack/mrkdwn'
import {
  networkFamily,
  planText,
  batchNetwork,
  injectScheduleWallets,
  planSteps,
  autoAccountSentence,
  ruleSentence,
  NoWalletForFamilyError,
} from './proposal'
import type { TreasuryWallet } from './store'

// The cross-family swap that motivates all of this, ported from the Go build's
// handlers_autoaccount_test.go. The crypto destination is the SOLANA target;
// the auto-account deposits on base-sepolia (EVM); the schedule pays that
// deposit. Fund it from the Solana wallet and the platform rejects it.
const swapPlan = [
  {
    actions: [
      {
        type: 'create_crypto_destination',
        create_crypto_destination: {
          network_id: 'solana-devnet',
          address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        },
      },
      {
        type: 'create_auto_account',
        create_auto_account: {
          source_network_id: 'base-sepolia',
          source_asset: 'USDC',
          output_asset: 'USDC',
        },
      },
      { type: 'create_scheduled_payments', create_scheduled_payments: { amount: '10', asset: 'USDC' } },
    ],
  },
]

const wallets: TreasuryWallet[] = [
  { id: 'w-evm', address: '0xevm', network: 'evm', groupId: 'g1', policyId: 'p1' },
  { id: 'w-sol', address: 'sol1', network: 'solana', groupId: 'g2', policyId: 'p2' },
]

describe('networkFamily', () => {
  it.each([
    ['ethereum-sepolia', 'evm'],
    ['base-sepolia', 'evm'],
    ['arbitrum-sepolia', 'evm'],
    ['optimism', 'evm'],
    ['polygon-amoy', 'evm'],
    ['solana-devnet', 'solana'],
    ['solana', 'solana'],
    ['SOLANA-DEVNET', 'solana'],
    ['  base-sepolia  ', 'evm'],
  ])('%s -> %s', (net, want) => {
    expect(networkFamily(net)).toBe(want)
  })

  it('has NO OPINION on a network it does not know', () => {
    // '' must read as "no opinion", never as "not EVM" — a wrong guess here
    // funds a payment from a wallet on the wrong chain.
    for (const n of ['bitcoin', 'tron', 'stellar-testnet', '', undefined]) {
      expect(networkFamily(n), String(n)).toBe('')
    }
  })
})

describe('batchNetwork', () => {
  it('prefers the auto-account deposit over the crypto destination', () => {
    // The whole point: the destination is the SWAP TARGET (Solana), the deposit
    // is what actually gets paid (EVM).
    expect(batchNetwork(swapPlan[0].actions)).toBe('base-sepolia')
  })

  it('falls back to the crypto destination when there is no auto-account', () => {
    expect(
      batchNetwork([
        { type: 'create_crypto_destination', create_crypto_destination: { network_id: 'solana-devnet' } },
      ])
    ).toBe('solana-devnet')
  })

  it('falls back to the mandate rule', () => {
    expect(
      batchNetwork([
        { type: 'create_mandate', create_mandate: { rule: { network_id: 'ethereum-sepolia' } } },
      ])
    ).toBe('ethereum-sepolia')
  })

  it('is empty when nothing names a network', () => {
    expect(batchNetwork([{ type: 'create_scheduled_payments', create_scheduled_payments: {} }])).toBe('')
    expect(batchNetwork([])).toBe('')
  })
})

describe('injectScheduleWallets', () => {
  it('funds a cross-family swap from the DEPOSIT network wallet', () => {
    const out = injectScheduleWallets(swapPlan, wallets) as typeof swapPlan
    const sp = out[0].actions.find((a) => a.type === 'create_scheduled_payments')!
    expect((sp.create_scheduled_payments as Record<string, unknown>).wallet_id).toBe('w-evm')
  })

  it('does NOT drop the auto-account action on the round trip', () => {
    // The Go build has a regression test with this exact name, because
    // rewriting proposals through a typed struct deleted the action silently.
    const out = injectScheduleWallets(swapPlan, wallets) as typeof swapPlan
    expect(out[0].actions.some((a) => a.type === 'create_auto_account')).toBe(true)
    expect(out[0].actions).toHaveLength(3)
  })

  it('preserves an action type it has never heard of, verbatim', () => {
    const plan = [
      {
        actions: [
          { type: 'create_mandate', create_mandate: { rule: { network_id: 'ethereum-sepolia' } } },
          { type: 'create_something_new', create_something_new: { magic: 42, nested: { deep: true } } },
          { type: 'create_scheduled_payments', create_scheduled_payments: { amount: '1' } },
        ],
      },
    ]
    const out = injectScheduleWallets(plan, wallets) as typeof plan
    expect(out[0].actions[1]).toEqual(plan[0].actions[1])
  })

  it('respects an explicit wallet_id — a caller who chose deserves to have chosen', () => {
    const plan = [
      {
        actions: [
          { type: 'create_crypto_destination', create_crypto_destination: { network_id: 'ethereum-sepolia' } },
          { type: 'create_scheduled_payments', create_scheduled_payments: { wallet_id: 'w-chosen' } },
        ],
      },
    ]
    const out = injectScheduleWallets(plan, wallets) as typeof plan
    expect((out[0].actions[1].create_scheduled_payments as Record<string, unknown>).wallet_id).toBe('w-chosen')
  })

  it('leaves the payment alone when the network is unrecognised', () => {
    // Better the platform decides than we guess a family wrong.
    const plan = [
      {
        actions: [
          { type: 'create_crypto_destination', create_crypto_destination: { network_id: 'bitcoin' } },
          { type: 'create_scheduled_payments', create_scheduled_payments: { amount: '1' } },
        ],
      },
    ]
    const out = injectScheduleWallets(plan, wallets) as typeof plan
    expect((out[0].actions[1].create_scheduled_payments as Record<string, unknown>).wallet_id).toBeUndefined()
  })

  it('refuses, by name, when no wallet exists for the family', () => {
    const evmOnly = [wallets[0]]
    const plan = [
      {
        actions: [
          { type: 'create_crypto_destination', create_crypto_destination: { network_id: 'solana-devnet' } },
          { type: 'create_scheduled_payments', create_scheduled_payments: { amount: '1' } },
        ],
      },
    ]
    expect(() => injectScheduleWallets(plan, evmOnly)).toThrow(NoWalletForFamilyError)
    expect(() => injectScheduleWallets(plan, evmOnly)).toThrow(/solana/)
  })

  it('does not mutate the plan it was given', () => {
    // The same object is held in the stored draft and re-rendered after accept.
    const before = JSON.stringify(swapPlan)
    injectScheduleWallets(swapPlan, wallets)
    expect(JSON.stringify(swapPlan)).toBe(before)
  })

  it('handles an empty plan and empty wallets without throwing', () => {
    expect(injectScheduleWallets([], wallets)).toEqual([])
    expect(injectScheduleWallets([{ actions: [] }], [])).toEqual([{ actions: [] }])
  })
})

describe('autoAccountSentence', () => {
  it('renders a crypto→crypto swap', () => {
    expect(
      autoAccountSentence({ source_asset: 'USDC', source_network_id: 'base-sepolia', output_asset: 'USDC' })
    ).toBe('USDC on base-sepolia → USDC')
  })

  it('renders a crypto→bank offramp, naming the rail', () => {
    expect(
      autoAccountSentence({
        source_asset: 'USDC',
        source_network_id: 'base-sepolia',
        output_asset: 'USD',
        rail: 'ach',
      })
    ).toBe('USDC on base-sepolia → USD to the bank via ACH')
  })

  it('reads destination_rail too, which is what the list endpoint returns', () => {
    expect(autoAccountSentence({ source_asset: 'USDC', destination_asset: 'USD', destination_rail: 'fedwire' })).toBe(
      'USDC → USD to the bank via FEDWIRE'
    )
  })
})

describe('planSteps', () => {
  it('renders every action in a swap plan, including the auto-account', () => {
    const steps = planSteps(swapPlan)
    expect(steps.map((s) => s.type)).toEqual([
      'create_crypto_destination',
      'create_auto_account',
      'create_scheduled_payments',
    ])
    expect(steps[1].detail).toBe('USDC on base-sepolia → USDC')
    expect(steps[1].note).toContain('base-sepolia')
  })

  it('gives the scheduled payment the batch network when it carries none', () => {
    const steps = planSteps(swapPlan)
    const sched = steps.find((s) => s.type === 'create_scheduled_payments')!
    expect(sched.detail).toBe('10 USDC on base-sepolia')
  })

  it('still renders an action it does not recognise, rather than hiding it', () => {
    // Approving what you cannot see is the failure this screen exists to stop.
    const steps = planSteps([{ actions: [{ type: 'create_something_new', create_something_new: {} }] }])
    expect(steps).toHaveLength(1)
    expect(steps[0].title).toBe('create something new')
  })

  it('survives junk', () => {
    expect(planSteps([])).toEqual([])
    expect(planSteps([{ actions: null }] as unknown[])).toEqual([])
    expect(planSteps([null, undefined] as unknown[])).toEqual([])
  })
})

describe('ruleSentence', () => {
  it('renders a per-payment cap with its network', () => {
    expect(ruleSentence({ asset: 'USDC', max_per_tx: '2', network_id: 'ethereum-sepolia' })).toBe(
      'up to 2 USDC per payment on ethereum-sepolia'
    )
  })

  it('renders a windowed count', () => {
    expect(ruleSentence({ asset: 'USDC', max_per_tx: '2', window: 'MONTHLY', max_count_per_target_in_window: 1 })).toBe(
      'up to 2 USDC per payment, once per month'
    )
  })

  it('is empty for no rule', () => {
    expect(ruleSentence(undefined)).toBe('')
  })
})

describe('planText', () => {
  it('renders every step, marking the supporting ones', () => {
    const out = planText(swapPlan)
    expect(out).toContain('↳ Convert & forward — USDC on base-sepolia → USDC')
    expect(out).toContain('Schedule payment — 10 USDC on base-sepolia')
    // The auto-account's note is the bit that explains the indirection.
    expect(out).toContain('You pay its deposit on base-sepolia')
  })

  it('survives Slack mrkdwn without losing structure', () => {
    // mrkdwn rewrites "- " into a bullet and strips horizontal rules, so the
    // Slack caller passes • deliberately. If that ever regresses, the plan
    // turns into an unreadable run of lines in the channel.
    const out = toMrkdwn(planText(swapPlan, { bullet: '•' }))
    expect(out).toContain('• Schedule payment')
    expect(out).toContain('↳ Convert & forward')
    // mrkdwn must not eat the arrows or collapse the lines together.
    expect(out).toContain('↳ Add crypto address')
    expect(out.split('\n').length).toBeGreaterThan(3)
  })

  it('takes a plain bullet for email', () => {
    expect(planText(swapPlan, { bullet: '-' })).toContain('- Schedule payment')
  })

  it('is empty for an empty plan, so callers can skip the block', () => {
    expect(planText([])).toBe('')
  })
})
