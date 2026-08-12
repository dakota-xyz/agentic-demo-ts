import { createHash, createPrivateKey } from 'node:crypto'
import { P256MandateSigner } from '@dakota-xyz/ts-sdk'

// The service signer.
//
// Every treasury wallet is born with a signer group, and a group needs at least
// one recognised key or the wallet cannot be created at all. That is what this
// is for — a deterministic P-256 keypair derived from DEMO_KEY_SALT.
//
// It does NOT authorize spending. Real spend is gated by an approved mandate,
// signed by the visitor's passkey (§8), which this key cannot produce. Its only
// job is to make the wallet's group well-formed at birth.
//
// Deterministic on purpose: a redeploy must derive the SAME key, or every
// existing wallet's group would suddenly reference a signer the platform has
// never seen and the whole tenancy would be orphaned.

const globalForKey = globalThis as unknown as { serviceKey?: ServiceKey }

export interface ServiceKey {
  /** base64 PKIX (SPKI) — what the platform stores and groups reference. */
  publicKey: string
  signer: P256MandateSigner
}

/**
 * Derive the service keypair from DEMO_KEY_SALT.
 *
 * A P-256 private key is any 32-byte scalar in range, so the salt's SHA-256 is
 * used directly as the scalar. The chance of landing outside the curve order is
 * about 2^-32 of 2^-96 — not worth a rejection loop that would then make the
 * derivation input-dependent.
 */
export function serviceKey(): ServiceKey {
  if (globalForKey.serviceKey) return globalForKey.serviceKey

  const salt = process.env.DEMO_KEY_SALT
  if (!salt) throw new Error('DEMO_KEY_SALT is not set — the service signer cannot be derived')

  const scalar = createHash('sha256').update(`agentic-demo-service:${salt}`).digest()

  // Wrap the raw scalar in the PKCS#8 envelope Node needs to import it. The
  // prefix is the fixed ASN.1 header for an EC P-256 private key; only the
  // 32-byte scalar varies, so splicing it in is exact and avoids pulling in an
  // ASN.1 encoder for one constant.
  const pkcs8Prefix = Buffer.from(
    '308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
    'hex'
  )
  const der = Buffer.concat([pkcs8Prefix, scalar])
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })

  // Let the SDK own the key handling and the base64 PKIX encoding, rather than
  // re-deriving a format the platform has to agree with byte for byte.
  const signer = P256MandateSigner.fromPrivateKey(privateKey)
  globalForKey.serviceKey = { publicKey: signer.publicKeyBase64(), signer }
  return globalForKey.serviceKey
}
