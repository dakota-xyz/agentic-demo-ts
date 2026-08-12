import { NextResponse } from 'next/server'
import { authed, body } from '@/lib/api'
import { createAgent } from '@/lib/provision'

export const GET = authed(async ({ tenancy }) =>
  NextResponse.json({ agents: tenancy.agents ?? [] })
)

/**
 * Create an agent.
 *
 * This is the first request that provisions platform tenancy, because it is the
 * first one that genuinely needs a customer to hang an agent off.
 */
export const POST = authed(async ({ user, req }) => {
  const { name } = await body<{ name?: string }>(req)
  const trimmed = (name ?? '').trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'give the agent a name' }, { status: 400 })
  }
  if (trimmed.length > 64) {
    return NextResponse.json({ error: 'that name is too long' }, { status: 400 })
  }
  const agent = await createAgent(user.email, trimmed)
  return NextResponse.json({ id: agent.id, name: trimmed }, { status: 201 })
})
