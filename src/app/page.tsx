import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { currentUser } from '@/lib/auth'
import { ensureUser } from '@/lib/store'
import { readTenancy } from '@/lib/tenancy'
import { captureLead } from '@/lib/lead'
import { Workspace } from '@/components/workspace'

// The signed-in workspace.
//
// A server component: the session and the visitor's agents are read on the
// server and handed to the client island already resolved, so the app does not
// open on a spinner while a fetch discovers what the server already knew.
//
// Note it does NOT provision platform tenancy — that happens on the first
// request that needs it (creating an agent). Someone who signs in, looks
// around and leaves costs the platform nothing.

export default async function Home() {
  const user = await currentUser()
  if (!user) redirect('/signin')

  const row = await ensureUser(user.email, user.name, user.domain, user.image)

  // Record the lead AFTER the page is sent. Nobody evaluating the product
  // should wait on our CRM, and nobody should be locked out if it is down.
  after(() => captureLead(row))

  // The AGENTS come from the tenancy, not from the person. In team mode they
  // live on the shared document, so reading them off `row` renders "create
  // your first agent" to someone whose team already has several — then the
  // client fetch corrects it a moment later, which is the flicker.
  const tenancy = await readTenancy(row.email)

  return (
    <Workspace
      user={{
        name: row.name,
        email: row.email,
        domain: row.domain,
        picture: row.picture,
      }}
      initialAgents={(tenancy?.agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        slack: a.slack,
        handlesEmail: a.handlesEmail,
      }))}
      hasPasskey={Boolean(row.publicKey)}
    />
  )
}
