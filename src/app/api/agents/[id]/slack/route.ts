import { NextResponse } from 'next/server'
import { authed, body } from '@/lib/api'
import { explainError } from '@/lib/dakota'
import { listUsers, updateUser } from '@/lib/store'
import { isTeamMode } from '@/lib/tenancy'
import { authTest, channelInfo, slackConfigured } from '@/lib/slack/client'

/** Connect this agent to a Slack channel. */
export const POST = authed(async ({ user, tenancy, req, saveTenancy }) => {
  if (!slackConfigured()) {
    return NextResponse.json(
      { error: 'this deployment has no Slack credentials — set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET' },
      { status: 503 }
    )
  }

  const agentId = req.url.split('/api/agents/')[1]?.split('/')[0] ?? ''
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })

  // The channel id is the only thing a caller supplies. The name comes from
  // Slack, which is authoritative; older clients may still post `channelName`
  // and `botName` and are simply ignored rather than rejected.
  const { channelId } = await body<{ channelId?: string }>(req)

  const id = (channelId ?? '').trim()
  if (!id) return NextResponse.json({ error: 'a channel id is required' }, { status: 400 })

  // A channel drives exactly ONE agent — but "already claimed" means different
  // things depending on WHO holds the claim, and treating them alike made this
  // route impossible to use.
  //
  // Within one account, reassigning a channel is an ordinary thing to want:
  // this room used to talk to Payroll, now it should talk to Accounts payable.
  // Everyone here is a teammate looking at the same money, so it is moved and
  // reported, not refused.
  //
  // ACROSS accounts it stays a hard refusal. Per-user claiming was a
  // cross-tenant hole — inbound routing returns the first match, so a message
  // meant for one company's agent could be handled by another's, against their
  // wallets and into their transcript.
  //
  // And a claim left on a user row while this deployment runs in TEAM mode is
  // neither: it is a leftover from before the move, pointing at an agent the
  // team cannot reach. Refusing on it produced a genuine dead end — Slack told
  // people to reconnect here, and here told them the channel was taken by an
  // account that no longer drives anything.
  let released = ''
  for (const a of tenancy.agents ?? []) {
    if (a.slack?.channelId === id && a.id !== agentId) {
      released = a.name // same account: take it, and say from whom
      await saveTenancy((t) => {
        const prev = (t.agents ?? []).find((x) => x.id === a.id)
        if (prev) delete prev.slack
      })
    }
  }

  for (const other of await listUsers()) {
    for (const a of other.agents ?? []) {
      if (a.slack?.channelId !== id) continue
      if (other.email === user.email && a.id === agentId) continue // re-linking is fine

      if (isTeamMode()) {
        // Stale by definition — team mode does not route to user-row agents.
        await updateUser(other.email, (u) => {
          const prev = (u.agents ?? []).find((x) => x.id === a.id)
          if (prev) delete prev.slack
        })
        released ||= a.name
        continue
      }

      const mine = other.email === user.email
      return NextResponse.json(
        {
          error: mine
            ? `that channel is already connected to ${a.name}`
            : 'that channel is already connected by another account',
        },
        { status: 409 }
      )
    }
  }

  // Everything below fails HERE, while someone is looking at the settings,
  // rather than as silence in a channel later.
  //
  // A bad token surfaces first.
  const bot = await authTest()

  // Then the channel: it must exist in the workspace this deployment's token
  // belongs to, and the bot must be IN it. Skipping this accepts any string
  // starting with C, shows "Connected", and delivers nothing — and once more
  // than one visitor can connect, it also lets anyone squat a channel they
  // cannot reach.
  const info = await channelInfo(id)
  if (info.verified && !info.isMember) {
    const where = info.name ? `#${info.name}` : id
    return NextResponse.json(
      { error: `the bot isn't in ${where} yet — run /invite @${bot.userName} there, then connect again` },
      { status: 409 }
    )
  }

  await saveTenancy((u) => {
    const a = (u.agents ?? []).find((x) => x.id === agentId)
    if (a) {
      a.slack = {
        channelId: id,
        // Slack's own name, or none. It is authoritative — a hand-typed one
        // only ever showed up later as a channel nobody could find — and it is
        // absent exactly when the workspace withheld `channels:read`, in which
        // case the UI shows the id rather than inventing a label.
        channelName: info.name || undefined,
      }
    }
  })

  return NextResponse.json({
    connected: true,
    channelId: id,
    channelName: info.name || undefined,
    // Who this was taken from, when it was taken from anyone. Silently moving a
    // channel between agents is the kind of change someone should be told about
    // rather than discover from an answer in the wrong voice.
    ...(released ? { released } : {}),
    // Surfaced so the UI can say the link is unchecked rather than implying a
    // verification that did not happen.
    verified: info.verified,
    ...(info.unverifiedReason ? { note: info.unverifiedReason } : {}),
  })
})

/**
 * What Slack currently calls this agent's channel.
 *
 * The name is resolved here rather than remembered, because Slack is the only
 * thing that knows it: a channel renamed after it was connected would otherwise
 * keep showing whatever it was called on the day someone wired it up, and a
 * channel connected while the app lacked `channels:read` has no stored name at
 * all. Reading it live fixes both, and the answer is written back so the rail
 * and anything else reading the stored link improve with it.
 *
 * This is a display nicety and behaves like one: no failure here is an error.
 * Every one of them — no token, a missing scope, a deleted channel, Slack being
 * down — resolves to the name we already had, or to null, and the card falls
 * back to the id.
 *
 * But it always says WHY. A first cut swallowed the reason entirely, which made
 * the one question anyone asks of this endpoint — "the env vars are set, so why
 * is it still showing an id?" — unanswerable from outside: no name, no error,
 * nothing in the network tab, nothing in the logs. Quiet about failing is not
 * the same as quiet about the cause.
 *
 * The bot token never leaves the server; the browser only ever sees a name and
 * a sentence about why there isn't one.
 */
export const GET = authed(async ({ tenancy, req, saveTenancy }) => {
  const agentId = req.url.split('/api/agents/')[1]?.split('/')[0] ?? ''
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)

  if (!agent?.slack) return NextResponse.json({ error: 'no such agent' }, { status: 404 })
  const stored = agent.slack.channelName ?? null

  if (!slackConfigured()) {
    return NextResponse.json({
      channelName: stored,
      reason: 'this deployment has no SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET',
    })
  }

  try {
    const info = await channelInfo(agent.slack.channelId)
    if (!info.name) {
      return NextResponse.json({
        channelName: stored,
        // channelInfo reports a missing scope as "unverified" rather than
        // throwing, precisely so a setup that works keeps working — so this is
        // the branch a scope problem lands in, and the one that most needs to
        // explain itself.
        reason:
          info.unverifiedReason ??
          `Slack returned no name for ${agent.slack.channelId} — check the bot can see that channel`,
      })
    }

    if (info.name !== stored) {
      await saveTenancy((u) => {
        const a = (u.agents ?? []).find((x) => x.id === agentId)
        if (a?.slack) a.slack.channelName = info.name
      })
    }
    return NextResponse.json({ channelName: info.name })
  } catch (e) {
    return NextResponse.json({ channelName: stored, reason: explainError(e) })
  }
})

/** Disconnect. */
export const DELETE = authed(async ({ req, saveTenancy }) => {
  const agentId = req.url.split('/api/agents/')[1]?.split('/')[0] ?? ''
  await saveTenancy((u) => {
    const a = (u.agents ?? []).find((x) => x.id === agentId)
    if (a) delete a.slack
  })
  return NextResponse.json({ connected: false })
})
