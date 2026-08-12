import { NextResponse } from 'next/server'
import type { RegistrationResponseJSON } from '@simplewebauthn/types'
import { authed, body } from '@/lib/api'
import { parseEnrollment, rpIDFrom } from '@/lib/webauthn'
import { dakota } from '@/lib/dakota'
import { tenancyFor } from '@/lib/tenancy'
import { getUser, updateUser } from '@/lib/store'
import { requestOrigin } from '@/lib/origin'

/**
 * Finish passkey enrolment: verify the attestation, register the COSE key with
 * the platform as a WEBAUTHN signer, and attach it to the treasury wallets.
 *
 * The attach is what makes the key able to APPROVE a mandate: the policy engine
 * only accepts an approval from a signer the wallet's group recognises.
 */
export const POST = authed(async ({ user, req }) => {
  const attestation = await body<RegistrationResponseJSON>(req)

  const fresh = await getUser(user.email)
  const expected = (fresh as { passkeyChallenge?: string } | null)?.passkeyChallenge
  if (!expected) {
    return NextResponse.json({ error: 'start the enrolment again' }, { status: 400 })
  }

  const origin = requestOrigin(req)
  const { coseB64, credentialId } = await parseEnrollment(
    attestation,
    expected,
    origin,
    rpIDFrom(origin)
  )

  // tenancyFor, NOT ensureTenancy: in team mode the wallets to attach to are
  // the SHARED ones, and provisioning a per-visitor tenancy here would give
  // this person their own account instead of adding them to the team's.
  const tenancy = await tenancyFor(user.email)
  const client = dakota()

  await client.signers.create({
    name: `passkey-${user.email}`,
    public_key: coseB64,
    key_type: 'WEBAUTHN',
  })

  // Add the key to each treasury wallet's signer group, so the policy engine
  // recognises this person as an approver.
  //
  // This is what makes team mode work at all: the policies are threshold-1
  // ("any group member's signature allows"), so once a second person's key is
  // in the group they can sign a mandate the first person drafted. No
  // platform-side change, no roles — membership IS the permission.
  const { attachUserToWallet } = await import('@dakota-xyz/ts-sdk')
  for (const wallet of tenancy.wallets ?? []) {
    await attachUserToWallet(client, wallet.id, coseB64, wallet.groupId)
  }

  await updateUser(user.email, (u) => {
    u.publicKey = coseB64
    u.webauthnCredId = credentialId
    // WHERE the credential lives, as the authenticator reported it.
    //
    // Without this the browser has to guess which provider holds a credential,
    // and Chrome guesses the platform authenticator — so a passkey kept in
    // 1Password (or on a phone, over hybrid) is never offered, and the prompt
    // fails with "the operation either timed out or was not allowed". The
    // private key is only ever in one provider; transports is how the browser
    // is told which.
    u.webauthnTransports = attestation.response?.transports ?? []
    u.registered = true
    // When this key was put into the wallet groups. Recorded so the attach can
    // be skipped on a re-enrolment that changes nothing, and so the Team tab
    // can say who is actually able to sign rather than merely who has a passkey.
    u.attachedAt = new Date().toISOString()
    // WHICH wallets, not just when — see ensurePasskeyAttached.
    u.attachedWallets = (tenancy.wallets ?? []).map((w) => w.id)
    delete (u as { passkeyChallenge?: string }).passkeyChallenge
  })

  return NextResponse.json({ enrolled: true })
})
