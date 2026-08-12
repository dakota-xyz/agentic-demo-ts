'use client'

import { useState } from 'react'
import { Badge, Button, Group, Select, Stack, Table, Text, Tooltip } from '@/theme/ui'
import { IconFingerprint, IconInfoCircle } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { enrollPasskey, signMandate, passkeysAvailable } from '@/lib/passkey'
import { fmtDateTime } from '@/lib/format'
import { badgeTone } from '@/lib/tone'
import { currencyLabel } from '@/lib/money'
import { SetLimitModal } from './set-limit-modal'

// Spend limits.
//
// "Spend limit" here, "mandate" on the wire — the same object. The UI says the
// former because that is what it means to whoever is reading: the wall the
// agent can never spend past, whatever it is asked to do.
//
// A table, because a list of limits is scanned — "which of these is still
// waiting on me?" — but the RULE stays a sentence. A rule split into columns
// (asset / cap / window / targets) is a database row; as a sentence it is
// something a person can check against what they meant.

export interface MandateRow {
  id: string
  status?: string
  target_names?: string[]
  valid_until?: number
  rule?: Record<string, unknown>
}

/**
 * Render a mandate rule the way a person would say it.
 *
 * In dollars, and with no chain. Which stablecoin on which network is how this
 * deployment is plumbed, not something the reader chose or can act on — and a
 * limit that reads "on ethereum-sepolia" invites the question "what happens on
 * the other one?", which has no useful answer here. See lib/money.
 */
export function limitSentence(m: MandateRow): string {
  const rule = m.rule ?? {}
  const unit = currencyLabel(rule.asset as string | undefined)
  const window = String(rule.window ?? 'NONE')
  const targets = m.target_names?.length ? m.target_names.join(', ') : 'anyone'

  // A standing limit is bounded by its WINDOW total; a drafted one by its
  // per-payment cap. Say whichever the rule actually carries.
  const total = rule.max_amount_in_window ?? rule.max_amount_per_target_in_window
  const perTx = rule.max_per_tx

  const period = { DAILY: 'per day', WEEKLY: 'per week', MONTHLY: 'per month' }[window]
  if (total) {
    return `Can pay ${targets} up to ${String(total)} ${unit}${period ? ` ${period}` : ' in total'}.`
  }
  const cap = perTx ? `up to ${String(perTx)} ${unit}` : `any amount of ${unit}`
  return `Can pay ${targets} ${cap} per payment.`
}

/**
 * Which limits the table is showing.
 *
 * `active` carries PENDING too: both are limits with a future — one in force,
 * one a signature away from it. The split people actually make here is "what
 * can this agent spend" against "what could it once", and a pending limit is
 * on the first side of that line.
 */
type StatusFilter = 'active' | 'revoked' | 'all'

const STATUS_COLOR: Record<string, string> = {
  active: 'evergreen',
  pending: 'canyon',
  revoked: 'blaze',
  rejected: 'blaze',
  expired: 'slate',
  done: 'slate',
}

