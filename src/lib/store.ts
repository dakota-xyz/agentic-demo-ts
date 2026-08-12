import { Pool } from 'pg'

// Per-visitor state, keyed by email.
//
// One row per user holding one JSONB document. The shape is carried over from
// the Go build, where it earned its keep: the demo's state is a small object
// graph that is always read and written whole, and normalising it would buy
// query flexibility nobody needs while making every schema tweak a migration.
// Adding a field here costs nothing.
//
// Serverless note: a Pool is created per warm lambda and cached on globalThis,
// so a container that handles many requests opens one connection, not one per
// request. Use a pooled connection string (Neon's -pooler host, Supabase's
// pgBouncer port) — Postgres will run out of backends long before Vercel runs
// out of concurrency otherwise.

/** A treasury wallet on one chain family. */
export interface TreasuryWallet {
  id: string
  address: string
  /** Chain family: 'evm' | 'solana'. */
  network: string
  /**
   * The wallet's signer group. Kept because attaching a principal to a wallet
   * means adding its key to THIS group — an agent has no wallet access, and no
   * 'active' state, until that happens.
   */
  groupId: string
  policyId: string
}

/** A message we posted that carries a button, so it can be retired later. */
export interface SlackMsg {
  ts: string
  /** The text the message showed, kept so retiring it does not blank the plan. */
  text?: string
}

/** How an agent is wired to a Slack channel. */
export interface SlackLink {
  channelId: string
  /**
   * Slack's own name for the channel, absent when the workspace withheld
   * `channels:read`. Optional on purpose: it is read for display and falls back
   * to the id, so an unverifiable channel stays connectable.
   */
  channelName?: string
  /** The thread that most recently asked this agent for something. */
  lastThreadTs?: string
  /** The message carrying "Review & approve". */
  pendingDraft?: SlackMsg
  /** The message carrying "Sign it". */
  pendingSign?: SlackMsg
}

/** One of the visitor's agents. */
export interface AgentRef {
  id: string
  name: string
  signerId?: string
  createdAt: string
  /** Under this amount the agent may pay without asking. '' ⇒ always ask. */
  autoPayUnder?: string
  /**
   * This agent receives forwarded invoices.
   *
   * At most one agent per tenancy: there is a single inbound address, so a
   * second claimant would make routing depend on row order. Absent everywhere
   * means nobody has chosen, and the first agent takes it — the demo has to
   * work before anyone visits a settings tab.
   */
  handlesEmail?: boolean
  slack?: SlackLink
}

/** A rendered event in the human-facing activity log. */
export interface ChatEvent {
  id: string
  agentId: string
  at: string
  kind: string
  text: string
  data?: unknown
  /**
   * Who did it.
   *
   * Absent in visitor mode, where the log has an audience of one and the answer
   * is always "you". In team mode a shared log with no actor is not a log — it
   * records that a payment was approved while losing the only fact anyone would
   * come here to find.
   */
  actor?: string
}

/**
 * The platform-facing state: everything that describes the ACCOUNT rather than
 * the person looking at it.
 *
 * Split out because the same fields are owned by different things in the two
 * tenancy modes — by the visitor in the public demo, by the team on an internal
 * deployment — and every route that touches the platform should be indifferent
 * to which. See lib/tenancy.
 */
export interface Tenancy {
  customerId?: string
  wallets?: TreasuryWallet[]
  agents?: AgentRef[]
  /** Multi-turn transcripts per agent, resent to the stateless endpoint. */
  conversations?: Record<string, unknown[]>
  /** Last drafted, not-yet-accepted proposal per agent, so a reload restores it. */
  proposals?: Record<string, unknown>
  /**
   * The Slack thread a stored proposal was drafted in, per agent.
   *
   * Travels with the PLAN rather than the agent. A plan drafted in Slack is
   * usually approved in the browser — the channel's button is a link, because
   * approving needs a passkey — so by accept time the only record of where it
   * came from is this. Reading the agent's most recent thread instead answers
   * "what happened last", which is a different question and often a different
   * thread.
   */
  proposalThreads?: Record<string, string>
  /** The address a stored proposal was emailed in by, per agent. Same reason. */
  proposalEmails?: Record<string, string>
  /** The human-facing event log the UI renders. */
  history?: ChatEvent[]
  /** payment id -> Slack thread that asked for it. */
  paymentThreads?: Record<string, string>
  /**
   * payment id -> the address that emailed it in.
   *
   * The email equivalent of paymentThreads, and it matters more: someone
   * working by email has no screen to check, so "it executed" has nowhere else
   * to arrive. Recorded per payment for the same reason — the sender of the
   * most recent invoice is not necessarily who asked for THIS one.
   */
  paymentEmails?: Record<string, string>
  /** payment id -> last-seen terminal status, so each is announced once. */
  paymentStatuses?: Record<string, string>
}

