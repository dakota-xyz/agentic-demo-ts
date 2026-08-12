// Provision the shared team account, once, before anyone signs in.
//
// In team mode (TENANCY_MODE=team) nothing at request time creates a customer
// or a wallet — that is the point. This script is the only thing that does, and
// running it is a deliberate act by a person who knows which customer they mean.
//
//   node scripts/provision-team.mjs
//
// Env:
//   DATABASE_URL          where the team row lives
//   DAKOTA_API_KEY        the platform client
//   DAKOTA_ENV            optional; sandbox when unset
//   DEMO_KEY_SALT         derives the service signer (must match the app's)
//   TEAM_CUSTOMER_ID      the known customer to run as        ─┐ one of
//   TEAM_CUSTOMER_NAME    or a name to resolve/create instead ─┘
//   TEAM_EVM_WALLET_ID    adopt these rather than minting fresh ones
//   TEAM_SOLANA_WALLET_ID
//
// IDEMPOTENT. Re-running is a no-op: wallets already recorded on the team doc
// are left exactly as they are.
//
// ⚠️ The trap this exists to avoid: the platform has no "list a customer's
// wallets" endpoint, so OUR database is the only map from customer to wallets.
// Pointing this at a customer whose wallets we have no record of will mint a
// second set and leave the funded ones unreachable. Hence TEAM_*_WALLET_ID:
// when the wallets already exist, say so, and they are adopted rather than
// replaced.

import { Client } from 'pg'
import { createHash, createPrivateKey } from 'node:crypto'
import { DakotaClient, Environment, P256MandateSigner } from '@dakota-xyz/ts-sdk'

const DB = process.env.DATABASE_URL
if (!DB) throw new Error('DATABASE_URL is not set')
if (!process.env.DAKOTA_API_KEY) throw new Error('DAKOTA_API_KEY is not set')

const FAMILIES = ['evm', 'solana']
const TEAM_ID = 'default'

// The SDK holds the URL for each environment, so name the environment. Sandbox
// or production only — the same two the app accepts, and for the same reason.
const ENVIRONMENTS = [Environment.Sandbox, Environment.Production]
const wanted = (process.env.DAKOTA_ENV ?? '').trim().toLowerCase() || Environment.Sandbox
const environment = ENVIRONMENTS.find((e) => e === wanted)
if (!environment) {
  throw new Error(`DAKOTA_ENV="${wanted}" is not a Dakota environment — expected ${ENVIRONMENTS.join(' or ')}`)
}

const client = new DakotaClient({
  apiKey: process.env.DAKOTA_API_KEY,
  environment,
})

const log = (...a) => console.log(...a)

// --- the service signer -----------------------------------------------------
// Derived from DEMO_KEY_SALT exactly as the app does — the SAME derivation, not
// a lookalike. The key this script puts in each signer group has to be the one
// the running app presents; a mismatch is invisible until a payment fails to
// submit, long after anyone would connect it to this script.

function serviceKey() {
  const salt = process.env.DEMO_KEY_SALT
  if (!salt) throw new Error('DEMO_KEY_SALT is not set — it derives the service signer')
  const scalar = createHash('sha256').update(`agentic-demo-service:${salt}`).digest()
  const pkcs8Prefix = Buffer.from(
    '308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
    'hex'
  )
  const privateKey = createPrivateKey({ key: Buffer.concat([pkcs8Prefix, scalar]), format: 'der', type: 'pkcs8' })
  return P256MandateSigner.fromPrivateKey(privateKey).publicKeyBase64()
}

// --- customer ---------------------------------------------------------------

async function resolveCustomer() {
  const known = process.env.TEAM_CUSTOMER_ID
  if (known) {
    const c = await client.customers.get(known)
    log(`customer   : ${c.id} (${c.name}) — kyb ${c.kyb_status}`)
    return c.id
  }

  const name = process.env.TEAM_CUSTOMER_NAME ?? 'Dakota Agentic Team'
  try {
    const created = await client.customers.create({
      name,
      customer_type: 'business',
      is_sub_client: false,
    })
    log(`customer   : ${created.id} (${name}) — created`)
    await onboardInSandbox(created.application_id)
    return created.id
  } catch (e) {
    if (!/already exists/i.test(String(e?.message ?? e))) throw e
  }
  for await (const c of client.customers.list({ search: name })) {
    if (c.name === name && c.id) {
      log(`customer   : ${c.id} (${name}) — adopted`)
      return c.id
    }
  }
  throw new Error(`customer "${name}" exists but could not be resolved`)
}

