// Auto-pay: when a drafted plan needs no NEW authority, stop asking.
//
// An invoice arriving by email is the case where a click is most annoying and
// least useful. The person already decided — that is what the spend limit was
// for. Making them open the app to press "approve" on a payment their own
// signed mandate already covers is ceremony, not control.
//
// The decision is not ours to compute. When the agent drafts a plan it either
// includes a `create_mandate` action or it does not, and that IS the answer:
//
//   no create_mandate  ⇒ existing signed authority covers this ⇒ just pay it
//   create_mandate     ⇒ this needs authority you have not granted ⇒ ask
//
// Reading the plan's SHAPE rather than re-deriving amounts against rules
// matters, because a second implementation of "does this fit" is a second
// chance to get it wrong — and the two would disagree silently, in favour of
// paying. The platform already decides this once, at fire time; the drafted
// plan is that decision surfaced early.
//
// The platform is also the backstop. A scheduled payment with no covering
// mandate does not slip through — it FAILS when it fires, with reason
// "no mandate". So the worst case of being wrong here is a payment that does
// not happen, never one that should not have.

/** The one action that is safe without a human: spending inside existing authority. */
const SPEND = 'create_scheduled_payments'

interface Action {
  type?: string
  create_mandate?: { rule?: MandateRule }
  create_scheduled_payments?: {
    amount?: string
    asset?: string
    count?: number
    network_id?: string
  }
}

interface MandateRule {
  /** 'any' is what makes a limit STANDING rather than one payee's. */
  target_type?: string
  network_id?: string
  asset?: string
  max_per_tx?: string
  window?: string
  max_amount_in_window?: string
  max_count_in_window?: number
  max_amount_per_target_in_window?: string
  max_count_per_target_in_window?: number
}

export interface Proposal {
  summary?: string
  actions?: Action[]
}

export interface Mandate {
  status?: string
  target_names?: readonly string[]
  rule?: MandateRule
  valid_until?: number
}

export type Verdict =
  /** Covered by authority already signed. Accept it without asking. */
  | { auto: true; payments: number }
  /** Needs something the visitor has not authorised. `blocker` names what. */
  | { auto: false; blocker: 'new_limit' | 'setup' | 'nothing_to_do'; wants?: string }

function actionsOf(plan: readonly unknown[]): Action[] {
  return (plan as Proposal[]).flatMap((p) => (Array.isArray(p?.actions) ? p.actions : []))
}

/** A rule rendered the way a person would say it: "2.00 USDC per payment". */
export function describeRule(rule: MandateRule | undefined): string {
  if (!rule) return 'a new spend limit'
  const asset = rule.asset ?? 'USDC'
  const parts: string[] = []
  if (rule.max_per_tx) parts.push(`${rule.max_per_tx} ${asset} per payment`)

  const capAmount = rule.max_amount_in_window ?? rule.max_amount_per_target_in_window
  const capCount = rule.max_count_in_window ?? rule.max_count_per_target_in_window
  const window = (rule.window ?? 'NONE').toUpperCase()
  const per = { DAILY: 'per day', WEEKLY: 'per week', MONTHLY: 'per month' }[window]

  if (capAmount && per) parts.push(`${capAmount} ${asset} ${per}`)
  if (capCount) parts.push(`${capCount} payment${capCount === 1 ? '' : 's'}${per ? ` ${per}` : ' in total'}`)

  return parts.length ? parts.join(', up to ') : `payments in ${asset}`
}

/**
 * Decide whether a drafted plan can run without a human.
 *
 * Deliberately narrow: ONLY a plan made entirely of scheduled payments passes.
 * A plan that also adds a payee or opens an account is doing setup, and setup
 * arriving by email is exactly the shape a business-email-compromise attempt
 * takes — a forged invoice from a real address, naming a new payee. Those stop
 * and wait for a person even though no mandate would cover the new payee
 * anyway. Two independent reasons to refuse is the right number here.
 */
export function verdictFor(plan: readonly unknown[]): Verdict {
  const actions = actionsOf(plan)
  if (actions.length === 0) return { auto: false, blocker: 'nothing_to_do' }

  const mandate = actions.find((a) => a.type === 'create_mandate')
  if (mandate) {
    return { auto: false, blocker: 'new_limit', wants: describeRule(mandate.create_mandate?.rule) }
  }

  const other = actions.find((a) => a.type !== SPEND)
  if (other) return { auto: false, blocker: 'setup', wants: other.type }

  return { auto: true, payments: actions.length }
}

