'use client'

/**
 * ChainIcon — the real network marks, not text badges.
 *
 * A wallet's chain is the one property that decides whether a payment can
 * settle at all (funding the wrong network is the failure people actually hit),
 * so it deserves a glyph you recognise at a glance rather than a grey pill
 * reading "evm".
 *
 * Drawn inline rather than pulled from a CDN: the app ships as a single Go
 * binary with no external asset fetches, and these need to inherit size and
 * colour from the row they sit in.
 */
export function ChainIcon({ family, size = 16 }: { family: string; size?: number }) {
  if (family === 'solana') return <SolanaMark size={size} />
  return <EthereumMark size={size} />
}

// Ethereum's octahedron, standing in for the EVM wallet family.
function EthereumMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <g fill="currentColor">
        <path d="M12 1.5 5.6 12.1 12 15.9l6.4-3.8L12 1.5Z" opacity="0.65" />
        <path d="M12 17.2 5.6 13.4 12 22.5l6.4-9.1-6.4 3.8Z" />
      </g>
    </svg>
  )
}

// Solana's three slanted bars — outer two lean one way, the middle the other.
function SolanaMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <g fill="currentColor">
        <path d="M6.6 4.6h14.1a.5.5 0 0 1 .36.86l-3 3a.9.9 0 0 1-.64.27H3.3a.5.5 0 0 1-.36-.86l3-3a.9.9 0 0 1 .66-.27Z" />
        <path d="M3.3 10.4h14.12c.24 0 .47.1.64.27l3 3a.5.5 0 0 1-.36.86H6.6a.9.9 0 0 1-.64-.27l-3-3a.5.5 0 0 1 .34-.86Z" opacity="0.75" />
        <path d="M6.6 16.2h14.1a.5.5 0 0 1 .36.86l-3 3a.9.9 0 0 1-.64.27H3.3a.5.5 0 0 1-.36-.86l3-3a.9.9 0 0 1 .66-.27Z" opacity="0.55" />
      </g>
    </svg>
  )
}

/** The human name for a wallet family — "EVM" and "Solana", not "evm". */
export function chainLabel(family: string): string {
  return family === 'solana' ? 'Solana' : 'EVM'
}
