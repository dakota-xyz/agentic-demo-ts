import { createHmac, timingSafeEqual } from 'node:crypto'
import { toMrkdwn } from './mrkdwn'

// The transport between a Slack channel and an agent.
//
// It does three things and nothing else: prove an inbound request really came
// from Slack, fetch a file someone posted, and post a message back. All the
// payment reasoning stays where it already lives — a Slack message is just
// another chat turn.

/** How stale a signed request may be. Slack recommends five minutes. */
const MAX_SKEW_SECONDS = 5 * 60

/** Bounds what we will pull out of Slack. Invoices are small. */
const MAX_FILE_BYTES = 8 << 20 // 8 MiB

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET)
}

/**
 * Check that body really came from Slack, unmodified.
 *
 * Slack signs "v0:{timestamp}:{body}" with HMAC-SHA256 under the signing
 * secret. Our endpoint is public by necessity — Slack has to reach it — so
 * without this check anyone who found the URL could post a forged "invoice
 * arrived" event and have an agent draft a payment to an address they chose.
 * The spend limit would still cap the loss, but that is the last line, not the
 * first.
 */
export function verifySignature(headers: Headers, rawBody: string): { ok: true } | { ok: false; reason: string } {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) return { ok: false, reason: 'slack signing secret is not configured' }

  const ts = headers.get('x-slack-request-timestamp')
  const sig = headers.get('x-slack-signature')
  if (!ts || !sig) return { ok: false, reason: 'missing slack signature headers' }

  const secs = Number.parseInt(ts, 10)
  if (!Number.isFinite(secs)) return { ok: false, reason: 'bad slack timestamp' }

  // Reject replays in BOTH directions: a clock skewed the other way would
  // otherwise accept arbitrarily old captures.
  const drift = Math.floor(Date.now() / 1000) - secs
  if (drift > MAX_SKEW_SECONDS || drift < -MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'slack request too old' }
  }

  const want = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex')
  const a = Buffer.from(want)
  const b = Buffer.from(sig)
  // timingSafeEqual throws on a length mismatch, which is itself a mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'slack signature mismatch' }
  }
  return { ok: true }
}

type SlackResponse = { ok?: boolean; error?: string; ts?: string; [k: string]: unknown }

async function call(method: string, payload: Record<string, unknown>): Promise<SlackResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  })
  const out = (await res.json()) as SlackResponse
  if (!out.ok) {
    // "not_in_channel" is the one everybody hits: the app is installed but
    // nobody invited the bot to the channel.
    if (out.error === 'not_in_channel') {
      throw new Error('the bot is not in that channel — run /invite in Slack')
    }
    throw new Error(`slack ${method}: ${out.error ?? 'unknown error'}`)
  }
  return out
}

/** One Block Kit element. Kept loose — this format is built in one place. */
export type Block = Record<string, unknown>

/**
 * An actions block with a single URL button.
 *
 * A url button needs no interaction handler — Slack just opens the link — so it
 * adds no server surface and cannot fail silently the way a callback can.
 */
export function linkButton(label: string, url: string): Block {
  return {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: label, emoji: true }, url, style: 'primary' },
    ],
  }
}

export function textBlock(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text: toMrkdwn(text) } }
}

/** Post a message; returns its ts, the handle needed to edit it later. */
export async function post(channel: string, text: string, threadTs?: string): Promise<string> {
  const out = await call('chat.postMessage', {
    channel,
    text: toMrkdwn(text),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  })
  return out.ts ?? ''
}

export async function postBlocks(
  channel: string,
  fallback: string,
  blocks: Block[],
  threadTs?: string
): Promise<string> {
  const out = await call('chat.postMessage', {
    channel,
    // The plain text is the fallback: it is what shows in notifications and on
    // clients that cannot render blocks.
    text: toMrkdwn(fallback),
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  })
  return out.ts ?? ''
}

/**
 * Rewrite a message posted earlier.
 *
 * This is how the placeholder becomes the answer: one message that changes,
 * rather than a second message under a stale "thinking" line.
 */
