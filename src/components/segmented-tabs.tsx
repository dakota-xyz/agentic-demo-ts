'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { UnstyledButton } from '@/theme/ui'

export type SegItem = {
  value: string
  label: string
  /** Optional count rendered inside the tab. Omitted when undefined or 0. */
  count?: number
  /** Draws the count in canyon — "this one is waiting on you". */
  alert?: boolean
}

/**
 * SegmentedTabs is a pill track with a single indicator that slides between
 * positions.
 *
 * Dakota ships no tab component, and Mantine's underline tabs read as browser
 * chrome next to the rest of this UI. The sliding indicator also does something
 * useful: it shows the move between tabs as a continuous thing, so switching
 * feels like moving along one surface rather than repainting the page.
 *
 * Counts ride inside the tabs so the nav carries state — "Scheduled 3",
 * "Spend limits 1" — instead of making you open each one to find out.
 */
export function SegmentedTabs({ items, value, onChange }: {
  items: SegItem[]
  value: string
  onChange: (value: string) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  // Measure the active tab and park the indicator on it. useLayoutEffect so the
  // first paint already has it in the right place (no visible jump on load).
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = () => {
      const active = track.querySelector<HTMLElement>('[data-active="true"]')
      if (!active) return
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    // Labels shift when a count appears or the font finishes loading.
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    return () => ro.disconnect()
  }, [items, value])

  return (
    <div className="seg" ref={trackRef} role="tablist">
      {indicator && (
        <span
          className="seg-indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      )}
      {items.map((it) => {
        const active = it.value === value
        return (
          <UnstyledButton
            key={it.value}
            role="tab"
            aria-selected={active}
            data-active={active}
            className={`seg-item${active ? ' is-active' : ''}`}
            onClick={() => onChange(it.value)}
          >
            {it.label}
            {it.count ? (
              <span className={`seg-count${it.alert && !active ? ' is-alert' : ''}`}>{it.count}</span>
            ) : null}
          </UnstyledButton>
        )
      })}
    </div>
  )
}
