'use client'

import { useState } from 'react'
import { Badge, Button, Group, Stack, Table, Text, Tooltip } from '@/theme/ui'
import { IconAlertTriangle, IconArrowRight } from '@tabler/icons-react'
import { fmtDateTime } from '@/lib/format'
import { PaymentDetail } from './payment-detail'

// Scheduled and Activity: the same rows, split by whether they have happened.
//
// Two views rather than one filtered list, because the questions differ.
// "Scheduled" answers *what is about to happen* — the thing you might still
// want to stop. "Activity" answers *what did happen* — the receipt.
//
// A table rather than cards. These are homogeneous records people SCAN — "is
// MeatCo in here twice?", "what runs next?" — and cards make the eye re-find
// every field on every row. Columns put amount under amount and date under
// date, which is the entire job.

export interface PaymentRow {
  id?: string
  status?: string
  amount?: string
  asset?: string
  network_id?: string
  destination_label?: string
  /** Resolved server-side from the payee book; '' when only an address is known. */
  payee?: string
  address?: string
  scheduled_at?: number
  mandate_id?: string
}

const FINAL_STATES = new Set(['executed', 'failed', 'cancelled'])

const STATUS_COLOR: Record<string, string> = {
  executed: 'evergreen',
  scheduled: 'canyon',
  pending: 'canyon',
  failed: 'blaze',
  cancelled: 'slate',
}

/** Why a payment is in the state it is, when the state alone would puzzle. */
function explain(p: PaymentRow): string | null {
  if (p.status === 'failed') {
    return 'It did not move. Usually an unsigned spend limit, or no funds in the treasury when it fired.'
  }
  if (p.status === 'cancelled') return 'Its spend limit was revoked.'
  return null
}

function payeeOf(p: PaymentRow): string {
  if (p.payee) return p.payee
  if (p.address) return `${p.address.slice(0, 6)}…${p.address.slice(-4)}`
  return '—'
}

/** The row shape the table renders — Dakota's Table requires an `id`. */
type Row = PaymentRow & { id: string }

function Rows({ payments }: { payments: PaymentRow[] }) {
  const records: Row[] = payments.map((p, i) => ({ ...p, id: p.id ?? `row-${i}` }))
  const [open, setOpen] = useState<string | null>(null)

  // A row with no platform id is a local placeholder — there is nothing to
  // fetch for it, so it is not made to look openable.
  const openable = (p: Row) => Boolean(p.id && !p.id.startsWith('row-'))

  return (
    <>
    <PaymentDetail paymentId={open} onClose={() => setOpen(null)} />
    <Table<Row>
      records={records}
      highlightOnHover
      minHeight={160}
      onRowClick={({ record }) => openable(record) && setOpen(record.id)}
      columns={[
        {
          accessor: 'payee',
          title: 'Payee',
          render: (p) => <Text size="sm">{payeeOf(p)}</Text>,
        },
        {
          accessor: 'amount',
          title: 'Amount',
          textAlign: 'right',
          // Tabular figures so the digits line up down the column and an odd
          // one out is visible without reading every row.
          render: (p) => (
            <Text size="sm" fw={500} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {p.amount ?? '—'} {p.asset ?? ''}
            </Text>
          ),
        },
        {
          accessor: 'network_id',
          title: 'Network',
          render: (p) => (
            <Text size="sm" c="dimmed">
              {p.network_id ?? '—'}
            </Text>
          ),
        },
        {
          accessor: 'scheduled_at',
          title: 'When',
          render: (p) => (
            <Text size="sm" c="dimmed">
              {fmtDateTime(p.scheduled_at)}
            </Text>
          ),
        },
        {
          accessor: 'status',
          title: 'Status',
          render: (p) => {
            const note = explain(p)
            return (
              <Group gap={6} wrap="nowrap">
                <Badge color={STATUS_COLOR[p.status ?? ''] ?? 'slate'} variant="light">
                  {p.status}
                </Badge>
                {/* The explanation rides in a tooltip rather than its own row:
                    "failed" alone reads as a bug, and a second line per row
                    would wreck the scan the table exists for. */}
                {note && (
                  <Tooltip label={note} withArrow multiline w={260}>
                    <IconAlertTriangle size={14} style={{ opacity: 0.55, flexShrink: 0 }} />
                  </Tooltip>
                )}
              </Group>
            )
          },
        },
        {
          // An explicit button as well as the row click. A whole-row target is
          // undiscoverable — nothing says a row is clickable until you try it —
          // and this is the screen where the mandate and the settlement hash
          // live, which is the thing worth finding.
          accessor: 'id',
          title: '',
          textAlign: 'right',
          width: 120,
          render: (p) =>
            openable(p) ? (
              <Button
                size="compact-xs"
                variant="default"
                rightSection={<IconArrowRight size={13} />}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(p.id)
                }}
              >
                Details
              </Button>
            ) : null,
        },
      ]}
    />
    </>
  )
}

function Empty({ emoji, title, hint }: { emoji: string; title: string; hint: string }) {
  return (
    <Stack gap="xs" pt="xl" align="center" ta="center">
      <Text fz={32} lh={1}>
        {emoji}
      </Text>
      <Text fw={500}>{title}</Text>
      <Text size="sm" c="dimmed" maw={440}>
        {hint}
      </Text>
    </Stack>
  )
}

export function ScheduledPanel({ payments }: { payments: PaymentRow[] }) {
  // Soonest first: the next thing to happen is what you came to check.
  const upcoming = payments
    .filter((p) => !FINAL_STATES.has(p.status ?? ''))
    .sort((a, b) => (a.scheduled_at ?? Infinity) - (b.scheduled_at ?? Infinity))

  if (upcoming.length === 0) {
    return (
      <Empty
        emoji="◷"
        title="Nothing scheduled"
        hint="Ask an agent to pay someone at a time — “pay Acme 1 USDC on Friday” — and it appears here until it runs."
      />
    )
  }
  return <Rows payments={upcoming} />
}

export function ActivityPanel({ payments }: { payments: PaymentRow[] }) {
  // Newest first: the most recent thing that happened is what you came to see.
  const done = payments
    .filter((p) => FINAL_STATES.has(p.status ?? ''))
    .sort((a, b) => (b.scheduled_at ?? 0) - (a.scheduled_at ?? 0))

  if (done.length === 0) {
    return (
      <Empty
        emoji="◍"
        title="Nothing has run yet"
        hint="Once a scheduled payment executes — or fails — it moves here with what happened."
      />
    )
  }
  return <Rows payments={done} />
}
