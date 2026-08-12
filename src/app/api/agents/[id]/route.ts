import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { dakota } from '@/lib/dakota'
import { pushHistory } from '@/lib/store'

/**
 * Retire an agent.
 *
 * REVOKED upstream, not merely dropped from our row. Forgetting an agent
 * locally would leave a hosted signer on the platform that still holds whatever
 * mandates it was granted — able to fire scheduled payments nobody can see any
 * more, because the screen that listed them is gone. Revoking is what actually
 * ends its authority: the platform fails its future fires.
 *
 * The local row is removed either way. An agent this app cannot address is
 * worse kept than dropped — it would occupy a rail entry that no request could
 * route to.
 */
export const DELETE = authed(async ({ user, tenancy, saveTenancy, req }) => {
  const agentId = req.url.split('/api/agents/')[1]?.split('/')[0]?.split('?')[0] ?? ''
  const agent = (tenancy.agents ?? []).find((a) => a.id === agentId)
  if (!agent) return NextResponse.json({ error: 'no such agent' }, { status: 404 })

  let revoked = true
  try {
    await dakota().paymentAgents.revoke(agent.id)
  } catch (e) {
    // An agent the platform will not revoke is precisely the one worth keeping
    // on screen: dropping it here would hide something that can still spend.
    console.error('[agents] revoke failed', agent.id, e)
    revoked = false
    return NextResponse.json(
      {
        error:
          'The platform would not revoke that agent, so it has been left in place — removing it here would hide an agent that can still make payments.',
      },
      { status: 502 }
    )
  }

  await saveTenancy((t) => {
    t.agents = (t.agents ?? []).filter((a) => a.id !== agentId)
    // Its transcript and any drafted plan go with it. Keeping them would leave
    // a conversation nothing can continue and a plan nothing can accept.
    delete (t.conversations ?? {})[agentId]
    delete (t.proposals ?? {})[agentId]
    pushHistory(t, {
      id: crypto.randomUUID(),
      agentId,
      at: new Date().toISOString(),
      kind: 'agent_revoked',
      text: `Agent "${agent.name}" was revoked. Payments still scheduled under it will not run.`,
      actor: user.email,
    })
  })

  return NextResponse.json({ revoked })
})
