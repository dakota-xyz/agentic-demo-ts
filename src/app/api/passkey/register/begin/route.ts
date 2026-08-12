import { NextResponse } from 'next/server'
import { generateRegistrationOptions } from '@simplewebauthn/server'
import { authed } from '@/lib/api'
import { rpIDFrom } from '@/lib/webauthn'
import { updateUser } from '@/lib/store'
import { requestOrigin } from '@/lib/origin'

/**
 * Begin passkey enrolment.
 *
 * The challenge is stashed on the visitor's row so finish() can verify against
 * the one we actually issued — without that, a replayed enrolment would
 * register a key we never challenged.
 */
export const POST = authed(async ({ user, req }) => {
  // The host the browser is on, not a configured one — see requestOrigin.
  const origin = requestOrigin(req)
  const options = await generateRegistrationOptions({
    rpName: 'Dakota Agentic Demo',
    rpID: rpIDFrom(origin),
    // The email is the tenancy key, so it is also the stable user handle: a
    // visitor returning on the same device gets the same credential rather than
    // stacking up a new passkey per sign-in.
    userID: user.email,
    userName: user.email,
    userDisplayName: user.name,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    // ES256 only. The platform restricts WebAuthn signer keys to ES256 and
    // RS256, and a passkey minted with anything else could never sign a
    // mandate — better to refuse it at enrolment than at payment time.
    supportedAlgorithmIDs: [-7],
  })

  await updateUser(user.email, (u) => {
    ;(u as { passkeyChallenge?: string }).passkeyChallenge = options.challenge
  })

  return NextResponse.json(options)
})
