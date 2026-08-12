'use client'

import { DakotaUIProvider } from '@/theme/ui'
import { SessionProvider } from 'next-auth/react'

/**
 * The client boundary.
 *
 * DakotaUIProvider is the design system's own provider — it carries the theme,
 * the forced dark scheme and the notification host. Using it rather than a
 * hand-configured MantineProvider is the point: the palette, spacing and
 * component defaults come from the same source as every other Dakota frontend,
 * so this app cannot drift from them.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <DakotaUIProvider>{children}</DakotaUIProvider>
    </SessionProvider>
  )
}
