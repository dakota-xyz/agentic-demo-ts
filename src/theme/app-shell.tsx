'use client'

import { AppShell, Box, Burger, Group, Stack } from '@mantine/core'

/**
 * The app shell: `AppLayout` / `AppHeader` / `AppNavbar`.
 *
 * A Mantine `AppShell` in "alt" layout — a full-height navbar with the header
 * offset to its right — plus the two slot components the header and navbar are
 * built from. The plane colours (navbar, header) are set in globals.css; this
 * file owns the structure and the mobile burger.
 */

const APP_HEADER_HEIGHT = 70
const APP_NAVBAR_WIDTH = 250

export function AppLayout({
  children,
  header,
  navbar,
  opened,
}: {
  children: React.ReactNode
  header: React.ReactNode
  navbar: React.ReactNode
  opened: boolean
}) {
  return (
    <AppShell
      layout="alt"
      header={{ height: APP_HEADER_HEIGHT }}
      navbar={{ breakpoint: 'sm', collapsed: { mobile: !opened }, width: APP_NAVBAR_WIDTH }}
      styles={{
        header: {
          backgroundColor: 'transparent',
          borderBottom: 'none',
          display: 'flex',
          flexDirection: 'column',
          left: 'var(--app-shell-navbar-width)',
          paddingLeft: '16px',
          right: 0,
          width: 'auto',
        },
        main: {
          display: 'flex',
          flexDirection: 'column',
          height: `calc(100dvh - var(--app-shell-header-height, ${APP_HEADER_HEIGHT}px))`,
          overflow: 'auto',
        },
        navbar: {
          borderRight: 'none',
          boxShadow: 'none',
        },
      }}
    >
      <AppShell.Header>{header}</AppShell.Header>
      <AppShell.Navbar>{navbar}</AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  )
}

export function AppHeader({
  left,
  opened,
  right,
  toggle,
}: {
  left?: React.ReactNode
  opened: boolean
  right?: React.ReactNode
  toggle: () => void
}) {
  return (
    <Group align="center" justify="space-between" pl={0} pr="md" py={16}>
      <Group gap="md" style={{ flex: 1 }}>
        <Burger color="#b0afad" hiddenFrom="sm" ml="md" opened={opened} size="sm" onClick={toggle} />
        {left}
      </Group>
      {right && (
        <Group gap="md" wrap="nowrap">
          {right}
        </Group>
      )}
    </Group>
  )
}

export function AppNavbar({
  bottom,
  items,
  top,
}: {
  bottom?: React.ReactNode
  items?: React.ReactNode
  top?: React.ReactNode
}) {
  return (
    <Stack h="100%" justify="space-between" role="navigation" aria-label="Main navigation">
      <Box>
        <Box my="sm" p="md">
          {top}
        </Box>
        <Box px="sm">{items}</Box>
      </Box>
      {bottom && <Box p="md">{bottom}</Box>}
    </Stack>
  )
}
