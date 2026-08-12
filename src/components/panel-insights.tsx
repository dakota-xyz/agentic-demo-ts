'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { Button, Card, Divider, Group, Loader, Stack, Text, Tooltip } from '@/theme/ui'
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendarClock,
  IconChartPie,
  IconClockExclamation,
  IconCode,
  IconGauge,
  IconPoint,
  IconRefresh,
  IconUserPlus,
  IconWallet,
  type Icon as TablerIcon,
} from '@tabler/icons-react'
import { fmtDateTime } from '@/lib/format'
import { tone } from '@/lib/tone'

// Insights: the account, read-only.
//
// Two things make this worth its own view rather than another agent tab.
//
// It is CUSTOMER-scoped. Agents share one account — one treasury, one set of
// payees — so "what is happening here" is a question about the account, not
// about whichever agent you last clicked. Putting it under an agent would
// quietly imply the numbers were that agent's.
//
// And every figure below arrives in a SINGLE platform response, each
// observation carrying evidence: typed references to the objects it was
// derived from. That is the property worth showing off, so the page states it
// plainly and offers the raw JSON alongside — a claim about provenance is
// worth little if you cannot check it.
//
// The one thing this app does with those figures is draw them to scale. See
// the Position card: funding and commitments are the account's whole story and
// the only question asked of them is whether one covers the other, which is a
// comparison of two lengths rather than a number anybody wants to read.

interface Evidence {
  type: string
  id: string
}

interface Item {
  kind: string
  severity: 'info' | 'warn' | 'critical'
  message: string
  evidence?: Evidence[]
}

interface Balance {
  wallet_id?: string
  name?: string
  asset?: string
  network_id?: string
  amount_usd?: string
}

interface Report {
  generated_at?: number
  snapshot?: {
    total_usd?: string
    balances?: Balance[]
    upcoming?: { days?: number; count?: number; totals?: Record<string, string> }
    open_scheduled_payments?: number
    active_mandates?: number
  }
  insights?: Item[]
  suggestions?: Item[]
}

// `kind` is an OPEN set — the platform may add kinds this build has never seen.
// Unknown ones fall back to a softened label and a neutral glyph rather than
// being dropped, because a dropped insight is worse than an unstyled one.
//
// Each kind carries its own icon and tone. Severity alone is not enough to read
// a feed by: the platform marks most things `info`, so colouring by severity
// leaves a wall of identical grey rows where "2 payments failed" and "a new
// payee appeared" look the same. The KIND is what the eye should sort on.
const KIND_META: Record<string, { label: string; icon: TablerIcon; tone: string }> = {
  upcoming_payments: { label: 'Upcoming payments', icon: IconCalendarClock, tone: 'slate' },
  payments_failed: { label: 'Failed payments', icon: IconAlertTriangle, tone: 'blaze' },
  payment_failures_clustered: { label: 'Repeated failures', icon: IconAlertTriangle, tone: 'blaze' },
  account_activity: { label: 'Activity', icon: IconActivity, tone: 'slate' },
  new_counterparty: { label: 'New payee', icon: IconUserPlus, tone: 'evergreen' },
  counterparty_concentration: { label: 'Concentration', icon: IconChartPie, tone: 'canyon' },
  payment_at_risk: { label: 'Payment at risk', icon: IconAlertTriangle, tone: 'canyon' },
  funding_shortfall: { label: 'Funding shortfall', icon: IconWallet, tone: 'blaze' },
  mandate_expiring: { label: 'Limit expiring', icon: IconClockExclamation, tone: 'canyon' },
  mandate_headroom: { label: 'Limit headroom', icon: IconGauge, tone: 'slate' },
}

const SEVERITY_TONE: Record<string, string> = {
  critical: 'blaze',
  warn: 'canyon',
  info: 'slate',
}

// Shared with the limits table — see lib/tone for why the shades are named
// by hand rather than left to Mantine's `light` variant.
const toneStyle = tone

/**
 * How a row should look: the kind decides, with severity as the override.
 *
 * A `critical` item is drawn as critical whatever its kind — the platform
 * escalating something must never be flattened by our styling.
 */
function metaFor(item: Item) {
  const base = KIND_META[item.kind] ?? {
    label: item.kind.replace(/_/g, ' '),
    icon: IconPoint,
    tone: 'slate',
  }
  return item.severity === 'critical' || item.severity === 'warn'
    ? { ...base, tone: SEVERITY_TONE[item.severity] }
    : base
}

/** Sort worst-first: a funding shortfall outranks an activity summary. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 }
const bySeverity = (a: Item, b: Item) =>
  (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)

/* ------------------------------------------------------------------ *
 * numbers                                                             *
 * ------------------------------------------------------------------ */

/** The platform sends decimals as strings. A missing one is zero, never NaN. */
function num(s?: string): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

