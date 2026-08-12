import { salesforceConfigured, recordLead } from './salesforce'
import { updateUser, type User } from './store'

/**
 * Push a sign-in to the CRM, at most once a day per visitor.
 *
 * Everything here is best-effort by design. A demo visitor is a prospect, and
 * losing one because a CRM write failed would be a far worse trade than losing
 * the record of them — so every failure is logged and swallowed.
 */
export async function captureLead(user: User): Promise<void> {
  if (!salesforceConfigured()) return

  // Once recorded, never again. recordLead is create-only, so a repeat visit
  // would spend two API calls to discover there is nothing to do.
  if (user.crmSyncedAt) return

  try {
    const outcome = await recordLead({
      email: user.email,
      name: user.name,
      domain: user.domain,
    })
    await updateUser(user.email, (u) => {
      u.crmSyncedAt = new Date().toISOString()
    })
    console.info('[crm] lead', outcome, user.email, user.domain)
  } catch (e) {
    // Deliberately not rethrown: this runs after the response, and there is
    // nobody left to tell. The log is the record.
    console.error('[crm] lead capture failed', user.email, e)
  }
}
