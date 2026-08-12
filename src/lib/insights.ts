// Answering questions about the account, from the same chat that pays people.
//
// These are two different endpoints on purpose, and the difference is a safety
// property rather than a detail:
//
//   payments agent  drafts proposals — it can put a payment in front of you
//   insights        read-only, narrates a deterministic report, never proposes
//
// The visitor should not have to know that. They type into one box and say
// "how much am I spending on MeatCo?" — so this decides which endpoint a turn
// belongs to.
//
// The default is the PAYMENTS agent, always. Misrouting a question to it is
// mild: it has account context and will answer imperfectly. Misrouting an
// INSTRUCTION to insights would be worse — the person asked for a payment and
// got a summary, with nothing drafted and no error to explain why. So the
// insight path only claims a turn it is clearly entitled to.

/**
 * Phrases that mean "tell me about the account" rather than "do something".
 *
 * Deliberately narrow. A broad matcher would start eating payment requests,
 * and the cost of a false positive here is a silently undrafted payment.
 */
const ASKS_ABOUT_ACCOUNT = [
  /\binsights?\b/i,
  /\b(summar|overview|report)\w*\b/i,
  /\bhow (am i|are we|is it) doing\b/i,
  /\bhow much (have|did|do|am|are|is)\b/i,
  /\bwhat('s| is| are)? (my|our|the) (balance|spend|spending|total|status)\b/i,
  /\b(am i|are we) (running low|overspending|on track)\b/i,
]

/**
 * Words that mean the visitor wants something DONE.
 *
 * Checked first and wins outright: "pay MeatCo and give me a summary" is a
 * payment request with a pleasantry attached, and treating it as a report
 * would drop the actual instruction on the floor.
 */
const WANTS_ACTION = [
  /\bpay\b/i,
  /\bsend\b/i,
  /\bschedule\b/i,
  /\btransfer\b/i,
  /\bcancel\b/i,
  /\brevoke\b/i,
  /\bset up\b/i,
  /\bcreate\b/i,
  /\badd\b/i,
]

/** Which endpoint a turn belongs to. */
export function routeTurn(text: string): 'payments' | 'insights' {
  const t = text.trim()
  if (!t) return 'payments'
  if (WANTS_ACTION.some((re) => re.test(t))) return 'payments'
  if (ASKS_ABOUT_ACCOUNT.some((re) => re.test(t))) return 'insights'
  return 'payments'
}

/** One turn of the insights conversation, in the shape the endpoint wants. */
export interface InsightMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Trim the transcript to what the insights endpoint accepts.
 *
 * It takes 1–40 messages. The chat transcript is shared with the payments
 * agent and grows without bound, so the tail is what travels — recent context
 * is what a follow-up question depends on ("and MeatCo?"), and older payment
 * drafting is noise to a reporter that cannot act on it anyway.
 */
export function tailForInsights(
  history: { role?: string; content?: string }[],
  next: string,
  limit = 20
): InsightMessage[] {
  const usable = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim())
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content! }))

  return [...usable.slice(-(limit - 1)), { role: 'user' as const, content: next }]
}

/**
 * Strip attachments from a transcript before it is stored or replayed.
 *
 * Attachments ride only on the turn they are sent — the SDK says so, and the
 * platform keeps the agent's text reply as the durable record of what the
 * document said. Persisting the bytes is therefore pointless, and actively
 * harmful in two ways:
 *
 *   1. A Uint8Array does not survive JSON. Stored and reloaded it becomes a
 *      plain object, and the SDK's `Buffer.from(a.data)` throws on the NEXT
 *      turn — so sending one PDF quietly broke every message after it.
 *   2. Transcripts adopted from the Go build carry Go's field names (`Data`,
 *      capitalised), which the SDK cannot read at all.
 *
 * Both fail the same way and both are fixed by not carrying bytes in a
 * transcript that only needs words.
 */
export function withoutAttachments<T>(history: T[]): T[] {
  return (history as Record<string, unknown>[]).map((m) => {
    if (!m || typeof m !== 'object') return m
    const { attachments, Attachments, ...rest } = m
    void attachments
    void Attachments
    return rest
  }) as T[]
}
