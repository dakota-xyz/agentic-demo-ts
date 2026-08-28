import { NextResponse } from 'next/server'
import type { Attachment, AttachmentMediaType, ChatMessage } from '@dakota-xyz/ts-sdk'
import { authed, body } from '@/lib/api'
import { dakota } from '@/lib/dakota'
import { dropCoveredMandates, activeLimitsFor, verdictFor } from '@/lib/autopay'
import { acceptPlan } from '@/lib/accept'
import { withoutAttachments } from '@/lib/transcript'

// One chat turn with an agent.
//
// This is the demo's whole thesis in one handler: the visitor writes what they
// want in plain language, the agent either asks a question or drafts a
// reviewable payment, and nothing moves until a mandate is signed.
//
// The transcript lives in our store rather than on the platform: the proposals
// endpoint is stateless, so the full history is resent every turn. The SDK
// models this directly — persist `messages()`, rebuild with
// `resumeAgentConversation` — which is exactly the shape a route handler needs,
// since a serverless function keeps nothing between requests.

/**
 * An agent turn is an LLM call, and one that has to READ a PDF is materially
 * slower. 60s was killing those, and a Vercel kill is not catchable — the
 * request just dies with no error the browser can show.
 */
export const maxDuration = 300

interface ChatRequest {
  agentId?: string
  message?: string
  /** IANA zone, so "tomorrow" and "10 am" mean what the visitor means. */
  timezone?: string
  /** An invoice to draft from. Data is base64 — JSON carries no bytes. */
  attachment?: { mediaType?: string; data?: string; filename?: string }
}

/** What the agent can read. Anything else is refused with a reason. */
const READABLE: Record<string, AttachmentMediaType> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/** 8 MiB, matching the Slack path — invoices are small. */
const MAX_ATTACHMENT_BYTES = 8 << 20

/**
 * The stored transcript for an agent.
 *
 * The conversation lives in our store, not on the platform — the proposals
 * endpoint is stateless. Without this the transcript was written on every turn
 * and never read back, so a reload showed an empty chat while the history sat
 * in Postgres: the agent looked amnesiac when it was not.
 *
 * Attachments are stripped. The persisted transcript carries invoice bytes
 * (replayed to the agent each turn); the browser needs role and content only,
 * and shipping a PDF into a chat render is pure weight.
 */
export const GET = authed(async ({ tenancy, req }) => {
  const agentId = new URL(req.url).searchParams.get('agentId') ?? ''
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })

  const stored = ((tenancy.conversations ?? {})[agent.id] ?? []) as {
    role?: string
    content?: string
  }[]
  const messages = stored
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim())
    .map((m) => ({ role: m.role, content: m.content }))

  // Restore the last drafted-but-unaccepted plan too, so a reload brings back
  // the actionable proposal rather than only the text that described it.
  const proposals = (tenancy.proposals ?? {})[agent.id]

  return NextResponse.json({
    messages,
    proposals: proposals ?? null,
    hasProposals: Array.isArray(proposals) && proposals.length > 0,
  })
})

