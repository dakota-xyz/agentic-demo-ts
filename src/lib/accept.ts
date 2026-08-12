import { dakota } from './dakota'
import { pushHistory, type User, type AgentRef } from './store'
import { tenancyFor, updateTenancy } from './tenancy'
import { notifySlackThread, retireButton, rememberPending, hasSlack, linkButton } from './slack/notify'
import { appOrigin } from './origin'
import { injectScheduleWallets } from './proposal'

// Turning a drafted plan into real platform artifacts.
//
// Lives here rather than in the route because two callers need it and they must
// not drift: the visitor pressing "approve" in the browser, and an emailed
// invoice that a signed mandate already covers. Same platform call, same
// bookkeeping, same Slack follow-through — the only difference is who decided,
// and that is a parameter.

/** Every scheduled-payment id currently belonging to an agent's signer. */
async function paymentIds(signerId?: string): Promise<Set<string>> {
  const ids = new Set<string>()
  if (!signerId) return ids
  try {
    for await (const p of dakota().scheduledPayments.list({ signer_id: signerId } as never)) {
      const id = (p as { id?: string }).id
      if (id) ids.add(id)
    }
  } catch {
    // A failed snapshot costs thread-accurate receipts, never the acceptance.
  }
  return ids
}

/**
 * Record which thread asked for each payment this accept created.
 *
 * A settlement arrives long after the conversation carrying only a payment id.
 * Without this mapping the announcement can only fall back to the agent's LAST
 * thread — so the moment two requests are in flight, both confirmations land in
 * whichever conversation spoke most recently. That is wrong in the way that is
 * hardest to notice: the message is real, the amount is right, and it is
 * answering the wrong question.
 *
 * Diffed rather than read off the response because the instructions result
 * returns mandates, not the scheduled payments they authorize.
 */
async function tagNewPayments(
  email: string,
  agent: AgentRef,
  before: Set<string>,
  thread: string | undefined,
  replyTo: string | undefined
): Promise<string[]> {
  // Only a request that CAME from a thread gets tagged with one. This used to
  // read agent.slack.lastThreadTs, which is the last thread that spoke to this
  // agent — so a payment made in the browser was mapped to whichever Slack
  // conversation happened to be most recent, and its settlement announced
  // there. Loud, confident, and about something that thread never asked for.
  if (!thread && !replyTo) return []

  // instructions.create RETURNS before the scheduled payments are listable.
  //
  // A single read here found nothing new, every time — so no payment was ever
  // tagged with the thread that asked for it, and every settlement went
  // unannounced. Silently, because "no new payments" is indistinguishable from
  // "nothing to do".
  //
  // Polled instead, briefly. The whole point of the mapping is to answer a
  // question that arrives minutes later, so a few seconds here is cheap; and
  // giving up says so rather than leaving the caller to wonder.
  let fresh: string[] = []
  for (const waitMs of [0, 600, 1200, 2500]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs))
    const after = await paymentIds(agent.signerId)
    fresh = [...after].filter((id) => !before.has(id))
    if (fresh.length > 0) break
  }
  if (fresh.length === 0) {
    console.warn('[accept] no new scheduled payments appeared; settlement will not be announced')
    return []
  }

  await updateTenancy(email, (t) => {
    t.paymentThreads ??= {}
    t.paymentEmails ??= {}
    for (const id of fresh) {
      if (thread) t.paymentThreads[id] = thread
      if (replyTo) t.paymentEmails[id] = replyTo
    }
  })
  return fresh
}

export interface AcceptResult {
  instructionIds: string[]
  mandateIds: string[]
  /** The scheduled payments this accept created, so a caller can link to them. */
  paymentIds: string[]
}

/**
 * Accept a drafted plan.
 *
 * This turns the agent's proposal into real platform artifacts: scheduled
 * payments, and any MANDATE that authorizes them. A mandate arrives unsigned —
 * accepting is not authorizing. Nothing it covers can execute until the visitor
 * signs the §8 payload with their passkey.
 *
 * `auto` says a machine decided this, because a signed mandate already covered
 * it (see lib/autopay). It changes only what the transcript says: the visitor
 * needs to be able to tell, later, which payments they clicked and which ones
 * their own standing limit released without them.
 */
