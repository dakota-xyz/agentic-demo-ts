'use client'

import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Stack, Text } from '@/theme/ui'
import { signIn } from 'next-auth/react'
import { GoogleMark } from './google-mark'

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(config: {
            client_id: string
            scope: string
            callback: (r: { access_token?: string; error?: string }) => void
          }): { requestAccessToken(): void }
        }
      }
    }
  }
}

// Google sign-in via the browser token client — the same flow the Go build
// uses, and the one Dakota's existing OAuth client was created for.
//
// The client id is NOT a secret: it ships to every browser that loads this
// page. What constrains it is the client's authorized JavaScript ORIGINS list,
// which Google enforces before issuing anything. The server then checks the
// token's audience really is this client (see identityFromToken).

const MESSAGES: Record<string, string> = {
  work_account_required:
    'That looks like a personal account. Sign in with the Google account your company issued you.',
  CredentialsSignin:
    'That account could not be signed in. It usually means a personal address rather than a work one.',
}

export function GoogleSignInButton({
  clientId,
  anyDomain,
}: {
  clientId: string
  /** When true the work-account rule is off, so the copy must not claim it. */
  anyDomain?: boolean
}) {
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Google's script is loaded in the layout with `async`, so it may not have
  // arrived by first paint. Poll briefly rather than rendering a button that
  // does nothing when pressed.
  useEffect(() => {
    if (window.google?.accounts?.oauth2) {
      // Readiness is external state — Google's script is loaded async by the layout —
      // and mirroring it into React is exactly what this effect is for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReady(true)
      return
    }
    const t = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        setReady(true)
        window.clearInterval(t)
      }
    }, 150)
    return () => window.clearInterval(t)
  }, [])

  const start = useCallback(() => {
    const oauth2 = window.google?.accounts?.oauth2
    if (!oauth2 || !clientId) {
      setError('Google sign-in is still loading — try again in a moment.')
      return
    }
    setError('')
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid email profile',
      callback: async (resp) => {
        if (!resp.access_token) {
          // Closing the popup reports as an error; that is a cancellation, not
          // a failure, so it should leave no message behind.
          if (resp.error && !/popup_closed|access_denied/.test(resp.error)) setError(resp.error)
          setBusy(false)
          return
        }
        setBusy(true)
        const res = await signIn('google-token', {
          token: resp.access_token,
          redirect: false,
        })
        if (res?.error) {
          setError(MESSAGES[res.error] ?? MESSAGES.CredentialsSignin)
          setBusy(false)
          return
        }
        window.location.href = '/'
      },
    })
    client.requestAccessToken()
  }, [clientId])

  return (
    <Stack gap="sm">
      <Button
        fullWidth
        size="md"
        loading={busy}
        disabled={!clientId || !ready}
        onClick={start}
        leftSection={!busy && <GoogleMark size={17} />}
      >
        {busy ? 'Signing you in…' : 'Continue with Google'}
      </Button>
      <Text size="xs" c="dimmed" ta="center">
        {anyDomain
          ? 'Any Google account works.'
          : 'Use your work account — personal Gmail isn’t supported.'}
      </Text>
      {!clientId && <Alert color="blaze">Google sign-in isn’t configured on this deployment.</Alert>}
      {error && <Alert color="canyon">{error}</Alert>}
    </Stack>
  )
}
