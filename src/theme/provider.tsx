'use client'

import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { theme } from './theme'

/**
 * The app's UI provider: a `MantineProvider` carrying the Dakota theme, pinned
 * to dark, with the notification host mounted. One component so `providers.tsx`
 * names a single thing, and so the forced dark scheme and the theme always
 * travel together.
 */
export function DakotaUIProvider({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Notifications />
      {children}
    </MantineProvider>
  )
}
