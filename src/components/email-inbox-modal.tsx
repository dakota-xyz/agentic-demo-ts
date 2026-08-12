'use client'

import { useState } from 'react'
import {
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Stack,
  Text,
  UnstyledButton,
} from '@/theme/ui'
import { useClipboard } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import {
  IconCheck,
  IconCopy,
  IconFileText,
  IconMailForward,
  IconRobot,
  IconShieldLock,
} from '@tabler/icons-react'

// Where forwarded invoices land.
//
// There is ONE inbound address for the whole workspace and exactly one agent
// behind it. That is a workspace fact, not an agent fact — which is why it now
// lives in a dialog of its own instead of being restated, identically, on every
// agent's Integrations tab. Rendering a singleton N times is what made "which
// agent has email?" a question you had to click through the rail to answer.
//
// The address is never printed at full length anywhere in the UI. It is a
// Postmark inbound mailbox — a hash, an @, and a domain nobody recognises —
// and a string like that on screen reads as an error message. It is something
// you copy once and paste into a mail client, so the affordance is a button.

export interface InboxAgent {
  id: string
  name: string
}

/**
 * Copy the inbound address.
 *
 * Exported so the Integrations card and this dialog use the SAME control. Two
 * spellings of "get the address" is how one of them ends up being the ugly one.
 */
