/**
 * The origin the BROWSER is actually on, read from the request.
 *
 * WebAuthn is origin-bound, and a static configured origin cannot be right when
 * the app answers on several hostnames — Vercel gives every deployment a short
 * alias, a team alias and a branch alias, and a passkey enrolled against one
 * host is rejected outright on another:
 *
 *   "The relying party ID is not a registrable domain suffix of, nor equal to,
 *    the current domain."
 *
 * So anything WebAuthn touches derives the origin from the request, never from
 * configuration. Configuration is still right for links we SEND (Slack, email),
 * where there is no browser to agree with — that is what appOrigin is for.
 */
export function requestOrigin(req: Request): string {
  const h = req.headers
  // x-forwarded-* is what the browser asked for; `host` behind a proxy can be
  // the internal name.
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https')
  if (host) return `${proto}://${host}`
  return appOrigin()
}

/**
 * The canonical origin for links this app SENDS — Slack buttons, email replies.
 *
 * Not for WebAuthn: see requestOrigin.
 */
export function appOrigin(): string {
  const explicit = process.env.APP_BASE_URL || process.env.AUTH_URL
  if (explicit) return explicit.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return `http://localhost:${process.env.PORT ?? 3000}`
}
