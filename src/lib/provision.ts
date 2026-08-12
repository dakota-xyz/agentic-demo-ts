import { attachUserToWallet } from '@dakota-xyz/ts-sdk'
import { dakota, isSandbox } from './dakota'
import { serviceKey } from './service-key'
import { getUser, updateUser, type Tenancy, type User, type TreasuryWallet } from './store'
import { tenancyFor, updateTenancy } from './tenancy'

// Per-visitor platform tenancy.
//
// Every visitor gets their OWN platform customer, signer groups, policies and
// treasury wallets. Tenancy is not the API key — one key serves the whole demo
// — it is this customer, which is why one visitor's agents, payees and payments
// are invisible to another's.
//
// Provisioning is LAZY: nothing upstream is created until a visitor does
// something that needs it. Someone who signs in, looks around and leaves costs
// the platform nothing.

/** One treasury wallet per chain family, so a Solana payment has a Solana wallet. */
const FAMILIES = ['evm', 'solana'] as const

export function treasuryWalletName(family: string) {
  return family === 'solana' ? 'Solana Treasury' : 'EVM Treasury'
}

/** True once the visitor has a customer and at least one wallet. */
function provisioned(u: User): boolean {
  return Boolean(u.customerId && u.wallets && u.wallets.length > 0)
}

/**
 * Ensure the visitor has a platform tenancy, creating it on first need.
 *
 * Concurrency: two requests can race here — the demo opens with several parallel
 * fetches — so the work happens inside updateUser's row lock and re-checks
 * under it. Without that, two requests both see "not provisioned" and mint two
 * customers, and the loser's wallets are silently orphaned.
 *
 * The customer name is deterministic per visitor because the platform resolves
 * an existing customer by name: a crash between creating the customer and
 * writing our row re-provisions onto the SAME customer rather than duplicating.
 */
export async function ensureTenancy(email: string): Promise<User> {
  const existing = await getUser(email)
  if (!existing) throw new Error(`no such user: ${email}`)
  if (provisioned(existing)) return existing

  return updateUser(email, async (u) => {
    if (provisioned(u)) return // another request won the race

    const client = dakota()
    const label = process.env.DEMO_CUSTOMER_NAME ?? 'Agentic Demo'

    const customerName = `${label} (${email})`
    const customerId = await resolveCustomer(customerName)

    // The service signer seeds every wallet's group, so each treasury wallet has
    // a recognised signer from birth. It cannot authorize spending — that needs
    // a mandate signed by the visitor's passkey.
    const { publicKey } = serviceKey()
    await client.signers
      .create({ name: 'agentic-demo-service', public_key: publicKey, key_type: 'ES256' })
      .catch((e: unknown) => {
        // Already registered is the normal case from the second visitor onward:
        // the key is derived from a deployment-wide salt, so it is the same key
        // every time. Anything else is real.
        const msg = e instanceof Error ? e.message : String(e)
        if (!/exist|duplicate|conflict/i.test(msg)) throw e
      })

    // NOTE: this app's own database is the map from a visitor to their
    // wallets, so when it adopts an EXISTING customer whose wallets it has no
    // record of, it mints a fresh set rather than reusing them. The visitor
    // then sees an empty treasury while the funded wallets sit unreferenced.
    // Provisioning a known customer with existing wallets should pass their ids
    // in (see scripts/provision-team.mjs and TEAM_*_WALLET_ID) so they are
    // adopted rather than re-minted.
    const wallets: TreasuryWallet[] = []
    for (const family of FAMILIES) {
      // Signer groups are client-scoped on the platform, so the names carry the
      // email to stay distinct across visitors.
      const group = await client.signerGroups.create({
        name: `agentic-demo-${family}-${email}`,
        member_keys: [publicKey],
      })
      const policy = await client.policies.create({
        name: `agentic-demo-${family}-allow-${email}`,
        description: 'agentic-demo allow policy',
        signer_group_id: group.id,
        rules: [
          {
            rule_type: 'approval_threshold',
            action: 'allow',
            // `definition` is an open object in the spec, which the generator
            // renders as Record<string, never>. The shape it takes depends on
            // rule_type — for approval_threshold that is a threshold — so the
            // value is built here and cast on the way out.
            definition: {
              threshold: 1,
              description: "Any group member's signature allows (agentic-demo)",
            } as unknown as Record<string, never>,
          },
        ],
      })
      const wallet = await client.wallets.create({
        customer_id: customerId,
        name: treasuryWalletName(family),
        family,
        signer_groups: [group.id],
        policies: [policy.id],
      })
      wallets.push({
        id: wallet.id,
        address: wallet.address ?? '',
        network: family,
        groupId: group.id,
        policyId: policy.id,
      })
    }

    u.customerId = customerId
    u.wallets = wallets
  })
}