/**
 * The shared account, when TENANCY_MODE=team.
 *
 * One row for the deployment. Everyone who signs in works inside it: same
 * customer, same wallets, same agents, same history. Identity and passkeys stay
 * on User, because those are irreducibly personal — a signature has to be
 * traceable to a human even when the account is not.
 */
export interface Team extends Tenancy {
  id: string
}

/** The whole per-visitor document. */
export interface User extends Tenancy {
  email: string
  name: string
  /** Verified work domain — the lead. See lib/work-domain.ts. */
  domain: string
  /**
   * When this visitor was last pushed to Salesforce.
   *
   * Kept so a returning visitor is not re-pushed on every single sign-in: the
   * lead does not change, and the CRM should not take an API call per page
   * load. Absent means never pushed.
   */
  crmSyncedAt?: string
  picture?: string
  /** Passkey enrolment (§8 signing). */
  publicKey?: string
  webauthnCredId?: string
  /** Where the credential lives ('internal' | 'hybrid' | 'usb' | …), so the
   *  browser can route the prompt to the provider that actually holds it. */
  webauthnTransports?: string[]
  registered?: boolean
  /**
   * When this user's passkey was attached to the team's wallet signer groups.
   *
   * Team mode only, and the reason a second member can sign at all: policies are
   * threshold-1, so a key in the group authorises. Kept as a marker so the
   * attach runs once rather than on every enrolment check.
   */
  attachedAt?: string
  /**
   * The wallets this key is actually in the signer group of.
   *
   * `attachedAt` alone says WHEN, which stops being useful the moment the
   * tenancy's wallets change — repointing a deployment at another customer
   * mints new wallets, and a key attached yesterday is in none of them. Signing
   * then fails at the platform with nothing on screen to explain why.
   */
  attachedWallets?: string[]
}

const globalForPg = globalThis as unknown as { dakotaPool?: Pool }

function pool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — the demo cannot persist anything')
  }
  if (!globalForPg.dakotaPool) {
    globalForPg.dakotaPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Small: many short-lived lambdas each holding a big pool is how you
      // exhaust a Postgres instance.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  }
  return globalForPg.dakotaPool
}

let ensured: Promise<void> | null = null

