import type { Metadata } from 'next'
import { ColorSchemeScript, mantineHtmlProps } from '@mantine/core'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { Providers } from './providers'

import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dates/styles.css'
import './ui-overrides.css'
import './globals.css'

// Fonts come from next/font: Inter (sans) and JetBrains Mono (mono), both open
// fonts. next/font self-hosts each and exposes it as a CSS variable; the theme
// in src/theme resolves fontFamily to those variables, and globals.css uses
// --font-mono for code and wire dumps.
const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' })

export const metadata: Metadata = {
  title: 'Agentic Payments Demo — Dakota',
  description:
    'Give an agent a spending limit, then tell it what to pay in plain language. Built on the Dakota TypeScript SDK.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // mantineHtmlProps + ColorSchemeScript settle the colour scheme before
    // first paint, so a dark app does not flash white on load.
    <html lang="en" {...mantineHtmlProps} className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <ColorSchemeScript defaultColorScheme="dark" />
        {/* Google Identity Services, for the browser token client. Async so it
            never blocks first paint; the sign-in button waits for it. */}
        <script src="https://accounts.google.com/gsi/client" async />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
