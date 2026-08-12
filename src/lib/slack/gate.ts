// Which inbound Slack messages are for the bot, and which are somebody else's
// conversation.
//
// The demo subscribes to `message.channels` (and `message.groups`), so Slack
// delivers EVERY message in a connected channel — not just the ones that name
// the bot. Without a gate the bot answers colleagues talking to each other, and
// treats a "joined the channel" line as an instruction. This is the same
// classification the Go slack-gateway does in `internal/slackgw/events.go`
// before Financial Account ever sees the text; the refusals matter more than
// the acceptances.
//
// The one rule that ties it together: **if the bot speaks in a thread, the bot
// listens in it** — for a short idle window, without its name being said again.
// Talking keeps a thread alive; silence ends it.

/** The fields of a Slack event the gate reads. A superset is fine. */
export interface GateEvent {
  type?: string
  subtype?: string
  text?: string
  channel?: string
  ts?: string
  thread_ts?: string
  /** "im" for a DM, "channel"/"group" otherwise. */
  channel_type?: string
}

/**
 * How long the bot follows a thread it has spoken in, without being mentioned
 * again.
 *
 * Short on purpose. While a thread is followed, an ordinary remark to a
 * colleague in it can be read as an instruction — so the window is exactly the
 * period in which that can happen. Ten minutes is long enough to think and
 * reply, short enough that a thread abandoned at lunchtime is inert by the
 * afternoon. Mirrors `ThreadIdleWindow` in the Go build.
 */
export const THREAD_IDLE_MS = 10 * 60_000

/**
 * Threads the bot has spoken in, keyed (channel, threadTs) → last-spoke epoch.
 *
 * In-memory and lost on a cold start, deliberately — the same tradeoff as the
 * `seen` deduper. The window is minutes, and the cost of forgetting is a single
 * re-mention, never a missed or duplicated payment. The channel id is part of
 * the key because a thread timestamp repeats across channels.
 */
const followed = new Map<string, number>()

function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`
}

/**
 * Record that the bot has spoken in a thread, so it will follow plain replies
 * to it. Call this whenever the bot posts into a thread.
 */
export function followThread(channel: string, threadTs: string, now = Date.now()): void {
  followed.set(threadKey(channel, threadTs), now)
  if (followed.size > 500) {
    // Drop expired entries first, then oldest, so the map stays bounded.
    const cutoff = now - THREAD_IDLE_MS
    for (const [k, t] of followed) if (t < cutoff) followed.delete(k)
    while (followed.size > 500) followed.delete(followed.keys().next().value as string)
  }
}

/** Is this thread one the bot is currently following? */
export function followingThread(channel: string, threadTs: string, now = Date.now()): boolean {
  const at = followed.get(threadKey(channel, threadTs))
  if (at === undefined) return false
  if (now - at > THREAD_IDLE_MS) {
    followed.delete(threadKey(channel, threadTs))
    return false
  }
  return true
}

/** Test seam: forget every followed thread. */
export function resetFollowedThreads(): void {
  followed.clear()
}

/**
 * Does a message OPEN by naming a person?
 *
 * Only the leading position counts, and that asymmetry is the whole point.
 * "<@Gabe> take a look" is somebody turning to a colleague inside a thread the
 * bot happens to be in; "pay <@Alice> 50" names a payee later in the sentence
 * and is content. Dropping the second would make the bot deaf to half of what
 * it is for.
 */
export function addressedToSomeoneElse(text: string): boolean {
  return /^\s*<@[A-Z0-9]+>/.test(text)
}

/**
 * Strip only the LEADING bot mention, so the agent sees "pay this invoice"
 * rather than a user id.
 *
 * Later mentions are left in place — a mention of a colleague further along is
 * content, and silently deleting it would change what the customer asked for.
 * (The old behavior stripped every `<@…>` in the message.)
 */
export function stripLeadingMention(text: string): string {
  const trimmed = (text ?? '').trim()
  const m = /^<@[A-Z0-9]+>/.exec(trimmed)
  return m ? trimmed.slice(m[0].length).trim() : trimmed
}

/**
 * Decide whether an inbound message is for the bot to answer.
 *
 *  - a mention is always ours, wherever it lands;
 *  - a DM is all ours — every message in one is addressed to the bot;
 *  - inside a thread the bot is following, a plain reply is ours UNLESS it opens
 *    by naming someone else;
 *  - everything else — a channel message that did not mention us, a subtype that
 *    is not somebody talking — is left alone.
 *
 * The bot's own replies (bot_id / bot_message) are filtered by the caller's
 * loop guard before this runs.
 */
export function forThisBot(event: GateEvent, now = Date.now()): boolean {
  if (event.type === 'app_mention') return true
  if (event.type !== 'message') return false

  // A join, a leave, an edit, a pinned item. Not somebody talking, and treating
  // an edit as a new instruction would let someone rewrite history into a fresh
  // request.
  if (event.subtype) return false

  // A DM to the bot. Every message in one is addressed to us.
  if (event.channel_type === 'im') return true

  const threadTs = event.thread_ts
  if (threadTs && threadTs !== event.ts) {
    // A reply inside a thread. Ours only if the bot is part of it — and never
    // when the reply is aimed at a colleague.
    if (addressedToSomeoneElse(event.text ?? '')) return false
    return event.channel ? followingThread(event.channel, threadTs, now) : false
  }

  // A message at the root of a channel that did not mention us. Someone talking
  // to their colleagues.
  return false
}
