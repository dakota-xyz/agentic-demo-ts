import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import type { ChatMessage } from '@dakota-xyz/ts-sdk'
import {
  verifySignature,
  slackConfigured,
  post,
  update,
  updateBlocks,
  linkButton,
  textBlock,
  fileInfo,
  download,
} from '@/lib/slack/client'
import type { Attachment, AttachmentMediaType } from '@dakota-xyz/ts-sdk'
import { dakota } from '@/lib/dakota'
import {
  listUsers,
  updateUser,
  getTeam,
  updateTeam,
  type User,
  type AgentRef,
} from '@/lib/store'
import { tenancyFor, updateTenancy, isTeamMode } from '@/lib/tenancy'
import { appOrigin } from '@/lib/origin'
import { planText } from '@/lib/proposal'
import { dropCoveredMandates, activeLimitsFor, verdictFor } from '@/lib/autopay'
import { acceptPlan } from '@/lib/accept'
import { rememberPending } from '@/lib/slack/notify'
import {
  forThisBot,
  followThread,
  stripLeadingMention,
} from '@/lib/slack/gate'
import { withoutAttachments } from '@/lib/transcript'

// Slack -> agent.
//
// A Slack message is just another chat turn: this resolves which agent owns the
// channel, hands the text to the same conversation the web composer uses, and
// posts the reply back. It adds NO payment reasoning.
//
// The one thing serverless changes is how the work outlives the response. Slack
// retries anything it has not seen acknowledged within three seconds, and an
// agent turn is an LLM call that routinely takes longer — so replying
// synchronously means Slack retries and the same invoice gets drafted twice.
// The Go build answered immediately and carried on in a goroutine; here
// waitUntil keeps the function alive past the response, which is the same
// shape.

// An agent turn is an LLM call, and a turn that has to READ a PDF is
// materially slower — 60s killed those mid-flight. A kill is not catchable, so
// the placeholder was stranded at "Reading…" with nothing ever updating it.
export const maxDuration = 300

/**
 * How long we let a turn run before giving up ourselves.
 *
 * Deliberately under maxDuration: a Vercel timeout kills the function outright,
 * so no catch runs and no message is updated. Losing the race on our own terms
 * is the only way to leave the channel with an explanation rather than a
 * sentence that never finishes.
 */
const TURN_BUDGET_MS = 270_000

/** Events already handled, keyed (channel, ts). */
const seen = new Set<string>()

/**
 * Remember an event, reporting whether it is new.
 *
 * A file posted WITH a mention arrives as two events — app_mention and
 * message.channels/file_share — different types, same message. Deduping on
 * (channel, ts) collapses those, and Slack's retries with them.
 *
 * The set lives on the warm container, so a cold start forgets. That is
 * acceptable: the window that matters is seconds, and a duplicate across a cold
 * start is far rarer than the same-message double-delivery this exists for.
 */
function firstTime(channel: string, ts: string): boolean {
  const key = `${channel}:${ts}`
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > 500) seen.delete(seen.values().next().value as string)
  return true
}

interface SlackFile {
  id?: string
}

interface SlackEvent {
  type?: string
  subtype?: string
  text?: string
  channel?: string
  ts?: string
  thread_ts?: string
  /** "im" for a DM, "channel"/"group" otherwise. Decides if a message is ours. */
  channel_type?: string
  user?: string
  bot_id?: string
  /** Present on a message posted WITH an upload. */
  files?: SlackFile[]
  /** file_shared events carry only an id. */
  file_id?: string
}

/** What the agent can actually read. */
const READABLE: Record<string, AttachmentMediaType> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/**
 * Pull any readable uploads off an event.
 *
 * Slack delivers a file two ways: inline on the message (`files`) when it was
 * posted with text, and as a bare `file_id` on a file_shared event.
 *
 * Either way this collects only the IDS and looks each one up with files.info,
 * exactly as the Go build does. The inline object is deliberately not trusted:
 * Slack frequently sends it partial — commonly without url_private_download —
 * and reading the URL straight off it means a PDF silently never downloads.
 * files.info always returns the full record.
 *
 * A file the agent cannot read is skipped, not failed on: someone dropping a
 * .docx in the channel should get an answer about their text, not an error
 * about the attachment.
 */
