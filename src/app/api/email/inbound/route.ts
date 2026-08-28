import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import type { ChatMessage } from '@dakota-xyz/ts-sdk'
import {
  senderVerdict,
  senderAddress,
  agentTag,
  slugify,
  bodyFor,
  attachmentsFrom,
  type InboundEmail,
} from '@/lib/email'
import { dakota } from '@/lib/dakota'
import { listUsers, getUser, type AgentRef, type User } from '@/lib/store'
import { requiredDomains, emailDomain } from '@/lib/work-domain'
import { tenancyFor, updateTenancy } from '@/lib/tenancy'
import { acceptPlan } from '@/lib/accept'
import {
  verdictFor,
  describeLimits,
  amountRequested,
  dropCoveredMandates,
  activeLimitsFor,
  type Mandate,
} from '@/lib/autopay'
import { planSteps } from '@/lib/proposal'
import { renderEmail, type EmailParts } from '@/lib/email-template'
import { sendMail, mailConfigured } from '@/lib/mailer'
import { appOrigin } from '@/lib/origin'
import { withoutAttachments } from '@/lib/transcript'

// Forward an invoice, get a drafted payment.
//
// The security question here is sharper than in Slack. A "From" address is a
// claim anyone can make, and an invoice is precisely the thing worth forging —
// this is how business email compromise works. Three rules answer it:
//
//  1. DKIM must not FAIL. A forged sender is rejected before anything is read.
//  2. The sender must already be a visitor. A stranger emailing this address
//     gets silence — no draft, no reply, nothing that could be mistaken for
//     the system engaging with them.
//  3. Nothing executes. The agent DRAFTS; a payment still needs a signed
//     mandate, so even a convincing forgery from a known address cannot move
//     money outside what its owner already authorised.
//
// That third rule is the one that matters. The others reduce noise; the mandate
// is what makes this safe.

export const maxDuration = 300

export async function POST(req: Request) {
  // Postmark webhooks are unauthenticated by default, so the URL carries a
  // secret — and it is REQUIRED, not checked-if-present.
  //
  // The three rules above are all read out of the request BODY: senderVerdict()
  // parses DKIM from `Headers`, and the sender comes from `FromFull`. They
  // defend against a forged EMAIL, which is what Postmark hands us. They defend
  // against nothing at all if the caller is not Postmark, because then the
  // whole body is the attacker's to write — `dkim=pass` and a known visitor's
  // address included.
  //
  // This secret is the only thing that establishes the caller. Skipping the
  // check when it happens to be unset therefore did not degrade the endpoint's
  // safety, it removed it: rule 3 is not "nothing executes" either — a plan
  // inside an already-signed mandate auto-pays below. So an unset variable was
  // an unauthenticated way to move money within existing limits.
  //
  // Refusing is the only safe answer. An inbox that is off is recoverable in
  // one env var; the alternative is not recoverable at all.
  const expected = process.env.POSTMARK_WEBHOOK_SECRET
  if (!expected) {
    console.error('[email] POSTMARK_WEBHOOK_SECRET is unset — refusing inbound mail')
    return NextResponse.json({ error: 'inbound email is not configured' }, { status: 503 })
  }
  const given = new URL(req.url).searchParams.get('secret')
  if (given !== expected) {
    return NextResponse.json({ error: 'not authorized' }, { status: 401 })
  }

  let email: InboundEmail
  try {
    email = (await req.json()) as InboundEmail
  } catch {
    return NextResponse.json({ error: 'unreadable payload' }, { status: 400 })
  }

  // Acknowledge immediately. Postmark retries anything slow, and an agent turn
  // reading a PDF is slow — a retry would draft the same invoice twice.
  waitUntil(handle(email).catch((e) => console.error('[email] failed', e)))
  return NextResponse.json({ ok: true })
}

