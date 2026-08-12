// Who gets in: work accounts only.
//
// The demo is a sales surface. A visitor signing in from a company domain tells
// us which company is evaluating Dakota; a visitor signing in from a personal
// inbox tells us nothing and costs us a sandbox tenancy. So the front door
// admits Google Workspace accounts and turns away consumer ones.
//
// The test is Google's own `hd` (hosted domain) claim, not a list of free
// providers. Google sets hd only for accounts belonging to a Workspace or Cloud
// organisation and omits it for @gmail.com — so it IS the definition of "this
// is a work account", asserted by the identity provider rather than inferred by
// us.
//
// The distinction matters because the two approaches fail in opposite
// directions. A denylist fails OPEN: the day someone signs up at a free
// provider we have never heard of, they are let straight in and we never find
// out. Requiring hd fails CLOSED: an account we cannot confirm is refused, and
// the visitor sees a message telling them exactly what to do instead. For a
// lead-capture gate, letting the wrong person in silently is the worse failure.
//
// CONSUMER_DOMAINS is not the gate — it is a second line for the narrow case
// where a domain is both a Workspace domain and a free mail provider. Without
// it, an address there would carry an hd and read as a company.

/** Free/personal mail providers. Refused even when an hd is present. */
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'googlegroups.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.es',
  'outlook.com', 'live.com', 'live.co.uk', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru',
  'zoho.com', 'fastmail.com', 'hey.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'daum.net',
  'rediffmail.com', 'comcast.net', 'verizon.net', 'btinternet.com',
  'sbcglobal.net', 'orange.fr', 'free.fr', 'libero.it',
  'terra.com.br', 'uol.com.br', 'bol.com.br',
])

/** Throwaway inboxes. These do sometimes carry an hd, and are worth nothing. */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com',
  'trashmail.com', 'temp-mail.org', 'getnada.com', 'sharklasers.com',
  'dispostable.com', 'maildrop.cc', 'tempmail.com', 'throwawaymail.com',
])

/** Thrown when a sign-in is a personal account. */
export class NotWorkAccountError extends Error {
  readonly code = 'work_account_required'
  constructor(readonly domain: string) {
    super(
      domain
        ? `Please sign in with your work account — ${domain} is a personal email provider.`
        : `Please sign in with your work Google account — personal accounts aren't supported.`
    )
    this.name = 'NotWorkAccountError'
  }
}

/** The lowercased part after the last "@", or '' if there isn't one. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return ''
  return email.slice(at + 1).trim().toLowerCase()
}

/**
 * Whether the work-account rule is switched off for this deployment.
 *
 * Off, ANY Google account is admitted — including personal ones. That is a
 * deliberate trade, not a loosening by accident: the rule exists so the
 * recorded domain names a COMPANY, and with it off the leads include
 * gmail.com addresses that name nobody.
 *
 * Worth having as a switch because "who may try this" is a question that
 * changes with the audience — an open demo day wants everyone in, a lead-gen
 * campaign does not — and neither answer deserves a code change.
 */
export function anyDomainAllowed(): boolean {
  return process.env.DEMO_ALLOW_ANY_DOMAIN === 'true'
}

/**
 * Decide whether an identity is a work account, returning the domain to record
 * against it.
 *
 * `hd` is preferred over the address because it names the ORGANISATION, which
 * is not always the mail domain — a tenant with several domains reports one hd
 * — and the organisation is the thing worth recording as a lead.
 *
 * `allow` admits domains this would otherwise refuse: the escape hatch for a
 * real prospect on a personal-looking domain, so nobody ships a code change to
 * close a deal.
 *
 * @throws {NotWorkAccountError}
 */
export function workDomain(
  hd: string | undefined | null,
  email: string,
  allow: ReadonlySet<string> = new Set()
): string {
  const claimed = (hd ?? '').trim().toLowerCase()

  // A required-domain list outranks EVERYTHING, including DEMO_ALLOW_ANY_DOMAIN.
  // Checked first on purpose: the two switches contradict each other, and a
  // deployment that has named its domain has made the stricter statement. The
  // permissive one winning here would be the failure that matters — it is how
  // a stray gmail account ends up inside a shared treasury.
  const required = requiredDomains()
  if (required.size > 0) {
    const domain = claimed || emailDomain(email)
    if (!required.has(domain)) throw new NotWorkAccountError(domain)
    return domain
  }

  // With the rule off, the domain is still RECORDED — it is the useful part —
  // it simply no longer decides who gets in.
  if (anyDomainAllowed()) return claimed || emailDomain(email)

  if (!claimed) {
    // No hd ⇒ a personal Google account. The address is read only to name the
    // provider in the error, so the message is specific.
    const fallback = emailDomain(email)
    if (allow.has(fallback)) return fallback
    throw new NotWorkAccountError(fallback)
  }
  if (allow.has(claimed)) return claimed
  if (CONSUMER_DOMAINS.has(claimed) || DISPOSABLE_DOMAINS.has(claimed)) {
    throw new NotWorkAccountError(claimed)
  }
  return claimed
}

/**
 * Domains this deployment restricts sign-in TO, if any.
 *
 * The opposite of the allow-list: that one widens who gets in, this one
 * narrows it to exactly these domains and refuses everyone else.
 *
 * It exists for shared-tenancy deployments. When every visitor gets their own
 * account, admitting a stranger costs a sandbox tenancy. When they all share
 * ONE account holding real money, admitting a stranger puts them inside it —
 * so "any work account" stops being an acceptable gate and the deployment has
 * to name its own domain.
 *
 * Empty means no restriction, which keeps the public demo exactly as it was.
 */
export function requiredDomains(): Set<string> {
  return parseAllowList(process.env.DEMO_REQUIRE_DOMAIN)
}

/** Parse DEMO_ALLOW_DOMAINS ("a.com, b.io") into a set. */
export function parseAllowList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((d) => d.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  )
}
