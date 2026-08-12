'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActionIcon,
  AppHeader,
  AppLayout,
  AppNavbar,
  Center,
  Divider,
  Button,
  Group,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@/theme/ui'
import { Popover } from '@mantine/core'
import { signOut } from 'next-auth/react'
import { useDisclosure } from '@mantine/hooks'
import {
  IconArrowsExchange,
  IconBulb,
  IconUsersGroup,
  IconCoins,
  IconLogout,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react'
import { SegmentedTabs } from './segmented-tabs'
import { Chat } from './chat'
import { SpendLimitsPanel } from './panel-limits'
import { ScheduledPanel, ActivityPanel } from './panel-payments'
import { IntegrationsPanel } from './panel-integrations'
import { NewAgentModal } from './new-agent-modal'
import { PayeesPanel } from './panel-payees'
import { InsightsPanel } from './panel-insights'
import { AutoAccountsPanel } from './panel-auto-accounts'
import { TeamPanel } from './panel-team'
import { DeleteAgentModal } from './delete-agent-modal'
import { PaymentDetail } from './payment-detail'
import { FundModal } from './fund-modal'
import { ChainIcon, chainLabel } from './chain-icon'
import { CopyAddress, shortAddr } from './copy-address'

// The signed-in workspace, matching the Go build: an agent rail on the left, a
// header carrying the agent name + tabs + treasury, and one agent's tabs below.
//
// The scoping is the point. Everything under the tabs belongs to ONE agent,
// while the treasury sits in the header because wallets are provisioned per
// VISITOR — every agent draws from the same ones. Putting the balance inside a
// chat implied it belonged to that agent, which it never did.

export interface AgentSummary {
  id: string
  name: string
  slack?: SlackLinkView
  /** This agent receives forwarded invoices. At most one does. */
  handlesEmail?: boolean
}

export interface WalletView {
  id: string
  address: string
  network: string
  /** Pre-summed by the platform — do not re-derive it from the assets. */
  totalUsd?: string
  balances?: { asset?: string; name?: string; network?: string; amountUsd?: string }[]
  error?: string
}

interface MandateRow {
  id: string
  status?: string
  agentId?: string
  target_names?: string[]
  rule?: Record<string, unknown>
}

interface SlackLinkView {
  channelId: string
  channelName?: string
}

interface PaymentRow {
  id?: string
  status?: string
  amount?: string
  agentId?: string
  scheduled_at?: number
}

const FINAL_STATES = new Set(['executed', 'failed', 'cancelled'])

/**
 * A view that is taller than the window and scrolls the shell.
 *
 * `flexShrink: 0` is the load-bearing part, and it is not a nicety. AppShell's
 * main is `display:flex; flex-direction:column; overflow:auto`, so a view
 * dropped into it is a flex CHILD and shrinks by default: its box gets squeezed
 * to the window's height while its content carries on past the bottom of it.
 * Measured on Insights, the box was 830px around 1636px of content.
 *
 * Everything about that is invisible until you ask for trailing space, and then
 * it eats it — `pb` lands inside the squeezed box, a third of the way up the
 * content, and the last card still ends flush against the viewport edge. This
 * cost two wrong fixes: `pb` alone (applied, computed, and doing nothing) and a
 * theory about flex containers dropping their own bottom padding, which main
 * does not even have — its padding-bottom is 0.
 *
 * Refusing to shrink makes the box its content's real height, and `pb` is then
 * ordinary space at the end of the scroll.
 */
const scrolls = {
  gap: 'sm',
  maw: 980,
  mx: 'auto',
  w: '100%',
  style: { minHeight: 0, flexShrink: 0 },
} as const

export function Workspace({
  user,
  initialAgents,
  hasPasskey,
}: {
  user: { name: string; email: string; domain: string; picture?: string }
  initialAgents: AgentSummary[]
  hasPasskey: boolean
}) {
  const [agents, setAgents] = useState(initialAgents)

  // Whether this PERSON has a passkey — one per person, reused by every agent.
  //
  // Seeded from the server render and then kept current, because it was a frozen
  // prop: after enrolling, it still said false for the rest of the session, so
  // switching agents remounted the limits panel and the button went back to
  // "Create passkey & sign". Read literally, that says every agent needs its
  // own key. It does not; the button was just describing stale state.
  const [enrolled, setEnrolled] = useState(hasPasskey)
  const [selected, setSelected] = useState<string | null>(initialAgents[0]?.id ?? null)
  const [tab, setTab] = useState('chat')
  // Payees, Insights and Auto-accounts are ACCOUNT-scoped: agents share one
  // treasury and one set of payees, so none of them belongs inside a single
  // agent's tabs.
  const [view, setView] = useState<'agent' | 'payees' | 'insights' | 'auto' | 'team'>('agent')
  const [modalOpen, modal] = useDisclosure(false)

  /** A payment named by a deep link, opened once the agent list has loaded. */
  const [openPayment, setOpenPayment] = useState<string | null>(null)

  const [wallets, setWallets] = useState<WalletView[]>([])
  const [limits, setLimits] = useState<MandateRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])

  // Derived, not stored. `selected` starts from the server-rendered list, so
  // anything that arrives afterwards — the client fetch, a newly created agent
  // — would otherwise leave nothing chosen until someone clicks. Falling back
  // to the first agent at RENDER does that without a second pass, and without
  // a state write that fights whatever the visitor picks next.
  const active = agents.find((a) => a.id === selected) ?? agents[0] ?? null

  const refresh = useCallback(async () => {
    // Failures are left to the panels to report. The header must not blank
    // itself because one list is briefly unavailable.
    const [w, m, p] = await Promise.allSettled([
      fetch('/api/treasury').then((r) => r.json()),
      fetch('/api/mandates').then((r) => r.json()),
      fetch('/api/scheduled').then((r) => r.json()),
    ])
    // Agents are re-read as well: connecting Slack changes an agent, and
    // without this the Integrations tab keeps rendering the pre-connect state.
    try {
      const me = await fetch('/api/me').then((r) => r.json())
      if (typeof me.passkey === 'boolean') setEnrolled(me.passkey)
      if (Array.isArray(me.agents)) {
        setAgents(
          me.agents.map(
            (a: { id: string; name: string; slack?: SlackLinkView; handlesEmail?: boolean }) => ({
              id: a.id,
              name: a.name,
              slack: a.slack,
              handlesEmail: a.handlesEmail,
            })
          )
        )
      }
    } catch {
      // Leave the current list rather than blanking the rail on one bad fetch.
    }
    if (w.status === 'fulfilled') setWallets(w.value.wallets ?? [])
    if (m.status === 'fulfilled') setLimits(m.value.mandates ?? [])
    if (p.status === 'fulfilled') setPayments(p.value.payments ?? [])
  }, [])

  useEffect(() => {
    // refresh() sets state before its first await — the rail's fetch on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // Land on the agent a link names, then fall back to the first one.
  //
  // Slack's "Review & approve →" and "Sign it →" point at /?agent=<id>&tab=limits,
  // and nothing read those — so following a link from a channel dropped you on
  // whatever happened to be selected, which is the wrong conversation to be
  // approving a payment in.
  //
  useEffect(() => {
    if (agents.length === 0) return
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('agent')
    const tabWanted = params.get('tab')
    const paymentWanted = params.get('payment')

    if (wanted && agents.some((a) => a.id === wanted)) {
      // Mirrors the URL — external state — onto the selection, and can only run once
      // the agents it names have arrived.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(wanted)
      setView('agent')
      if (tabWanted) setTab(tabWanted)
      // Opens the detail drawer straight onto the payment the link names, so a
      // settlement announcement lands on the answer rather than near it.
      if (paymentWanted) setOpenPayment(paymentWanted)
      // Consume them, so a later reload does not yank the visitor back to a
      // payment they have already dealt with.
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [agents])

  // Counts ride inside the tabs, so the nav carries state instead of making you
  // open each one to find out.
  const counts = useMemo(() => {
    const mine = limits.filter((m) => m.agentId === selected)
    const minePayments = payments.filter((p) => p.agentId === selected)
    return {
      limits: mine.length,
      pending: mine.filter((m) => m.status === 'pending').length,
      upcoming: minePayments.filter((p) => !FINAL_STATES.has(p.status ?? '')).length,
      done: minePayments.filter((p) => FINAL_STATES.has(p.status ?? '')).length,
    }
  }, [limits, payments, selected])

  const tabs = [
    { value: 'chat', label: 'Chat' },
    { value: 'limits', label: 'Limits', count: counts.limits, alert: counts.pending > 0 },
    { value: 'scheduled', label: 'Scheduled', count: counts.upcoming },
    { value: 'activity', label: 'Activity', count: counts.done },
    { value: 'integrations', label: 'Integrations' },
  ]

  /** The agent whose revoke dialog is open. */
  const [revoking, setRevoking] = useState<AgentSummary | null>(null)

  // Who receives forwarded invoices — the ONE place this rule is expressed.
  //
  // Nobody claimed ⇒ the first agent receives, matching the inbound route's own
  // fallback (api/email/inbound). `claimed` keeps that distinction visible: the
  // UI must not present an accident of creation order as a decision, and the
  // dialog offers to make it one.
  const emailClaimed = agents.some((a) => a.handlesEmail)
  const emailOwnerId = (agents.find((a) => a.handlesEmail) ?? agents[0])?.id


  const [navOpen, setNavOpen] = useState(true)

  return (
    <AppLayout
      opened={navOpen}
      header={
        <AppHeader
          opened={navOpen}
          toggle={() => setNavOpen((o) => !o)}
          left={
            active && view === 'agent' ? (
              <Group className="agent-bar" gap="lg" wrap="nowrap">
                <Text size="lg" fw={500} truncate style={{ maxWidth: 200 }}>
                  {active.name}
                </Text>
                <SegmentedTabs items={tabs} value={tab} onChange={setTab} />
              </Group>
            ) : null
          }
          right={
            <Group gap="sm" wrap="nowrap">
              {/* Insights moved out of the rail and into the chrome, beside the
                  treasury it reports on. The rail lists things you WORK in —
                  agents, payees, the team; this is a read-only look at the
                  account, which is what the header already holds.
                  A bubble that always carries its name — nothing here has to be
                  hovered to be understood. The motion is the glyph's alone. */}
              <UnstyledButton
                className={`topbar-bubble${view === 'insights' ? ' is-active' : ''}`}
                onClick={() => setView('insights')}
              >
                <IconBulb size={16} />
                Insights
              </UnstyledButton>
              <TreasuryMenu wallets={wallets} onRefresh={refresh} />
            </Group>
          }
        />
      }
      navbar={
        <AppNavbar
          top={
            <Stack gap="md">
              {/* The wordmark, self-hosted: a demo that shows someone else's
                  asset host in its network tab has a dependency it did not
                  need. next/image would buy nothing here — the file is 2.4kB
                  and its size is fixed. */}
              {/* And it goes home. A wordmark in the top-left of an app is a
                  button everywhere else on the web, so it gets clicked here
                  whether or not it does anything — and it did nothing, which
                  reads as the app being stuck rather than the mark being inert.
                  Home is the state the app opens in: the first agent, in chat. */}
              <UnstyledButton
                className="rail-logo-btn"
                aria-label="Back to the first agent"
                onClick={() => {
                  setView('agent')
                  setSelected(agents[0]?.id ?? null)
                  setTab('chat')
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/dakota-logo.png" alt="Dakota" className="rail-logo" />
              </UnstyledButton>
              {/* A rule under the mark. Whose product this is and what is IN it
                  are two different registers, and without a line between them
                  the wordmark reads as the first item in the list. */}
              <Divider color="var(--mantine-color-slate-7)" />
              {/* Making an agent is the FIRST thing, so it is the first row —
                  a full-width action rather than a 15px plus tucked beside a
                  heading. The old control was the same size as the heading's
                  own descender and read as decoration on it. */}
              <UnstyledButton className="rail-new" onClick={modal.open}>
                <span className="rail-new-plus" aria-hidden>
                  <IconPlus size={14} />
                </span>
                <Text size="sm">New agent</Text>
              </UnstyledButton>
            </Stack>
          }
          items={
            <Stack gap={2}>
              {/* A label over the list, not a heading with a control in it.
                  It names what these rows ARE — the rail holds other things
                  below — and stays quiet enough that the names read first. */}
              <Text className="rail-label">Agents</Text>
              {/* A div, not a button. The row holds its own button for the
                  name and another for the trash, and a button inside a button
                  is invalid — browsers drop one of them, usually the one you
                  wanted. */}
              {agents.map((a) => (
                <div
                  key={a.id}
                  className={`rail-row${view === 'agent' && a.id === selected ? ' is-active' : ''}`}
                >
                  <IconRobot size={16} className="rail-icon" />
                  {/* rail-row-hit stretches this button's hit area over the
                      whole row. Without it the target is the text and nothing
                      else — not the row's own padding, not the glyph — so the
                      top and bottom few pixels of a row that visibly highlights
                      under the cursor do not respond to a click. */}
                  <UnstyledButton
                    className="rail-row-hit"
                    style={{ flex: 1, minWidth: 0, textAlign: 'left' }}
                    onClick={() => {
                      setSelected(a.id)
                      setTab('chat')
                      setView('agent')
                    }}
                  >
                    <Text size="sm" truncate>
                      {a.name}
                    </Text>
                  </UnstyledButton>
                  {/* A name and, on hover, the way to revoke it. Nothing else:
                      a status light nobody can decode is worse than no status
                      light, and the pending-signature count already sits on the
                      Limits tab where the signing happens. */}
                  <Tooltip label={`Revoke ${a.name}`} withArrow>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      className="rail-row-action rail-row-danger"
                      aria-label={`Revoke ${a.name}`}
                      onClick={(e) => {
                        // The row behind this selects an agent; revoking one is
                        // not selecting it.
                        e.stopPropagation()
                        setRevoking(a)
                      }}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </div>
              ))}
            </Stack>
          }
          bottom={
            <Stack gap={4}>
              <UnstyledButton
                className={`rail-row${view === 'payees' ? ' is-active' : ''}`}
                onClick={() => setView('payees')}
              >
                <IconUsers size={16} className="rail-icon" />
                <Text size="sm">Payees</Text>
              </UnstyledButton>
              <UnstyledButton
                className={`rail-row${view === 'auto' ? ' is-active' : ''}`}
                onClick={() => setView('auto')}
              >
                <IconArrowsExchange size={16} className="rail-icon" />
                <Text size="sm">Auto-accounts</Text>
              </UnstyledButton>
              <UnstyledButton
                className={`rail-row${view === 'team' ? ' is-active' : ''}`}
                onClick={() => setView('team')}
              >
                <IconUsersGroup size={16} className="rail-icon" />
                <Text size="sm">Team</Text>
              </UnstyledButton>
              <Divider my={4} />
              <Text size="sm" c="dimmed" truncate px={4}>
                {user.email}
              </Text>
              <UnstyledButton className="rail-row" onClick={() => void signOut()}>
                <IconLogout size={16} className="rail-icon" />
                <Text size="sm">Sign out</Text>
              </UnstyledButton>
            </Stack>
          }
        />
      }
    >
        {view === 'payees' ? (
          <Stack gap="sm" maw={980} mx="auto" w="100%" h="100%" style={{ minHeight: 0 }}>
            <Text size="lg" fw={500}>
              Payees
            </Text>
            <PayeesPanel />
          </Stack>
        ) : view === 'insights' ? (
          <Stack {...scrolls} pb="xl">
            <Text size="lg" fw={500}>
              Insights
            </Text>
            <InsightsPanel />
          </Stack>
        ) : view === 'auto' ? (
          <Stack {...scrolls} pb="xl">
            <Text size="lg" fw={500}>
              Auto-accounts
            </Text>
            <Text size="sm" c="dimmed" maw={640}>
              One-off convert-and-forward accounts. When a plan needs an asset or a rail your
              treasury does not hold, the payment goes to one of these and it converts and forwards
              from there — to a bank, or to another chain.
            </Text>
            <AutoAccountsPanel />
          </Stack>
        ) : view === 'team' ? (
          <Stack {...scrolls} pb="xl">
            <Text size="lg" fw={500}>
              Team
            </Text>
            <TeamPanel signedInAs={user.email} />
          </Stack>
        ) : !active ? (
          <Center h="calc(100vh - 88px)">
            <Stack gap="md" align="center" maw={420} ta="center">
              <Text fz={40} lh={1}>
                ◈
              </Text>
              <Text fw={500} size="lg">
                Name your first agent
              </Text>
              <Text size="sm" c="dimmed">
                An agent is who you talk to. Give it a name — “Accounts payable”, “Ops” —
                then tell it what to pay.
              </Text>
              <Button onClick={modal.open}>New agent</Button>
            </Stack>
          </Center>
        ) : (
          <Stack gap="sm" maw={980} mx="auto" w="100%" h="100%" style={{ minHeight: 0 }}>
            {tab === 'chat' && (
              <Chat
                key={active.id}
                agentId={active.id}
                agentName={active.name}
                hasPasskey={enrolled}
                // So the sign button survives a reload — see Chat's prop docs.
                pendingMandateIds={limits
                  .filter((m) => m.agentId === active.id && m.status === 'pending')
                  .map((m) => m.id)}
                onChanged={refresh}
              />
            )}
            {tab === 'limits' && (
              <SpendLimitsPanel
                agentId={active.id}
                agentName={active.name}
                limits={limits.filter((m) => m.agentId === active.id)}
                hasPasskey={enrolled}
                onChanged={refresh}
              />
            )}
            {tab === 'scheduled' && (
              <ScheduledPanel payments={payments.filter((p) => p.agentId === active.id)} />
            )}
            {tab === 'activity' && (
              <ActivityPanel payments={payments.filter((p) => p.agentId === active.id)} />
            )}
            {tab === 'integrations' && (
              <IntegrationsPanel
                agentId={active.id}
                agentName={active.name}
                slack={active.slack}
                agents={agents.map((a) => ({ id: a.id, name: a.name }))}
                emailOwnerId={emailOwnerId}
                emailClaimed={emailClaimed}
                onChanged={refresh}
              />
            )}
          </Stack>
        )}

        {/* Opened by a deep link from a Slack settlement. Rendered here rather
            than inside the Activity table because the link should work whether
            or not that table has finished loading the row. */}
        <PaymentDetail paymentId={openPayment} onClose={() => setOpenPayment(null)} />

        {revoking && (
          <DeleteAgentModal
            agentId={revoking.id}
            agentName={revoking.name}
            scheduledCount={
              payments.filter((p) => p.agentId === revoking.id && !FINAL_STATES.has(p.status ?? ''))
                .length
            }
            onClose={() => setRevoking(null)}
            onDeleted={() => {
              setAgents((list) => list.filter((x) => x.id !== revoking.id))
              setTab('chat')
              void refresh()
            }}
          />
        )}

      {modalOpen && (
        <NewAgentModal
          onClose={modal.close}
          onCreated={(id, name) => {
            setAgents((a) => [...a, { id, name }])
            setSelected(id)
            setTab('chat')
            modal.close()
            void refresh()
          }}
        />
      )}
    </AppLayout>
  )
}

/**
 * TreasuryMenu is the balance, in the app header.
 *
 * It used to be a full-width card at the top of every chat, which was wrong
 * twice over: it ate the space the conversation needed, and it implied the
 * treasury belongs to the agent. It does not — wallets are provisioned per
 * VISITOR, and every agent draws from the same ones. Header is where
 * account-wide state belongs.
 */
function TreasuryMenu({ wallets, onRefresh }: { wallets: WalletView[]; onRefresh: () => void }) {
  const [funding, setFunding] = useState(false)

  // Read from the public env rather than guessed: NEXT_PUBLIC_DEMO_TEST_FUNDS
  // is set on deployments where a faucet actually exists.
  const testFundsAvailable = process.env.NEXT_PUBLIC_DEMO_TEST_FUNDS === 'true'
  const [spinning, setSpinning] = useState(false)

  // Refreshing a balance usually changes nothing on screen — the number was
  // already right — so without a visible response the click feels ignored. The
  // spin IS the receipt.
  const refresh = () => {
    setSpinning(true)
    onRefresh()
  }

  // total_amount_usd comes straight from the platform; summing the assets
  // ourselves would drift the moment one is priced in something else.
  const walletTotal = (w: WalletView) => parseFloat(w.totalUsd ?? '0') || 0
  const total = wallets.reduce((s, w) => s + walletTotal(w), 0)
  const empty = total === 0 && wallets.length > 0

  return (
    <Popover width={400} position="bottom-end" withArrow shadow="md">
      <div className="treasury-group">
        <Popover.Target>
          <UnstyledButton className="treasury-chip">
            <Text size="sm" c="dimmed">
              Treasury
            </Text>
            <Text size="sm" fw={500} style={{ fontVariantNumeric: 'tabular-nums' }}>
              ${total.toFixed(2)}
            </Text>
            {empty && <span className="treasury-alert" aria-label="needs funding" />}
          </UnstyledButton>
        </Popover.Target>
        <Tooltip label="Refresh balances" withArrow>
          <ActionIcon
            className={`treasury-refresh${spinning ? ' is-spinning' : ''}`}
            variant="subtle"
            size="md"
            onClick={refresh}
            onAnimationEnd={() => setSpinning(false)}
            aria-label="Refresh balances"
          >
            <IconRefresh size={15} />
          </ActionIcon>
        </Tooltip>
      </div>

      <Popover.Dropdown p="md">
        <Stack gap="sm">
          <Text size="sm" fw={500}>
            Treasury wallets
          </Text>

          {wallets.length === 0 ? (
            <Text size="sm" c="dimmed">
              Provisioning your wallets…
            </Text>
          ) : (
            // One line per wallet: chain, address and copy together, balance
            // right. Stacking the chain above the address made two rows out of
            // one fact and left the balance floating beside neither.
            wallets.map((w) => (
              <Group key={w.id} justify="space-between" wrap="nowrap" gap="sm">
                <Group gap={7} wrap="nowrap" style={{ minWidth: 0 }}>
                  <ChainIcon family={w.network} size={16} />
                  <Text size="sm" c="dimmed" style={{ width: 44, flexShrink: 0 }}>
                    {chainLabel(w.network)}
                  </Text>
                  <CopyAddress address={w.address} display={shortAddr(w.address)} />
                </Group>
                <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  ${walletTotal(w).toFixed(2)}
                </Text>
              </Group>
            ))
          )}

          {/* Sandbox only. The faucet it opens issues TEST funds, so on a
              deployment pointed at the real platform the button is an offer we
              cannot keep — and "add test funds" sitting above a treasury
              holding real money is worse than merely useless. */}
          {testFundsAvailable && (
            <>
              <Divider />
              <Button fullWidth onClick={() => setFunding(true)} leftSection={<IconCoins size={16} />}>
                Add test funds
              </Button>
            </>
          )}
        </Stack>
      </Popover.Dropdown>

      {funding && testFundsAvailable && (
        <FundModal wallets={wallets} onClose={() => setFunding(false)} />
      )}
    </Popover>
  )
}