export function SpendLimitsPanel({
  agentId,
  agentName,
  limits,
  hasPasskey,
  onChanged,
}: {
  agentId: string
  agentName: string
  limits: MandateRow[]
  hasPasskey: boolean
  onChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState('')
  // Follows the prop rather than snapshotting it. useState only reads its
  // argument on the first render, so a panel mounted before enrolment kept
  // saying "Create passkey & sign" long after there was a passkey — which
  // reads as "every agent needs its own".
  const [justEnrolled, setJustEnrolled] = useState(false)

  // Active by default. A revoked limit is history — it authorises nothing, and
  // leaving it in the list makes a table about "what this agent may spend" also
  // a table about what it used to.
  const [show, setShow] = useState<StatusFilter>('active')
  const enrolled = hasPasskey || justEnrolled
  const [setting, setSetting] = useState(false)

  // What we just did, before the platform admits it.
  //
  // Signing is not synchronous end to end: the assertion is accepted, then the
  // status changes. Re-reading immediately can still return `pending`, so the
  // row would snap back to its old state and the whole thing would look like it
  // had not worked — which is why this needed a manual refresh before.
  //
  // The override is dropped as soon as the server reports anything other than
  // the status we were replacing, so the truth always wins in the end.
  const [applied, setApplied] = useState<Record<string, string>>({})

  /**
   * The status to render: what we just did, until the server catches up.
   *
   * The override applies ONLY while the server still says `pending`, so a stale
   * entry becomes inert on its own the moment real data arrives — no effect, no
   * clearing, and the truth always wins.
   */
  const statusOf = (m: MandateRow) =>
    m.status === 'pending' && applied[m.id] ? applied[m.id] : m.status

  async function act(id: string, action: 'approve' | 'cancel') {
    setBusy(id + action)
    try {
      if (!enrolled) {
        await enrollPasskey()
        setJustEnrolled(true)
      }
      await signMandate(id, action)
      setApplied((a) => ({ ...a, [id]: action === 'approve' ? 'active' : 'revoked' }))

      // Signing a new limit RETIRES the ones it replaces.
      //
      // Limits stack: a payment needs only one active limit that covers it, so
      // leaving the old one live means the new, usually smaller, one changes
      // nothing. Someone lowering a limit has said what they want the ceiling
      // to be, and leaving a higher one in force quietly contradicts them.
      //
      // Each revocation is its OWN signature — the platform will not retire a
      // mandate without one, and no server can produce it. So this is several
      // prompts, and the toast says how many rather than letting them arrive
      // unexplained.
      let retired = 0
      if (action === 'approve') {
        const superseded = limits.filter((m) => m.id !== id && statusOf(m) === 'active')
        for (const old of superseded) {
          try {
            await signMandate(old.id, 'cancel')
            setApplied((a) => ({ ...a, [old.id]: 'revoked' }))
            retired++
          } catch (e) {
            // A refused or dismissed prompt leaves the old limit in force. Say
            // so — silently continuing would imply a ceiling that is not real.
            console.warn('[limits] could not retire', old.id, e)
            notifications.show({
              color: 'canyon',
              message: `The previous limit is still active — revoke it from the list to make this one the ceiling.`,
            })
            break
          }
        }
      }

      notifications.show({
        color: action === 'approve' ? 'evergreen' : 'blaze',
        message:
          action === 'approve'
            ? retired > 0
              ? `Signed — this is now the only limit in force. ${retired} previous ${retired === 1 ? 'one was' : 'ones were'} revoked.`
              : 'Signed — payments under this limit are live.'
            : 'Revoked — payments scheduled under it are cancelled.',
      })
      await onChanged()
    } catch (e) {
      notifications.show({ color: 'blaze', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  /** Enrol an ADDITIONAL passkey, for a signer that moved. */
  async function addPasskey() {
    setBusy('enroll')
    try {
      await enrollPasskey()
      setJustEnrolled(true)
      notifications.show({ color: 'evergreen', message: 'Passkey added — try signing again.' })
      onChanged()
    } catch (e) {
      notifications.show({ color: 'blaze', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  // A passkey can only be used by whatever holds its private key. Someone who
  // enrolled in the browser's own store and later wants their password manager
  // — or who has simply changed device — needs a way to enrol a SECOND one,
  // otherwise every limit here is permanently unsignable. Enrolling again ADDS
  // a signer rather than replacing one, so limits already signed keep working.
  //
  // Rendered in both the empty and populated states on purpose: the error shown
  // when signing fails tells people to come here, and an instruction pointing
  // at a control that is not on screen is worse than no instruction.
  // "Replace", not "Add". Enrolling overwrites the key this app signs with —
  // there is only ever one per person — so "Add" promised an extra and
  // delivered a swap, quietly stopping an old device from being used.
  const passkeyCta = enrolled ? (
    <>
      <Tooltip
        label="Replaces the passkey this app signs with. One per person, used by every agent — enrol again only if you have switched device or password manager."
        withArrow
        multiline
        w={300}
      >
        {/* An outlined button, not a subtle dimmed one. This is where people
            are sent when signing fails, and greyed-out text reads as "not
            available" — the opposite of what a recovery action should say. */}
        <Button
          size="xs"
          variant="default"
          leftSection={<IconFingerprint size={14} />}
          loading={busy === 'enroll'}
          // Only its OWN work blocks it. Disabling while another row signs made
          // it look permanently unavailable at exactly the moment it is needed.
          disabled={!passkeysAvailable() || busy === 'enroll'}
          onClick={() => void addPasskey()}
        >
          Replace passkey
        </Button>
      </Tooltip>
    </>
  ) : null

  const actions = (
    <Group justify="flex-end" gap="sm">
      {/* The PRIMARY way to grant authority, and the one this app was missing.
          Everything else here drafts a limit as a side effect of asking for a
          payment; this decides up front how much the agent may ever spend. */}
      <Button size="xs" onClick={() => setSetting(true)}>
        Set a spend limit
      </Button>
      {passkeyCta}
    </Group>
  )

  const modal = setting ? (
    <SetLimitModal
      agentId={agentId}
      agentName={agentName}
      existing={limits
        .filter((m) => statusOf(m) === 'active')
        .map((m) => limitSentence(m))}
      onClose={() => setSetting(false)}
      onCreated={onChanged}
    />
  ) : null

  if (limits.length === 0) {
    return (
      <Stack gap="xs">
        {modal}
        {actions}
        <Stack gap="xs" pt="xl" align="center" ta="center">
        <Text fz={32} lh={1}>
          ◈
        </Text>
        <Text fw={500}>No spend limits yet</Text>
        <Text size="sm" c="dimmed" maw={440}>
          Ask the agent to pay someone. It drafts the payment and the limit that bounds it;
          you sign the limit once, and payments inside it run without asking again.
          </Text>
        </Stack>
      </Stack>
    )
  }

  const live = (m: MandateRow) => ['active', 'pending'].includes(statusOf(m) ?? '')
  const liveCount = limits.filter(live).length
  const retired = limits.length - liveCount
  const visible =
    show === 'all' ? limits : show === 'active' ? limits.filter(live) : limits.filter((m) => !live(m))

  // Counts in the options, so the choice is made before it is made: whether
  // there is anything under "Revoked" is answered by the menu itself rather
  // than by picking it and finding an empty table.
  const filterOptions = [
    { value: 'active', label: `Active (${liveCount})` },
    { value: 'revoked', label: `Revoked (${retired})` },
    { value: 'all', label: `All (${limits.length})` },
  ]

  // Pending first — those are the ones waiting on a human.
  const sorted = [...visible].sort(
    (a, b) => (statusOf(a) === 'pending' ? 0 : 1) - (statusOf(b) === 'pending' ? 0 : 1)
  )

  return (
    <Stack gap="xs">
      {modal}
      {actions}
      {/* The filter sits UNDER the buttons and above the table it filters —
          the last thing read before the rows, on the same edge as the control
          it governs. State the consequence, not the concept, on the left: the
          previous version explained how mandates compose, which is our
          problem, not the reader's — what they need to know is that more than
          one is live and any of them is enough. Shown only when there IS more
          than one. */}
      <Group justify="space-between" wrap="nowrap" gap="md" align="center">
        {limits.filter((m) => statusOf(m) === 'active').length > 1 ? (
          <Group gap={6} wrap="nowrap">
            <IconInfoCircle size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
            <Text size="xs" c="dimmed">
              {limits.filter((m) => statusOf(m) === 'active').length} limits are active. A payment
              needs only one of them to cover it.
            </Text>
          </Group>
        ) : (
          <span />
        )}
        <Select
          aria-label="Filter limits by status"
          size="xs"
          w={150}
          data={filterOptions}
          value={show}
          onChange={(v) => setShow((v as StatusFilter) ?? 'active')}
          // A filter always has a value — an empty one would show nothing and
          // say nothing about why.
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          style={{ flexShrink: 0 }}
        />
      </Group>
      <Table<MandateRow>
      records={sorted}
      minHeight={160}
      customEmptyState={
        show === 'revoked'
          ? 'No revoked limits — nothing here has been retired yet.'
          : 'No active limits. Set one above, or ask the agent to pay someone.'
      }
      columns={[
        {
          accessor: 'rule',
          title: 'What it allows',
          // The RULE stays a sentence even inside a table. Split into columns
          // (asset / cap / window / targets) it becomes a database row; as a
          // sentence it is something a person can check against what they meant.
          render: (m) => (
            <Stack gap={2}>
              <Text size="sm">{limitSentence(m)}</Text>
              <Tooltip label="Mandate id" withArrow>
                <Text size="xs" c="dimmed" ff="var(--font-gt-america-mono)">
                  {m.id}
                </Text>
              </Tooltip>
            </Stack>
          ),
        },
        {
          accessor: 'valid_until',
          title: 'Expires',
          width: 190,
          render: (m) => (
            <Text size="sm" c="dimmed">
              {m.valid_until ? fmtDateTime(m.valid_until) : '—'}
            </Text>
          ),
        },
        {
          accessor: 'status',
          title: 'Status',
          width: 110,
          render: (m) => (
            <Badge {...badgeTone(STATUS_COLOR[statusOf(m) ?? ''] ?? 'slate')}>{statusOf(m)}</Badge>
          ),
        },
        {
          accessor: 'id',
          title: '',
          textAlign: 'right',
          width: 230,
          render: (m) => (
            <>
              {/* Pending is the one that wants you: a limit sits inert until it
                  carries a signature this server cannot produce. */}
              {statusOf(m) === 'pending' && (
                <Group gap="xs" justify="flex-end" wrap="nowrap">
                  <Button
                    size="xs"
                    color="canyon"
                    leftSection={<IconFingerprint size={14} />}
                    loading={busy === m.id + 'approve'}
                    disabled={!passkeysAvailable() || busy !== ''}
                    onClick={() => void act(m.id, 'approve')}
                  >
                    {enrolled ? 'Sign' : 'Create passkey & sign'}
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    loading={busy === m.id + 'cancel'}
                    disabled={busy !== ''}
                    onClick={() => void act(m.id, 'cancel')}
                  >
                    Reject
                  </Button>
                </Group>
              )}
              {statusOf(m) === 'active' && (
                <Button
                  size="xs"
                  variant="subtle"
                  // Not color="blaze": that resolves to the MID shade of a dark
                  // scale (#7b181d) and is unreadable on this row. The light end
                  // of the same scale, set explicitly.
                  styles={{ root: { color: 'var(--mantine-color-blaze-0)' } }}
                  loading={busy === m.id + 'cancel'}
                  disabled={busy !== ''}
                  onClick={() => void act(m.id, 'cancel')}
                >
                  Revoke
                </Button>
              )}
            </>
          ),
        },
      ]}
      />
    </Stack>
  )
}