async function attachmentsFrom(event: SlackEvent): Promise<Attachment[]> {
  const ids = (event.files ?? []).map((f) => f.id).filter(Boolean) as string[]
  if (ids.length === 0 && event.file_id) ids.push(event.file_id)

  const out: Attachment[] = []
  for (const id of ids) {
    let meta
    try {
      meta = await fileInfo(id)
    } catch (e) {
      console.error('[slack] files.info failed', id, e)
      continue
    }

    const mediaType = READABLE[(meta.mimetype ?? '').toLowerCase()]
    if (!mediaType) {
      console.warn('[slack] skipping unreadable attachment', meta.name, meta.mimetype)
      continue
    }
    if (!meta.url_private_download) {
      console.error('[slack] file has no download url', meta.name)
      continue
    }

    try {
      const bytes = await download(meta.url_private_download)
      out.push({ mediaType, data: new Uint8Array(bytes), filename: meta.name })
    } catch (e) {
      console.error('[slack] file download failed', meta.name, e)
    }
  }
  return out
}

export async function POST(req: Request) {
  if (!slackConfigured()) {
    return NextResponse.json({ error: 'slack is not configured' }, { status: 503 })
  }

  // The raw body, byte for byte — the signature covers exactly these bytes, so
  // parsing first and re-serialising would break verification.
  const raw = await req.text()

  const check = verifySignature(req.headers, raw)
  if (!check.ok) {
    console.warn('[slack] rejected:', check.reason)
    return NextResponse.json({ error: check.reason }, { status: 401 })
  }

  const payload = JSON.parse(raw) as {
    type?: string
    challenge?: string
    event?: SlackEvent
  }

  // Slack verifies the Request URL by posting a challenge it wants echoed.
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const event = payload.event
  if (!event?.channel || !event.ts) return NextResponse.json({ ok: true })

  // Ignore our own messages. The bot's reply is itself a channel message;
  // without this it answers itself forever.
  if (event.bot_id || event.subtype === 'bot_message') return NextResponse.json({ ok: true })

  // Is this message for us at all? A mention, a DM, or a reply in a thread the
  // bot is following — anything else in the channel is somebody else talking.
  // This runs BEFORE the deduper on purpose: an ignored event must not consume
  // a (channel, ts) slot, or the second delivery of a file-with-mention (which
  // shares that ts) would be dropped as a duplicate instead of answered.
  if (!forThisBot(event)) return NextResponse.json({ ok: true })

  if (!firstTime(event.channel, event.ts)) return NextResponse.json({ ok: true })

  // Ack FIRST. Everything below runs after the response has gone.
  waitUntil(handleTurn(event).catch((e) => console.error('[slack] turn failed', e)))
  return NextResponse.json({ ok: true })
}

/** Reject if the turn outlives our budget, so the channel still hears back. */
function withBudget<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('that took too long to work out — try asking for one payment at a time')),
        TURN_BUDGET_MS
      )
    ),
  ])
}

/**
 * Find the visitor and agent that own a channel.
 *
 * Refuses to answer when more than one agent claims the same channel. Returning
 * the first match would make routing depend on row order — and route one
 * company's payment request into another company's agent, silently. Claiming is
 * guarded at the point of connection, so this should be unreachable; it exists
 * because "unreachable" and "safe to guess" are different things.
 *
 * NOTE: keyed on channel id alone. Channel ids are not unique ACROSS Slack
 * workspaces, so this is only sound while the deployment serves one workspace.
 * Per-workspace OAuth has to make the key (team_id, channel_id).
 */
async function ownerOf(
  channelId: string
): Promise<
  { user: User; agent: AgentRef; moved?: string } | { ambiguous: string[] } | null