/** Sandbox KYB, so convert-and-forward works. See lib/provision for the why. */
async function onboardInSandbox(applicationId) {
  if (!applicationId || environment !== 'sandbox') return
  for (const type of ['kyb_approve', 'applicant_activate']) {
    try {
      await client.sandbox.simulateOnboarding({
        type,
        applicant_id: applicationId,
        simulation_id: `team-${type}-${applicationId}`,
      })
    } catch (e) {
      console.warn(`  sandbox ${type} failed:`, e?.message ?? e)
      return
    }
  }
  log('onboarding : kyb approved, applicant activated')
}

// --- wallets ----------------------------------------------------------------

async function adoptWallet(walletId, family) {
  const w = await client.wallets.get(walletId)
  const groups = w.signer_groups ?? w.signerGroups ?? []
  const policies = w.policies ?? []
  const groupId = typeof groups[0] === 'string' ? groups[0] : (groups[0]?.id ?? '')
  const policyId = typeof policies[0] === 'string' ? policies[0] : (policies[0]?.id ?? '')
  if (!groupId) {
    throw new Error(
      `wallet ${walletId} reports no signer group; cannot adopt it — members would have nothing to be attached to`
    )
  }
  log(`wallet     : ${walletId} (${family}) — adopted`)
  return { id: w.id, address: w.address ?? '', network: family, groupId, policyId }
}

async function createWallet(customerId, family, publicKey) {
  const group = await client.signerGroups.create({
    name: `agentic-team-${family}`,
    member_keys: [publicKey],
  })
  const policy = await client.policies.create({
    name: `agentic-team-${family}-allow`,
    description: 'agentic-demo team allow policy',
    // threshold 1: ANY member of the group can authorise. This is what lets a
    // second person sign a mandate the first one drafted, and it is why team
    // mode needs no platform-side change.
    signer_group_id: group.id,
    rules: [
      {
        rule_type: 'approval_threshold',
        action: 'allow',
        definition: { threshold: 1, description: "Any team member's signature allows" },
      },
    ],
  })
  const wallet = await client.wallets.create({
    customer_id: customerId,
    name: family === 'solana' ? 'Solana Treasury' : 'EVM Treasury',
    family,
    signer_groups: [group.id],
    policies: [policy.id],
  })
  log(`wallet     : ${wallet.id} (${family}) — created`)
  return {
    id: wallet.id,
    address: wallet.address ?? '',
    network: family,
    groupId: group.id,
    policyId: policy.id,
  }
}

// --- main -------------------------------------------------------------------

const db = new Client({ connectionString: DB })
await db.connect()
await db.query(`CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`)

const { rows } = await db.query('SELECT data FROM teams WHERE id = $1', [TEAM_ID])
const team = rows[0]?.data ?? { id: TEAM_ID }

const customerId = team.customerId ?? (await resolveCustomer())

const publicKey = serviceKey()
await client.signers
  .create({ name: 'agentic-demo-service', public_key: publicKey, key_type: 'ES256' })
  .then(() => log('service    : signer registered'))
  .catch((e) => {
    if (!/exist|duplicate|conflict/i.test(String(e?.message ?? e))) throw e
    log('service    : signer already registered')
  })

const existing = team.wallets ?? []
const wallets = []
for (const family of FAMILIES) {
  const already = existing.find((w) => w.network === family)
  if (already) {
    log(`wallet     : ${already.id} (${family}) — already recorded, untouched`)
    wallets.push(already)
    continue
  }
  const adoptId = process.env[`TEAM_${family.toUpperCase()}_WALLET_ID`]
  wallets.push(
    adoptId ? await adoptWallet(adoptId, family) : await createWallet(customerId, family, publicKey)
  )
}

team.customerId = customerId
team.wallets = wallets
team.agents ??= []

await db.query(
  `INSERT INTO teams (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`,
  [TEAM_ID, team]
)
await db.end()

log('')
log('team ready. Set TENANCY_MODE=team on the deployment.')
log(`  customer : ${customerId}`)
for (const w of wallets) log(`  ${w.network.padEnd(7)}: ${w.id}  ${w.address}`)
