import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * The visitor's scheduled payments, across their agents.
 *
 * Payee names are resolved here rather than shown as raw addresses. The
 * scheduled-payment row carries `recipient_id` and `address` but usually an
 * EMPTY `destination_label`, so without this every row reads "to
 * 0x8e10…8667" — which is technically true and useless to the person deciding
 * whether a payment should go out.
 *
 * Errors are NOT swallowed into an empty list. A platform failure rendered as
 * "no scheduled payments" is how a truthful agent gets accused of lying: it
 * said it scheduled the payment, and the UI showed nothing.
 */
export const GET = authed(async ({ tenancy, req }) => {
  const agentId = new URL(req.url).searchParams.get('agentId')
  const agents = (tenancy.agents ?? []).filter((a) => !agentId || a.id === agentId)
  const client = dakota()

  // Two maps: by id when the payment names a saved payee, by address for a
  // payment made straight to an address.
  //
  // Field names verified against a live response: recipients live under
  // /customers/{id}/recipients (a bare /recipients is a 404), and a
  // destination's address is `crypto_address`, not `address`.
  const byId = new Map<string, string>()
  const byAddress = new Map<string, string>()
  if (tenancy.customerId) {
    try {
      for await (const r of client.recipients.list(tenancy.customerId)) {
        const rec = r as {
          id?: string
          name?: string
          destinations?: { crypto_address?: string }[]
        }
        if (rec.id && rec.name) byId.set(rec.id, rec.name)
        for (const d of rec.destinations ?? []) {
          if (d.crypto_address && rec.name) byAddress.set(d.crypto_address.toLowerCase(), rec.name)
        }
      }
    } catch {
      // A missing payee book is cosmetic — fall back to addresses rather than
      // failing the whole list over a nicety.
    }
  }

  const payments = []
  for (const agent of agents) {
    if (!agent.signerId) continue
    for await (const p of client.scheduledPayments.list({ signer_id: agent.signerId } as never)) {
      const row = p as { recipient_id?: string; address?: string; destination_label?: string }
      payments.push({
        ...p,
        agentId: agent.id,
        agentName: agent.name,
        // Resolved name FIRST. destination_label is usually just the address
        // repeated, so letting it win renders every row as a hex string even
        // when the payee is saved and has a name.
        payee:
          (row.recipient_id ? byId.get(row.recipient_id) : '') ||
          (row.address ? byAddress.get(row.address.toLowerCase()) : '') ||
          (row.destination_label && !row.destination_label.startsWith('0x')
            ? row.destination_label
            : '') ||
          '',
      })
    }
  }

  // scheduled_at is a unix timestamp; soonest first, and undefined sorts last
  // so a malformed row does not jump to the top of the list.
  payments.sort((a, b) => (a.scheduled_at ?? Infinity) - (b.scheduled_at ?? Infinity))
  return NextResponse.json({ payments })
})