const usd = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const fmtUsd = (n: number) => usd.format(n)

/**
 * Assets the balance index prices 1:1 against the dollar.
 *
 * The snapshot gives funding in USD and commitments per asset, so comparing
 * them at all requires knowing the two are the same unit. For stablecoins they
 * are — the SDK is explicit that deposit conversion is 1:1 — and for anything
 * else they are not. Rather than guess a rate this app does not have, an
 * unrecognised asset drops the comparison bar entirely and the totals are
 * printed as text. A wrong exchange rate on a funding chart is worse than no
 * funding chart.
 */
const USD_PEGGED = new Set(['USD', 'USDC', 'USDT', 'PYUSD', 'DAI'])

/* ------------------------------------------------------------------ *
 * bars                                                                *
 * ------------------------------------------------------------------ */

/**
 * The funding ramp, light → dark.
 *
 * Segment i is painted from one stop to the next, so consecutive segments hand
 * off mid-hue and the bar reads as one continuous sweep broken by hairlines
 * rather than as a row of separate blocks. Every stop clears 3:1 against the
 * card it sits on; the tail mix is only ever reached as the far end of the
 * last segment.
 */
const STOPS = [
  'var(--mantine-color-sierra-0)',
  'var(--mantine-color-sierra-1)',
  'var(--mantine-color-sierra-2)',
  'var(--mantine-color-sierra-3)',
  'color-mix(in srgb, var(--mantine-color-sierra-3) 55%, var(--mantine-color-sierra-4))',
]

/**
 * Segment `i` of `n`, sampled across the WHOLE ramp rather than off the top of
 * it.
 *
 * Taking the first n stops packs three wallets into the three lightest tans,
 * which are a step apart on the bar and indistinguishable once shrunk into a
 * 10px legend key — and the legend is the only thing naming these segments, so
 * that is the one place the colours have to survive. Spreading the same stops
 * over the full range instead pulls them as far apart as the ramp allows, and
 * has the side effect that a single-wallet account gets the entire sweep.
 */
function rampFill(i: number, n: number): string {
  const at = (k: number) => STOPS[Math.round((k * (STOPS.length - 1)) / n)]
  return `linear-gradient(90deg, ${at(i)}, ${at(i + 1)})`
}

/** Four wallets, then a bucket — see the series-count ceiling in the legend. */
const MAX_SEGMENTS = 4

interface Segment {
  key: string
  /** Legend name. */
  label: string
  /** The second line of the legend row — network, asset, whatever qualifies it. */
  note?: string
  value: number
  /** Left → right fill. Also painted into the legend dot, so the two match. */
  fill: string
}

/**
 * One bar on a shared scale.
 *
 * `max` is the scale, NOT the sum: the bar fills `sum(values) / max` of the
 * track and leaves the rest empty. That is the whole mechanism by which two
 * bars in this card can be compared — normalise each to its own width and the
 * comparison quietly becomes a lie.
 */
function Bar({
  segments,
  max,
  height,
  label,
}: {
  segments: Segment[]
  max: number
  height: number
  label: string
}) {
  const drawn = segments.filter((s) => s.value > 0)
  // Segments are laid out with `gap`, so each one has to give back its share of
  // the gaps or a full bar overflows its track by (n-1) × 2px.
  const give = drawn.length > 1 ? ((drawn.length - 1) * 2) / drawn.length : 0

  return (
    <div
      className="ins-track"
      style={{ height, borderRadius: height / 2 }}
      role="img"
      aria-label={label}
    >
      {drawn.map((s) => {
        const pct = max > 0 ? (s.value / max) * 100 : 0
        return (
          <Tooltip key={s.key} withArrow label={`${s.label} · ${fmtUsd(s.value)}`}>
            <div
              className="ins-seg"
              style={{ width: `calc(${pct}% - ${give}px)`, background: s.fill }}
            />
          </Tooltip>
        )
      })}
    </div>
  )
}

/**
 * Label, bar, value — three cells of the card's shared `.ins-scale` grid.
 *
 * A fragment rather than a wrapper, deliberately: the columns have to be shared
 * across every bar in the card, and a wrapper div would give each row a grid of
 * its own. See `.ins-scale`.
 */
function BarRow({
  name,
  segments,
  max,
  height,
  value,
  note,
  lead,
}: {
  name: string
  segments: Segment[]
  max: number
  height: number
  value: string
  note?: string
  /** The card's headline figure. Sized up; there is exactly one. */
  lead?: boolean
}) {
  return (
    <>
      <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        {name}
      </Text>
      <Bar segments={segments} max={max} height={height} label={`${name}: ${value}`} />
      <Group gap={8} align="baseline" wrap="nowrap" className="ins-row-value">
        {/* Proportional figures, not tabular: these two are the only numbers in
            the column and nothing is aligned under them, where tabular-nums
            widens every digit to a zero and reads loose at this size. */}
        <Text fz={lead ? 22 : 16} fw={lead ? 600 : 500} lh={1.2} style={{ whiteSpace: 'nowrap' }}>
          {value}
        </Text>
        {note && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {note}
          </Text>
        )}
      </Group>
    </>
  )
}

