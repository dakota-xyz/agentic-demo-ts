import { NextResponse } from 'next/server'
import { currentUser } from './auth'
import { ensureUser } from './store'
import { explainError, errorStatus } from './dakota'
import { tenancyFor, updateTenancy } from './tenancy'
import type { Tenancy, User } from './store'

// Shared plumbing for route handlers.
//
// Every authed route needs the same three things — a session, the visitor's row,
// and an error path that says what actually broke — so they live here instead of
// being re-typed (and drifting) in a dozen files.

/**
 * What a route gets.
 *
 * `user` is who is asking — identity and passkey, always personal. `tenancy` is
 * the account being acted on, which in team mode is shared and in visitor mode
 * is the same person's row. Reading platform state off `user` is the mistake
 * this separation exists to prevent: it compiles either way (User extends
 * Tenancy) and is silently wrong in team mode.
 *
 * `saveTenancy` writes to whichever document that was, under its own lock.
 */
export type Handler = (ctx: {
  user: User
  tenancy: Tenancy
  saveTenancy: (mutate: (t: Tenancy) => void | Promise<void>) => Promise<Tenancy>
  req: Request
}) => Promise<Response>

/**
 * Wrap a route handler with the session check and the visitor's row.
 *
 * ensureUser runs on every request rather than only at sign-in because the
 * session is a JWT: it survives a database wipe, so a valid cookie can arrive
 * with no row behind it. Recreating it is cheaper and less confusing than
 * signing the visitor out of a session that is genuinely still valid.
 */
export function authed(handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const session = await currentUser()
    if (!session) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 })
    }
    try {
      const user = await ensureUser(session.email, session.name, session.domain, session.image)
      // Resolved once per request. In visitor mode this still provisions
      // lazily; in team mode it only reads, and refuses rather than creating.
      const tenancy = await tenancyFor(user.email)
      const saveTenancy = (mutate: (t: Tenancy) => void | Promise<void>) =>
        updateTenancy(user.email, mutate)
      return await handler({ user, tenancy, saveTenancy, req })
    } catch (e) {
      return fail(e)
    }
  }
}

/**
 * Turn a thrown error into a response.
 *
 * Never swallow one into an empty result. An earlier version of this demo
 * logged the error and rendered an empty list, so a platform outage looked
 * exactly like "you have no scheduled payments" — and the agent got blamed for
 * lying when it had been truthful and the UI was hiding a 500.
 */
export function fail(e: unknown): Response {
  const status = errorStatus(e)
  const message = explainError(e)
  // 5xx is ours; log it with the stack. 4xx is the visitor's and is already in
  // the response, so logging it would just be noise.
  if (status >= 500) console.error('[api]', e)
  return NextResponse.json({ error: message }, { status })
}

/** Parse a JSON body, with a readable error rather than a raw SyntaxError. */
export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new Error('that request body was not valid JSON')
  }
}