async function handle(email: InboundEmail) {
  const from = senderAddress(email)
  if (!from) return

  const { dkim } = senderVerdict(email)
  if (dkim === false) {
    // Explicitly failed, not merely absent. Absent means the receiving server
    // reported nothing, which is common for internal relays and is not
    // evidence of forgery.
    console.warn('[email] rejected: DKIM failed', from)
    return
  }

  // Who may drive an agent by email.
  //
  // A known member always may. On a deployment that restricts sign-in to a
  // domain, anyone AT that domain may too — they could sign in and do it
  // through the app, so requiring them to visit first adds a step without
  // adding a check. It also fixes the case that actually happens: a colleague
  // forwards an invoice before they have ever opened the tool, and their mail
  // vanishes with no reply.
  //
  // Without a domain restriction this stays exact-match. "Anyone whose address
  // we have seen" is the only line available when the front door is open, and
  // a public deployment must not let a stranger drive someone else's agent.
  //
  // DKIM is what makes the domain test worth anything — it is checked above,
  // so the sender is the domain's, not merely claiming to be.
  const users = await listUsers()
  const known = users.find((u) => u.email === from)
  const domains = requiredDomains()
  const sameOrg = domains.size > 0 && domains.has(emailDomain(from))

  if (!known && !sameOrg) {
    console.info('[email] ignored: not a member and not on an allowed domain', from)
    return
  }

  // The ACTOR is whoever sent it, member or not — that is what the activity log
  // should say. In team mode the tenancy is shared, so the address decides who
  // gets the credit, not which account is touched.
  const user = known ?? ({ email: from, name: from, domain: emailDomain(from) } as User)

  const tenancy = await tenancyFor(user.email)
  const agents = tenancy.agents ?? []
  if (agents.length === 0) return

  // Who gets a forwarded invoice.
  //
  //   1. `+payroll` in the address, if the sender's mail client allows it
  //   2. the agent that CLAIMED email in Integrations
  //   3. the first agent — so this works before anyone has chosen
  //
  // Without step 2 every inbox landed on whichever agent happened to be created
  // first, while the Integrations card appeared identically on all of them and
  // implied otherwise.
  const tag = agentTag(email)
  const agent =
    (tag && agents.find((a) => slugify(a.name) === tag)) ||
    agents.find((a) => a.handlesEmail) ||
    agents[0]

  const attachments = attachmentsFrom(email)
  const text = bodyFor(email, attachments.length > 0)
  if (!text && attachments.length === 0) return

  const history = withoutAttachments(((tenancy.conversations ?? {})[agent.id] ?? []) as ChatMessage[])
  const convo = dakota().resumeAgentConversation(agent.id, history, {
    timezone: process.env.DEMO_TIMEZONE ?? 'America/New_York',
  })

  const turn = attachments.length
    ? await convo.sendWithAttachments(text, attachments as never)
    : await convo.send(text)

  // The boundary screen can TERMINATE a conversation — repeated off-topic turns
  // or a manipulation attempt. In the app that surfaces as "start a new chat",
  // which an inbox has no way to offer: the next invoice would resume the same
  // dead transcript and get the same refusal, for ever. So a blocked turn
  // clears it, and the reply says the next one will work.
  const blocked = turn.conversationStatus === 'blocked'

  await updateTenancy(user.email, (u) => {
    u.conversations ??= {}
    // `rejected_input` means this message was refused wholesale and must NOT
    // join the history — the conversation itself is unharmed.
    if (blocked) delete u.conversations[agent.id]
    else if (turn.conversationStatus !== 'rejected_input') {
      u.conversations[agent.id] = withoutAttachments(convo.messages())
    }
    // A plan drafted HERE has no thread. Clearing it matters because the entry
    // is per agent, not per plan: an abandoned Slack draft would otherwise lend
    // its thread to whatever is drafted next, and a payment asked for in the app
    // would announce itself in a channel that never mentioned it.
    u.proposals ??= {}
    delete (u.proposalThreads ?? {})[agent.id]
    // Who to tell when this executes. A plan emailed in is usually approved in
    // the app, so by settlement time this is the only surviving record of where
    // it came from — the same trip through the browser that loses a Slack
    // thread loses an email address.
    u.proposalEmails ??= {}
    if (turn.hasProposals) u.proposalEmails[agent.id] = from
    else delete u.proposalEmails[agent.id]
    if (turn.hasProposals) u.proposals[agent.id] = turn.proposals
    else delete u.proposals[agent.id]
  })

  if (blocked) {
    if (mailConfigured()) {
      const rendered = renderEmail({
        reply: turn.reply,
        steps: [],
        outcome: {
          kind: 'failed',
          line: 'I have started a fresh conversation — forward the invoice again and it will go through.',
        },
        link: `${appOrigin()}/?agent=${encodeURIComponent(agent.id)}`,
        agentName: agent.name,
      })
      await sendMail({
        to: from,
        subject: `Re: ${email.Subject ?? 'your invoice'}`,
        text: rendered.text,
        html: rendered.html,
      }).catch((e) => console.error('[email] reply failed', e))
    }
    return
  }

  const parts = await settle(user.email, agent, turn, from)

  if (!mailConfigured()) {
    console.info('[email] handled, no reply sent (outbound not configured)', from)
    return
  }
  const rendered = renderEmail(parts)
  await sendMail({
    to: from,
    subject: `Re: ${email.Subject ?? 'your invoice'}`,
    text: rendered.text,
    html: rendered.html,
  }).catch((e) => console.error('[email] reply failed', e))
}