/** What the plan is asking to move, for a reply that quotes it back. */
export function amountRequested(plan: readonly unknown[]): string {
  const spends = actionsOf(plan).filter((a) => a.type === SPEND)
  const first = spends[0]?.create_scheduled_payments
  if (!first?.amount) return ''
  return `${first.amount} ${first.asset ?? 'USDC'}`
}

/**
 * The visitor's live authority, in plain English — the "which is X amount" half
 * of a refusal. A refusal that does not say what the limit IS just moves the
 * question to a second email.
 */
export function describeLimits(mandates: readonly Mandate[]): string {
  const active = mandates.filter((m) => m.status === 'active')
  if (active.length === 0) return 'You have no signed spend limits yet.'

  const lines = active.map((m) => {
    const who = m.target_names?.length ? m.target_names.join(', ') : 'any payee'
    return `  • ${who} — ${describeRule(m.rule)}`
  })
  return `Your signed spend limits:\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Standing limits, without the platform policy
// ---------------------------------------------------------------------------

/**
 * Drop a drafted limit that an already-signed standing limit covers.
 *
 * This is `mandate_strategy: external_only` done here rather than upstream.
 * The platform can be told once, per client, to stop the conversation drafting
 * limits at all — but that endpoint is not reachable with a customer API key
 * today, so the agent keeps proposing a fresh mandate alongside every payment
 * even when the visitor has already granted standing authority. Accepting it
 * would then ask for a signature that authorises nothing new.
 *
 * So: if a signed, active, any-payee limit already covers what is being
 * scheduled, the drafted `create_mandate` is removed and the plan goes through
 * on the authority that exists. The payment actions are untouched.
 *
 * SAFETY. Being wrong here cannot overspend. Stripping a mandate never grants
 * authority — it only declines to ask for more — and the platform still checks
 * every payment against its covering mandate when it fires. A payment this
 * misjudges fails with "no mandate"; it does not go out unauthorised. That
 * asymmetry is the whole reason this is safe to do client-side.
 *
 * Deliberately strict: same asset, same network, per-transaction headroom for
 * every scheduled payment. Anything it cannot confirm, it leaves alone, and
 * the visitor signs as before.
 *
 * Becomes a no-op once the policy IS registered, because the agent stops
 * sending create_mandate at all.
 */
export function dropCoveredMandates(
  plan: readonly unknown[],
  mandates: readonly Mandate[]
): { plan: unknown[]; covered: boolean } {
  const actions = actionsOf(plan)
  if (!actions.some((a) => a.type === 'create_mandate')) return { plan: [...plan], covered: false }

  const spends = actions
    .filter((a) => a.type === SPEND)
    .map((a) => a.create_scheduled_payments ?? {})
  if (spends.length === 0) return { plan: [...plan], covered: false }

  const standing = mandates.filter(
    (m) => m.status === 'active' && (m.rule?.target_type ?? '') === 'any'
  )

  const covers = (rule: MandateRule) =>
    spends.every((sp) => {
      const asset = sp.asset ?? 'USDC'
      if ((rule.asset ?? '') !== asset) return false
      // A rule naming no network covers any of them; one that names a network
      // covers only that network.
      const net = sp.network_id ?? ''
      if (rule.network_id && net && rule.network_id !== net) return false
      // No per-tx cap means the window cap alone bounds it, which the platform
      // enforces at fire time. A per-tx cap has to actually fit.
      if (!rule.max_per_tx) return true
      const amount = Number(sp.amount)
      return Number.isFinite(amount) && amount <= Number(rule.max_per_tx)
    })

  if (!standing.some((m) => covers(m.rule ?? {}))) return { plan: [...plan], covered: false }

  const stripped = (structuredClone(plan) as Proposal[]).map((batch) => ({
    ...batch,
    actions: (batch?.actions ?? []).filter((a) => a.type !== 'create_mandate'),
  }))
  return { plan: stripped as unknown[], covered: true }
}

/**
 * Every mandate bound to an agent's signer. Empty on any failure.
 *
 * Read at turn time rather than cached: a limit signed a second ago has to
 * count, and this is one small call against a page that is already waiting on
 * a model.
 */
export async function activeLimitsFor(signerId: string | undefined): Promise<Mandate[]> {
  if (!signerId) return []
  try {
    const { dakota } = await import('./dakota')
    const out: Mandate[] = []
    for await (const m of dakota().mandates.list({ signer_id: signerId } as never)) {
      out.push(m as Mandate)
    }
    return out
  } catch (e) {
    // A failed read must not silently make a covered payment ask for a
    // signature it does not need — but asking IS the safe direction, so this
    // degrades to the old behaviour rather than failing the turn.
    console.warn('[autopay] could not read limits', e)
    return []
  }
}
