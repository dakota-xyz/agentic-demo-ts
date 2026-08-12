import { describe, it, expect } from 'vitest'
import { ensureUser, updateUser } from './store'
import { ensureTenancy, createAgent } from './provision'
import { dakota } from './dakota'

// Live integration check against the real sandbox platform.
//
// Skipped unless DAKOTA_API_KEY and DATABASE_URL are both present, so CI —
// which has neither — stays green without a mock. This is the test that would
// have caught the two things a type-check could not: that a freshly created
// agent is `pending` and refuses to talk until it is attached to a wallet, and
// that the policy `definition` cast actually produces a policy the platform
// accepts.
//
// It creates real sandbox resources (a customer, two wallets, an agent) on each
// run under a unique address. Sandbox only; no real money exists here.
const live = process.env.DAKOTA_API_KEY && process.env.DATABASE_URL
const maybe = live ? describe : describe.skip

maybe('against the sandbox platform', () => {
  const email = `smoke+${Date.now()}@dakota.xyz`

  it('provisions a tenancy: customer, groups, policies, wallets', async () => {
    await ensureUser(email, 'Smoke Test', 'dakota.xyz')
    const u = await ensureTenancy(email)
    expect(u.customerId).toBeTruthy()
    expect(u.wallets?.length).toBe(2)
    for (const w of u.wallets ?? []) {
      expect(w.id).toBeTruthy()
      expect(w.address).toBeTruthy()
    }
  }, 120_000)

  it('is idempotent — a second call reuses the same customer', async () => {
    const first = await ensureTenancy(email)
    const second = await ensureTenancy(email)
    expect(second.customerId).toBe(first.customerId)
    expect(second.wallets?.[0].id).toBe(first.wallets?.[0].id)
  }, 60_000)

  it('adopts an existing customer instead of failing on the duplicate name', async () => {
    // The exact failure reported from the deployment: our database is per
    // environment while the customer lives on the platform, so a fresh database
    // meets a customer it has never heard of. Blindly creating returns
    // "a customer with that name already exists".
    const first = await ensureTenancy(email)

    // Simulate a fresh deployment: wipe OUR record, leave the platform's.
    await updateUser(email, (u) => {
      delete u.customerId
      delete u.wallets
    })

    const second = await ensureTenancy(email)
    expect(second.customerId).toBe(first.customerId)
    expect(second.wallets?.length).toBe(2)
  }, 180_000)

  it('creates a hosted payment agent', async () => {
    const agent = await createAgent(email, 'Smoke Agent')
    expect(agent.id).toBeTruthy()
    expect(agent.hosted).toBe(true)
  }, 60_000)

  it('holds a chat turn and gets a real reply', async () => {
    const u = await ensureTenancy(email)
    const agentId = u.agents![0].id
    const convo = dakota().resumeAgentConversation(agentId, [], { timezone: 'America/New_York' })
    const turn = await convo.send('What can you help me with?')
    expect(turn.reply.length).toBeGreaterThan(0)
    expect(convo.messages().length).toBe(2)
    console.log('\n  agent replied:', turn.reply.slice(0, 160).replace(/\n/g, ' '), '\n')
  }, 120_000)
})
