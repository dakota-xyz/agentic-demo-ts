// Declare this product's vocabulary and rules to the platform, once.
//
//   node scripts/register-agentic-policy.mjs
//
// An agentic policy is a CONTRACT, not a preference: every field is a fact
// about how this app is built, and changing one without changing the app to
// match makes the agent describe a product that does not exist.
//
// It is registered per CLIENT, not sent per request. The platform removed the
// per-request door because a conversation is two calls — draft, then accept —
// and a policy attached to each let them disagree: a plan drafted under one set
// of rules and accepted under another was refused at the customer's approval
// click, which is the worst possible moment to find out.
//
// The client id is not derivable here. The platform knows it from the API key
// and never tells the caller, so it has to be supplied.

// There is no client id to supply. The platform resolves it from the API key —
// an earlier shape took one in the path, which meant the only legal value was
// one the server already knew and the caller had no way to learn. ts-sdk 2.2.0
// still called that removed route and 404'd everywhere; 2.2.1 fixed it.
import { DakotaClient, Environment } from '@dakota-xyz/ts-sdk'

if (!process.env.DAKOTA_API_KEY) throw new Error('DAKOTA_API_KEY is not set')

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

/**
 * What this demo is.
 *
 *   payee_model "nested"    — this app has destinations: a payee holds several,
 *                             and the Payees screen shows them nested
 *                             underneath.
 *   labels                  — the words the UI uses. The agent writes prose
 *                             back to the customer, and it should be this
 *                             product's prose: "spend limit", not "mandate".
 *   mandate_strategy        — left unset deliberately. See the note below.
 *   payout_assets           — what a recipient may actually receive here.
 */
const POLICY = {
  payee_model: 'nested',
  labels: {
    limit: 'spend limit',
    payee: 'payee',
  },
  // The inversion. With external_only the conversation may not draft or amend
  // a limit: proposals arrive with no create_mandate action, so accepting one
  // needs no signature at all, and a payment beyond the limit comes back as a
  // reply pointing at the Limits tab rather than as an offer to widen itself.
  //
  // Authority is granted ONCE, deliberately, in a form a person filled in —
  // instead of being requested again with every payment, which is how signing
  // becomes a reflex rather than a decision.
  mandate_strategy: 'external_only',
  payout_assets: ['USDC', 'USDT'],
}

// ORDER MATTERS. external_only means an agent can only ever have the authority
// somebody granted it by hand, so registering this before "Set a spend limit"
// existed would have left every agent unable to pay anyone, with no way to fix
// it from the UI. The editor ships first; this second.

// No registration is a 404 and that is the DEFAULT, not an error: a client
// without one drafts on platform defaults exactly as before this existed.
// REFUSE to overwrite someone else's registration.
//
// A policy is per-CLIENT, and a client can be shared. If something else already
// runs behind this API key, the "current :" line below prints ITS policy, and a
// blind write here would replace it — with no undo beyond what a previous run
// happened to log.
//
// So an existing registration stops this dead unless FORCE=1 says otherwise.
// The default has to be "leave it alone": a policy shapes what an agent says to
// somebody else's customers, and there is no undo beyond what a previous run
// happened to log.
const before = await client.agenticPolicy.get().catch(() => null)
console.log('current :', before ? JSON.stringify(before.policy ?? {}) : '(none — platform defaults)')

if (before?.policy && process.env.FORCE !== '1') {
  console.error('\nA policy is ALREADY registered for this client, and it is not ours to replace.')
  console.error('This is per-client, not per-app: whatever else runs behind this key gets what is written here.')
  console.error('Nothing was changed. Set FORCE=1 only if you know that policy is yours.')
  process.exit(1)
}

const after = await client.agenticPolicy.set(POLICY)
console.log('written :', JSON.stringify(after.policy ?? after))
console.log(`\nregistered against ${environment}`)