/**
 * The key that ties a legend row to its segment — the same fill, shrunk.
 *
 * A short bar rather than a dot, and deliberately wide enough for the gradient
 * to travel: squeezed into a 10px square, two adjacent stops of a ramp this
 * gentle average out to the same tan and the key stops identifying anything.
 */
function Swatch({ fill }: { fill: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 18,
        height: 8,
        borderRadius: 4,
        flexShrink: 0,
        background: fill,
        display: 'inline-block',
      }}
    />
  )
}

/**
 * A small count, shown rather than read.
 *
 * Up to a dozen, ticks beat a numeral — five is recognisably more than two at a
 * glance, where "5" and "2" are the same shape until parsed. Past the cap it is
 * a texture and not a count, so the tile falls back to the number alone.
 */
const UNIT_CAP = 12

function UnitStrip({ count }: { count: number }) {
  if (count <= 0 || count > UNIT_CAP) return null
  return (
    <div className="ins-units" aria-hidden>
      {Array.from({ length: UNIT_CAP }, (_, i) => (
        <span key={i} className={`ins-unit${i < count ? ' is-on' : ''}`} />
      ))}
    </div>
  )
}

/** A number the platform computed, with what it was computed from underneath. */
function Stat({
  label,
  value,
  sub,
  units,
}: {
  label: string
  value: string
  sub?: string
  units?: number
}) {
  return (
    <Card padding="md" style={{ flex: '1 1 200px', minWidth: 200 }}>
      <Stack gap={6}>
        <Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: '0.04em' }}>
          {label}
        </Text>
        {/* Proportional figures, not tabular: nothing is aligned under this, and
            tabular-nums gives every digit the width of a zero, which reads
            loose at display size. */}
        <Text fz={30} fw={600} lh={1.1}>
          {value}
        </Text>
        {units !== undefined && <UnitStrip count={units} />}
        {sub && (
          <Text size="xs" c="dimmed" lineClamp={2}>
            {sub}
          </Text>
        )}
      </Stack>
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * headroom — how much of each limit is left                           *
 * ------------------------------------------------------------------ */

/** One active limit's current window, from GET /api/budgets. */
interface Budget {
  mandateId: string
  agentName: string
  targets: string[]
  asset: string
  window: string
  bucket: string
  committed: string
  open: string
  remaining: string | null
  unsummable: boolean
}

const WINDOW_LABEL: Record<string, string> = {
  DAILY: 'today',
  WEEKLY: 'this week',
  MONTHLY: 'this month',
  NONE: 'lifetime',
}

/** Spent and earmarked, in the app's existing vocabulary for both. */
const SPENT_FILL =
  'linear-gradient(90deg, var(--mantine-color-sierra-1), var(--mantine-color-sierra-3))'
const OPEN_FILL =
  'linear-gradient(90deg, var(--mantine-color-canyon-1), var(--mantine-color-canyon-0))'

/**
 * How close each agent is to the wall.
 *
 * This is the question the product exists to answer — an agent can spend
 * without asking, so what stops it is the limit, and the only thing worth
 * knowing about a limit is how much of it is gone. The platform meters this
 * itself; the bar is its three figures laid end to end against the cap.
 *
 * Two segments, not three: spent and earmarked are drawn, and what is LEFT is
 * the empty track they have not reached. Colouring headroom would make an
 * untouched limit the loudest thing on the page, when the whole point of the
 * chart is to notice the full ones.
 *
 * An uncapped rule gets no bar at all. Its remaining is absent rather than
 * zero — the platform is explicit that those mean opposite things — so there
 * is no denominator, and a full-width bar would say "at the ceiling" about a
 * limit that has none.
 */
