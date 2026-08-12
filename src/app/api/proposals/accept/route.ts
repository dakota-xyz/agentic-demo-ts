import { NextResponse } from 'next/server'
import { authed, body } from '@/lib/api'
import { acceptPlan } from '@/lib/accept'

/**
 * Approve a drafted plan from the browser.
 *
 * The work is in lib/accept, shared with the email path — an invoice covered by
 * a signed mandate accepts itself, and must do so by exactly the same route.
 */
export const POST = authed(async ({ user, tenancy, req }) => {
  const { agentId, proposals } = await body<{ agentId?: string; proposals?: unknown[] }>(req)

  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })

  // Fall back to the stored draft, so a reload between drafting and approving
  // does not lose the plan the visitor is looking at.
  const plan = proposals ?? (tenancy.proposals ?? {})[agent.id]
  if (!Array.isArray(plan) || plan.length === 0) {
    return NextResponse.json({ error: 'there is no drafted plan to approve' }, { status: 400 })
  }

  return NextResponse.json(await acceptPlan({ user, agent, plan }))
})
