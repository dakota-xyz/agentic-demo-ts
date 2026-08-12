'use client'

import { useEffect, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  CopyableText,
  Divider,
  Group,
  LabeledRow,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@/theme/ui'
import {
  IconExternalLink,
  IconPlugConnected,
  IconPlugConnectedX,
  IconRobot,
  IconSettings,
} from '@tabler/icons-react'
import { SlackMark } from './slack-mark'
import { EmailMark } from './email-mark'
import { CopyAddress } from './copy-address'
import { EmailInboxModal, type InboxAgent } from './email-inbox-modal'

// Connect an agent to a Slack channel.
//
// The link is per agent and per channel, because a channel drives exactly one
// agent — routing one message to two would draft the same payment twice.

const SETUP_STEPS = [
  {
    title: 'Create a Slack app',
    body: (
      <Text size="sm" c="dimmed">
        At{' '}
        <Anchor href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" size="sm">
          api.slack.com/apps <IconExternalLink size={12} style={{ verticalAlign: '-1px' }} />
        </Anchor>{' '}
        → <b>From scratch</b>, then pick your workspace.
      </Text>
    ),
  },
  {
    title: 'Add the bot scopes',
    body: (
      <Stack gap={4}>
        <Text size="sm" c="dimmed">
          <b>app_mentions:read</b> · <b>chat:write</b> · <b>channels:history</b> ·{' '}
          <b>channels:read</b> · <b>files:read</b>
        </Text>
        {/* The one people miss, every time. Slack's channels:* scopes cover
            PUBLIC channels only; a private channel is a "group" and needs its
            own pair — which is why a correctly-scoped app still shows an id
            instead of a name. */}
        <Text size="sm" c="dimmed">
          For a <b>private</b> channel add <b>groups:history</b> and <b>groups:read</b> too —
          Slack&apos;s <i>channels:*</i> scopes cover public channels only, and without these the
          card shows the channel id instead of its name.
        </Text>
      </Stack>
    ),
  },
  {
    title: 'Turn Socket Mode OFF, and set the Request URL',
    body: (
      <Text size="sm" c="dimmed">
        Event Subscriptions → paste the Request URL below, and subscribe to bot events{' '}
        <b>app_mention</b> and <b>message.channels</b> — plus <b>message.groups</b> for a private
        channel. With Socket Mode <b>on</b>, Slack stops sending HTTP — the URL verifies and then
        nothing is ever delivered.
      </Text>
    ),
  },
  {
    title: 'Install it, then invite it to the channel',
    body: (
      <Text size="sm" c="dimmed">
        In Slack: <b>/invite @your-bot</b> in the channel it should watch.
      </Text>
    ),
  },
  {
    title: 'Copy the channel ID',
    body: (
      <Text size="sm" c="dimmed">
        Channel name → <b>View channel details</b> → the ID at the bottom, starting <b>C</b>.
      </Text>
    ),
  },
]

export interface SlackLinkView {
  channelId: string
  /** Slack's own name for the channel, when the workspace let us read it. */
  channelName?: string
}

/**
 * The address to forward invoices to.
 *
 * The PLAIN address, deliberately. A `+tag` variant does route to a named agent
 * — Postmark splits it out as MailboxHash — but some mail providers refuse to
 * send to plus-addressed recipients, and an address a visitor's own mail client
 * rejects is worse than useless on a page telling them to use it.
 */
function inbox(): string | null {
  return process.env.NEXT_PUBLIC_POSTMARK_INBOUND_ADDRESS ?? null
}

/**
 * Enough of a URL to recognise it, then stars.
 *
 * Keeps the scheme and the start of the host — which is the only part anyone
 * checks ("yes, that is my deployment") — and drops the rest. Not a secret,
 * just noise: a full endpoint URL is a long line that has to be read before it
 * can be ignored, and this one is copied, never typed.
 */
function maskUrl(url: string): string {
  return `${url.slice(0, 18)}${'*'.repeat(14)}`
}

/**
 * An inbox address with its mailbox hidden and its domain intact.
 *
 * The opposite end from a URL: the recognisable part of an address is the
 * DOMAIN — "@inbound.postmarkapp.com" is what tells you which inbox this is —
 * while the local part is 32 characters of Postmark hash that identify nothing
 * to a human. Masking the first 18 characters, as URLs do, would leave the half
 * nobody can read and hide the half they can.
 */
function maskEmail(addr: string): string {
  const at = addr.indexOf('@')
  if (at < 1) return maskUrl(addr)
  return `${addr.slice(0, 4)}${'*'.repeat(10)}${addr.slice(at)}`
}

export function IntegrationsPanel({
  agentId,
  agentName,
  slack,
  agents,
  emailOwnerId,
  emailClaimed = false,
  onChanged,
}: {
  agentId: string
  agentName: string
  slack?: SlackLinkView
  /** Every agent, because the inbox belongs to the workspace and not to one. */
  agents: InboxAgent[]
  /** The agent forwarded invoices reach today — chosen, or the fallback. */
  emailOwnerId?: string
  /** False when nobody chose and the inbound route is falling back to the first. */
  emailClaimed?: boolean
  onChanged: () => void
}) {
  const address = inbox()
  const [configuring, setConfiguring] = useState(false)

  // Derived here rather than passed in. The caller was computing "does this
  // agent receive?" and "who else does?" as two nested ternaries over the same
  // fallback rule, which is one rule and belongs in one place.
  const handlesEmail = emailOwnerId === agentId
  const owner = agents.find((a) => a.id === emailOwnerId)?.name

  // The channel id is the whole form. The two fields that used to sit under it
  // asked for things nobody needed to supply: Slack's API returns the channel's
  // real name, which is authoritative and beats anything typed here, and the
  // bot answers under its own Slack identity — the "Answers as" value was
  // stored and then never read by anything.
  const [channelId, setChannelId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showSetup, setShowSetup] = useState(false)

  // Slack's current name for the connected channel, asked for once the card is
  // on screen. The stored name is used until it answers, so the sentence never
  // flickers between a name and an id — it either starts with a name or gains
  // one. A channel we cannot name keeps showing its id, which is still enough
  // to find the room.
  const [liveName, setLiveName] = useState<string | null>(null)
  const connectedTo = slack?.channelId

  useEffect(() => {
    if (!connectedTo) return
    let alive = true
    // Every failure path ends in the same place: no live name, and the card
    // falls back to the stored one or says "Not available". A non-ok response
    // is not parsed at all — an error page is HTML, and r.json() on HTML throws
    // for a reason that has nothing to do with the channel.
    fetch(`/api/agents/${agentId}/slack`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { channelName?: string | null; reason?: string } | null) => {
        if (!alive) return
        if (d?.channelName) setLiveName(d.channelName)
        // The response also carries WHY a name is missing. It is not rendered —
        // the row says "Not available" and that is the whole story on screen —
        // but it is there for whoever is debugging with the network tab open.
      })
      .catch(() => {
        // Slack down, endpoint 500, offline: the card keeps whatever name it
        // already had. Nothing here is worth interrupting a working page for.
      })
    return () => {
      alive = false
    }
  }, [agentId, connectedTo])

  const channelLabel = liveName ?? slack?.channelName ?? null

  // The Request URL has to be the origin the browser is actually on — localhost
  // while developing, the deployment once shipped. Hard-coding it would send
  // people to configure a URL that does not serve them.
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  async function connect() {
    if (!channelId.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/agents/${agentId}/slack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'could not connect that channel')
      setChannelId('')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await fetch(`/api/agents/${agentId}/slack`, { method: 'DELETE' })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Side by side, because they are siblings and not steps: two channels an
          agent can be reached on, neither one leading to the other. Stacked,
          the second read as a follow-up to the first — and on a 980px column
          each card was a wide, mostly empty band. One column below md, where
          two would just be two narrow ones. */}
      <SimpleGrid
        cols={{ base: 1, md: 2 }}
        spacing="md"
        pt="xs"
        className="scroll-pane"
        style={{ flex: 1, minHeight: 0, alignContent: 'start' }}
      >
        <Card bg="slate.8" p="lg" withBorder>
          <Stack gap="md">
            {/* Mark, name, state. Nothing else — the header is two columns in
                a half-width card now, and the setup button that used to sit
                here truncated to "How do I set thi" while the badge lost its
                own second word. A control that cannot show its label is not a
                control. */}
            <Group justify="space-between" wrap="nowrap">
              <Group gap={10}>
                <SlackMark size={22} />
                <Text fw={500}>Slack</Text>
              </Group>
              <Badge
                color={slack ? 'evergreen' : 'slate'}
                variant="light"
                style={{ flexShrink: 0 }}
              >
                {slack ? 'Connected' : 'Not connected'}
              </Badge>
            </Group>

            {slack ? (
              /* What it is wired to, in the two names Slack has for it — one you
                 read, one you paste into a config field — each copyable, and the
                 way out underneath. The id is not a fallback for a missing name;
                 it is the identifier every Slack setting asks for, so it is
                 shown even when the name resolves. */
              <Stack gap="sm">
                {/* The row stays whether or not Slack answers. A row that
                    vanishes leaves a card whose shape depends on an API call —
                    two connected channels rendering differently, and no way to
                    tell "no name" from "no such field". "Not available" is a
                    state; a missing row is a mystery. */}
                <LabeledRow label="Channel">
                  {channelLabel ? (
                    <CopyableText value={channelLabel} displayValue={`#${channelLabel}`} size="sm" />
                  ) : (
                    <Text size="sm" c="dimmed">
                      Not available
                    </Text>
                  )}
                </LabeledRow>
                <LabeledRow label="Channel ID">
                  <CopyableText value={slack.channelId} monospace size="sm" />
                </LabeledRow>
                <Divider />
                <Group justify="flex-end">
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconPlugConnectedX size={14} />}
                    onClick={() => void disconnect()}
                    loading={busy}
                  >
                    Disconnect
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Stack gap="sm">
                <TextInput
                  label="Channel ID"
                  description="Starts with C — Slack channel details, at the bottom."
                  placeholder="C01ABCDEFGH"
                  value={channelId}
                  onChange={(e) => setChannelId(e.currentTarget.value)}
                />
                {error && <Alert color="blaze">{error}</Alert>}
                {/* The guide sits WITH the form it explains, where there is room
                    for its whole label. In the header it was a control competing
                    with a state badge for the same corner. */}
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Button
                    onClick={() => void connect()}
                    loading={busy}
                    disabled={!channelId.trim()}
                    leftSection={<IconPlugConnected size={16} />}
                  >
                    Connect
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    style={{ flexShrink: 0 }}
                    onClick={() => setShowSetup(true)}
                  >
                    Setup guide
                  </Button>
                </Group>
              </Stack>
            )}
          </Stack>
        </Card>

        <Card bg="slate.8" p="lg" withBorder>
          <Stack gap="md">
            {/* Same three parts as Slack, in the same places: mark, name, and
                one thing on the right. Configure is the exception to actions
                living at the foot of the card — it is the way IN to a setting,
                not something you do to what is on screen, and the corner is
                where the other card's state sits. */}
            <Group justify="space-between" wrap="nowrap">
              <Group gap={10}>
                <EmailMark size={22} />
                <Text fw={500}>Email</Text>
              </Group>
              {!address && (
                <Badge color="slate" variant="light" style={{ flexShrink: 0 }}>
                  Not configured
                </Badge>
              )}
            </Group>

            {address ? (
              /* Labelled rows, like the channel and its id — the two facts
                 worth knowing about an inbox: where mail lands, and who reads
                 it. The address is masked for the same reason the Request URL
                 is: it is a Postmark hash nobody reads, and the button below
                 hands over the real thing. */
              <Stack gap="sm">
                {/* The copy lives ON the address, the way it lives on the
                    channel id next door — one affordance, on the thing it
                    copies. Masked in place, whole in the clipboard. */}
                <LabeledRow label="Address">
                  <CopyableText
                    value={address}
                    displayValue={maskEmail(address)}
                    monospace
                    size="sm"
                  />
                </LabeledRow>
                {/* "Invoices go to → Invoices" is what this row said on an
                    agent called Invoices: a label and a value that read as the
                    same word, so neither carried information. The label names
                    the RELATION and the glyph names the KIND, so whatever the
                    agent is called the row still says what it is. */}
                <LabeledRow label="Emails handled by">
                  <Group gap={6} wrap="nowrap">
                    <IconRobot size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
                    <Text size="sm" fw={500} truncate>
                      {handlesEmail ? agentName : (owner ?? 'nobody yet')}
                    </Text>
                  </Group>
                </LabeledRow>
                <Divider />
                {/* The foot of the card is where an action goes, and this one
                    takes the exact shape of Disconnect next door: same size,
                    same variant, glyph then label. Two cards side by side
                    should not have two kinds of button in the same corner. */}
                <Group justify="flex-end">
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconSettings size={14} />}
                    onClick={() => setConfiguring(true)}
                  >
                    Configure
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                This deployment has no inbound address configured.
              </Text>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      {configuring && (
        <EmailInboxModal
          address={address}
          agents={agents}
          ownerId={emailOwnerId}
          claimed={emailClaimed}
          onClose={() => setConfiguring(false)}
          onChanged={onChanged}
        />
      )}

      <Modal opened={showSetup} onClose={() => setShowSetup(false)} size="lg">
        <Modal.Header onClose={() => setShowSetup(false)}>Connect Slack</Modal.Header>
        <Modal.Body>
          <Stack gap="lg">
            <Text size="md" c="dimmed">
              A Slack app posts messages into your workspace and forwards mentions here. It
              takes about five minutes, once.
            </Text>

            <Stack gap="md">
              {SETUP_STEPS.map((s, i) => (
                <Group key={s.title} align="flex-start" gap="sm" wrap="nowrap">
                  <span className="step-num">{i + 1}</span>
                  <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                    <Text size="md" fw={500}>
                      {s.title}
                    </Text>
                    {s.body}
                  </Stack>
                </Group>
              ))}
            </Stack>

            <Divider />

            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Your Request URL
              </Text>
              {/* Shown masked, copied whole. Nobody types this URL — it goes
                  from here into a Slack settings field — so the full string is
                  a long line of chrome that has to be read to be ignored. The
                  copy still yields the real endpoint. */}
              <CopyAddress
                address={`${origin}/api/slack/events`}
                display={maskUrl(`${origin}/api/slack/events`)}
              />
              <Text size="xs" c="dimmed">
                Copy it into Event Subscriptions. Slack posts a challenge immediately — if it
                says <b>Verified</b>, the pipe is open.
              </Text>
            </Stack>
          </Stack>
        </Modal.Body>
        <Modal.Footer>
          <Group justify="flex-end">
            <Button onClick={() => setShowSetup(false)}>Done</Button>
          </Group>
        </Modal.Footer>
      </Modal>
    </>
  )
}
