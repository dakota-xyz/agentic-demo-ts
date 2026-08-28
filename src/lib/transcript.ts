// Transcript hygiene for the agent chat.
//
// This file used to do more. It carried `routeTurn` and `tailForInsights`: a
// keyword matcher that decided, per turn, whether the visitor had asked the
// PAYMENTS agent to do something or asked a read-only INSIGHTS endpoint a
// question about the account, and a trimmer that reshaped the transcript for
// whichever one won.
//
// Platform folded account-insight Q&A into the payment converser (ENG-3407)
// and removed the insight chat endpoint (ENG-3153), so there is no longer a
// second endpoint to route to. One converser answers "pay MeatCo $2,000" and
// "how much am I spending on MeatCo?" in the same conversation, with the same
// history, and decides between them with the account actually in front of it.
//
// That is strictly better than what was here. The matcher was guessing from
// the words alone, and it said so: the default was PAYMENTS on every ambiguous
// turn, because misrouting a question to the payments agent is mild while
// misrouting an INSTRUCTION to a read-only reporter silently drops a payment
// on the floor. A safe default is still a coin toss dressed up as a rule.
//
// The deterministic insight REPORT is untouched — `insights.get`, still served
// at `GET /customers/{customer_id}/insights`, still behind the Insights panel.
// It was only the conversational half that moved.

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
