'use client'

// Browser side of §8 signing.
//
// The passkey lives in the device's secure enclave and never leaves it. What
// crosses the wire is an assertion over the mandate's canonical bytes — which is
// why no server, including ours, can authorize a payment on the visitor's
// behalf. It is also why a Slack button can never do this: there is no browser,
// no origin, and no enclave in an HTTP callback.

/**
 * base64url -> bytes.
 *
 * Typed as Uint8Array<ArrayBuffer> rather than plain Uint8Array: since TS 5.7
 * BufferSource excludes SharedArrayBuffer-backed views, and every WebAuthn
 * field below is a BufferSource. Allocating the buffer explicitly satisfies
 * that without a cast.
 */
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * UTF-8 string -> bytes.
 *
 * Needed because @simplewebauthn/server v9 passes `userID` through to
 * `options.user.id` VERBATIM — it is the raw string, not base64url. Feeding it
 * to atob() throws "The string to be decoded is not correctly encoded" the
 * moment the id contains an @ or a dot, which an email always does.
 */
function textToBytes(s: string): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder().encode(s)
  const out = new Uint8Array(new ArrayBuffer(utf8.length))
  out.set(utf8)
  return out
}

function bytesToB64url(b: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(b))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Whether this browser can do passkeys at all. */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential
}

/** Enrol a passkey and register it with the platform. */
export async function enrollPasskey(): Promise<void> {
  const optionsRes = await fetch('/api/passkey/register/begin', { method: 'POST' })
  const options = await optionsRes.json()
  if (!optionsRes.ok) throw new Error(options.error ?? 'could not start enrolment')

  const created = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: b64urlToBytes(options.challenge),
      // The challenge IS base64url; user.id is NOT (see textToBytes).
      user: { ...options.user, id: textToBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map(
        (c: { id: string; type: string }) => ({ ...c, id: b64urlToBytes(c.id) })
      ),
    },
  })) as PublicKeyCredential | null

  if (!created) throw new Error('enrolment was cancelled')
  const response = created.response as AuthenticatorAttestationResponse

  const finishRes = await fetch('/api/passkey/register/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: created.id,
      rawId: bytesToB64url(created.rawId),
      type: created.type,
      clientExtensionResults: created.getClientExtensionResults(),
      response: {
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        attestationObject: bytesToB64url(response.attestationObject),
      },
    }),
  })
  const finished = await finishRes.json()
  if (!finishRes.ok) throw new Error(finished.error ?? 'could not finish enrolment')
}

/**
 * Sign a mandate with the passkey.
 *
 * Two round trips on purpose: the server builds the canonical §8 challenge (the
 * SDK derives the exact bytes the platform will re-derive), the passkey signs
 * those bytes, and the assertion goes back for the platform to verify.
 */
export async function signMandate(mandateId: string, action: 'approve' | 'cancel'): Promise<void> {
  const challengeRes = await fetch(`/api/mandates/${mandateId}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const { challenge, credentialId, transports, error } = await challengeRes.json()
  if (!challengeRes.ok) throw new Error(error ?? 'could not build the challenge')

  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(challenge),
        // Naming the credential avoids the browser offering passkeys from other
        // sites, which reads as broken when the visitor picks one that cannot sign.
        //
        // `transports` says WHERE that credential lives. Omit it and the browser
        // guesses — Chrome guesses the platform authenticator, so a passkey held
        // in a password manager or on a phone is never offered and the prompt
        // dies with "the operation either timed out or was not allowed".
        allowCredentials: credentialId
          ? [
              {
                id: b64urlToBytes(credentialId),
                type: 'public-key' as const,
                ...(Array.isArray(transports) && transports.length
                  ? { transports: transports as AuthenticatorTransport[] }
                  : {}),
              },
            ]
          : [],
        // Pinned rather than inferred, so it matches enrolment on a host with
        // several aliases.
        rpId: window.location.hostname,
        userVerification: 'preferred',
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    // The browser's own message here is uniquely unhelpful — "not allowed"
    // covers a dismissed prompt, a timeout, and the case that actually bites:
    // the credential lives in a provider this device cannot reach right now.
    // A passkey can only be used by whatever holds its private key, so the fix
    // is usually to enrol a new one rather than to retry.
    const name = e instanceof Error ? e.name : ''
    if (name === 'NotAllowedError') {
      throw new Error(
        'That passkey was not available. It can only be used from the password manager or device that created it — if you have switched, use Replace passkey on the Limits tab.'
      )
    }
    throw e
  }

  if (!assertion) throw new Error('signing was cancelled')
  const response = assertion.response as AuthenticatorAssertionResponse

  const submitRes = await fetch(`/api/mandates/${mandateId}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      assertion: {
        id: assertion.id,
        rawId: bytesToB64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: bytesToB64url(response.clientDataJSON),
          authenticatorData: bytesToB64url(response.authenticatorData),
          signature: bytesToB64url(response.signature),
          ...(response.userHandle ? { userHandle: bytesToB64url(response.userHandle) } : {}),
        },
      },
    }),
  })
  const submitted = await submitRes.json()
  if (!submitRes.ok) throw new Error(submitted.error ?? 'the platform rejected that signature')
}