/**
 * Do as much as the visitor already authorised, and say what happened.
 *
 * This is the difference between a demo and something usable. An invoice that
 * fits inside a spend limit the visitor SIGNED needs no further permission —
 * asking again would be asking them to authorise the same thing twice. One that
 * does not fit stops, and the reply names the limit that stopped it, because a
 * refusal you have to go and investigate is barely better than silence.
 */
async function settle(
  email: string,
  agent: AgentRef,
  turn: { reply: string; hasProposals: boolean; proposals: unknown[] },
  replyTo: string
): Promise<EmailParts> {
  // Drop a drafted limit the visitor's standing one already covers, BEFORE
  // judging the plan — otherwise an invoice inside an authority they granted
  // last week still comes back asking for a signature.
  const drafted = turn.hasProposals ? turn.proposals : []
  const { plan } = dropCoveredMandates(drafted, await activeLimitsFor(agent.signerId))
  const verdict = verdictFor(plan)
  const link = `${appOrigin()}/?agent=${encodeURIComponent(agent.id)}`

  // What the plan actually DOES, not just what the agent said about it. An
  // emailed reply is the whole interface here — there is no screen to check
  // afterwards — so the actions travel with it, in both outcomes. It matters
  // most when the answer is "paid": the reader is being told after the fact,
  // and the actions are their only account of what happened.
  const steps = planSteps(plan)
  const base = { reply: turn.reply, steps, link, agentName: agent.name }

  if (verdict.auto) {
    const user = await getUser(email)
    if (!user) return { ...base, outcome: { kind: 'none' } }
    try {
      await acceptPlan({ user, agent, plan, auto: true, originEmail: replyTo })
      return {
        ...base,
        outcome: {
          kind: 'paid',
          line: 'Paid — this was inside a spend limit you had already signed.',
        },
      }
    } catch (e) {
      // Money did not move and we are about to tell them so. Do not dress a
      // failure up as a pending approval.
      console.error('[email] auto-pay failed', e)
      return {
        ...base,
        outcome: {
          kind: 'failed',
          line: 'I could not schedule that automatically — something went wrong on our side.',
        },
      }
    }
  }

  if (verdict.blocker === 'nothing_to_do') return { ...base, outcome: { kind: 'none' } }

  const asked = amountRequested(plan)
  const head =
    verdict.blocker === 'new_limit'
      ? `Not paid${asked ? ` — ${asked}` : ''} is outside your signed spend limits.`
      : `Not paid — this adds a new payee or account, which always needs you.`

  const limits = await describeCurrentLimits(agent)
  const grant =
    verdict.blocker === 'new_limit' && verdict.wants
      ? `\n\nTo allow it, you would be signing a new limit of ${verdict.wants}.`
      : ''

  return { ...base, outcome: { kind: 'blocked', line: head, limits, grant: grant.trim() || undefined } }
}

/** The agent's live authority, or a usable message if we cannot read it. */
async function describeCurrentLimits(agent: AgentRef): Promise<string> {
  if (!agent.signerId) return 'You have no signed spend limits yet.'
  try {
    const mandates = []
    for await (const m of dakota().mandates.list({ signer_id: agent.signerId } as never)) {
      mandates.push(m as Mandate)
    }
    return describeLimits(mandates)
  } catch (e) {
    console.error('[email] could not read limits', e)
    return 'I could not read your current spend limits just now.'
  }
}
