import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { workDomain, parseAllowList, emailDomain } from './work-domain'

// Sign-in: Google, work accounts only.
//
// The verified domain is the point — it names the COMPANY evaluating Dakota,
// which an address typed into a box never could. It is also the tenancy key
// every platform artifact hangs off, and Google verifying it is what makes that
// isolation enforceable: you cannot claim a colleague's sandbox by typing their
// address.
//
// The flow is Google's BROWSER TOKEN CLIENT, the same one the Go build uses,
// rather than Auth.js's server-side authorization-code provider.
//
// That is not a stylistic choice. The token client is a PUBLIC client: it has
// no client secret, by design. Dakota's existing OAuth client was created for
// that flow, so no secret for it exists anywhere to be shared — and the
// authorization-code provider cannot run without one. Reusing the existing
// client therefore means using the flow it was made for.
//
// What it costs: the access token passes through the browser. What constrains
// it is the client's authorized JavaScript ORIGINS list — Google refuses to
// issue a token to a page served from anywhere else — plus the check below that
// the token really belongs to OUR client id, which is what stops a token minted
// for some other app being replayed here.
//
// Auth.js still owns the session: the cookie, its rotation and expiry are its
// job, and only the identity step is ours.

const allowDomains = parseAllowList(process.env.DEMO_ALLOW_DOMAINS)

/**
 * Google-less sign-in for local development.
 *
 * A developer on localhost has no origin the shared Google client authorizes,
 * and standing up an OAuth client just to click through the UI is a poor trade.
 * This trusts a typed address, so it is off unless DEMO_DEV_LOGIN is exactly
 * 'true' — and the provider is not even CONSTRUCTED otherwise, so there is no
 * dormant credentials endpoint on a real deployment for a config slip to
 * expose. main() warns loudly whenever it is on.
 */
const devLogin = process.env.DEMO_DEV_LOGIN === 'true'

const devProvider = Credentials({
  id: 'dev',
  name: 'Developer sign-in',
  credentials: { email: { label: 'Email', type: 'email' } },
  authorize(credentials) {
    if (!devLogin) return null
    const email = String(credentials?.email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return null
    return {
      id: email,
      email,
      name: email.slice(0, email.indexOf('@')),
      // Dev sign-in skips the work-account rule on purpose: it exists to let a
      // developer in, not to rehearse the gate. The gate has its own tests.
      domain: emailDomain(email),
    }
  },
})

/** Google's Workspace claim. Present only for organisation accounts. */
type GoogleProfile = {
  sub?: string
  hd?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

/** The OAuth client the browser starts the flow with. Public, not a secret. */
export function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID ?? process.env.AUTH_GOOGLE_ID ?? ''
}

/**
 * Validate a browser-obtained Google access token and return the identity.
 *
 * Two checks, both load-bearing:
 *
 *  1. Google itself must recognise the token — /userinfo is the authority, and
 *     an expired or forged token dies here.
 *  2. The token must have been issued for OUR client id. Without this, a token
 *     minted for ANY other Google app could be replayed against this endpoint
 *     and would happily identify its holder — the classic confused-deputy hole
 *     in token-client flows. /tokeninfo returns the audience, so we check it.
 */
async function identityFromToken(accessToken: string): Promise<GoogleProfile> {
  const clientId = googleClientId()
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured')

  const audRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  )
  if (!audRes.ok) throw new Error('google rejected that sign-in')
  const info = (await audRes.json()) as { aud?: string; azp?: string; expires_in?: string }
  if (info.aud !== clientId && info.azp !== clientId) {
    throw new Error('that token was issued for a different application')
  }

  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('google rejected that sign-in')
  return (await res.json()) as GoogleProfile
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    ...(devLogin ? [devProvider] : []),
    Credentials({
      id: 'google-token',
      name: 'Google',
      credentials: { token: { label: 'Google access token', type: 'text' } },
      async authorize(credentials) {
        const token = String(credentials?.token ?? '')
        if (!token) return null

        const p = await identityFromToken(token)
        if (!p.email) return null
        // An address Google will not vouch for cannot be a tenancy key: two
        // people could then claim the same sandbox.
        if (p.email_verified === false) return null

        // The work-account rule. Throwing here surfaces as a failed sign-in;
        // the screen reads the reason from the error it gets back.
        const domain = workDomain(p.hd, p.email, allowDomains)

        return {
          id: p.sub ?? p.email,
          email: p.email.toLowerCase(),
          name: p.name ?? p.email.split('@')[0],
          image: p.picture ?? '',
          domain,
        }
      },
    }),
  ],

  // A JWT session means no session table, which matters on serverless: a
  // database round trip on every request would tax each cold start for nothing.
  session: { strategy: 'jwt', maxAge: 24 * 60 * 60 },

  pages: { signIn: '/signin', error: '/signin' },

  callbacks: {
    /**
     * The gate. Returning a URL sends the visitor back to the sign-in screen
     * with enough detail to explain the rule — a personal account is something
     * they can act on, not an error that should read as broken.
     */
    signIn({ account }) {
      // Both providers decide in authorize(); by the time this runs the
      // identity has already passed the work-account rule.
      if (account?.provider === 'dev') return devLogin
      return true
    },

    /**
     * Resolve the domain once, at sign-in, and carry it on the token. Doing it
     * per-request would re-derive the same value on every call for nothing, and
     * the raw Google profile is only available on the sign-in pass.
     */
    jwt({ token, user }) {
      // Resolved once, at sign-in, and carried on the token — re-deriving it
      // per request would repeat the same work for nothing.
      if (user && 'domain' in user && typeof user.domain === 'string') {
        token.domain = user.domain
      }
      return token
    },

    session({ session, token }) {
      if (session.user) {
        session.user.domain = (token.domain as string) ?? ''
        session.user.email = (token.email as string) ?? session.user.email
      }
      return session
    },
  },
})

/** Whether the Google-less local bypass is on. The sign-in page shows it. */
export function devLoginEnabled() {
  return devLogin
}

/**
 * The signed-in visitor, or null.
 *
 * Email is the tenancy key: every platform artifact — customer, wallets,
 * agents, payees — hangs off it, so two visitors never see each other's
 * payments.
 */
export async function currentUser() {
  const session = await auth()
  if (!session?.user?.email) return null
  return {
    email: session.user.email.toLowerCase(),
    name: session.user.name ?? session.user.email.split('@')[0],
    image: session.user.image ?? '',
    domain: session.user.domain ?? '',
  }
}