/**
 * Find the customer for this visitor, creating it only if it is not there.
 *
 * The platform rejects a duplicate name, and our database is NOT the source of
 * truth for whether the customer exists — the platform is. A deployment with a
 * fresh database therefore meets customers it has never heard of, and blindly
 * creating would fail with "a customer with that name already exists".
 *
 * The name is deterministic per visitor precisely so this lookup works.
 */
/**
 * Onboard a freshly created customer, in sandbox.
 *
 * A new customer starts at `kyb_status: pending`, and the platform refuses to
 * convert-and-forward until onboarding completes: "customer is not onboarded to
 * convert and forward funds". So every visitor could pay in crypto and none
 * could pay a bank — the offramp would be permanently broken for everyone but
 * whoever had been approved by hand.
 *
 * Sandbox provides the transitions for exactly this. Both are needed: approving
 * the application does not activate the applicant, and provisioning only
 * happens on activation.
 *
 * Guarded on the DECLARED environment, because the failure mode of getting this
 * wrong is calling a KYB override against real money. An earlier version
 * pattern-matched the base URL for "sandbox", which decided that question by
 * inference from a string anyone could set; DAKOTA_ENV states it outright, and
 * anything other than sandbox does nothing at all here.
 *
 * Best-effort throughout: a visitor who cannot offramp is a lesser failure than
 * a visitor who cannot sign in, so nothing here is allowed to fail provisioning.
 */
async function onboardInSandbox(applicationId: string, customerName: string): Promise<void> {
  if (!isSandbox() || !applicationId) return

  const client = dakota()
  for (const type of ['kyb_approve', 'applicant_activate'] as const) {
    try {
      await client.sandbox.simulateOnboarding({
        type,
        applicant_id: applicationId,
        // Idempotent per application, so a retried provision does not re-run it.
        simulation_id: `provision-${type}-${applicationId}`,
      })
    } catch (e) {
      console.warn(`[provision] sandbox ${type} failed for ${customerName}`, e)
      return
    }
  }
}

