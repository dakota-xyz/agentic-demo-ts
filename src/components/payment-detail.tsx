'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge, Group, Loader, Modal, Stack, Text, Tooltip } from '@/theme/ui'
import { CopyAddress } from './copy-address'
import { fmtDateTime } from '@/lib/format'
import { badgeTone } from '@/lib/tone'

// One payment, in full.
//
// The table answers "what is happening"; this answers "where did the money
// actually go, and what let it go there". Two rows here carry that second half
// and exist in no ordinary payments UI:
//
//   the MANDATE — why this ran with nobody present
//   the HASH    — proof it did, checkable in a block explorer
//
// Everything is fetched when the drawer opens rather than per table row,
// because it costs three extra reads and most rows are never opened.

interface Detail {
  payment: Record<string, unknown>
  recipientName?: string
  bank?: { bankName?: string; accountType?: string; routingNumber?: string; accountLabel?: string }
  crypto?: { address?: string; networkId?: string }
  mandate?: Record<string, unknown>
  transaction?: Record<string, unknown>
}

const STATUS_TONE: Record<string, string> = {
  executed: 'evergreen',
  scheduled: 'canyon',
  pending: 'canyon',
  failed: 'blaze',
  cancelled: 'slate',
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)

/** Where a hash can be looked at. Sepolia only — the demo's one network. */
function explorerUrl(networkId: string, hash: string): string | null {
  if (!hash) return null
  if (networkId.startsWith('ethereum-sepolia')) return `https://sepolia.etherscan.io/tx/${hash}`
  if (networkId.startsWith('base-sepolia')) return `https://sepolia.basescan.org/tx/${hash}`
  return null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="lg" align="flex-start">
      <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ textAlign: 'right', minWidth: 0 }}>{children}</div>
    </Group>
  )
}

function Value({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <Text size="sm" ff={mono ? 'var(--font-gt-america-mono)' : undefined} style={{ wordBreak: 'break-all' }}>
      {children}
    </Text>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap={8} pt="md" style={{ borderTop: '1px solid var(--mantine-color-slate-6)' }}>
      <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.05em' }}>
        {title}
      </Text>
      {children}
    </Stack>
  )
}

/**
 * The life of the payment, from the timestamps that actually exist.
 *
 * Nothing is invented: each entry is a real field, and one missing simply does
 * not render. A fabricated "processing" step would be the easiest thing to add
 * here and the least honest.
 */
function Timeline({ detail }: { detail: Detail }) {
  const p = detail.payment
  const tx = detail.transaction ?? {}
  const steps = [
    { at: num(p.scheduled_at), label: 'Scheduled by the agent' },
    { at: num(p.executed_at), label: 'Payment initiated' },
    { at: num(tx.created_at), label: 'Submitted on-chain' },
    { at: num(tx.confirmed_at), label: 'Confirmed' },
  ].filter((s) => s.at)

  if (steps.length === 0) return null

  return (
    <Section title="Timeline">
      <Stack gap={0}>
        {steps.map((s, i) => (
          <Group key={i} gap="sm" wrap="nowrap" align="flex-start">
            <Stack gap={0} align="center" style={{ flexShrink: 0, width: 12 }}>
              <div
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  marginTop: 5,
                  background: 'var(--mantine-color-sierra-4)',
                }}
              />
              {i < steps.length - 1 && (
                <div style={{ width: 1, flex: 1, minHeight: 22, background: 'var(--mantine-color-slate-6)' }} />
              )}
            </Stack>
            <Stack gap={0} pb={i < steps.length - 1 ? 10 : 0}>
              <Text size="sm">{s.label}</Text>
              <Text size="xs" c="dimmed">
                {fmtDateTime(s.at)}
              </Text>
            </Stack>
          </Group>
        ))}
      </Stack>
    </Section>
  )
}

