import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * The visitor's one-off convert-and-forward accounts.
 *
 * An auto-account is what lets a crypto treasury pay a bank. The agent's
 * schedule pays the account's crypto DEPOSIT; the provider converts the asset
 * and forwards it on — to a bank over ACH/wire (`offramp`), or to an address on
 * another chain family (`swap`).
 *
 * `account_type` is a REQUIRED filter on the platform's list endpoint, not an
 * optional one, so "all of them" means asking twice and concatenating. Sending
 * no type does not return everything; it returns an error.
 */
const TYPES = ['swap', 'offramp'] as const

export const GET = authed(async ({ tenancy }) => {
  if (!tenancy.customerId) return NextResponse.json({ accounts: [] })

  const client = dakota()
  const accounts: unknown[] = []

  // Sequential rather than parallel: two small reads, and a failure on the
  // second should not leave the first half-rendered.
  for (const account_type of TYPES) {
    try {
      for await (const a of client.accounts.list({
        account_type,
        customer_id: tenancy.customerId,
      } as never)) {
        accounts.push(a)
      }
    } catch (e) {
      // One account type failing must not blank the other. A sandbox that has
      // never seen an offramp answers unhelpfully rather than emptily.
      console.warn(`[auto-accounts] ${account_type} list failed`, e)
    }
  }

  return NextResponse.json({ accounts })
})
