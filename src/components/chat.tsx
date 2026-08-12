'use client'

import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Badge, Button, Card, Group, Kbd, Loader, Paper, Stack, Text, Textarea, Tooltip } from '@/theme/ui'
import { Box } from '@mantine/core'
import { IconArrowUp, IconCheck, IconFingerprint, IconPaperclip, IconX } from '@tabler/icons-react'
import Markdown from 'react-markdown'
import { notifications } from '@mantine/notifications'
import { BrandMark } from './brand-mark'
import { enrollPasskey, signMandate, passkeysAvailable } from '@/lib/passkey'
import { ChatSkeleton } from './chat-skeleton'
import { PlanPreview } from './plan-preview'

// The chat surface.
//
// The agent writes Markdown, so replies render as Markdown — a payment plan
// arrives as a list with amounts in bold, and showing it raw would put literal
// asterisks in front of the one thing the visitor has to read carefully.

interface Turn {
  role: 'user' | 'agent'
  text: string
  /** Set when the agent drafted a reviewable plan on this turn. */
  proposals?: unknown[]
  /** Set once the plan is approved and a limit needs signing. */
  mandateIds?: string[]
  approved?: boolean
  signed?: boolean
}

export function Chat({
  agentId,
  agentName,
  hasPasskey,
  pendingMandateIds = [],
  onChanged,
}: {
  agentId: string
  agentName: string
  hasPasskey: boolean
  /**
   * Limits for this agent that are drafted but unsigned.
   *
   * Passed in rather than remembered, because the ids from an approve live only
   * in this component's state: after a reload the transcript said "sign the
   * spend limit" while the button that does it had vanished, sending people to
   * the Limits tab to finish a job they started here. Pending mandates are the
   * truth, and they self-clear the moment one is signed — wherever it is signed.
   */
  pendingMandateIds?: string[]
  /** Called after approving or signing, so the tab counts and treasury refresh. */
  onChanged?: () => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [enrolled, setEnrolled] = useState(hasPasskey)
  const [acting, setActing] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Restore the transcript. It is persisted per agent, so a reload — or
  // switching agents and back — picks the conversation up where it was left
  // rather than starting over.
  useEffect(() => {
    let cancelled = false
    // The effect re-runs whenever agentId changes, so the spinner has to be reset
    // on every switch. There is no render-time value to derive it from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    fetch(`/api/chat?agentId=${encodeURIComponent(agentId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.messages)) return
        const restored: Turn[] = data.messages.map((m: { role: string; content: string }) => ({
          role: m.role === 'user' ? 'user' : 'agent',
          text: m.content,
        }))
        // A plan drafted but not yet approved belongs on the LAST agent turn,
        // which is the one that drafted it.
        if (data.hasProposals && restored.length) {
          const last = restored[restored.length - 1]
          if (last.role === 'agent') last.proposals = data.proposals
        }
        setTurns(restored)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  // Follow the conversation as it grows. Without this the newest reply lands
  // below the fold and the visitor watches a spinner resolve into nothing.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: turns.length > 40 ? 'auto' : 'smooth' })
  }, [turns, busy])

  /** Read a File as base64 — JSON cannot carry bytes. */
  function toBase64(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      // readAsDataURL gives "data:<type>;base64,<payload>"; only the payload
      // travels.
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = () => reject(new Error('could not read that file'))
      r.readAsDataURL(f)
    })
  }

  async function send() {
    const text = draft.trim()
    // An invoice on its own is a complete request — it says "pay this".
    if ((!text && !file) || busy) return
    const sending = file
    setDraft('')
    setFile(null)
    setError('')
    setTurns((t) => [
      ...t,
      { role: 'user', text: text || `📎 ${sending?.name ?? 'document'}` },
    ])
    setBusy(true)
    try {
      const attachment = sending
        ? {
            mediaType: sending.type || 'application/pdf',
            data: await toBase64(sending),
            filename: sending.name,
          }
        : undefined

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          message: text,
          attachment,
          // The agent resolves "tomorrow" and "10 am" in this zone. Unsent, it
          // would resolve them as UTC and schedule the wrong moment for
          // everyone outside one timezone.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'that turn failed')
      setTurns((t) => [
        ...t,
        { role: 'agent', text: data.reply, proposals: data.hasProposals ? data.proposals : undefined },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Approve a drafted plan: create the payments and the limit that bounds them. */
  async function approve(index: number, proposals: unknown[]) {
    setActing(true)
    setError('')
    try {
      const res = await fetch('/api/proposals/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, proposals }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'could not approve that plan')
      setTurns((t) =>
        t.map((turn, i) =>
          i === index ? { ...turn, approved: true, mandateIds: data.mandateIds } : turn
        )
      )
      if (!data.mandateIds?.length) {
        notifications.show({ color: 'evergreen', message: 'Approved — everything has been created.' })
      }
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActing(false)
    }
  }

  /** Enrol a passkey, then sign the limit. Touch ID is the authorization. */
  async function sign(index: number, mandateIds: string[]) {
    setActing(true)
    setError('')
    try {
      if (!enrolled) {
        await enrollPasskey()
        setEnrolled(true)
      }
      for (const id of mandateIds) {
        await signMandate(id, 'approve')
      }
      setTurns((t) => t.map((turn, i) => (i === index ? { ...turn, signed: true } : turn)))
      notifications.show({
        color: 'evergreen',
        title: 'Signed',
        message: 'The payments are live — they will run without asking again, within this limit.',
      })
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActing(false)
    }
  }

  /**
   * Which limits the sign button on turn `i` should sign.
   *
   * A turn approved in THIS session carries its own ids. A restored transcript
   * carries none, so the last agent turn adopts whatever is still pending —
   * unless it is showing an unapproved plan, where the next step is Approve and
   * offering Sign as well would be two buttons for one decision.
   */
  function signableOn(i: number): string[] {
    const turn = turns[i]
    if (turn?.mandateIds?.length) return turn.mandateIds
    const isLast = i === turns.length - 1
    if (!isLast || turn?.proposals) return []
    return pendingMandateIds
  }

  return (
    <div className="chat-shell">
      <div className="chat-scroll">
        <Stack gap="md" maw={772} mx="auto" w="100%" py="lg" px="lg">
          {loading && <ChatSkeleton />}

          {!loading && turns.length === 0 && (
            <Card bg="slate.8" p="lg" withBorder>
              <Stack gap="xs">
                <Group gap={8}>
                  <BrandMark size={18} />
                  <Text size="sm" fw={500}>
                    {agentName}
                  </Text>
                </Group>
                <Text size="sm" c="dimmed">
                  Tell me what to pay, in plain language. I’ll draft it and show you the
                  details — nothing moves until you approve it with your passkey.
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  Try: <em>pay Acme 25 USDC next Friday</em>
                </Text>
              </Stack>
            </Card>
          )}

          {turns.map((turn, i) => (
            <Group key={i} justify={turn.role === 'user' ? 'flex-end' : 'flex-start'} align="flex-start">
              {turn.role === 'agent' && <BrandMark size={18} />}
              <Paper
                className="msg-bubble"
                bg={turn.role === 'user' ? 'sierra.7' : 'slate.8'}
                p="sm"
                radius="md"
                maw="80%"
              >
                {turn.role === 'agent' ? (
                  <Stack gap="sm">
                    <Box className="msg-prose">
                      <Markdown>{turn.text}</Markdown>
                    </Box>

                    {/* The approval beat. A drafted plan is inert until this is
                        pressed, and still inert until the limit is signed —
                        two distinct steps, because approving is a decision and
                        signing is an authorization. */}
                    {turn.proposals && !turn.approved && (
                      <>
                        {/* The prose above describes the plan; THIS is the
                            plan. They can differ, and an offramp is exactly
                            where — "pay the invoice" reads the same whether
                            the money stays in crypto or lands in a bank. */}
                        <PlanPreview plan={turn.proposals} />
                        <Button
                          size="xs"
                          loading={acting}
                          onClick={() => void approve(i, turn.proposals!)}
                          leftSection={<IconCheck size={14} />}
                        >
                          Review &amp; approve
                        </Button>
                      </>
                    )}

                    {signableOn(i).length > 0 && !turn.signed && (
                      <Stack gap={6}>
                        <Text size="xs" c="dimmed">
                          {enrolled
                            ? 'Sign the spend limit to activate these payments.'
                            : 'Create a passkey and sign the spend limit to activate these payments.'}
                        </Text>
                        <Button
                          size="xs"
                          color="canyon"
                          loading={acting}
                          disabled={!passkeysAvailable()}
                          onClick={() => void sign(i, signableOn(i))}
                          leftSection={<IconFingerprint size={14} />}
                        >
                          {enrolled ? 'Sign with passkey' : 'Create passkey & sign'}
                        </Button>
                      </Stack>
                    )}

                    {turn.signed && (
                      <Text size="xs" c="evergreen.2">
                        ✅ Signed — the payments are live.
                      </Text>
                    )}
                  </Stack>
                ) : (
                  <Text size="sm">{turn.text}</Text>
                )}
              </Paper>
            </Group>
          ))}

          {busy && (
            <Group gap={8}>
              <BrandMark size={18} />
              <Loader size="xs" color="sierra" />
              <Text size="sm" c="dimmed">
                Thinking…
              </Text>
            </Group>
          )}
          <div ref={endRef} />
        </Stack>
      </div>

      {/* The composer sits INSIDE the shell, with the text area on its own row
          and the controls beneath — so a long instruction wraps naturally
          instead of being squeezed into a slot between two icons. */}
      <Stack gap={6} px="lg" pb="sm" pt={4} maw={772} mx="auto" w="100%">
        {error && <Alert color="blaze">{error}</Alert>}
        {file && (
          <Badge
            color="sierra"
            variant="light"
            leftSection={<IconPaperclip size={12} />}
            rightSection={
              <ActionIcon
                size="xs"
                variant="transparent"
                onClick={() => setFile(null)}
                aria-label="Remove attachment"
              >
                <IconX size={11} />
              </ActionIcon>
            }
            style={{ alignSelf: 'flex-start' }}
          >
            {file.name}
          </Badge>
        )}
        <div className="composer">
          <div className="composer-input">
            <Textarea
              autosize
              minRows={1}
              maxRows={10}
              size="md"
              variant="unstyled"
              placeholder={`Tell ${agentName} what to pay…`}
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — a chat composer,
                // not a form field.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
          </div>
          <div className="composer-controls">
            <Tooltip label="Attach an invoice (PDF or image)" withArrow>
              <ActionIcon
                variant="subtle"
                size="md"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach an invoice"
              >
                <IconPaperclip size={17} />
              </ActionIcon>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                setFile(e.currentTarget.files?.[0] ?? null)
                // Cleared so picking the SAME file twice still fires onChange.
                e.currentTarget.value = ''
              }}
            />
            <Group gap={6} ml="auto" wrap="nowrap" align="center">
              <Text size="xs" c="dimmed">
                <Kbd>Enter</Kbd> to send
              </Text>
              <ActionIcon
                size="lg"
                radius="xl"
                onClick={() => void send()}
                disabled={(!draft.trim() && !file) || busy}
                aria-label="Send"
              >
                <IconArrowUp size={18} />
              </ActionIcon>
            </Group>
          </div>
        </div>
        <Text size="xs" c="dimmed" ta="center">
          The agent drafts; nothing moves until you approve with your passkey.
        </Text>
      </Stack>
    </div>
  )
}
