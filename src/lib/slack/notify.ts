import { post, postBlocks, updateBlocks, textBlock, linkButton, slackConfigured } from './client'
import { type Tenancy, type AgentRef, type SlackMsg } from '../store'
import { updateTenancy } from '../tenancy'

// Note these take a TENANCY, not a user. An agent's Slack link is platform
// state — in team mode it lives on the shared document, and reading it off the
// person who happened to trigger the notification would find nothing there.

// Talking BACK to Slack after something happened in the app.
//
// A request that started in a channel has to finish there. Approving and
// signing happen in the browser — a passkey signature cannot come from an HTTP
// callback — so without this the channel goes quiet at exactly the moment the
// person who asked wants to know it worked, and they are left checking the app
// to find out whether the thing they just did in the app took effect.

// There is deliberately NO "post to this agent's latest thread" helper.
//
// It existed, and every caller of it was a bug: approving a plan in the app
// announced itself in whatever conversation happened to be open, about a plan
// that conversation had never seen. A channel is not a notification bus — a
// message belongs in the thread that asked for it, or nowhere.

/**
 * Post into a SPECIFIC thread.
 *
 * Settlements use this with the thread recorded for that payment: an
 * agent-level "last thread" would send every confirmation to whichever
 * conversation spoke most recently, so two requests in flight both report into
 * the wrong one.
 *
 * An empty thread posts to the channel — right for anything that did not start
 * in Slack, which should still be visible rather than silently dropped.
 */
export async function notifySlackThread(
  tenancy: Tenancy,
  agentId: string,
  thread: string | undefined,
  text: string,
  blocks?: Parameters<typeof postBlocks>[2]
): Promise<string | null> {
  if (!slackConfigured()) return null
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent?.slack) return null

  try {
    if (blocks?.length) {
      return await postBlocks(agent.slack.channelId, text, [textBlock(text), ...blocks], thread)
    }
    return await post(agent.slack.channelId, text, thread)
  } catch (e) {
    // A channel that cannot be posted to must not fail the action that
    // succeeded in the app — the payment is real either way.
    console.error('[slack] notify failed', agentId, e)
    return null
  }
}

/**
 * Retire a button that has been used.
 *
 * Slack has no disabled state for a button, so an untouched one stays clickable
 * forever — a thread from last week still offering to approve a payment that
 * settled days ago. Taking the action rewrites the message: the button is
 * replaced by a note saying who acted, and the plan text stays readable.
 */
export async function retireButton(
  tenancy: Tenancy,
  actorEmail: string,
  agentId: string,
  which: 'pendingDraft' | 'pendingSign',
  note: string
): Promise<void> {
  if (!slackConfigured()) return
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  const msg = agent?.slack?.[which]
  if (!agent?.slack || !msg?.ts) return

  try {
    await updateBlocks(agent.slack.channelId, msg.ts, msg.text ?? note, [
      textBlock(msg.text ?? ''),
      { type: 'context', elements: [{ type: 'mrkdwn', text: note }] },
    ])
  } catch (e) {
    console.error('[slack] retire failed', agentId, e)
  }

  await updateTenancy(actorEmail, (t) => {
    const link = (t.agents ?? []).find((a) => a.id === agentId)?.slack
    if (link) delete link[which]
  })
}

/** Remember a message carrying a button, so it can be retired later. */
export async function rememberPending(
  email: string,
  agentId: string,
  which: 'pendingDraft' | 'pendingSign',
  msg: SlackMsg
): Promise<void> {
  await updateTenancy(email, (t) => {
    const link = (t.agents ?? []).find((a) => a.id === agentId)?.slack
    if (link) link[which] = msg
  })
}

/** True when this agent has somewhere to report back to. */
export function hasSlack(agent: AgentRef | undefined): boolean {
  return Boolean(slackConfigured() && agent?.slack?.channelId)
}

export { linkButton }

/**
 * Which thread a settlement should be announced in.
 *
 * Recorded per payment at accept time. The fallback to the agent's last thread
 * exists for payments created before this mapping did, or outside Slack
 * entirely — but it is a FALLBACK, never the rule: an agent-level "last thread"
 * sends every confirmation to whichever conversation spoke most recently, so
 * two requests in flight both report into the wrong one. That failure is
 * especially bad because nothing looks broken — the amount is right, the
 * payment is real, and it is answering the wrong question.
 *
 * Returning undefined posts to the channel rather than a thread, which is
 * correct for a payment that never had a conversation.
 */
export function threadForPayment(
  tenancy: Tenancy,
  agent: AgentRef,
  paymentId: string | undefined
): string | undefined {
  // NO fallback to the agent's last thread. A payment we cannot place is
  // announced in the channel itself, which is merely unthreaded — where the
  // fallback put it in a specific conversation that had asked for something
  // else entirely, which is worse than unthreaded because it looks deliberate.
  void agent
  return paymentId ? tenancy.paymentThreads?.[paymentId] : undefined
}
