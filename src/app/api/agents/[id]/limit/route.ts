import { NextResponse } from 'next/server'
import { authed, body } from '@/lib/api'
import { dakota } from '@/lib/dakota'

// The agent's standing spend limit.
//
// One limit per agent, set here by a person, rather than a fresh mandate
// drafted alongside every payment. That inversion is the whole point: the
// authority is granted ONCE and the conversation spends inside it, instead of
// asking for a new signature each time it wants to move money.
//
// It is an ordinary mandate on the wire, so nothing downstream is special —
// it arrives `pending`, appears in the Limits table, and is signed with the
// same passkey flow as any other. What changes is who drafted it and how often.

/** How long a standing limit lasts unless the caller says otherwise: one year. */
const DEFAULT_DAYS = 365

/**
 * The asset a limit is metered in.
 *
 * Not asked for. Which stablecoin is a fact about how this deployment is
 * plumbed, not a choice the person setting a spending limit has any basis to
 * make. Financial Account resolves it server-side from the account for the same
 * reason, and shows every dollar stablecoin as plain USD.
 */
const ASSET = process.env.DEMO_LIMIT_ASSET ?? 'USDC'

export const POST = authed(async ({ tenancy, req }) => {
  const agentId = new URL(req.url).pathname.split('/').slice(-2)[0]
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })
  if (!tenancy.customerId) {
    return NextResponse.json({ error: 'tenancy is missing a customer id' }, { status: 409 })
  }

  const {
    amount,
    window = 'MONTHLY',
    days = DEFAULT_DAYS,
  } = await body<{
    amount?: string
    window?: 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY'
    days?: number
  }>(req)

  if (!amount || Number(amount) <= 0) {
    return NextResponse.json({ error: 'give the limit an amount above zero' }, { status: 400 })
  }

  // target_type 'any' is what makes this a STANDING limit rather than one
  // payee's: it bounds what the agent may spend in total, leaving who to pay
  // to the conversation. A recipient-scoped rule would be back to one mandate
  // per payee, which is the thing this replaces.
  // NO network_id, deliberately.
  //
  // A rule that names one is refused outright where that network does not
  // exist — a hardcoded "ethereum-sepolia" is fine on sandbox and dies on
  // production with `unknown network "ethereum-sepolia"`. There is nothing to
  // substitute it with either: /info/networks reports the same list on both, so
  // it cannot tell them apart, and an unfunded treasury has no balances to read
  // a live network off.
  //
  // Omitting it is not a workaround. A spending limit is a statement about how
  // much an agent may move, and it holds whichever chain the payment settles
  // on — which is also the only version of it the customer could restate,
  // having never been shown a chain.
  const rule: Record<string, unknown> = {
    target_type: 'any',
    asset: ASSET,
    window,
    // The cap the window applies to. With window NONE this is a lifetime total,
    // which is a legitimate way to say "this much, ever".
    max_amount_in_window: amount,
  }

  // EXACTLY ONE binding. The platform refuses `payment_agent_id` alongside
  // `signer_id`/`customer_id` — "provide exactly one binding" — and the agent
  // is the right one here: the limit belongs to the agent, not to whoever
  // happened to set it.
  const mandate = await dakota().mandates.create({
    payment_agent_id: agent.id,
    rule,
    valid_until: Math.floor(Date.now() / 1000) + days * 86400,
  } as never)

  // Unsigned on purpose. Creating a limit is not granting it — the visitor
  // still signs the §8 payload with their passkey, which is the only thing
  // that gives an agent any authority at all.
  return NextResponse.json({ mandate })
})