export async function acceptPlan(opts: {
  user: User
  agent: AgentRef
  plan: unknown[]
  auto?: boolean
  /**
   * The Slack thread this request came from, if it came from one.
   *
   * Passed rather than inferred: only the caller knows where the request
   * started, and guessing it is how a settlement ends up announced in an
   * unrelated conversation.
   */
  originThread?: string
  /** The address that emailed this in, if it arrived that way. */
  originEmail?: string
}): Promise<AcceptResult> {
  const { user, agent, plan, auto = false } = opts

  const tenancy = await tenancyFor(user.email)

  // Which payments existed BEFORE, so the ones this accept creates can be tied
  // to the thread that asked for them. See tagNewPayments.
  const before = await paymentIds(agent.signerId)

  // Name the funding wallet the agent could not know. For a cross-family swap
  // this is the auto-account's DEPOSIT network rather than the payment's
  // destination — see lib/proposal.
  const funded = injectScheduleWallets(plan, tenancy.wallets ?? [])

  const result = await dakota().instructions.create({
    payment_agent_id: agent.id,
    proposals: funded as never,
  })

  // Explicit origin first (a Slack turn that paid outright), then the thread
  // the STORED plan was drafted in — which is the case that matters, since a
  // Slack plan is normally approved in the browser.
  const originThread = opts.originThread ?? tenancy.proposalThreads?.[agent.id]
  const replyTo = opts.originEmail ?? tenancy.proposalEmails?.[agent.id]
  const paymentIdsCreated = await tagNewPayments(user.email, agent, before, originThread, replyTo)

  const mandateIds = (result.mandates ?? []).map((m) => m.id).filter(Boolean) as string[]

  const confirm = auto
    ? '✅ Paid automatically — this was inside a spend limit you had already signed.'
    : mandateIds.length
      ? '✅ Approved — everything in the plan above has been created. Sign the spend limit to activate the payments.'
      : '✅ Approved — everything in the plan above has been created.'

  await updateTenancy(user.email, (t) => {
    delete (t.proposals ?? {})[agent.id]
    delete (t.proposalThreads ?? {})[agent.id]
    delete (t.proposalEmails ?? {})[agent.id]

    // Close the loop in the transcript with a DURABLE assistant turn. Without
    // it the conversation ends at the proposal, so after a reload it looks like
    // nothing happened — the optimistic bubble in the browser is client-only.
    t.conversations ??= {}
    t.conversations[agent.id] = [
      ...((t.conversations[agent.id] ?? []) as unknown[]),
      { role: 'assistant', content: confirm },
    ]

    // `actor` matters once the log is shared: without it the team can see that
    // a plan was approved but not by whom, which is the one fact anyone would
    // open a shared log to find.
    pushHistory(t, {
      id: crypto.randomUUID(),
      agentId: agent.id,
      at: new Date().toISOString(),
      kind: 'accepted',
      text: confirm,
      actor: user.email,
    })
  })

  // Close the loop in the channel — but ONLY for a plan that started there,
  // and only in the thread that started it.
  //
  // This used to post wherever notifySlack defaults to, which is the thread
  // that spoke to this agent most recently. So approving something in the app
  // dropped "Approved — everything in the plan above has been created" into
  // whatever conversation happened to be open, referring to a plan that
  // conversation had never seen. Loud, unattributed, and about nothing the
  // reader had asked for.
  //
  // Same rule as the settlement announcement: Slack hears about what Slack
  // asked for. Everything else has the app.
  if (hasSlack(agent) && originThread) {
    // The TENANCY, not the user row. In team mode the agents live on the shared
    // document, so re-reading the person here returned a row with no agents at
    // all — every notify and retire below then looked up the agent, found
    // nothing, and returned silently. Approving worked; the channel just never
    // heard about it.
    const fresh = await tenancyFor(user.email)
    if (fresh) {
      if (!auto) {
        await retireButton(fresh, user.email, agent.id, 'pendingDraft', `✅ Approved by ${user.email}`)
      }

      // An `auto` accept is reported by whoever triggered it — Slack edits its
      // own message, email sends a reply, the app shows it inline. Posting here
      // too produced the same sentence twice, seconds apart, in one thread.
      if (auto) {
        // nothing to add
      } else if (mandateIds.length) {
        const text = '📝 *Plan created.* It needs your signature before anything can run.'
        const ts = await notifySlackThread(fresh, agent.id, originThread, text, [
          linkButton('Sign it →', `${appOrigin()}/?agent=${encodeURIComponent(agent.id)}&tab=limits`),
        ])
        if (ts) await rememberPending(user.email, agent.id, 'pendingSign', { ts, text })
      } else {
        await notifySlackThread(
          fresh,
          agent.id,
          originThread,
          confirm.replace('✅ ', '✅ *').replace(' — ', '* — ')
        )
      }
    }
  }

  return { instructionIds: [...(result.instruction_ids ?? [])], mandateIds, paymentIds: paymentIdsCreated }
}
