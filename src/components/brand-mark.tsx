/**
 * BrandMark — the demo's one piece of iconography.
 *
 * A filled diamond held inside an open one: the agent acting, inside the
 * boundary you signed. That is the whole product thesis, so it is worth the
 * mark rather than a generic wallet or robot glyph — and it rhymes with the ◈
 * used for the agent in the transcript.
 *
 * Drawn as an inline SVG so it inherits the sierra gradient and stays crisp at
 * any size; a rounded-square background would have made it one more grey chip.
 */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <defs>
        <linearGradient id="dakota-mark" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--mantine-color-sierra-2)" />
          <stop offset="1" stopColor="var(--mantine-color-sierra-5)" />
        </linearGradient>
      </defs>
      {/* the boundary — open, because a limit is a shape you can see through */}
      <path
        d="M12 1.6 22.4 12 12 22.4 1.6 12 12 1.6Z"
        stroke="url(#dakota-mark)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* the agent — solid, contained */}
      <path d="M12 7.4 16.6 12 12 16.6 7.4 12 12 7.4Z" fill="url(#dakota-mark)" />
    </svg>
  )
}