export const POST = authed(async ({ user, tenancy, req, saveTenancy }) => {
  const { agentId, message, timezone, attachment } = await body<ChatRequest>(req)

  const text = (message ?? '').trim()

  // An invoice with no words is a complete request on its own — it says "pay
  // this". Only a turn with NEITHER is empty.
  let attachments: Attachment[] | undefined
  if (attachment?.data) {
    const mediaType = READABLE[(attachment.mediaType ?? '').toLowerCase()]
    if (!mediaType) {
      return NextResponse.json(
        { error: 'the agent can read PDFs and images (PNG, JPEG, WebP, GIF)' },
        { status: 400 }
      )
    }
    const bytes = Buffer.from(attachment.data, 'base64')
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        { error: `that file is too large (limit ${MAX_ATTACHMENT_BYTES >> 20} MiB)` },
        { status: 400 }
      )
    }
    attachments = [{ mediaType, data: new Uint8Array(bytes), filename: attachment.filename }]
  }

  if (!text && !attachments) {
    return NextResponse.json({ error: 'say something to the agent' }, { status: 400 })
  }

  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  // Checked against the visitor's OWN agents, not just for existence: agent ids
  // are the only thing between one visitor's sandbox and another's, so a
  // guessed id must not route.
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })

  // A chat turn can be the first thing a visitor does, and drafting a payment
  // needs somewhere to pay from.

  const history = withoutAttachments(((tenancy.conversations ?? {})[agent.id] ?? []) as ChatMessage[])

  const conversation = dakota().resumeAgentConversation(agent.id, history, {
    // Left unset, the agent resolves times as UTC — so "pay them at 10am"
    // silently means 10am UTC, which is the wrong payment at the wrong time for
    // everyone outside one timezone.
    ...(timezone ? { timezone } : {}),
  })

  const turn = attachments
    ? await conversation.sendWithAttachments(
        text || 'Draft a payment from the attached document.',
        attachments
      )
    : await conversation.send(text)

  // A standing limit the visitor already signed makes the agent's freshly
  // drafted one redundant — see dropCoveredMandates. Applied HERE, before the
  // plan is stored, so the preview, the approve button, the stored draft and
  // the reply all describe the same plan.
  const limits = await activeLimitsFor(agent.signerId)
  const settled = turn.hasProposals
    ? dropCoveredMandates(turn.proposals, limits)
    : { plan: turn.proposals as unknown[], covered: false }

  // Nothing left to ask. A plan that is ONLY scheduled payments, inside a limit
  // already signed, has no question in it: the amount was authorised when the
  // limit was, the payee is one the agent was allowed to pay, and there is no
  // signature to collect. Asking anyway is a button whose only honest label is
  // "yes, the thing I just asked for".
  //
  // The email path has worked this way since it existed. Chat asking while
  // email did not was the inconsistency, not this.
  //
  // Anything else still stops: a new payee, a new address, an auto-account, or
  // a limit the agent wants widened. verdictFor draws that line, and draws it
  // the same way for both channels.
  const verdict = turn.hasProposals ? verdictFor(settled.plan) : { auto: false as const }
  let paid = false
  if (verdict.auto) {
    try {
      await acceptPlan({ user, agent, plan: settled.plan, auto: true })
      paid = true
    } catch (e) {
      // Say so rather than falling back to a button, which would look like the
      // payment is merely waiting when it has actually failed.
      console.error('[chat] auto-accept failed', e)
    }
  }

  await saveTenancy((u) => {
    u.conversations ??= {}
    u.conversations[agent.id] = withoutAttachments(conversation.messages())

    // Keep the last drafted-but-unaccepted proposal so a page reload restores
    // the actionable plan, not just the text that described it. A plan already
    // accepted is not one of those.
    // A plan drafted HERE has no thread. Clearing it matters because the entry
    // is per agent, not per plan: an abandoned Slack draft would otherwise lend
    // its thread to whatever is drafted next, and a payment asked for in the app
    // would announce itself in a channel that never mentioned it.
    u.proposals ??= {}
    delete (u.proposalThreads ?? {})[agent.id]
    if (turn.hasProposals && !paid) {
      u.proposals[agent.id] = settled.plan
    } else {
      delete u.proposals[agent.id]
    }

    u.history ??= []
    u.history.push({
      id: crypto.randomUUID(),
      agentId: agent.id,
      at: new Date().toISOString(),
      kind: 'chat',
      text: text || `(sent ${attachment?.filename ?? 'a document'})`,
    })
  })

  return NextResponse.json({
    reply: turn.reply,
    // Accepted already: the client should render what happened, not an offer.
    paid,
    proposals: paid ? [] : settled.plan,
    hasProposals: turn.hasProposals,
    // 'blocked' means the boundary screen terminated the chat: stop serving it
    // and offer a fresh conversation rather than letting the visitor type into
    // something that will never answer again.
    conversationStatus: turn.conversationStatus,
  })
})