> {
  // In team mode the agents live on the shared document and any member may be
  // named as the actor, so the first member stands in for "the team". In
  // visitor mode the agent genuinely belongs to one person and the search is
  // over their own rows.
  if (isTeamMode()) {
    const team = await getTeam()
    const agent = (team?.agents ?? []).find((a) => a.slack?.channelId === channelId)
    if (agent) {
      const [member] = await listUsers()
      return member ? { user: member, agent } : null
    }

    // Claimed, but by an agent from BEFORE this deployment moved to a shared
    // team account — those links live on user rows, which the team document
    // cannot see, so a channel that had always replied simply went quiet.
    //
    // The CLAIM moves; the agent does not. An agent belongs to a customer, and
    // the pre-team one belongs to a different one — answering as it would spend
    // from wallets nobody in this channel is looking at. What the channel
    // actually meant is "this room talks to our payments agent", and in a
    // shared account that is unambiguous whenever there is exactly one.
    const stale = (await listUsers()).find((u) =>
      (u.agents ?? []).some((a) => a.slack?.channelId === channelId)
    )
    if (!stale) return null

    const old = (stale.agents ?? []).find((a) => a.slack?.channelId === channelId)!
    const candidates = team?.agents ?? []

    if (candidates.length !== 1) {
      console.warn('[slack] stale claim, %d team agents — cannot pick', candidates.length, channelId)
      return { ambiguous: candidates.map((a) => a.name) }
    }

    const heir = candidates[0]
    await updateTeam((t) => {
      const a = (t.agents ?? []).find((x) => x.id === heir.id)
      // Carry the channel across, but NOT the pending-button state: those
      // messages point at a plan in the old tenancy that this agent never made.
      if (a) a.slack = { ...old.slack!, pendingDraft: undefined, pendingSign: undefined }
    })
    // Release the old claim, so the channel is not claimed twice the moment
    // anyone switches this deployment back to per-visitor mode.
    await updateUser(stale.email, (u) => {
      const a = (u.agents ?? []).find((x) => x.id === old.id)
      if (a) delete a.slack
    })
    console.info('[slack] moved channel %s from %s to team agent %s', channelId, old.id, heir.id)

    const [member] = await listUsers()
    return member ? { user: member, agent: { ...heir, slack: old.slack }, moved: heir.name } : null
  }

  const matches: { user: User; agent: AgentRef }[] = []
  for (const user of await listUsers()) {
    for (const agent of user.agents ?? []) {
      if (agent.slack?.channelId === channelId) matches.push({ user, agent })
    }
  }
  if (matches.length > 1) {
    console.error('[slack] channel claimed by multiple agents, refusing to route', channelId,
      matches.map((m) => `${m.user.email}:${m.agent.id}`))
    return null
  }
  return matches[0] ?? null
}

