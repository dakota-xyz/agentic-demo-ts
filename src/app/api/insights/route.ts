import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * The account insight report.
 *
 * Everything on this page is computed by the platform and rendered verbatim —
 * this route adds no arithmetic of its own, and that is the point worth
 * demonstrating. The balances, the counts, the observations and the
 * recommendations all arrive in one response, each item carrying `evidence`:
 * typed references to the objects it was derived from.
 *
 * Recomputed server-side on every call, so it keeps up with payments firing in
 * the background rather than serving a stale cache.
 */
export const GET = authed(async ({ tenancy }) => {
  if (!tenancy.customerId) {
    return NextResponse.json({ error: 'tenancy is missing a customer id' }, { status: 409 })
  }

  const report = await dakota().insights.get(tenancy.customerId)
  return NextResponse.json({ report })
})
