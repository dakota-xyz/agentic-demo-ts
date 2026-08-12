import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'

/**
 * Treasury wallets and their balances.
 *
 * The platform returns `total_amount_usd` on the response and `amount_usd` per
 * asset — NOT `amount`. Reading the wrong field is silent: it yields 0.00 for a
 * funded wallet, which then reads as "you have no test funds" and sends the
 * visitor to a faucet they do not need.
 *
 * Balances are fetched per wallet in parallel; serially, two round trips would
 * be visible on every page load.
 */
export const GET = authed(async ({ tenancy }) => {
  const client = dakota()

  const wallets = await Promise.all(
    (tenancy.wallets ?? []).map(async (w) => {
      try {
        const res = await client.wallets.getBalances(w.id)
        return {
          ...w,
          totalUsd: res.total_amount_usd ?? '0.00',
          balances: (res.balances ?? []).map((b) => ({
            asset: b.asset?.id ?? '',
            name: b.asset?.name ?? '',
            network: b.asset?.network_id ?? '',
            amountUsd: b.amount_usd ?? '0.00',
          })),
        }
      } catch (e) {
        // One wallet failing must not blank the whole treasury: report it on
        // the row that failed and let the others render.
        return {
          ...w,
          totalUsd: '0.00',
          balances: [],
          error: e instanceof Error ? e.message : String(e),
        }
      }
    })
  )

  return NextResponse.json({ wallets })
})