export function CopyEmailButton({
  address,
  variant = 'default',
  size = 'xs',
  fullWidth = false,
}: {
  address: string
  variant?: string
  size?: string
  /** Own the row, when it is the row's only purpose. */
  fullWidth?: boolean
}) {
  // 1.6s: long enough to register as an answer, short enough that the button is
  // back to its normal label before anyone looks again.
  const clip = useClipboard({ timeout: 1600 })

  // No tooltip. The address is a Postmark hash nobody reads, so revealing it on
  // hover buys nothing — and the label is already the whole promise.
  // flexShrink guards the label: in a nowrap row beside a sentence, the button
  // was the thing that gave, and "Copy email add…" is not a button label.
  return (
    <Button
      size={size}
      fullWidth={fullWidth}
      variant={clip.copied ? 'light' : variant}
      color={clip.copied ? 'evergreen' : undefined}
      leftSection={clip.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      onClick={() => clip.copy(address)}
      style={{ flexShrink: 0 }}
    >
      {clip.copied ? 'Copied' : 'Copy email address'}
    </Button>
  )
}

/** One fact about how the inbox behaves: a glyph, a claim, a line of detail. */
function Fact({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof IconMailForward
  title: string
  children: React.ReactNode
}) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <Icon size={16} stroke={1.7} style={{ flexShrink: 0, marginTop: 2, opacity: 0.7 }} />
      <Stack gap={1} style={{ minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {title}
        </Text>
        <Text size="xs" c="dimmed">
          {children}
        </Text>
      </Stack>
    </Group>
  )
}

export function EmailInboxModal({
  address,
  agents,
  ownerId,
  claimed,
  onClose,
  onChanged,
}: {
  /** The inbound address, or null when this deployment has none. */
  address: string | null
  agents: InboxAgent[]
  /** The agent invoices reach today — chosen, or the fallback. */
  ownerId?: string
  /** False when nobody has chosen and the inbound route is falling back. */
  claimed: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [picked, setPicked] = useState(ownerId ?? '')
  const [busy, setBusy] = useState(false)

  const owner = agents.find((a) => a.id === ownerId)
  const target = agents.find((a) => a.id === picked)

  // A pick is only a MOVE once it differs from where mail goes today. The
  // unclaimed fallback counts as a difference even when it names the same
  // agent: confirming the default is a real act — it stops being "whichever
  // was created first" and starts being a decision.
  const moved = picked !== '' && (picked !== ownerId || !claimed)

  async function save() {
    if (!target || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(target.id)}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handlesEmail: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'could not move the inbox')
      notifications.show({
        color: 'evergreen',
        message: data.releasedFrom
          ? `Forwarded invoices now go to ${target.name}, not ${data.releasedFrom}.`
          : `Forwarded invoices now go to ${target.name}.`,
      })
      onChanged()
      onClose()
    } catch (e) {
      notifications.show({ color: 'blaze', message: e instanceof Error ? e.message : String(e) })
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>Email inbox</Modal.Header>
      <Modal.Body>
        <Stack gap="lg">
          {address ? (
            <>
              {/* The one thing to ACT on, owning its own row at full width —
                  side by side with the sentence it was squeezed to fit and its
                  own label ran out of room. */}
              <Stack gap={8}>
                <CopyEmailButton address={address} size="sm" fullWidth />
                <Text size="xs" c="dimmed" ta="center">
                  Forward an invoice here from the address you signed in with.
                </Text>
              </Stack>

              <Divider />

              {/* Rows, not a dropdown. A dropdown hides every option but one,
                  and the question being asked here — "who has this?" — is
                  answered by seeing them all at once with the holder marked. */}
              <Stack gap={8}>
                {/* Heading, then the rule under it. "Invoices go to" named the
                    list without saying what choosing one MEANS — that every
                    forwarded invoice is read by exactly one agent, and this
                    picks which. A reader who has to infer the rule from a list
                    of radio buttons is being asked to guess. */}
                <Stack gap={2}>
                  <Text size="sm" fw={500}>
                    Emails are handled by one agent
                  </Text>
                  <Text size="xs" c="dimmed">
                    {claimed
                      ? `Every invoice forwarded to this address is read and drafted by ${owner?.name ?? 'the agent below'} — whichever one is chosen here, for the whole workspace.`
                      : 'Nobody has chosen yet, so mail falls to the first agent. Pick one to make it a decision.'}
                  </Text>
                </Stack>

                <Stack gap={4} role="radiogroup" aria-label="Agent that receives forwarded invoices">
                  {agents.map((a) => {
                    const isPicked = a.id === picked
                    const isOwner = a.id === ownerId
                    return (
                      <UnstyledButton
                        key={a.id}
                        role="radio"
                        aria-checked={isPicked}
                        className={`inbox-row${isPicked ? ' is-picked' : ''}`}
                        onClick={() => setPicked(a.id)}
                      >
                        <span className="inbox-mark" aria-hidden>
                          <IconRobot size={15} />
                        </span>
                        <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                          {a.name}
                        </Text>
                        {isOwner && (
                          <Badge
                            size="sm"
                            variant="light"
                            color={claimed ? 'evergreen' : 'slate'}
                            style={{ flexShrink: 0 }}
                          >
                            {claimed ? 'Receiving' : 'Receiving by default'}
                          </Badge>
                        )}
                      </UnstyledButton>
                    )
                  })}
                </Stack>

                {/* The consequence, stated before it happens. This is the whole
                    confirmation: a second "are you sure?" dialog over a setting
                    you can change back in one click is friction pretending to
                    be safety. */}
                {moved && (
                  <Text size="xs" c="canyon.0" className="rise">
                    {owner && owner.id !== target?.id
                      ? `${target?.name} will receive forwarded invoices. ${owner.name} stops.`
                      : `${target?.name} keeps receiving forwarded invoices — chosen, not inherited.`}{' '}
                    Payments already drafted are unaffected.
                  </Text>
                )}
              </Stack>

              <Divider />

              {/* The explanation lives HERE, not on the card. Three lines read
                  once by whoever is setting this up; the card keeps a sentence. */}
              <Stack gap={10}>
                <Fact icon={IconMailForward} title="Only people who have signed in">
                  Mail from anyone else is ignored — no draft, no reply, nothing. The sending
                  domain is verified, so an address cannot be faked.
                </Fact>
                <Fact icon={IconFileText} title="It reads the invoice">
                  Payee, amount, network and due date, straight out of the PDF.
                </Fact>
                <Fact icon={IconShieldLock} title="Your spend limit still binds">
                  Inside it, the agent pays. Outside it, you get a reply saying so — a forged
                  invoice cannot widen its own limit.
                </Fact>
              </Stack>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              This deployment has no inbound address configured, so forwarded invoices go
              nowhere. Set <b>NEXT_PUBLIC_POSTMARK_INBOUND_ADDRESS</b> to turn it on.
            </Text>
          )}
        </Stack>
      </Modal.Body>
      <Modal.Footer>
        {/* Cancel and Confirm. The button used to name its target — "Confirm
            Invoices", "Move inbox to Payroll" — which on an agent called
            Invoices reads as a verb applied to a noun nobody meant, and made
            the footer change width as you clicked around the list. What is
            about to happen is stated in full above the buttons; the button
            only has to be the yes. */}
        <Group justify="flex-end" gap="sm" wrap="nowrap">
          {/* "default", never "subtle". The design system pins subtle buttons
              to 28px with !important whatever size they are asked for, so a
              subtle Cancel stands 8px shorter than the primary it is paired
              with — a footer whose two buttons do not share a baseline. */}
          <Button size="sm" variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} loading={busy} disabled={!moved}>
            Confirm
          </Button>
        </Group>
      </Modal.Footer>
    </Modal>
  )
}
