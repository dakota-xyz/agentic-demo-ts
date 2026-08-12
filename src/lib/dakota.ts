import { DakotaClient, Environment, APIError } from '@dakota-xyz/ts-sdk'

// The Dakota platform client.
//
// This is the file the repo exists to show: everything the demo does upstream
// goes through @dakota-xyz/ts-sdk, with no hand-rolled HTTP, no hand-rolled
// canonicalisation, and no generated-client drift to babysit.
//
// One API key serves every visitor. Tenancy is NOT the key — it is the platform
// customer created per visitor (see ensureCustomer), so one visitor's agents,
// wallets, payees and payments are invisible to another's.

const globalForDakota = globalThis as unknown as { dakota?: DakotaClient }

/**
 * Which Dakota environment to talk to. Sandbox unless told otherwise.
 *
 * The SDK already maps every environment to its host, so this names the
 * environment rather than restating a URL the SDK owns. Naming it is also the
 * safer half of the SDK's `baseURL` / `environment` pair: an unrecognised name
 * throws here, whereas a mistyped `baseURL` silently OUTRANKS `environment`
 * and points the demo at nothing, which looks like an outage rather than a
 * typo.
 *
 * Only these two, deliberately — NOT every value the SDK's enum carries. The
 * others name environments that are ours rather than a reader's, and a demo
 * that offers them puts an unreachable host one typo away and says the name
 * out loud while doing it.
 */
const ENVIRONMENTS: readonly Environment[] = [Environment.Sandbox, Environment.Production]

export function dakotaEnvironment(): Environment {
  const name = (process.env.DAKOTA_ENV ?? '').trim().toLowerCase() || Environment.Sandbox
  const match = ENVIRONMENTS.find((e) => e === name)
  if (!match) {
    throw new Error(
      `DAKOTA_ENV="${name}" is not a Dakota environment — expected ${ENVIRONMENTS.join(' or ')}`
    )
  }
  return match
}

/**
 * Whether the demo is pointed at sandbox.
 *
 * Read this rather than sniffing a URL: it is the difference between knowing
 * the environment and inferring it, and the things it guards (KYB overrides,
 * test funds) are the ones where inferring wrong is expensive.
 */
export function isSandbox(): boolean {
  return dakotaEnvironment() === Environment.Sandbox
}

/**
 * The shared client, cached per warm container.
 *
 * Built lazily rather than at module scope so that importing this file during a
 * build — which Next does — cannot fail on a missing key.
 */
export function dakota(): DakotaClient {
  const apiKey = process.env.DAKOTA_API_KEY
  if (!apiKey) {
    throw new Error('DAKOTA_API_KEY is not set — the demo cannot reach the platform')
  }
  globalForDakota.dakota ??= new DakotaClient({
    apiKey,
    // The environment, never a baseURL — the SDK holds the URLs, and passing
    // both would let the URL win silently.
    environment: dakotaEnvironment(),
    // NO client-wide timeout, deliberately. Since v2.1.1 an explicit one
    // outranks the per-endpoint defaults, so setting a single number here would
    // silently re-impose a read-sized deadline on agent turns — which is the
    // exact bug this app reported. Left unset, each endpoint gets the deadline
    // it was sized for, and a turn that needs longer says so per conversation.
  })
  return globalForDakota.dakota
}

/**
 * Networks the demo will operate on.
 *
 * Testnets by default, because that is what a public demo should move. A
 * deployment pointed at production sets DEMO_NETWORKS instead — a hardcoded
 * testnet list is how "unknown network \"ethereum-sepolia\"" reaches a
 * customer who never chose a chain in the first place.
 */
export const ALLOWED_NETWORKS = (
  process.env.DEMO_NETWORKS
    ? process.env.DEMO_NETWORKS.split(',').map((n) => n.trim()).filter(Boolean)
    : [
        'base-sepolia',
        'ethereum-sepolia',
        'arbitrum-sepolia',
        'optimism-sepolia',
        'polygon-amoy',
        'solana-devnet',
      ]
) as readonly string[]

export type Network = string

/**
 * Turn a platform failure into something a visitor can read.
 *
 * The rule is to never swallow one. An earlier version of this demo logged the
 * error and rendered an empty list, so a platform outage looked exactly like
 * "you have no scheduled payments" — the agent got blamed for lying when it had
 * been truthful and the UI was hiding a 500. Say what broke.
 */
export function explainError(e: unknown): string {
  if (e instanceof APIError) {
    const detail = e.message?.trim()
    if (!detail || detail === 'Unknown error') return `The platform rejected that (${e.statusCode}).`
    return humanise(detail)
  }
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * Rewrite the platform's field-path validation errors as sentences.
 *
 * These arrive addressed to whoever wrote the request, not to whoever is
 * reading the screen:
 *
 *   Validation Error: Request body validation failed - field
 *   'proposals/0/actions/0/create_recipient/name': minimum string length is 3
 *
 * The person who typed "pay QA 1 USD" has no way to connect that to a two-letter
 * payee name, and nothing in it tells them what to do instead. Only patterns
 * seen in practice are translated; anything else is passed through unchanged,
 * because a wrong guess about an unfamiliar error is worse than a raw one.
 */
function humanise(detail: string): string {
  const field = /field '([^']+)'/.exec(detail)?.[1] ?? ''
  const leaf = field.split('/').pop() ?? ''

  if (/minimum string length is (\d+)/.test(detail)) {
    const min = /minimum string length is (\d+)/.exec(detail)![1]
    if (leaf === 'name') {
      return `That name is too short — the platform needs at least ${min} characters. Try asking again with a longer payee name.`
    }
    return `"${leaf}" is too short — it needs at least ${min} characters.`
  }

  if (/maximum string length is (\d+)/.test(detail)) {
    const max = /maximum string length is (\d+)/.exec(detail)![1]
    return `"${leaf}" is too long — the platform allows at most ${max} characters.`
  }

  if (leaf && /is required|required field/i.test(detail)) {
    return `The platform needs "${leaf}", and this plan did not include it.`
  }

  return detail
}

/** The HTTP status to answer with for a platform failure. */
export function errorStatus(e: unknown): number {
  if (e instanceof APIError) {
    // 4xx is the visitor's problem and worth showing verbatim; 5xx is ours and
    // becomes a 502, because the demo did not fail — its upstream did.
    return e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 502
  }
  return 500
}

/** The mandate fields this app reads. */
export interface MandateRow {
  id: string
  status?: string
  bound_signer_id?: string
  customer_id?: string
  target_names?: string[]
  valid_until?: number
  version?: number
  rule?: Record<string, unknown>
}
