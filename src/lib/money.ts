// What a limit is called on screen.
//
// A limit is STORED in the stablecoin it governs — USDC on some chain — because
// that is the leg the platform actually enforces. It is SHOWN in dollars,
// because that is the thing the person setting it is thinking about.
//
// The two are 1:1, so nothing is lost in the translation, and a screen that
// says "5 USDC on Ethereum Sepolia" has replaced the customer's question ("how
// much may this agent spend?") with ours ("how is this deployment plumbed?").
// Financial Account made the same call and wrote down why: an agent that read
// the stored asset once told a customer their limit "only covers RD on Base
// Sepolia" — plumbing they never chose and never see.

/** Stablecoins that are worth a dollar, and can therefore be shown as one. */
const DOLLAR_STABLECOINS = new Set(['USDC', 'USDT', 'PYUSD', 'RD', 'DAI'])

/** The unit a limit is written in, for a human. */
export const LIMIT_CURRENCY = 'USD'

/**
 * How to label an amount held in `asset`.
 *
 * A dollar stablecoin reads as USD; anything else keeps its own name, because
 * calling it dollars would then be a claim about its value rather than a
 * simplification of its plumbing.
 */
export function currencyLabel(asset: string | undefined): string {
  if (!asset) return LIMIT_CURRENCY
  return DOLLAR_STABLECOINS.has(asset.toUpperCase()) ? LIMIT_CURRENCY : asset
}
