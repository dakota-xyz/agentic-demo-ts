'use client'

import { CopyableText } from '@/theme/ui'

/** Shorten an address the way every explorer does: head…tail. */
export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

/**
 * An address you can copy.
 *
 * CopyableText is the design system's own — same as the Go build. Rolling this
 * by hand produced a slightly different affordance, which is the whole class of
 * drift this port kept falling into.
 */
export function CopyAddress({ address, display }: { address: string; display?: string }) {
  return <CopyableText value={address} displayValue={display} monospace showCopyIcon size="sm" />
}
