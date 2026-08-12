// Reading and completing a drafted plan.
//
// The agent proposes ACTIONS; this turns them into something a person can
// check before approving, and fills in the one field the agent cannot know:
// which treasury wallet funds each payment.
//
// Everything here treats a proposal as loose JSON rather than a typed object,
// on purpose. `type` is an OPEN set — the platform adds actions — and a build
// that has never heard of one must pass it through untouched rather than drop
// it. That failure mode is not hypothetical: the Go build has a regression test
// named for it, because rewriting proposals through a typed struct silently
// deleted `create_auto_account` on the way to the platform.

import type { TreasuryWallet } from './store'

export interface Action {
  type?: string
  [key: string]: unknown
}

export interface Proposal {
  summary?: string
  actions?: Action[]
}

/**
 * Which chain family a network belongs to.
 *
 * Returns '' for anything unrecognised, which callers must read as "no opinion"
 * rather than "not EVM" — guessing wrong here funds a payment from a wallet on
 * the wrong chain.
 */
export function networkFamily(networkId?: string): string {
  const n = (networkId ?? '').trim().toLowerCase()
  if (!n) return ''
  if (n.startsWith('solana')) return 'solana'
  const chain = n.includes('-') ? n.slice(0, n.indexOf('-')) : n
  switch (chain) {
    case 'ethereum':
    case 'base':
    case 'arbitrum':
    case 'optimism':
    case 'polygon':
      return 'evm'
    default:
      return ''
  }
}