export function PaymentDetail({ paymentId, onClose }: { paymentId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError('')
    setDetail(null)
    try {
      const res = await fetch(`/api/payments/${encodeURIComponent(id)}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'could not load that payment')
      setDetail(body as Detail)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // load() sets state before its first await — it fetches the payment the drawer
    // was opened on. Deliberate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (paymentId) void load(paymentId)
  }, [paymentId, load])

  const p = detail?.payment ?? {}
  const status = str(p.status)
  const network = str(p.network_id)
  const hash = str(detail?.transaction?.transaction_hash)
  const explorer = explorerUrl(network, hash)
  const rule = (detail?.mandate?.rule ?? {}) as Record<string, unknown>

  return (
    <Modal opened={!!paymentId} onClose={onClose} size="lg">
      <Modal.Header onClose={onClose}>Payment</Modal.Header>
      <Modal.Body>
      {loading && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      )}

      {error && (
        <Text size="sm" c="blaze.1">
          {error}
        </Text>
      )}

      {detail && (
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Text fz={30} fw={600} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {str(p.amount)} {str(p.asset)}
            </Text>
            <Badge {...badgeTone(STATUS_TONE[status] ?? 'slate')}>{status}</Badge>
          </Group>

          <Section title="Details">
            <Stack gap={7}>
              <Row label="To">
                <Value>{detail.recipientName || '—'}</Value>
              </Row>
              {/* output_asset only differs when a conversion happened, and that
                  difference IS the offramp — worth its own row when present. */}
              {str(p.output_asset) && str(p.output_asset) !== str(p.asset) && (
                <Row label="Converted to">
                  <Value>
                    {str(p.asset)} → {str(p.output_asset)}
                  </Value>
                </Row>
              )}
              {str(p.destination_rail) && (
                <Row label="Rail">
                  <Value>{str(p.destination_rail).toUpperCase()}</Value>
                </Row>
              )}
              {detail.bank && (
                <>
                  {detail.bank.bankName && (
                    <Row label="Bank">
                      <Value>{detail.bank.bankName}</Value>
                    </Row>
                  )}
                  {detail.bank.accountType && (
                    <Row label="Account">
                      <Value>
                        {detail.bank.accountType.charAt(0).toUpperCase() + detail.bank.accountType.slice(1)}
                      </Value>
                    </Row>
                  )}
                  {detail.bank.accountLabel && (
                    <Row label="Account number">
                      <Value mono>{detail.bank.accountLabel}</Value>
                    </Row>
                  )}
                  {detail.bank.routingNumber && (
                    <Row label="Routing number">
                      <CopyAddress address={detail.bank.routingNumber} />
                    </Row>
                  )}
                </>
              )}
              {detail.crypto?.address && (
                <Row label="Address">
                  <CopyAddress address={detail.crypto.address} />
                </Row>
              )}
              {network && (
                <Row label="Network">
                  <Value>{network}</Value>
                </Row>
              )}
              <Row label="Payment id">
                <Value mono>{str(p.id)}</Value>
              </Row>
            </Stack>
          </Section>

          {/* The authority. A payment ran with nobody present because THIS was
              signed — the one row that explains the whole model. */}
          {detail.mandate && (
            <Section title="Authorised by">
              <Stack gap={7}>
                <Row label="Spend limit">
                  <Value>
                    {str(rule.max_per_tx) ? `up to ${str(rule.max_per_tx)} ${str(rule.asset) || 'USDC'} per payment` : '—'}
                  </Value>
                </Row>
                <Row label="Status">
                  <Badge {...badgeTone(str(detail.mandate.status) === 'active' ? 'evergreen' : 'slate')}>
                    {str(detail.mandate.status)}
                  </Badge>
                </Row>
                <Row label="Mandate id">
                  <Value mono>{str(detail.mandate.id)}</Value>
                </Row>
              </Stack>
            </Section>
          )}

          {hash && (
            <Section title="Settlement">
              <Stack gap={7}>
                <Row label="Transaction">
                  {explorer ? (
                    <Tooltip label="Open in a block explorer" withArrow>
                      <a
                        href={explorer}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--mantine-color-sierra-3)', fontSize: 14, wordBreak: 'break-all' }}
                      >
                        {hash}
                      </a>
                    </Tooltip>
                  ) : (
                    <Value mono>{hash}</Value>
                  )}
                </Row>
                {str(detail.transaction?.status) && (
                  <Row label="Result">
                    <Value>{str(detail.transaction?.status)}</Value>
                  </Row>
                )}
              </Stack>
            </Section>
          )}

          <Timeline detail={detail} />
        </Stack>
      )}
      </Modal.Body>
    </Modal>
  )
}