async function handleTurn(event: SlackEvent) {
  const channel = event.channel!
  const owner = await ownerOf(channel)
  if (!owner) return // a channel nobody has connected

  if ('ambiguous' in owner) {
    await post(
      channel,
      ':link: This channel was connected before the workspace moved to a shared account, and there ' +
        (owner.ambiguous.length === 0
          ? 'is no agent to move it to yet — create one in the app.'
          : `are several agents now (${owner.ambiguous.join(', ')}). Reconnect this channel from *Integrations* so I know which one you mean.`)
    ).catch(() => {})
    return
  }

  const { user, agent } = owner
  if (owner.moved) {
    await post(channel, `:link: Reconnected this channel to *${owner.moved}* — carrying on.`).catch(() => {})
  }
  const text = stripLeadingMention(event.text ?? '')

  // Fetched BEFORE the placeholder so a download failure does not leave a
  // "Thinking…" hanging in the channel.
  const attachments = await attachmentsFrom(event)

  // An invoice posted with no words is a complete request on its own — it says
  // "pay this". Requiring a caption would be pedantry.
  if (!text && attachments.length === 0) return

  // Reply in the thread the request started, so a conversation about one
  // invoice stays attached to it.
  const threadTs = event.thread_ts ?? event.ts!

  // The bot is about to speak in this thread, so from now on it follows plain
  // replies to it for the idle window — no re-mention needed.
  followThread(channel, threadTs)

  // A placeholder posted immediately, then EDITED into the answer — one message
  // that changes, rather than a stale "thinking" line above the reply.
  const placeholderTs = await post(
    channel,
    attachments.length ? `_Reading ${attachments[0].filename ?? 'the document'}…_` : '_Thinking…_',
    threadTs
  )

  try {
    const tenancy = await tenancyFor(user.email)

    const history = withoutAttachments(((tenancy.conversations ?? {})[agent.id] ?? []) as ChatMessage[])

    const convo = dakota().resumeAgentConversation(agent.id, history, {
      timezone: process.env.DEMO_TIMEZONE ?? 'America/New_York',
    })
    const turn = await withBudget(
      attachments.length
        ? convo.sendWithAttachments(
            text || 'Draft a payment from the attached document.',
            attachments
          )
        : convo.send(text)
    )

    // Same rule as the app: drop a drafted limit the standing one already
    // covers, then pay outright if nothing is left to ask.
    const limits = await activeLimitsFor(agent.signerId)
    const settled = turn.hasProposals
      ? dropCoveredMandates(turn.proposals, limits)
      : { plan: turn.proposals as unknown[], covered: false }
    const verdict = turn.hasProposals ? verdictFor(settled.plan) : { auto: false as const }

    let paid = false
    let paidIds: string[] = []
    if (verdict.auto) {
      try {
        const res = await acceptPlan({
          user,
          agent,
          plan: settled.plan,
          auto: true,
          originThread: threadTs,
        })
        paid = true
        paidIds = res.paymentIds
      } catch (e) {
        console.error('[slack] auto-accept failed', e)
      }
    }

    // See the email route: a terminated conversation has to be cleared here
    // too, or every later message in the channel resumes a dead transcript.
    const blocked = turn.conversationStatus === 'blocked'

    await updateTenancy(user.email, (u) => {
      u.conversations ??= {}
      if (blocked) delete u.conversations[agent.id]
      else if (turn.conversationStatus !== 'rejected_input') {
        u.conversations[agent.id] = withoutAttachments(convo.messages())
      }
      u.proposals ??= {}
      u.proposalThreads ??= {}
      if (turn.hasProposals && !paid) {
        u.proposals[agent.id] = settled.plan
        u.proposalThreads[agent.id] = threadTs
      } else {
        delete u.proposals[agent.id]
        delete u.proposalThreads[agent.id]
      }

      const link = (u.agents ?? []).find((a) => a.id === agent.id)?.slack
      if (link) link.lastThreadTs = threadTs
    })

    if (blocked) {
      await update(
        channel,
        placeholderTs,
        `${turn.reply}\n\n_Started a fresh conversation — ask again and it will go through._`
      )
      return
    }

    if (!turn.hasProposals) {
      await update(channel, placeholderTs, turn.reply)
      return
    }

    // Paid already — there is nothing to approve, so do not offer to. A button
    // whose only honest label is "yes, the thing I just asked for" is worse
    // than no button: it implies the payment is still waiting on you.
    if (paid) {
      const steps = planText(settled.plan, { bullet: '•' })
      // Link straight to the payment, the same way the settlement message does.
      // "Paid" invites "which one, and can I see it" — and the detail view
      // answers both, including the limit that allowed it.
      const done = ':white_check_mark: *Paid* — this was inside a spend limit you had already signed.'
      const deepLink = paidIds[0]
        ? `${appOrigin()}/?agent=${encodeURIComponent(agent.id)}&tab=scheduled&payment=${encodeURIComponent(paidIds[0])}`
        : ''
      await updateBlocks(channel, placeholderTs, `${turn.reply}\n\n${steps}\n\n${done}`, [
        textBlock(turn.reply),
        ...(steps ? [textBlock(steps)] : []),
        textBlock(done),
        ...(deepLink ? [linkButton('View the payment →', deepLink)] : []),
      ])
      return
    }

    // A drafted plan needs a human. Approving is a WebAuthn passkey signature:
    // it needs a browser, the right origin, and a key that never leaves the
    // device's secure enclave — none of which exist in a Slack callback. So the
    // button is a link into the app, not an action.
    await updateBlocksWithButton(channel, placeholderTs, turn.reply, agent.id, settled.plan)
    // Remembered so approving in the app can retire this button rather than
    // leaving it clickable forever.
    await rememberPending(user.email, agent.id, 'pendingDraft', {
      ts: placeholderTs,
      text: turn.reply,
    })
  } catch (e) {
    let why = e instanceof Error ? e.message : String(e)
    // The SDK's bare "Request timed out" tells the reader nothing they can act
    // on, and reads as the agent being broken when it was still thinking.
    if (/timed out|timeout/i.test(why)) {
      why = 'that one took too long to work out — try asking for a single payment, or a shorter series'
    }
    await update(channel, placeholderTs, `:warning: ${why}`).catch(() => {})
  }
}

async function updateBlocksWithButton(
  channel: string,
  ts: string,
  reply: string,
  agentId: string,
  plan?: readonly unknown[]
) {
  // The prose above describes the plan; this IS the plan. They can differ, and
  // an offramp is exactly where — "pay the invoice" reads identically whether
  // the money stays in crypto or lands in someone's bank account. The browser
  // shows this as a rendered preview before you can approve; the channel that
  // sent you there should not be the one place it is hidden.
  const steps = plan?.length ? planText(plan, { bullet: '•' }) : ''
  const blocks = [
    textBlock(reply),
    ...(steps ? [textBlock(steps)] : []),
    linkButton('Review & approve →', `${appOrigin()}/?agent=${encodeURIComponent(agentId)}`),
  ]
  await updateBlocks(channel, ts, steps ? `${reply}\n\n${steps}` : reply, blocks)
}
