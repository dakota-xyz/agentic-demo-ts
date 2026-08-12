// Pairing brand colours for a dark surface.
//
// Dakota's palette is desaturated and earthy — blaze is a wine, canyon a brown,
// evergreen an olive — and that breaks the two things Mantine does by default.
//
// `variant="light"` tints the background to 10% alpha, which on these colours
// lands somewhere indistinguishable from grey. And in dark mode the matching
// text colour resolves to the MID shade of an already-dark scale: blaze's is
// #933b3f, which on a dark card is barely legible. A "revoked" badge drawn that
// way is a red smudge.
//
// So each tone is paired by hand: a dark tinted well to sit on, and the light
// end of the same scale for anything that has to be read. Both ends are brand
// colours; only the pairing is ours.
//
// Note slate's scale is offset by one — its index 0 is pure white — so its
// numbers deliberately do not line up with the others.

export interface Tone {
  /** Background: a dark, tinted well. */
  well: string
  /** Foreground: light enough to read on that well AND on a dark card. */
  ink: string
}

export const TONES: Record<string, Tone> = {
  blaze: { well: 'var(--mantine-color-blaze-7)', ink: 'var(--mantine-color-blaze-0)' },
  canyon: { well: 'var(--mantine-color-canyon-7)', ink: 'var(--mantine-color-canyon-0)' },
  evergreen: { well: 'var(--mantine-color-evergreen-7)', ink: 'var(--mantine-color-evergreen-1)' },
  sierra: { well: 'var(--mantine-color-sierra-7)', ink: 'var(--mantine-color-sierra-0)' },
  slate: { well: 'var(--mantine-color-slate-8)', ink: 'var(--mantine-color-slate-2)' },
}

export const tone = (name: string): Tone => TONES[name] ?? TONES.slate

/**
 * Props for a status badge that is actually readable.
 *
 * Spread onto a Dakota/Mantine `Badge`. Deliberately bypasses `variant`, since
 * every built-in variant derives its text colour from the same mid shade that
 * makes these badges unreadable in the first place.
 */
export function badgeTone(name: string) {
  const { well, ink } = tone(name)
  return {
    variant: 'filled' as const,
    styles: {
      root: {
        backgroundColor: well,
        color: ink,
        border: `1px solid color-mix(in srgb, ${ink} 24%, transparent)`,
      },
    },
  }
}
