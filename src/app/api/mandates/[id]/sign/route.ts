import { NextResponse } from 'next/server'
import { authed, body } from '@/lib/api'
import { dakota } from '@/lib/dakota'
import { assertionSignature, type AssertionJSON } from '@/lib/webauthn'
import { getUser, type AgentRef } from '@/lib/store'
import { tenancyFor } from '@/lib/tenancy'
import { notifySlackThread, retireButton, hasSlack } from '@/lib/slack/notify'

/**
 * Submit the passkey's signature over the §8 challenge.
 *
 * We forward the assertion; the platform's policy engine verifies it. This
 * server never holds the user's key and never could produce this signature
 * itself — which is the property the whole demo rests on.
 */
export const POST = authed(async ({ user, req, saveTenancy }) => {
  const id = req.url.split('/api/mandates/')[1]?.split('/')[0] ?? ''
  const { action, assertion } = await body<{ action?: string; assertion?: AssertionJSON }>(req)

  if (action !== 'approve' && action !== 'cancel') {
    return NextResponse.json({ error: 'action must be approve or cancel' }, { status: 400 })
  }
  if (!assertion) {
    return NextResponse.json({ error: 'that signature is missing' }, { status: 400 })
  }

  const fresh = await getUser(user.email)
  if (!fresh?.publicKey) {
    return NextResponse.json({ error: 'enrol a passkey first' }, { status: 400 })
  }

  const signature = assertionSignature(assertion)
  const client = dakota()

  // Which agent owns this mandate, read BEFORE acting. Signing arrives with
  // only a mandate id, and the approve/cancel response does not echo the bound
  // signer — so this is the only thread back to the channel that asked.
  let boundSigner = ''
  try {
    boundSigner = (await client.mandates.get(id)).bound_signer_id ?? ''
  } catch {
    // Not knowing costs a Slack notification, not the signature.
  }

  const result =
    action === 'approve'
      ? await client.mandates.approve(id, {
          approver_public_key: fresh.publicKey,
          signature,
        })
      : await client.mandates.cancel(id, {
          signer_public_key: fresh.publicKey,
          signature,
        })

  await saveTenancy((u) => {
    u.history ??= []
    u.history.push({
      id: crypto.randomUUID(),
      agentId: '',
      at: new Date().toISOString(),
      kind: action === 'approve' ? 'signed' : 'revoked',
      text:
        action === 'approve'
          ? 'Spend limit signed — the scheduled payments are live.'
          : 'Spend limit revoked — any payments still scheduled under it are cancelled.',
    })
  })

  // Report back into the channel that asked. Signing arrives with only a
  // mandate id, so the agent is found by the signer the mandate is bound to —
  // that is the only thread back to the right conversation.
  // The TENANCY: in team mode the agents live on the shared document, so the
  // person's own row has none and nothing below would fire.
  const after = await tenancyFor(user.email)
  const owner = (after?.agents ?? []).find((a: AgentRef) => a.signerId && a.signerId === boundSigner)

  // Only speak in the thread that was ASKED to sign — the pendingSign message
  // is that thread, recorded when the plan was created from Slack. Without it
  // this posted wherever the agent last spoke, so signing a limit in the app
  // announced itself in an unrelated conversation.
  const askedIn = owner?.slack?.pendingSign?.ts
  if (after && owner && hasSlack(owner) && askedIn) {
    if (action === 'approve') {
      await retireButton(after, user.email, owner.id, 'pendingSign', `✅ Signed by ${user.email}`)
      await notifySlackThread(
        after,
        owner.id,
        askedIn,
        '✅ *Signed.* The scheduled payments are live — they will run without asking again, within this limit.'
      )
    } else {
      await retireButton(after, user.email, owner.id, 'pendingSign', `🚫 Revoked by ${user.email}`)
      await notifySlackThread(
        after,
        owner.id,
        askedIn,
        '🚫 *Limit revoked.* Any payments still scheduled under it are cancelled.'
      )
    }
  }

  return NextResponse.json({ mandateId: id, status: result.status ?? 'active' })
})
