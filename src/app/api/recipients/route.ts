import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * Everyone the visitor's agents can pay.
 *
 * Payees are created automatically the first time an agent pays someone new, so
 * this is mostly a record of what the conversations have built up — which is
 * the point: it shows that "pay Acme" became a real, reusable payee rather than
 * a one-off string.
 *
 * Lives under /customers/{id}/recipients on the platform; a bare /recipients is
 * a 404.
 */
export const GET = authed(async ({ tenancy }) => {
  if (!tenancy.customerId) return NextResponse.json({ payees: [] })

  const payees = []
  for await (const r of dakota().recipients.list(tenancy.customerId)) {
    const rec = r as {
      id?: string
      name?: string
      status?: string
      destinations?: {
        destination_id?: string
        crypto_address?: string
        network_id?: string
        family?: string
        name?: string
      }[]
    }
    payees.push({
      id: rec.id,
      name: rec.name,
      status: rec.status,
      destinations: (rec.destinations ?? []).map((d) => ({
        id: d.destination_id,
        address: d.crypto_address ?? '',
        network: d.network_id ?? '',
        family: d.family ?? '',
      })),
    })
  }
  payees.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  return NextResponse.json({ payees })
})
