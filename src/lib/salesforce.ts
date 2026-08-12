// Lead capture: who is trying the demo.
//
// This is the reason the front door insists on a work Google account. The
// verified domain names the COMPANY evaluating Dakota, which an address typed
// into a box never could — and this is where that signal goes.
//
// Auth is the OAuth 2.0 Client Credentials Flow, matching the Go services:
// SALESFORCE_CONSUMER_KEY + SALESFORCE_CONSUMER_SECRET are exchanged for an
// access token against the instance URL. No user is involved.
//
// Two rules govern everything below:
//
//  1. A Salesforce failure must NEVER affect sign-in. Someone evaluating the
//     product should not be locked out because our CRM is down, and a lead we
//     failed to record is a smaller loss than a visitor we turned away.
//  2. It runs AFTER the response. Sign-in should not wait on a third party.

const TOKEN_PATH = '/services/oauth2/token'
const API_VERSION = 'v60.0'

/**
 * Which Salesforce object a demo visitor becomes.
 *
 * A Lead, not a Contact. A Contact belongs to an Account — someone already
 * known to us — while a Lead is precisely "an unqualified person who showed
 * interest", which is what a demo visitor is. Change this constant if the
 * pipeline is modelled the other way.
 */
const OBJECT = 'Lead'

/**
 * The LeadSource picklist value.
 *
 * A picklist, not free text: Salesforce rejects any value not defined on the
 * field, so this has to match the API name exactly. Changing the campaign name
 * in Salesforce means changing it here too.
 */
const LEAD_SOURCE = 'Agentic_Demo_Website'

export function salesforceConfigured(): boolean {
  return Boolean(
    process.env.SALESFORCE_INSTANCE_URL &&
      process.env.SALESFORCE_CONSUMER_KEY &&
      process.env.SALESFORCE_CONSUMER_SECRET
  )
}

const globalForSf = globalThis as unknown as {
  sfToken?: { token: string; instanceUrl: string; expiresAt: number }
}

/**
 * A bearer token, cached on the warm container until shortly before it expires.
 *
 * Salesforce rate-limits token issuance, and a fresh exchange per sign-in would
 * be both slow and wasteful. The 60s margin means a token is never used in the
 * seconds around its expiry, where a request can die mid-flight.
 */
async function accessToken(): Promise<{ token: string; instanceUrl: string }> {
  const cached = globalForSf.sfToken
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached

  const base = process.env.SALESFORCE_INSTANCE_URL!.replace(/\/$/, '')
  const res = await fetch(`${base}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SALESFORCE_CONSUMER_KEY!,
      client_secret: process.env.SALESFORCE_CONSUMER_SECRET!,
    }),
  })

  const body = (await res.json()) as {
    access_token?: string
    instance_url?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token) {
    throw new Error(
      `salesforce auth failed (${res.status}): ${body.error_description ?? body.error ?? 'no token'}`
    )
  }

  // Client-credentials tokens carry no expires_in, so this assumes the default
  // session timeout and refreshes well inside it.
  const entry = {
    token: body.access_token,
    instanceUrl: (body.instance_url ?? base).replace(/\/$/, ''),
    expiresAt: Date.now() + 30 * 60_000,
  }
  globalForSf.sfToken = entry
  return entry
}

/** What we know about someone who signed in. */
export interface DemoLead {
  email: string
  name: string
  /** The verified work domain — the company signal this whole gate exists for. */
  domain: string
}

/** Split a display name into the two fields Salesforce insists on. */
function splitName(name: string, email: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return { first: parts[0], last: parts.slice(1).join(' ') }
  // LastName is REQUIRED on a Lead and rejected if empty, so it falls back to
  // something identifying rather than a placeholder that pollutes the CRM.
  return { first: parts[0] ?? '', last: parts[0] ? '—' : email }
}

/**
 * Record a demo sign-in as a Lead — but only if that email is not already in
 * Salesforce. An existing record is never modified.
 *
 * This is deliberately create-only, and it is the correction of a real bug: an
 * earlier version updated on match, and the first production run overwrote the
 * name on a lead the website had created months before. A record already in the
 * pipeline has a real name, an owner, a status and notes a person put there.
 * None of that is worth degrading to log that someone opened a demo.
 *
 * So: new email, new lead. Known email, nothing happens. The visit is still in
 * our own logs and database either way.
 */
export async function recordLead(lead: DemoLead): Promise<'created' | 'skipped'> {
  const { token, instanceUrl } = await accessToken()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const api = `${instanceUrl}/services/data/${API_VERSION}`

  // SOQL string literals take single quotes; an apostrophe in an address would
  // otherwise break the query — and injecting into SOQL is not a hypothetical
  // when the value comes from an email provider.
  const safeEmail = lead.email.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const soql = `SELECT Id FROM ${OBJECT} WHERE Email = '${safeEmail}' LIMIT 1`

  const found = await fetch(`${api}/query?q=${encodeURIComponent(soql)}`, { headers })
  if (!found.ok) {
    throw new Error(`salesforce query failed (${found.status}): ${(await found.text()).slice(0, 200)}`)
  }
  const existing = (await found.json()) as { records?: { Id: string }[] }
  const match = existing.records?.[0]

  const { first, last } = splitName(lead.name, lead.email)
  const fields: Record<string, string> = {
    FirstName: first,
    LastName: last,
    Email: lead.email,
    // Company is REQUIRED on a Lead. The verified domain is the best thing we
    // have, and it is genuinely the useful field: it is the company.
    Company: lead.domain || 'Unknown',
    LeadSource: LEAD_SOURCE,
  }

  // Already known — leave Salesforce completely alone.
  if (match) return 'skipped'

  const created = await fetch(`${api}/sobjects/${OBJECT}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(fields),
  })
  if (!created.ok) {
    throw new Error(`salesforce create failed (${created.status}): ${(await created.text()).slice(0, 200)}`)
  }
  return 'created'
}
