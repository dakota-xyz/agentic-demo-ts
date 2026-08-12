import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * How much of each active spend limit is left.
 *
 * The platform meters every mandate against its window and will hand back the
 * arithmetic — committed, earmarked, remaining — which nothing in this app was
 * asking for. It is the only endpoint here that answers "can my agents still
 * spend, and how close are they to the wall", which is the question an agent
 * payments product exists to answer.
 *
 * Fanned out HERE rather than from the browser. Budget is per mandate, so a
 * client doing this itself makes N round trips and renders the chart in N
 * staggered pieces; one call that returns every line renders once.
 *
 * The figures are advisory by the platform's own description — nothing here
 * reserves budget and the mandate gate is still the authority at fire time —
 * so this is a chart, never a pre-flight check.
 */

/** One line of the chart: an active limit and its current window. */
export interface BudgetRow {
  mandateId: string
  agentId: string
  agentName: string
  /** Who the limit covers, for the row label. */
  targets: string[]
  /** The rule's asset — decimals below are denominated in it. */
  asset: string
  /** NONE | DAILY | WEEKLY | MONTHLY, verbatim. */
  window: string
  /** The bucket these figures cover, e.g. "2026-08" or "lifetime". */
  bucket: string
  /** Already fired and spent. Decimal string. */
  committed: string
  /** Scheduled, not yet fired — earmarked against the same bucket. */
  open: string
  /**
   * Still permitted, or null when the rule sets no amount ceiling.
   *
   * Null is "not capped", NEVER "none left" — the platform is explicit that
   * absence and zero mean opposite things, and drawing a full bar for an
   * uncapped limit would invert its meaning exactly where it matters.
   */
  remaining: string | null
  /**
   * The platform could not sum this bucket and the gate fails closed on the
   * same data, so a payment against it will be denied. Reported rather than
   * coerced: `"?"` read as 0 looks like a spent limit, and read as the cap
   * looks like headroom that is not there.
   */
  unsummable: boolean
}

export const GET = authed(async ({ tenancy }) => {
  const client = dakota()
  const rows: BudgetRow[] = []

  for (const agent of tenancy.agents ?? []) {
    if (!agent.signerId) continue

    for await (const m of client.mandates.list({ signer_id: agent.signerId } as never)) {
      const mandate = m as {
        id?: string
        status?: string
        target_names?: string[]
        rule?: { asset?: string }
      }
      // Only limits that can still spend. A revoked one has no budget worth
      // drawing, and a pending one has never metered anything.
      if (!mandate.id || mandate.status !== 'active') continue

      try {
        const budget = await client.mandates.getBudget(mandate.id)

        // The aggregate line is the ceiling on the agent as a whole, across
        // every payee. Per-target lines meter each payee separately and so
        // cannot be summed into one bar — three payees capped at 10k each is
        // not a 30k limit, and drawing it as one would say it was.
        //
        // Lines are chronological and no bucket earlier than the current one is
        // ever reported, so the head is the window in force right now.
        const line = budget.aggregate?.[0]
        if (!line) continue

        rows.push({
          mandateId: mandate.id,
          agentId: agent.id,
          agentName: agent.name,
          targets: mandate.target_names ?? [],
          asset: mandate.rule?.asset ?? '',
          window: budget.window,
          bucket: line.bucket,
          committed: line.committed_amount,
          open: line.open_amount,
          remaining: line.remaining_amount === '?' ? null : (line.remaining_amount ?? null),
          unsummable: line.remaining_amount === '?',
        })
      } catch {
        // One limit the platform cannot meter must not blank the chart for the
        // others. It simply does not get a bar.
        continue
      }
    }
  }

  return NextResponse.json({ budgets: rows })
})
