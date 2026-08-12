import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

// Everything behind one payment.
//
// The scheduled-payments row carries ids, not facts: a destination_id, a
// mandate_id, a wallet_transaction_id. Answering "where did this money actually
// go, and what let it go there" means following all three — so it happens here,
// once, on demand, rather than being fetched for every row of a table nobody
// has clicked yet.
//
// Two of them are the point of the whole demo. The MANDATE is why the payment
// was allowed to run without anyone present. The wallet TRANSACTION is the hash
// that proves it did, which anyone watching can paste into a block explorer.

interface Detail {
  payment: Record<string, unknown>
  recipientName?: string
  bank?: {
    bankName?: string
    accountType?: string
    routingNumber?: string
    /** Masked. Never the full number — see below. */
    accountLabel?: string
  }
  crypto?: { address?: string; networkId?: string }
  mandate?: Record<string, unknown>
  transaction?: Record<string, unknown>
}

export const GET = authed(async ({ tenancy, req }) => {
  const id = new URL(req.url).pathname.split('/').pop() ?? ''
  if (!tenancy.customerId) return NextResponse.json({ error: 'no tenancy' }, { status: 409 })

  const client = dakota()

  // Scoped to THIS visitor's signers. Reading a payment by id alone would let
  // anyone with an id read another tenant's payment.
  const signerIds = new Set((tenancy.agents ?? []).map((a) => a.signerId).filter(Boolean))
  let payment: Record<string, unknown> | undefined
  for (const signer_id of signerIds) {
    for await (const p of client.scheduledPayments.list({ signer_id } as never)) {
      if ((p as { id?: string }).id === id) {
        payment = p as Record<string, unknown>
        break
      }
    }
    if (payment) break
  }
  if (!payment) return NextResponse.json({ error: 'no such payment' }, { status: 404 })

  const out: Detail = { payment }

  // The payee and the bank details behind destination_id. The recipients
  // endpoint returns account_number IN FULL, so only a masked label leaves this
  // route — the platform already computes one on the payment itself, and this
  // is the fallback for when it has not.
  const destinationId = payment.destination_id as string | undefined
  try {
    // customerId is POSITIONAL here, unlike most list endpoints. Passing it as
    // a param builds /customers/[object Object]/recipients and 404s.
    for await (const r of client.recipients.list(tenancy.customerId)) {
      const rec = r as { id?: string; name?: string; destinations?: Record<string, unknown>[] }
      const match = (rec.destinations ?? []).find((d) => d.destination_id === destinationId)
      if (!match) continue
      out.recipientName = rec.name
      if (match.aba_routing_number || match.bank_name) {
        const number = String(match.account_number ?? '')
        out.bank = {
          bankName: match.bank_name as string | undefined,
          accountType: match.account_type as string | undefined,
          routingNumber: match.aba_routing_number as string | undefined,
          accountLabel:
            (payment.destination_label as string | undefined) ??
            (number ? `••••${number.slice(-4)}` : undefined),
        }
      } else if (match.address) {
        out.crypto = {
          address: match.address as string,
          networkId: match.network_id as string | undefined,
        }
      }
      break
    }
  } catch (e) {
    console.warn('[payment] could not resolve the destination', e)
  }

  // The authority. Without this the drawer says what happened but not why it
  // was allowed to, which is the half worth showing.
  const mandateId = payment.mandate_id as string | undefined
  if (mandateId) {
    try {
      out.mandate = (await client.mandates.get(mandateId)) as Record<string, unknown>
    } catch (e) {
      console.warn('[payment] could not read the mandate', e)
    }
  }

  // The settlement, and the hash that proves it.
  const txId = payment.wallet_transaction_id as string | undefined
  if (txId) {
    try {
      out.transaction = (await client.transactions.get(txId)) as Record<string, unknown>
    } catch (e) {
      console.warn('[payment] could not read the transaction', e)
    }
  }

  return NextResponse.json(out)
})
