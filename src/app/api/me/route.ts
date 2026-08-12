import { NextResponse } from 'next/server'
import { authed } from '@/lib/api'
import { ALLOWED_NETWORKS } from '@/lib/dakota'

// Who the visitor is, and what this deployment can do.
//
// Deliberately does NOT provision: opening the app should cost the platform
// nothing until the visitor actually does something. Wallets are reported as
// whatever already exists, which is nothing on a first visit.
export const GET = authed(async ({ user, tenancy }) => {
  return NextResponse.json({
    email: user.email,
    name: user.name,
    domain: user.domain,
    picture: user.picture ?? '',
    // The full agent refs, slack link included — the Integrations tab reads it.
    agents: tenancy.agents ?? [],
    wallets: tenancy.wallets ?? [],
    passkey: Boolean(user.publicKey),
    networks: ALLOWED_NETWORKS,
  })
})
