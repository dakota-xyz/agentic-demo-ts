import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { listMembers } from '@/lib/store'
import { isTeamMode } from '@/lib/tenancy'
import { emailDomain, requiredDomains } from '@/lib/work-domain'

/**
 * Who else is in this account.
 *
 * Only meaningful in team mode — in the public demo every visitor is alone in
 * their own tenancy, and listing the other visitors would leak who has tried
 * the demo to anyone who signs in.
 *
 * Deliberately narrow: name, picture, email, whether they can sign, and when
 * they were last here. Nothing about their passkey beyond its existence.
 */
export const GET = authed(async () => {
  if (!isTeamMode()) return NextResponse.json({ teamMode: false, members: [] })

  // Membership is "could sign in today", not "has ever signed in".
  //
  // The users table outlives a change of mode: rows created while the
  // deployment was per-visitor — or while any domain was admitted — are not
  // team members, they are history. Listing them says the team includes people
  // who cannot get in, which is worse than useless on a screen whose whole
  // point is "these people can move money".
  //
  // The domain gate is the honest test, because it is the same rule the front
  // door applies. With no gate configured every row stands, which is correct:
  // an unrestricted deployment genuinely has no basis to exclude anyone.
  const required = requiredDomains()
  const rows = (await listMembers()).filter(
    (m) => required.size === 0 || required.has(emailDomain(m.email))
  )

  const members = rows.map((m) => ({
    email: m.email,
    name: m.name,
    picture: m.picture,
    // Enrolled is not the same as ABLE TO SIGN: the key also has to be in the
    // wallet groups, and that is what attachedAt records.
    canSign: Boolean(m.registered && m.attachedAt),
    enrolled: Boolean(m.registered),
    lastActive: m.lastActive,
  }))

  return NextResponse.json({ teamMode: true, members })
})