/** The body of an action, whichever key it arrived under. */
function actionBody(action: Action, key: string): Record<string, unknown> | undefined {
  const v = action?.[key]
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

/**
 * The network a batch of actions actually pays on.
 *
 * An auto-account redirects the schedule to its crypto DEPOSIT on
 * `source_network_id`, so that is the network the funding wallet must match —
 * NOT the crypto destination, which is the swap/offramp TARGET and may be on a
 * different family entirely. A Solana-bound swap is funded from the EVM
 * treasury, because the deposit it pays is on EVM. Hence: auto-accounts win
 * over everything else.
 */
export function batchNetwork(actions: Action[]): string {
  for (const a of actions ?? []) {
    const auto = actionBody(a, 'create_auto_account')
    const net = auto?.source_network_id
    if (typeof net === 'string' && net) return net
  }
  for (const a of actions ?? []) {
    const dest = actionBody(a, 'create_crypto_destination')
    const net = dest?.network_id
    if (typeof net === 'string' && net) return net
  }
  for (const a of actions ?? []) {
    const rule = actionBody(actionBody(a, 'create_mandate') ?? {}, 'rule')
    const net = rule?.network_id
    if (typeof net === 'string' && net) return net
  }
  for (const a of actions ?? []) {
    const sp = actionBody(a, 'create_scheduled_payments')
    const net = sp?.network_id
    if (typeof net === 'string' && net) return net
  }
  return ''
}

export class NoWalletForFamilyError extends Error {
  constructor(readonly family: string) {
    super(
      `This account has no ${family} treasury wallet, so a ${family} payment cannot be funded.`
    )
    this.name = 'NoWalletForFamilyError'
  }
}

/**
 * Name the funding wallet on every scheduled payment that lacks one.
 *
 * The agent drafts what to pay and to whom; it does not know which of the
 * visitor's wallets holds the money, and picking the wrong family is not a
 * near miss — the platform rejects it.
 *
 * Structure-preserving by construction: it walks the parsed JSON and assigns
 * one field, so actions it does not understand survive verbatim. See the note
 * at the top of this file for why that is load-bearing.
 *
 * An explicit `wallet_id` is always left alone; a caller who chose deserves to
 * have chosen.
 *
 * @throws {NoWalletForFamilyError}
 */
export function injectScheduleWallets(
  plan: readonly unknown[],
  wallets: readonly TreasuryWallet[]
): unknown[] {
  // TreasuryWallet.network holds the FAMILY ('evm' | 'solana'), not a network
  // id — every agent is attached to every wallet, so family is the only thing
  // that has to match.
  const byFamily = new Map<string, string>()
  for (const w of wallets ?? []) if (w?.network && w.id) byFamily.set(w.network, w.id)

  // Deep-cloned so a caller's stored draft is never mutated underneath it: the
  // same plan object is held in the transcript and re-rendered after accept.
  const out = structuredClone(plan) as Proposal[]

  for (const batch of out) {
    const actions = Array.isArray(batch?.actions) ? batch.actions : []
    const family = networkFamily(batchNetwork(actions))

    for (const action of actions) {
      const sp = actionBody(action, 'create_scheduled_payments')
      if (!sp) continue
      if (typeof sp.wallet_id === 'string' && sp.wallet_id) continue
      if (!family) continue // unknown network — let the platform decide

      const walletId = byFamily.get(family)
      if (!walletId) throw new NoWalletForFamilyError(family)
      sp.wallet_id = walletId
    }
  }

  return out as unknown[]
}

// ---------------------------------------------------------------------------
// Rendering a plan in plain English
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

function windowWord(w?: unknown): string {
  switch (str(w).toUpperCase()) {
    case 'MONTHLY':
      return 'month'
    case 'WEEKLY':
      return 'week'
    case 'DAILY':
      return 'day'
    default:
      return ''
  }
}

/** A mandate rule as a sentence: "up to 2 USDC per payment, once per month". */
export function ruleSentence(rule?: Record<string, unknown>, validUntil?: number): string {
  if (!rule) return ''
  const asset = str(rule.asset) || 'USDC'
  const parts: string[] = []

  if (rule.max_per_tx) {
    parts.push(
      `up to ${str(rule.max_per_tx)} ${asset} per payment${
        rule.network_id ? ` on ${str(rule.network_id)}` : ''
      }`
    )
  } else if (rule.network_id) {
    parts.push(`on ${str(rule.network_id)}`)
  }

  const period = windowWord(rule.window)
  const n = rule.max_count_per_target_in_window ?? rule.max_count_in_window
  if (period && typeof n === 'number') parts.push(n === 1 ? `once per ${period}` : `${n}× per ${period}`)
  else if (period) parts.push(`per ${period}`)

  const cap = rule.max_amount_per_target_in_window ?? rule.max_amount_in_window
  if (cap) parts.push(`max ${str(cap)} ${asset} per ${period || 'window'}`)

  let s = parts.join(', ')
  if (validUntil) s += `${s ? ' · ' : ''}valid until ${new Date(validUntil * 1000).toLocaleDateString()}`
  return s
}

/**
 * A one-off auto-account as a sentence.
 *
 * Two shapes: a crypto→crypto swap ("USDC on base-sepolia → USDC") and a
 * crypto→bank offramp ("USDC on base-sepolia → USD to the bank via ACH"). The
 * schedule pays the account's deposit; the provider converts and forwards.
 */
export function autoAccountSentence(a: Record<string, unknown>): string {
  const src = `${str(a.source_asset) || 'your crypto'}${
    a.source_network_id ? ` on ${str(a.source_network_id)}` : ''
  }`
  const out = str(a.output_asset) || str(a.destination_asset)
  const rail = str(a.rail) || str(a.destination_rail)
  if (rail) return `${src} → ${out || 'fiat'} to the bank via ${rail.toUpperCase()}`
  return out ? `${src} → ${out}` : src
}

/** A scheduled payment as a sentence. */
export function scheduleSentence(sp: Record<string, unknown>, fallbackNetwork?: string): string {
  const amount = `${str(sp.amount)} ${str(sp.asset) || 'USDC'}`.trim()
  const net = str(sp.network_id) || fallbackNetwork || ''
  const head = net ? `${amount} on ${net}` : amount

  const dates = Array.isArray(sp.dates) ? (sp.dates as number[]) : []
  if (dates.length) {
    const when = dates.map((d) => new Date(d * 1000).toLocaleDateString()).join(', ')
    return `${head}${net ? ' · ' : ' on '}${when}`
  }
  if (typeof sp.count === 'number' && sp.count > 1) return `${head} × ${sp.count}`
  return head
}

export interface Step {
  /** The action key, e.g. 'create_auto_account'. */
  type: string
  title: string
  detail: string
  /** A clarifying line, where the action deserves one. */
  note?: string
  /** True for steps that support another step rather than standing alone. */
  sub?: boolean
}

/**
 * A plan as text, for the channels that have no React.
 *
 * Slack and email describe a plan in the agent's PROSE, which is the one place
 * the two can diverge — an offramp reads exactly like an ordinary payment when
 * written out, and only the actions say the money is being converted and sent
 * to a bank. The browser got a rendered preview for that reason; these channels
 * need the same facts in the only form they can carry.
 *
 * `bullet` differs per channel because Slack renders "- " as a list and eats the
 * indentation that shows which step supports which.
 */
export function planText(plan: readonly unknown[], opts?: { bullet?: string; indent?: string }): string {
  const bullet = opts?.bullet ?? '•'
  const indent = opts?.indent ?? '   '
  const lines: string[] = []

  for (const step of planSteps(plan)) {
    const head = step.detail ? `${step.title} — ${step.detail}` : step.title
    lines.push(step.sub ? `${indent}↳ ${head}` : `${bullet} ${head}`)
    if (step.note) lines.push(`${indent}${step.sub ? '  ' : ''}${step.note}`)
  }

  return lines.join('\n')
}

const TITLES: Record<string, string> = {
  create_recipient: 'Add payee',
  create_crypto_destination: 'Add crypto address',
  create_bank_destination: 'Add bank account',
  create_mandate: 'Spend limit',
  create_scheduled_payments: 'Schedule payment',
  create_auto_account: 'Convert & forward',
}

/**
 * A plan as an ordered list of steps a person can check.
 *
 * Unknown action types still produce a step — named by their raw key — because
 * silently rendering nothing would let a plan do something the approver never
 * saw. Approving what you cannot see is the failure this whole screen exists to
 * prevent.
 */
export function planSteps(plan: readonly unknown[]): Step[] {
  const steps: Step[] = []

  for (const batch of (plan ?? []) as Proposal[]) {
    const actions = Array.isArray(batch?.actions) ? batch.actions : []
    const net = batchNetwork(actions)

    for (const action of actions) {
      const type = str(action?.type) || Object.keys(action ?? {}).find((k) => k !== 'type') || 'action'
      const body = actionBody(action, type) ?? {}

      switch (type) {
        case 'create_recipient':
          steps.push({ type, title: TITLES[type], detail: str(body.name) || 'a new payee' })
          break

        case 'create_crypto_destination':
          steps.push({
            type,
            title: TITLES[type],
            detail: `${str(body.address)}${body.network_id ? ` on ${str(body.network_id)}` : ''}`,
            sub: true,
          })
          break

        case 'create_bank_destination':
          steps.push({
            type,
            title: TITLES[type],
            detail:
              str(body.bank_name) ||
              str(body.account_holder_name) ||
              (body.iban ? `IBAN ${str(body.iban)}` : 'a bank account'),
            sub: true,
          })
          break

        case 'create_mandate':
          steps.push({
            type,
            title: TITLES[type],
            detail: ruleSentence(actionBody(action, type)?.rule as Record<string, unknown>, body.valid_until as number),
            note: 'You sign this with your passkey — nothing moves without it.',
          })
          break

        case 'create_scheduled_payments':
          steps.push({
            type,
            title: TITLES[type],
            detail: scheduleSentence(body, net),
          })
          break

        case 'create_auto_account':
          steps.push({
            type,
            title: body.rail ? 'Convert & send to bank' : TITLES[type],
            detail: autoAccountSentence(body),
            note: `A one-off account converts your funds and forwards them to the payee. You pay its deposit on ${
              str(body.source_network_id) || "your wallet's network"
            }.`,
            sub: true,
          })
          break

        default:
          steps.push({ type, title: type.replace(/_/g, ' '), detail: '' })
      }
    }
  }

  return steps
}