async function resolveCustomer(name: string): Promise<string> {
  const client = dakota()
  try {
    const created = await client.customers.create({
      name,
      customer_type: 'business',
      is_sub_client: false,
    })
    if (created.id) {
      // application_id comes back from create and is not derivable afterwards —
      // /applications does not say which customer each one belongs to — so this
      // is the only moment it is cheaply available.
      await onboardInSandbox(created.application_id, name)
      return created.id
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Anything other than a name collision is a real failure.
    if (!/already exists/i.test(msg)) throw e
  }

  for await (const c of client.customers.list({ search: name } as never)) {
    // Exact match only: `search` is a prefix/substring match, so
    // "Agentic Demo (a@x.com)" would otherwise be able to return
    // "Agentic Demo (ab@x.com)" and hand one visitor another's tenancy.
    if (c.name === name && c.id) return c.id
  }
  throw new Error(`customer "${name}" exists but could not be resolved`)
}


/**
 * Create a hosted payment agent for the visitor.
 *
 * "Hosted" means the platform holds the agent's signing key, which is what lets
 * a scheduled payment execute unattended later — the visitor is not around to
 * sign at fire time. What the visitor signed, once, is the MANDATE that bounds
 * what the agent may ever do.
 */
export async function createAgent(email: string, name: string) {
  // The tenancy, not the visitor: in team mode the agent belongs to the shared
  // account and is attached to the shared wallets, so everyone sees it.
  const tenancy = await tenancyFor(email)
  if (!tenancy.customerId) throw new Error('tenancy is missing a customer id')

  const client = dakota()
  const agent = await client.paymentAgents.create({
    customer_id: tenancy.customerId,
    name,
    hosted: true,
  })

  // Fields on the response are optional in the generated types, so the id is
  // checked rather than asserted. An agent we cannot address is worse stored
  // than not stored: it would occupy a row in the sidebar that no request
  // could ever route to.
  if (!agent.id) throw new Error('the platform created an agent without an id')

  // A freshly created agent is `pending` and CANNOT be talked to — the
  // proposals endpoint refuses with "agent is not active". It becomes active by
  // being attached to the wallets it may spend from, which means adding its
  // signer key to each wallet's signer group.
  //
  // Attaching does not grant the agent the power to move money on its own. It
  // binds the agent to that group's policies; every actual payment is still
  // gated by a mandate the visitor signed with a passkey.
  if (agent.signer_public_key) {
    for (const wallet of tenancy.wallets ?? []) {
      await attachUserToWallet(client, wallet.id, agent.signer_public_key, wallet.groupId)
    }
  }

  await updateTenancy(email, (t) => {
    t.agents ??= []
    t.agents.push({
      id: agent.id!,
      name,
      signerId: agent.signer_id,
      createdAt: new Date().toISOString(),
    })
  })
  return agent
}

/**
 * updateUser, narrowed to the platform state.
 *
 * The visitor-mode half of updateTenancy. It exists so lib/tenancy can dispatch
 * between the two documents without importing the User type or knowing that in
 * this mode the tenancy and the person are the same row.
 */
export async function updateVisitorTenancy(
  email: string,
  mutate: (t: Tenancy) => void | Promise<void>
): Promise<Tenancy> {
  return updateUser(email, mutate)
}

/**
 * Make sure this person's passkey can actually authorise on today's wallets.
 *
 * Enrolment attaches the key to the wallets that existed AT THE TIME. Wallets
 * are not forever: repointing a deployment at another customer creates a fresh
 * set, and every previously enrolled key is then in none of their signer
 * groups. The platform rejects the signature and the app has nothing useful to
 * say about it.
 *
 * So attachment is re-checked against the CURRENT wallets rather than trusted
 * from a timestamp. Idempotent — the platform accepts a key already in a group
 * — and cheap, since the common case compares two short arrays and stops.
 */
export async function ensurePasskeyAttached(email: string): Promise<void> {
  const user = await getUser(email)
  if (!user?.publicKey) return

  const tenancy = await tenancyFor(email)
  const wallets = tenancy.wallets ?? []
  const already = new Set(user.attachedWallets ?? [])
  const missing = wallets.filter((w) => !already.has(w.id))
  if (missing.length === 0) return

  const client = dakota()

  // The SIGNER may not exist on this platform at all.
  //
  // A key enrolled against a different environment leaves us holding a public
  // key the platform has never seen, and every attach answers "Signer Not
  // Found". Registering is idempotent — an existing signer conflicts, which is
  // fine — so it is cheaper to ensure it than to detect whether we need to.
  await client.signers
    .create({ name: `passkey-${email}`, public_key: user.publicKey, key_type: 'WEBAUTHN' })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/exist|duplicate|conflict/i.test(msg)) {
        console.warn('[passkey] signer registration failed', email, msg)
      }
    })

  const done: string[] = []
  for (const wallet of missing) {
    try {
      await attachUserToWallet(client, wallet.id, user.publicKey, wallet.groupId)
      done.push(wallet.id)
    } catch (e) {
      // One wallet failing must not stop the others: a key in the EVM group can
      // still sign EVM payments even if Solana refused.
      console.warn('[passkey] attach failed', wallet.id, e)
    }
  }
  if (done.length === 0) return

  await updateUser(email, (u) => {
    u.attachedWallets = [...new Set([...(u.attachedWallets ?? []), ...done])]
    u.attachedAt = new Date().toISOString()
  })
  console.info('[passkey] attached %s to %d wallet(s)', email, done.length)
}
