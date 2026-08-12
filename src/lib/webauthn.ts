import { verifyRegistrationResponse } from '@simplewebauthn/server'
import type { RegistrationResponseJSON } from '@simplewebauthn/types'

// The passkey-signing seam.
//
// This app is a PASSTHROUGH: the Dakota platform's policy engine is the
// verifying relying party. On enrolment we extract the credential's COSE public
// key and register it as a WEBAUTHN signer; at sign time the browser passkey
// signs the canonical §8 payload and we forward the assertion untouched. The
// user's private key never leaves their device, and this server never holds it.
//
// The two functions here are the only format-sensitive seams — they have to
// match what the platform unmarshals, which is go-webauthn's
// CredentialAssertionResponse. Get the shape wrong and signatures fail
// verification with no useful error, so both are pinned by tests.

/** What the browser hands back from navigator.credentials.get(). */
export interface AssertionJSON {
  id: string
  rawId: string
  type: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string | null
  }
}

/**
 * Extract the COSE public key and credential id from a registration attestation.
 *
 * Attestation is NOT trusted for identity here — the platform stores the COSE
 * key and verifies signatures against it, and the user's biometric at sign time
 * is the trust anchor. What this does need is to be structurally sound, so the
 * response is verified against the challenge we issued rather than parsed
 * blindly: a malformed or replayed enrolment would otherwise register a key
 * that can never sign.
 *
 * @returns coseB64 — base64 *standard* (the form the platform registers) and
 *          credentialId — base64url, for allowCredentials at get() time
 */
export async function parseEnrollment(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  origin: string,
  rpID: string
): Promise<{ coseB64: string; credentialId: string }> {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    // Attestation conveys who MADE the authenticator. We do not care, and
    // requiring it would refuse perfectly good platform passkeys.
    requireUserVerification: false,
  })

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('that passkey enrolment could not be verified')
  }

  const { credentialPublicKey, credentialID } = verification.registrationInfo
  if (!credentialPublicKey?.length || !credentialID?.length) {
    throw new Error('that attestation carried no credential public key')
  }

  return {
    // base64 STANDARD — the form the platform registers a WEBAUTHN signer in.
    coseB64: Buffer.from(credentialPublicKey).toString('base64'),
    // base64URL — the form allowCredentials wants back at get() time.
    credentialId: Buffer.from(credentialID).toString('base64url'),
  }
}

/**
 * Normalise an assertion into the base64(JSON) blob the platform expects.
 *
 * The policy engine base64-decodes this and unmarshals it into go-webauthn's
 * CredentialAssertionResponse, so the field names below are load-bearing —
 * they are that struct's JSON tags. Field ORDER is not (JSON unmarshalling
 * ignores it), but presence and casing are.
 *
 * The challenge inside clientDataJSON must be the canonical §8 payload: the
 * platform re-canonicalises the mandate and checks the hash against it, which
 * is what ties this signature to that exact intent and nothing else.
 */
export function assertionSignature(assertion: AssertionJSON): string {
  const missing = (['id', 'rawId', 'type'] as const).filter((k) => !assertion?.[k])
  if (missing.length) {
    throw new Error(`that assertion is missing ${missing.join(', ')}`)
  }
  const r = assertion.response
  if (!r?.clientDataJSON || !r?.authenticatorData || !r?.signature) {
    throw new Error('that assertion is missing its response fields')
  }

  const normalised: Record<string, unknown> = {
    id: assertion.id,
    rawId: assertion.rawId,
    type: assertion.type,
    response: {
      clientDataJSON: r.clientDataJSON,
      authenticatorData: r.authenticatorData,
      signature: r.signature,
      // Omitted rather than sent as null when absent: the Go struct tags it
      // omitempty, and a null would decode to an empty handle rather than none.
      ...(r.userHandle ? { userHandle: r.userHandle } : {}),
    },
  }

  return Buffer.from(JSON.stringify(normalised), 'utf8').toString('base64')
}

/** The relying-party id: the bare hostname, no scheme or port. */
export function rpIDFrom(origin: string): string {
  return new URL(origin).hostname
}
