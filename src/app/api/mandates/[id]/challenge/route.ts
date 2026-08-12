import { NextResponse } from 'next/server'
import { mandateSignPayload } from '@dakota-xyz/ts-sdk'
import { authed, body } from '@/lib/api'
import { ensurePasskeyAttached } from '@/lib/provision'
import { dakota } from '@/lib/dakota'
import { getUser } from '@/lib/store'

/**
 * Build the §8 challenge for a mandate.
 *
 * The challenge is the mandate's CANONICAL bytes (RFC 8785 JCS), produced by
 * the SDK so they match what the platform re-derives byte for byte. The browser
 * passkey signs exactly these, which is what ties the signature to this intent
 * and makes it useless for any other.
 *
 * Building this by hand is the single easiest thing to get subtly wrong in the
 * whole flow, and the failure is a signature that verifies nowhere with no
 * useful error. The SDK doing it is most of why this repo uses the SDK.
 */
export const POST = authed(async ({ user, req }) => {
  // Re-check attachment here rather than at enrolment only: the wallets a key
  // was attached to may no longer be the wallets it needs to sign for.
  await ensurePasskeyAttached(user.email).catch((e) =>
    console.warn('[passkey] attach check failed', e)
  )
  const id = req.url.split('/api/mandates/')[1]?.split('/')[0] ?? ''
  const { action } = await body<{ action?: string }>(req)
  if (action !== 'approve' && action !== 'cancel') {
    return NextResponse.json({ error: 'action must be approve or cancel' }, { status: 400 })
  }

  const mandate = await dakota().mandates.get(id)
  const payload = mandateSignPayload(mandate, action)

  const fresh = await getUser(user.email)
  return NextResponse.json({
    // base64url without padding: this becomes the WebAuthn challenge, which is
    // a BufferSource in the browser and must survive the round trip exactly.
    challenge: Buffer.from(payload).toString('base64url'),
    credentialId: fresh?.webauthnCredId ?? '',
    // See the note in register/finish: without transports the browser guesses
    // which provider holds the credential, and guesses wrong for anything that
    // is not the platform authenticator.
    transports: fresh?.webauthnTransports ?? [],
  })
})
