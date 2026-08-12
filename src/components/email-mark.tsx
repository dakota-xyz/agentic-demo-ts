/**
 * A plain envelope. Postmark is the transport, not the product — the visitor is
 * forwarding an invoice, and whose servers carry it is our problem rather than
 * something worth putting a logo on.
 */
export function EmailMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <rect
        x="2.5" y="5" width="19" height="14" rx="2.5"
        stroke="var(--mantine-color-sierra-3)" strokeWidth="1.6"
      />
      <path
        d="M3.5 7.5 12 13.2l8.5-5.7"
        stroke="var(--mantine-color-sierra-3)" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}