/** Create the table once per warm container, not once per request. */
function ensureSchema(): Promise<void> {
  ensured ??= pool()
    .query(
      `CREATE TABLE IF NOT EXISTS users (
         email      text PRIMARY KEY,
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE TABLE IF NOT EXISTS teams (
         id         text PRIMARY KEY,
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    )
    .then(() => undefined)
    .catch((e) => {
      ensured = null // let the next request retry rather than wedging forever
      throw e
    })
  return ensured
}

export async function getUser(email: string): Promise<User | null> {
  await ensureSchema()
  const { rows } = await pool().query<{ data: User }>(
    'SELECT data FROM users WHERE email = $1',
    [email.toLowerCase()]
  )
  return rows[0]?.data ?? null
}

/** Create the row on first sign-in, or refresh the identity fields on later ones. */
export async function ensureUser(
  email: string,
  name: string,
  domain: string,
  picture = ''
): Promise<User> {
  await ensureSchema()
  const key = email.toLowerCase()
  const fresh: User = { email: key, name, domain, picture }
  const { rows } = await pool().query<{ data: User }>(
    `INSERT INTO users (email, data) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE
       SET data = users.data || $3::jsonb, updated_at = now()
     RETURNING data`,
    [key, fresh, { name, domain, picture }]
  )
  return rows[0].data
}

/**
 * Read-modify-write a user document inside a transaction.
 *
 * `SELECT … FOR UPDATE` is the load-bearing part. Two requests can touch one
 * visitor at the same time — a chat turn and a settlement poll, say — and
 * without the row lock the second write silently discards the first, which in
 * this app means a drafted proposal or a payment's thread mapping vanishing.
 */
export async function updateUser(
  email: string,
  mutate: (u: User) => void | Promise<void>
): Promise<User> {
  await ensureSchema()
  const key = email.toLowerCase()
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ data: User }>(
      'SELECT data FROM users WHERE email = $1 FOR UPDATE',
      [key]
    )
    if (!rows[0]) throw new Error(`no such user: ${key}`)
    const doc = rows[0].data
    await mutate(doc)
    await client.query('UPDATE users SET data = $2, updated_at = now() WHERE email = $1', [key, doc])
    await client.query('COMMIT')
    return doc
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Every visitor. Used by the settlement cron, which has no request context. */
export async function listUsers(): Promise<User[]> {
  await ensureSchema()
  const { rows } = await pool().query<{ data: User }>('SELECT data FROM users')
  return rows.map((r) => r.data)
}

// ---------------------------------------------------------------------------
// The shared team document
// ---------------------------------------------------------------------------

/**
 * One deployment, one team.
 *
 * Not configurable, because a second team would need a way to decide which one
 * a request belongs to, and that decision does not exist anywhere in the app.
 * Multiple teams is an out-of-scope fast-follow, and hard-coding the id here is
 * the honest way to say so.
 */
export const TEAM_ID = 'default'

/** The shared account, or null if it has never been provisioned. */
export async function getTeam(): Promise<Team | null> {
  await ensureSchema()
  const { rows } = await pool().query<{ data: Team }>('SELECT data FROM teams WHERE id = $1', [
    TEAM_ID,
  ])
  return rows[0]?.data ?? null
}

/**
 * Read-modify-write the team document inside a transaction.
 *
 * The same `SELECT … FOR UPDATE` as updateUser, and it matters more here: this
 * is ONE row that every request in the deployment writes through, so a lost
 * update is not a rare interleaving but the default outcome under any
 * concurrency at all.
 *
 * That also makes it a hot row — every write serialises on it. Fine at
 * internal-team scale, and the reason this mode is not the public demo's.
 *
 * Creates the row if absent so a first write cannot fail on a missing document;
 * a team with no customerId still reads as unprovisioned to callers.
 */
export async function updateTeam(mutate: (t: Team) => void | Promise<void>): Promise<Team> {
  await ensureSchema()
  const client = await pool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO teams (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [TEAM_ID, { id: TEAM_ID }]
    )
    const { rows } = await client.query<{ data: Team }>(
      'SELECT data FROM teams WHERE id = $1 FOR UPDATE',
      [TEAM_ID]
    )
    const doc = rows[0].data
    await mutate(doc)
    await client.query('UPDATE teams SET data = $2, updated_at = now() WHERE id = $1', [TEAM_ID, doc])
    await client.query('COMMIT')
    return doc
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * How many events the activity log keeps.
 *
 * Unbounded, the log is a document that every write rewrites in full — so it
 * grows without limit while making every unrelated write more expensive. It is
 * render-only, and nobody scrolls back 500 events.
 */
const HISTORY_LIMIT = 500

/** Append to the activity log, oldest dropped past the cap. */
export function pushHistory(t: Tenancy, event: ChatEvent): void {
  t.history ??= []
  t.history.push(event)
  if (t.history.length > HISTORY_LIMIT) {
    t.history.splice(0, t.history.length - HISTORY_LIMIT)
  }
}

/** A user plus the row metadata the Team tab renders. */
export interface Member extends User {
  /** Row mtime — the closest thing to "last active" without new bookkeeping. */
  lastActive: string
}

/** Everyone who has signed in. In team mode, that is the membership. */
export async function listMembers(): Promise<Member[]> {
  await ensureSchema()
  const { rows } = await pool().query<{ data: User; updated_at: Date }>(
    'SELECT data, updated_at FROM users ORDER BY updated_at DESC'
  )
  return rows.map((r) => ({ ...r.data, lastActive: r.updated_at.toISOString() }))
}
