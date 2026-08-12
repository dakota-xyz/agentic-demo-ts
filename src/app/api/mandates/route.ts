import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * The visitor's spend limits.
 *
 * "Spend limit" in the UI, "mandate" on the wire — the same object. Scoped by
 * the agent's signer id so one visitor's limits never include another's.
 *
 * This went through the SDK, then around it, and now through it again.
 * /mandates answers with a BARE ARRAY while most list endpoints return
 * {data, meta}, and the paginator read `response.data ?? []` — so
 * mandates.list() yielded nothing at all, silently, for limits that plainly
 * existed. Fixed in the SDK's paginator in v2.1.1 (which also caught
 * signerGroups.listForWallet() failing the same way), so the hand-rolled
 * fetch that worked around it is gone.
 */
export const GET = authed(async ({ tenancy, req }) => {
  const agentId = new URL(req.url).searchParams.get('agentId')
  const agents = (tenancy.agents ?? []).filter((a) => !agentId || a.id === agentId)

  const out = []
  for (const agent of agents) {
    if (!agent.signerId) continue
    for await (const m of dakota().mandates.list({ signer_id: agent.signerId } as never)) {
      out.push({ ...m, agentId: agent.id, agentName: agent.name })
    }
  }
  return NextResponse.json({ mandates: out })
})
