import { NextResponse } from 'next/server'
import { authed, body } from '@/lib/api'

/**
 * Which agent receives forwarded invoices.
 *
 * Exactly one, and claiming MOVES it rather than being refused — the same rule
 * as a Slack channel, for the same reason: there is one inbound address, so a
 * second claimant would make routing depend on row order, and refusing would
 * leave someone unable to change their mind without deleting an agent.
 *
 * Turning it off leaves nobody holding it, which is a legitimate state: the
 * inbound route then falls back to the first agent, exactly as it did before
 * anyone chose.
 */
export const POST = authed(async ({ tenancy, saveTenancy, req }) => {
  const agentId = req.url.split('/api/agents/')[1]?.split('/')[0] ?? ''
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })

  const { handlesEmail } = await body<{ handlesEmail?: boolean }>(req)
  const claim = handlesEmail !== false

  let releasedFrom = ''
  await saveTenancy((t) => {
    for (const a of t.agents ?? []) {
      if (a.id === agentId) {
        a.handlesEmail = claim
      } else if (claim && a.handlesEmail) {
        // Whoever had it loses it. Silently leaving two claimants would put the
        // routing back on creation order, which is the thing this replaces.
        releasedFrom = a.name
        delete a.handlesEmail
      }
    }
  })

  return NextResponse.json({ handlesEmail: claim, ...(releasedFrom ? { releasedFrom } : {}) })
})
