import { Button } from '@/theme/ui'
import { signOut } from '@/lib/auth'

/**
 * Sign out via a server action, so the session cookie is cleared server-side
 * rather than by a client-side fetch that a failed request could leave
 * half-applied.
 */
export function SignOutButton() {
  return (
    <form
      action={async () => {
        'use server'
        await signOut({ redirectTo: '/signin' })
      }}
    >
      <Button type="submit" variant="default" fullWidth>
        Sign out
      </Button>
    </form>
  )
}