export async function update(channel: string, ts: string, text: string): Promise<void> {
  await call('chat.update', { channel, ts, text: toMrkdwn(text) })
}

export async function updateBlocks(
  channel: string,
  ts: string,
  fallback: string,
  blocks: Block[]
): Promise<void> {
  await call('chat.update', { channel, ts, text: toMrkdwn(fallback), blocks })
}

/**
 * Confirm the bot token works.
 *
 * Returns the workspace, the bot's user id (used to ignore our own messages so
 * the bot does not answer itself forever) and its handle, which is what a
 * person needs to type in an /invite.
 */
export async function authTest(): Promise<{ team: string; userId: string; userName: string }> {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  })
  const out = (await res.json()) as SlackResponse & {
    team?: string
    user_id?: string
    user?: string
  }
  if (!out.ok) throw new Error(`slack auth.test: ${out.error}`)
  return { team: out.team ?? '', userId: out.user_id ?? '', userName: out.user ?? 'your-bot' }
}

/** Look up a file by id — the file_shared event carries only an id. */
export async function fileInfo(id: string) {
  const res = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  })
  const out = (await res.json()) as SlackResponse & {
    file?: { name?: string; mimetype?: string; url_private_download?: string; size?: number }
  }
  if (!out.ok || !out.file) throw new Error(`slack files.info: ${out.error ?? 'no file'}`)
  return out.file
}

/** Fetch a private file's bytes using the bot token. */
export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  })
  if (!res.ok) throw new Error(`slack file download: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`that file is too large to read (limit ${MAX_FILE_BYTES >> 20} MiB)`)
  }
  return buf
}

/**
 * What conversations.info tells us about a channel.
 *
 * `verified: false` means we could not check — the app lacks channels:read —
 * NOT that the channel is bad. The two must stay distinguishable: refusing a
 * connection because we lack a scope would break every setup that works today.
 */
export interface ChannelInfo {
  id: string
  name: string
  isMember: boolean
  isPrivate: boolean
  verified: boolean
  /** Why verification was skipped, when it was. */
  unverifiedReason?: string
}

/**
 * Look up a channel, confirming it exists and that the bot can see it.
 *
 * Without this, connecting accepts any string starting with C: the app shows
 * "Connected", and messages silently never arrive because the channel is in
 * another workspace, does not exist, or the bot was never invited. A green
 * badge over a dead pipe is worse than no badge.
 *
 * It also stops channel-id squatting once more than one visitor can connect:
 * you can only claim a channel you can actually reach.
 */
export async function channelInfo(channelId: string): Promise<ChannelInfo> {
  const res = await fetch(
    `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  )
  const out = (await res.json()) as {
    ok?: boolean
    error?: string
    /** Slack names the exact scope it wanted. Do not guess in its place. */
    needed?: string
    channel?: { id?: string; name?: string; is_member?: boolean; is_private?: boolean }
  }

  if (!out.ok || !out.channel) {
    // A missing scope is OUR gap, not a bad channel. Blocking on it would stop
    // working setups from reconnecting, so it degrades to "unverified" and the
    // caller decides. Everything else is a real answer about the channel.
    if (out.error === 'missing_scope' || out.error === 'not_allowed_token_type') {
      return {
        id: channelId,
        name: '',
        isMember: false,
        isPrivate: false,
        verified: false,
        // Slack says WHICH scope it wanted, and it is not always channels:read
        // — a private channel needs groups:read, and naming the wrong one sends
        // someone to add a scope they already have.
        unverifiedReason: `add the ${out.needed ?? 'channels:read'} scope to the Slack app (and reinstall it) to have this checked automatically`,
      }
    }
    // Slack's raw codes are precise and unhelpful to a human, so each becomes
    // the thing to actually do about it.
    throw new Error(
      out.error === 'channel_not_found'
        ? 'no channel with that id — check you copied it from the right workspace'
        : `Slack rejected that channel (${out.error ?? 'unknown'})`
    )
  }

  return {
    id: out.channel.id ?? channelId,
    name: out.channel.name ?? '',
    isMember: out.channel.is_member ?? false,
    isPrivate: out.channel.is_private ?? false,
    verified: true,
  }
}