function HeadroomCard({ budgets }: { budgets: Budget[] }) {
  if (budgets.length === 0) return null

  return (
    <Card padding="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="baseline" wrap="wrap" gap="xs">
          <Text fw={500}>Spend limits</Text>
          <Group gap="md" wrap="nowrap">
            <Group gap={7} wrap="nowrap">
              <Swatch fill={SPENT_FILL} />
              <Text size="xs" c="dimmed">
                Spent
              </Text>
            </Group>
            <Group gap={7} wrap="nowrap">
              <Swatch fill={OPEN_FILL} />
              <Text size="xs" c="dimmed">
                Scheduled
              </Text>
            </Group>
          </Group>
        </Group>

        <div className="ins-scale">
          {budgets.map((b) => {
            const spent = num(b.committed)
            const open = num(b.open)
            const left = b.remaining === null ? null : num(b.remaining)
            // The cap is not sent as a number — it is what the three parts add
            // up to, which is also the only figure all three are metered
            // against.
            const cap = left === null ? 0 : spent + open + left
            const who = b.targets.length ? b.targets.join(', ') : 'anyone'
            const unit = b.asset || ''

            return (
              <Fragment key={b.mandateId}>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text size="xs" fw={500} truncate>
                    {b.agentName}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {WINDOW_LABEL[b.window] ?? b.window.toLowerCase()}
                  </Text>
                </Stack>

                {left === null ? (
                  // No ceiling to draw against. Say so rather than drawing a
                  // bar that would have to lie about the denominator.
                  <Text size="xs" c="dimmed">
                    No amount ceiling — {fmtAmount(spent + open)} {unit} used so far, paying {who}.
                  </Text>
                ) : (
                  <Bar
                    segments={[
                      { key: 'spent', label: 'Spent', value: spent, fill: SPENT_FILL },
                      { key: 'open', label: 'Scheduled', value: open, fill: OPEN_FILL },
                    ]}
                    max={cap}
                    height={14}
                    label={`${b.agentName}: ${fmtAmount(spent + open)} of ${fmtAmount(cap)} ${unit} used`}
                  />
                )}

                <Group gap={8} align="baseline" wrap="nowrap" className="ins-row-value">
                  {left === null ? (
                    <Text size="xs" c="dimmed">
                      uncapped
                    </Text>
                  ) : (
                    <>
                      <Text fz={16} fw={500} lh={1.2} style={{ whiteSpace: 'nowrap' }}>
                        {fmtAmount(left)}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                        {unit} left
                      </Text>
                    </>
                  )}
                </Group>

                {b.unsummable && (
                  <>
                    <span />
                    <Text size="xs" c="blaze.0" style={{ gridColumn: 'span 2' }}>
                      The platform could not total this window, and the limit gate fails closed on
                      the same data — treat it as no headroom until it is fixed.
                    </Text>
                  </>
                )}
              </Fragment>
            )
          })}
        </div>
      </Stack>
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * outflow — what leaves, and when                                     *
 * ------------------------------------------------------------------ */

/** The fields of a scheduled payment this chart needs. */
interface Outflow {
  status?: string
  amount?: string
  asset?: string
  scheduled_at?: number
}

const HORIZON_DAYS = 30
const DAY = 86_400

/** Midnight local, so a day bucket is a day as the reader means it. */
function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** A plain decimal, grouped — these are asset amounts, not dollars. */
const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const fmtAmount = (n: number) => decimal.format(n)

/**
 * Money leaving over the next month.
 *
 * The snapshot's "due in 7 days" is one number for a window someone else
 * chose, which answers "how much" and never "when" — and when is the half that
 * decides whether a wallet needs topping up on Tuesday or at the end of the
 * month. Same payments, laid on a day axis.
 *
 * Only assets the dollar prices 1:1 are summed. Mixing a token with an unknown
 * rate into the same column would silently invent an exchange rate, so those
 * payments are counted and named beneath instead.
 */
function OutflowCard({ payments, asOf }: { payments: Outflow[]; asOf: number }) {
  // `asOf` is stamped when the payments were fetched, not read here. Calling
  // Date.now() during render is impure — two renders a midnight apart would
  // silently draw different windows from identical data — and on a page that
  // server-renders it also invites a hydration mismatch. Passing the moment in
  // is both correct and what the chart actually means: these are the payments
  // as of that fetch.
  const today = startOfDay(asOf)
  const horizonEnd = today + HORIZON_DAYS * DAY * 1000

  // Open payments only: an executed one already left and is not a commitment.
  const open = payments.filter(
    (p) => p.status === 'scheduled' || p.status === 'pending'
  )

  let unpriced = 0
  const byDay = new Map<number, { amount: number; count: number }>()

  for (const p of open) {
    if (!p.scheduled_at) continue
    const at = startOfDay(p.scheduled_at * 1000)
    if (at < today || at > horizonEnd) continue

    if (!USD_PEGGED.has((p.asset ?? '').toUpperCase())) {
      unpriced += 1
      continue
    }
    const slot = byDay.get(at) ?? { amount: 0, count: 0 }
    slot.amount += num(p.amount)
    slot.count += 1
    byDay.set(at, slot)
  }

  // Every day in the window, not only the ones with payments — see .ins-cols.
  const days = Array.from({ length: HORIZON_DAYS }, (_, i) => {
    const at = today + i * DAY * 1000
    return { at, ...(byDay.get(at) ?? { amount: 0, count: 0 }) }
  })

  const peak = Math.max(...days.map((d) => d.amount), 0)
  const peakDay = peak > 0 ? days.find((d) => d.amount === peak) : undefined
  const total = days.reduce((s, d) => s + d.amount, 0)
  const count = days.reduce((s, d) => s + d.count, 0)

  if (count === 0 && unpriced === 0) return null

  const dayLabel = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <Card padding="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="baseline" wrap="wrap" gap="xs">
          <Text fw={500}>Leaving in the next {HORIZON_DAYS} days</Text>
          <Group gap={8} align="baseline">
            <Text fz={22} fw={600} lh={1.2}>
              {fmtUsd(total)}
            </Text>
            <Text size="xs" c="dimmed">
              {count} payment{count === 1 ? '' : 's'}
            </Text>
          </Group>
        </Group>

        <div>
          <div className="ins-cols" role="img" aria-label={`Payments due over the next ${HORIZON_DAYS} days`}>
            {days.map((d) => (
              <Tooltip
                key={d.at}
                withArrow
                label={
                  d.count
                    ? `${dayLabel(d.at)} · ${fmtUsd(d.amount)} · ${d.count} payment${d.count === 1 ? '' : 's'}`
                    : `${dayLabel(d.at)} · nothing due`
                }
              >
                <div className="ins-col">
                  <div
                    className={`ins-col-fill${d.count ? '' : ' is-empty'}`}
                    style={
                      d.count
                        ? // A day with money in it is never a hairline: below
                          // about 4px a column reads as an empty slot, which is
                          // the opposite of what it is.
                          { height: `${Math.max(4, peak > 0 ? (d.amount / peak) * 100 : 0)}%` }
                        : undefined
                    }
                  />
                </div>
              </Tooltip>
            ))}
          </div>
          {/* The ends of the window, and the extreme between them.
              No y-axis: a column chart of thirty slots at this width has room
              for two tick labels or none, and the one number that makes the
              rest readable is the tallest column — with it, every other column
              can be judged against a known height, and it is also the day
              somebody has to have the money ready. Labelling every column
              would be noise; labelling none leaves the shape unscaled. */}
          <div className="ins-axis">
            <Text size="xs" c="dimmed">
              {dayLabel(days[0].at)}
            </Text>
            {peakDay && (
              <Text size="xs" c="dimmed">
                biggest day {dayLabel(peakDay.at)} · {fmtUsd(peakDay.amount)}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {dayLabel(days[days.length - 1].at)}
            </Text>
          </div>
        </div>

        {unpriced > 0 && (
          <Text size="xs" c="dimmed">
            {unpriced} payment{unpriced === 1 ? ' is' : 's are'} in an asset this page cannot price
            against the dollar, so {unpriced === 1 ? 'it is' : 'they are'} not in the columns above.
          </Text>
        )}
      </Stack>
    </Card>
  )
}

/**
 * Funding against commitments, on one scale.
 *
 * Reads top-down: what the account holds, then what is already spoken for,
 * then which wallets the first is spread across. The two bars share a maximum
 * so "does funding cover the next week" is answered by looking, and the legend
 * beneath names every segment so nothing is identified by colour alone.
 */
function PositionCard({
  balances,
  totalUsd,
  upcoming,
}: {
  balances: Balance[]
  totalUsd?: string
  upcoming?: { days?: number; count?: number; totals?: Record<string, string> }
}) {
  const funding = num(totalUsd)
  const days = upcoming?.days ?? 7
  const dueCount = upcoming?.count ?? 0
  const totals = upcoming?.totals ?? {}
  const assets = Object.keys(totals)

  // Only compare like with like — see USD_PEGGED.
  const comparable = assets.length > 0 && assets.every((a) => USD_PEGGED.has(a.toUpperCase()))
  const due = comparable ? assets.reduce((sum, a) => sum + num(totals[a]), 0) : 0

  // Biggest wallet first, so the ramp runs light-to-dark with magnitude and the
  // legend is already sorted for reading.
  const sorted = [...balances].sort((a, b) => num(b.amount_usd) - num(a.amount_usd))
  const head = sorted.slice(0, MAX_SEGMENTS)
  const tail = sorted.slice(MAX_SEGMENTS)

  const walletSegments: Segment[] = head.map((b, i) => ({
    key: b.wallet_id ?? `${b.name}-${i}`,
    label: b.name?.trim() || 'Funding wallet',
    note: [b.network_id, b.asset].filter(Boolean).join(' · '),
    value: num(b.amount_usd),
    fill: rampFill(i, head.length),
  }))

  // A ninth hue is never the answer to too many series. The tail folds into one
  // neutral bucket, and the tooltip still names how many wallets are in it.
  if (tail.length) {
    walletSegments.push({
      key: 'other',
      label: `${tail.length} other wallet${tail.length > 1 ? 's' : ''}`,
      value: tail.reduce((sum, b) => sum + num(b.amount_usd), 0),
      fill: 'var(--mantine-color-slate-4)',
    })
  }

  // Anything committed beyond what is funded is drawn past the funding bar's
  // end, in the colour this app uses for failure — because that is what it is.
  const covered = Math.min(due, funding)
  const short = Math.max(0, due - funding)
  const dueSegments: Segment[] = [
    {
      key: 'covered',
      label: 'Covered by funding',
      value: covered,
      // The light end of canyon, not the middle of it. Canyon's mid shades are
      // a brown close enough to the slate track that the bar and the space it
      // has yet to fill read as one muddy strip — which is the single thing
      // this bar exists to distinguish.
      fill: 'linear-gradient(90deg, var(--mantine-color-canyon-1), var(--mantine-color-canyon-0))',
    },
    {
      key: 'short',
      label: 'Beyond funding',
      value: short,
      fill: 'linear-gradient(90deg, var(--mantine-color-blaze-2), var(--mantine-color-blaze-0))',
    },
  ]

  const max = Math.max(funding, due)
  const indexed = balances.length > 0

  const dueText = comparable
    ? fmtUsd(due)
    : assets.map((a) => `${totals[a]} ${a}`).join(' · ') || fmtUsd(0)

  return (
    <Card padding="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="baseline" wrap="wrap" gap="xs">
          <Text fw={500}>Position</Text>
          <Text size="xs" c="dimmed">
            {indexed
              ? `${balances.length} funding wallet${balances.length > 1 ? 's' : ''} · next ${days} days`
              : `next ${days} days`}
          </Text>
        </Group>

        {indexed ? (
          <div className="ins-scale">
            <BarRow
              name="Funding"
              segments={walletSegments}
              max={max}
              height={18}
              value={fmtUsd(funding)}
              lead
            />
            <BarRow
              name={`Due · ${days}d`}
              segments={comparable ? dueSegments : []}
              max={max}
              height={10}
              value={dueText}
              note={dueCount ? `${dueCount} payment${dueCount > 1 ? 's' : ''}` : 'nothing scheduled'}
            />
            {/* No axis. Both bars are directly labelled with their own value,
                and the scale runs 0 → whichever of the two is larger — so a
                tick row would have printed the number already sitting an inch
                above it, twice. Direct labels before gridlines. */}
          </div>
        ) : (
          // The snapshot omits balances entirely when the index has nothing for
          // this customer. That is not the same as "your wallets are empty",
          // and must not be drawn as a bar at zero — the Treasury panel reads
          // balances directly and is the honest place to look.
          <Stack gap={4}>
            <Text fz={30} fw={600} lh={1.1}>
              {dueText}
            </Text>
            <Text size="sm" c="dimmed">
              due in the next {days} days
              {dueCount ? ` across ${dueCount} payment${dueCount > 1 ? 's' : ''}` : ''}. Balance
              index unavailable, so there is nothing to compare it against — see Treasury.
            </Text>
          </Stack>
        )}

        {indexed && walletSegments.length > 0 && (
          <>
            <Divider color="var(--mantine-color-slate-6)" />
            <Stack gap={10}>
              {walletSegments.map((s) => (
                <Group key={s.key} justify="space-between" align="center" wrap="nowrap" gap="md">
                  {/* flex:1 + minWidth:0 is what actually lets this shrink. A
                      nowrap network id ("base-sepolia · USDC") is happy to push
                      the row past the viewport otherwise, and the whole panel
                      then scrolls sideways on a phone because of a footnote. */}
                  <Group
                    gap={9}
                    align="center"
                    wrap="nowrap"
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    <Swatch fill={s.fill} />
                    <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
                      {s.label}
                    </Text>
                    {s.note && (
                      <Text size="xs" c="dimmed" ff="var(--font-gt-america-mono)" truncate>
                        {s.note}
                      </Text>
                    )}
                  </Group>
                  <Text
                    size="sm"
                    style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                  >
                    {fmtUsd(s.value)}
                  </Text>
                </Group>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  )
}

/**
 * What an item was derived from.
 *
 * Grouped by type and counted, with the ids themselves on hover. The ids are
 * the part that matters for a demo: they turn "the platform noticed something"
 * into "the platform noticed THIS, and here is the row it read".
 */
function EvidenceChips({ evidence }: { evidence?: Evidence[] }) {
  if (!evidence?.length) return null

  const byType = new Map<string, string[]>()
  for (const e of evidence) {
    if (!byType.has(e.type)) byType.set(e.type, [])
    byType.get(e.type)!.push(e.id)
  }

  // Deliberately quiet — plain dimmed text, not pills. Rendered as badges these
  // competed with the kind label directly above them, so "1 recipient" carried
  // the same visual weight as "Repeated failures" and the row had no hierarchy
  // to read. Evidence is a footnote; it should look like one.
  return (
    <Group gap={10} wrap="wrap" justify="flex-end">
      {[...byType.entries()].map(([type, ids]) => (
        <Tooltip
          key={type}
          withArrow
          multiline
          maw={340}
          label={ids.join('\n')}
          styles={{ tooltip: { fontFamily: 'var(--font-gt-america-mono)', fontSize: 11 } }}
        >
          <Text
            size="xs"
            c="dimmed"
            style={{ cursor: 'help', whiteSpace: 'nowrap', borderBottom: '1px dotted currentColor' }}
          >
            {ids.length} {type.replace(/_/g, ' ')}
            {ids.length > 1 ? 's' : ''}
          </Text>
        </Tooltip>
      ))}
    </Group>
  )
}

/** The coloured glyph that opens a row, and carries its tone. */
function KindIcon({ icon: Icon, tone }: { icon: TablerIcon; tone: string }) {
  const { well, ink } = toneStyle(tone)
  return (
    <div
      style={{
        width: 32,
        height: 32,
        flexShrink: 0,
        borderRadius: 9,
        display: 'grid',
        placeItems: 'center',
        background: well,
        color: ink,
        // A hairline of the glyph's own colour lifts the well off a card that
        // is itself dark; without it the tint reads as a hole rather than a
        // element.
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${ink} 22%, transparent)`,
      }}
    >
      <Icon size={17} stroke={1.7} />
    </div>
  )
}

/**
 * One observation or recommendation.
 *
 * Three tiers, so the row can be read at a glance rather than parsed: a glyph
 * that says what KIND of thing this is, an eyebrow naming it, and the
 * platform's sentence as the only full-size text. Evidence sits right-aligned
 * on the eyebrow line, which also fills the width the old single-column layout
 * left empty.
 *
 * The spine down the left edge carries the same tone as the glyph. It gives a
 * long list a readable margin — where the critical items are is answerable
 * before a word of it is read.
 */
function InsightRow({ item, index }: { item: Item; index: number }) {
  const meta = metaFor(item)
  const ink = toneStyle(meta.tone).ink
  return (
    <div
      className="rise"
      style={{ position: 'relative', animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <span
        className="ins-spine"
        aria-hidden
        style={{
          background:
            meta.tone === 'slate'
              ? 'transparent'
              : `linear-gradient(180deg, ${ink}, color-mix(in srgb, ${ink} 10%, transparent))`,
        }}
      />
      {/* No padding of its own. The CARD owns the inset — padding="lg", the
          same 24px the Position card uses — and a row that added its own on
          top is what made these two cards start their content on two different
          edges, horizontally and vertically. One padding, one source. */}
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <KindIcon icon={meta.icon} tone={meta.tone} />
        <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" align="baseline" wrap="nowrap" gap="md">
            <Text
              size="xs"
              fw={600}
              tt="uppercase"
              style={{
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
                // Explicit, not c="blaze.1": in dark mode that resolves to the mid
                // shade of an already-dark scale and disappears into the card.
                color: meta.tone === 'slate' ? undefined : ink,
              }}
              c={meta.tone === 'slate' ? 'dimmed' : undefined}
            >
              {meta.label}
            </Text>
            <EvidenceChips evidence={item.evidence} />
          </Group>
          <Text size="sm" style={{ lineHeight: 1.5 }}>
            {item.message}
          </Text>
        </Stack>
      </Group>
    </div>
  )
}

/**
 * A list of items.
 *
 * An empty list renders an empty state only when the caller supplies copy for
 * one — otherwise nothing at all. The two lists here want different things: an
 * empty Observations list is worth explaining, because on a fresh account it is
 * the normal state and the copy says what will eventually appear there. An
 * empty suggestions list is not a state anyone needs narrated.
 */
function ItemList({
  items,
  emptyTitle,
  emptyBody,
}: {
  items: Item[]
  emptyTitle?: string
  emptyBody?: string
}) {
  if (items.length === 0) {
    if (!emptyTitle) return null
    return (
      <Card padding="lg">
        <Stack gap={4} align="center" ta="center">
          <Text size="sm" fw={500}>
            {emptyTitle}
          </Text>
          {emptyBody && (
            <Text size="xs" c="dimmed" maw={420}>
              {emptyBody}
            </Text>
          )}
        </Stack>
      </Card>
    )
  }
  // padding="lg", exactly as the Position card above — the rows carry none, so
  // both cards inset their content by the same 24px on every side. The rules
  // between rows are drawn by the Stack's own gap rather than a full-bleed
  // border, which is what a card with zero padding was for.
  return (
    <Card padding="lg">
      <Stack gap="md">
        {items.map((it, i) => (
          <div key={`${it.kind}-${i}`}>
            {i > 0 && <Divider mb="md" color="var(--mantine-color-slate-6)" />}
            <InsightRow item={it} index={i} />
          </div>
        ))}
      </Stack>
    </Card>
  )
}

export function InsightsPanel() {
  const [report, setReport] = useState<Report | null>(null)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [outflow, setOutflow] = useState<Outflow[]>([])
  /** When the data above was read — the instant the day columns are drawn against. */
  const [asOf, setAsOf] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showRaw, setShowRaw] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    // Three sources, one refresh. The insight report is the only one that can
    // fail loudly: the other two draw charts that simply do not appear if the
    // data is not there, and an error banner over a working page because a
    // secondary chart could not load is worse than the missing chart.
    const [insights, budget, scheduled] = await Promise.allSettled([
      fetch('/api/insights').then((r) => r.json().then((b) => ({ ok: r.ok, b }))),
      fetch('/api/budgets').then((r) => r.json()),
      fetch('/api/scheduled').then((r) => r.json()),
    ])

    if (insights.status === 'fulfilled' && insights.value.ok) {
      setReport(insights.value.b.report as Report)
    } else {
      const why =
        insights.status === 'fulfilled'
          ? (insights.value.b?.error ?? 'could not load insights')
          : String(insights.reason)
      setError(why)
    }

    if (budget.status === 'fulfilled') setBudgets(budget.value.budgets ?? [])
    if (scheduled.status === 'fulfilled') setOutflow(scheduled.value.payments ?? [])

    setAsOf(Date.now())
    setLoading(false)
  }, [])

  useEffect(() => {
    // load() sets state before its first await — a fetch on mount. Deliberate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const snap = report?.snapshot
  const suggestions = [...(report?.suggestions ?? [])].sort(bySeverity)
  const observations = [...(report?.insights ?? [])].sort(bySeverity)

  return (
    <Stack gap="lg">
      {/* The provenance claim, stated once and checkable via the raw report. */}
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Text size="sm" c="dimmed" maw={620}>
          A read-only view of your funding, payments and limits.
          {report?.generated_at ? ` Updated ${fmtDateTime(report.generated_at)}.` : ''}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconCode size={14} />}
            onClick={() => setShowRaw((v) => !v)}
            disabled={!report}
          >
            {showRaw ? 'Hide response' : 'View response'}
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={loading}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </Group>
      </Group>

      {error && (
        <Card padding="md">
          <Text size="sm" c="blaze.1">
            {error}
          </Text>
        </Card>
      )}

      {loading && !report ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      ) : snap ? (
        <>
          {/* Ordered by what someone came here to find out: what can still be
              spent, then what is about to leave, then what is sitting there to
              cover it. Each card answers one question; none of them restates
              another's. */}
          <HeadroomCard budgets={budgets} />
          {asOf > 0 && <OutflowCard payments={outflow} asOf={asOf} />}
          <PositionCard
            balances={snap.balances ?? []}
            totalUsd={snap.total_usd}
            upcoming={snap.upcoming}
          />

          <Group gap="sm" align="stretch" wrap="wrap">
            <Stat
              label="Open payments"
              value={String(snap.open_scheduled_payments ?? 0)}
              units={snap.open_scheduled_payments ?? 0}
              sub="scheduled, not yet settled"
            />
            <Stat
              label="Active limits"
              value={String(snap.active_mandates ?? 0)}
              units={snap.active_mandates ?? 0}
              sub="signed and in force"
            />
            <Stat
              label="Needs attention"
              value={String(suggestions.length)}
              units={suggestions.length}
              sub={
                suggestions.length
                  ? `${suggestions.filter((s) => s.severity === 'critical').length} critical`
                  : 'nothing outstanding'
              }
            />
          </Group>

          {showRaw && (
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                The exact response from{' '}
                <Text span ff="var(--font-gt-america-mono)">
                  GET /insights
                </Text>
                . Every figure above appears somewhere in it.
              </Text>
              <pre className="wire-json" style={{ maxHeight: 340, overflowY: 'auto' }}>
                {JSON.stringify(report, null, 2)}
              </pre>
            </Stack>
          )}

          {/* Only when there IS something. A heading over a card announcing that
              nothing is wrong costs a screenful to say what the stat tile above
              already says with a 0 — and it trains the eye to skip the one
              region that matters on the days it is not empty. */}
          {suggestions.length > 0 && (
            <Stack gap="xs">
              <Group gap="xs" align="baseline">
                <Text fw={500}>Needs attention</Text>
                <Text size="xs" c="dimmed">
                  {suggestions.length}
                </Text>
              </Group>
              <ItemList items={suggestions} />
            </Stack>
          )}

          <Stack gap="xs">
            <Text fw={500}>Observations</Text>
            <ItemList
              items={observations}
              emptyTitle="No observations yet"
              emptyBody="As your agents move money, activity summaries show up here."
            />
          </Stack>
        </>
      ) : null}
    </Stack>
  )
}
