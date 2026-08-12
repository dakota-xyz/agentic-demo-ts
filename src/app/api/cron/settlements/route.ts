import { NextResponse } from 'next/server'
import { dakota } from '@/lib/dakota'
import { postBlocks, textBlock, linkButton, slackConfigured } from '@/lib/slack/client'
import { threadForPayment } from '@/lib/slack/notify'
import { listUsers, getTeam, type Tenancy } from '@/lib/store'
import { isTeamMode, updateTenancy } from '@/lib/tenancy'
import { appOrigin } from '@/lib/origin'
import { renderEmail } from '@/lib/email-template'
import { sendMail, mailConfigured } from '@/lib/mailer'

/**
 * Announce settled payments in Slack, with nobody watching.
 *
 * The app learns a scheduled payment executed by POLLING, and in the browser
 * that only happens while someone has a page open. Fine for the web UI — if you
 * are looking at it, it is polling — but wrong for Slack: you ask in a channel,
 * close your laptop, and the channel should still tell you when the money
 * moved.
 *
 * The Go build did this on a ticker goroutine. Serverless has no long-running
 * process, so it becomes a cron (see vercel.json). Only Slack-connected agents
 * are polled — the rest have nowhere to announce to.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FINAL = new Set(['executed', 'failed'])

export async function GET(req: Request) {
  // Vercel signs cron invocations with CRON_SECRET, and it is REQUIRED.
  //
  // Checking it only when set meant the comment below described a hole rather
  // than a guard: with the variable absent this was an open trigger for as many
  // platform reads as anyone cared to make, which is exactly what it says, and
  // nothing stopped it. Vercel sets CRON_SECRET itself when a project has a
  // cron — and this one does, in vercel.json — so requiring it costs a
  // correctly configured deployment nothing.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET is unset — refusing to run the settlement sweep')
    return NextResponse.json({ error: 'cron is not configured' }, { status: 503 })
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'not authorized' }, { status: 401 })
  }
  // Either channel is reason enough to run. Gating the whole poll on Slack
  // meant a deployment using only email never checked a payment at all.
  if (!slackConfigured() && !mailConfigured()) {
    return NextResponse.json({ skipped: 'no slack and no outbound email' })
  }

  const client = dakota()
  let announced = 0

  // One tenancy per iteration. In team mode that is a single shared document
  // holding every agent; in visitor mode it is one per person, as before. The
  // actor email only decides which row a write locks, and in team mode every
  // one of them locks the same row.
  const scopes = isTeamMode()
    ? await (async () => {
        const team = await getTeam()
        const [member] = await listUsers()
        return team && member ? [{ email: member.email, tenancy: team as Tenancy }] : []
      })()
    : (await listUsers()).map((u) => ({ email: u.email, tenancy: u as Tenancy }))

  for (const { email, tenancy: scope } of scopes) {
    for (const agent of scope.agents ?? []) {
      // Poll for ANY agent with a signer. Requiring a Slack link here meant an
      // agent used only by email never had its payments checked at all — and
      // email is the one channel where the person has no screen to fall back
      // on, so silence there is the whole story rather than a missing extra.
      if (!agent.signerId) continue

      let payments
      try {
        payments = []
        for await (const p of client.scheduledPayments.list({ signer_id: agent.signerId } as never)) {
          payments.push(p as { id?: string; status?: string; amount?: string; asset?: string; network_id?: string })
        }
      } catch (e) {
        console.error('[cron] list failed', agent.id, e)
        continue
      }

      const seen = scope.paymentStatuses ?? {}
      const fresh = payments.filter(
        (p) => p.id && FINAL.has(p.status ?? '') && seen[p.id] !== p.status
      )
      if (fresh.length === 0) continue

      for (const p of fresh) {
        // Reply in the thread that ASKED for this payment. A settlement arrives
        // long after the conversation carrying only a payment id, so an
        // agent-level "last thread" would send every confirmation to whichever
        // thread spoke most recently — wrong the moment two requests are in
        // flight.
        const thread = threadForPayment(scope, agent, p.id)

        // No thread means this payment did not come from Slack — it was made in
        // the app or by email. Announcing it here anyway is noise about
        // something nobody in the channel asked for, and posting it unthreaded
        // just moves the interruption rather than removing it.
        //
        // The status is still recorded below, so this is "do not announce",
        // not "keep re-checking it for ever".
        // Deep link to THIS payment, not to the app in general. A settlement
        // announcement is where someone asks "which one, and did it really go?"
        // — and the detail drawer answers both, with the mandate that allowed
        // it and the on-chain hash.
        const deepLink = `${appOrigin()}/?agent=${encodeURIComponent(agent.id)}&tab=activity&payment=${encodeURIComponent(p.id!)}`
        const line =
          p.status === 'executed'
            ? `:white_check_mark: *Payment executed* — ${p.amount} ${p.asset} on ${p.network_id}`
            : `:x: *Payment failed* — ${p.amount} ${p.asset} on ${p.network_id}`
        // Slack hears only about what Slack asked for.
        if (thread && agent.slack) {
          // A button, not a link in the prose. Slack renders one as a target
          // rather than as text that happens to be clickable, which is what
          // "see the payment" should be after an announcement.
          await postBlocks(
            agent.slack.channelId,
            line,
            [textBlock(line), linkButton(p.status === 'executed' ? 'View the payment →' : 'See why →', deepLink)],
            thread
          ).catch((e) => console.error('[cron] post failed', e))
          announced++
        }

        // And whoever emailed it in gets told the same thing, because for them
        // the reply IS the interface — they were told a payment was drafted and
        // then heard nothing about whether it went.
        const replyTo = p.id ? scope.paymentEmails?.[p.id] : undefined
        if (replyTo && mailConfigured()) {
          const executed = p.status === 'executed'
          const rendered = renderEmail({
            reply: executed
              ? `Your payment of ${p.amount} ${p.asset} has gone out.`
              : `Your payment of ${p.amount} ${p.asset} did not go out.`,
            steps: [],
            outcome: executed
              ? { kind: 'paid', line: `Executed on ${p.network_id}.` }
              : {
                  kind: 'failed',
                  line: 'It failed when it ran — usually an unsigned spend limit, or no funds in the treasury at the time.',
                },
            link: deepLink,
            agentName: agent.name,
          })
          await sendMail({
            to: replyTo,
            subject: executed ? 'Payment sent' : 'Payment failed',
            text: rendered.text,
            html: rendered.html,
          }).catch((e) => console.error('[cron] settlement email failed', e))
          announced++
        }
      }

      await updateTenancy(email, (u) => {
        u.paymentStatuses ??= {}
        for (const p of fresh) u.paymentStatuses[p.id!] = p.status!
      })
    }
  }

  return NextResponse.json({ announced })
}
