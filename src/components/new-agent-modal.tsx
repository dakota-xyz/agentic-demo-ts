'use client'

import { useState } from 'react'
import { UnstyledButton } from '@mantine/core'
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '@/theme/ui'
import { IconLock } from '@tabler/icons-react'
import { LIMIT_CURRENCY } from '@/lib/money'

// Copied from the Go build so the modal is the same object, not a lookalike:
// Dakota's Modal is composed (Modal.Header / Body / Footer), which is why a
// Mantine-style `title` prop rendered nothing like it.

// Names that show what an agent is FOR. A visitor who has never seen an agentic
// payment does not know what to call one, and "Agent 1" teaches them nothing
// about why they might want a second.
const SUGGESTIONS = ['Accounts payable', 'Payroll', 'Subscriptions']

const WINDOWS = [
  { value: 'DAILY', label: 'per day' },
  { value: 'WEEKLY', label: 'per week' },
  { value: 'MONTHLY', label: 'per month' },
  { value: 'NONE', label: 'in total, ever' },
]

export function NewAgentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (agentId: string, name: string) => void
}) {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [window, setWindow] = useState('MONTHLY')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const windowLabel = WINDOWS.find((w) => w.value === window)?.label ?? ''
  const ready = Boolean(name.trim() && amount.trim() && Number(amount) > 0)

  /**
   * Create the agent AND the limit that makes it useful.
   *
   * Two platform calls, because a mandate binds to a payment_agent_id that does
   * not exist until the agent does — but one decision, because an agent with no
   * limit cannot pay anyone. Splitting them across two screens produced an
   * object whose only possible next step was the step we had not asked for.
   */
  const create = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'could not create that agent')

      // The agent exists either way. A limit that fails to create is worth
      // reporting, but not worth discarding the agent over — the Limits tab
      // can set one, and pretending the agent was never made would be a lie.
      const limit = await fetch(`/api/agents/${encodeURIComponent(data.id)}/limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amount.trim(), window }),
      })
      if (!limit.ok) {
        const why = await limit.json().catch(() => ({}))
        console.warn('[agent] limit not created', why)
      }

      onCreated(data.id, data.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} size="lg">
      <Modal.Header onClose={onClose}>New agent</Modal.Header>
      <Modal.Body>
        {/* No preamble. The two questions below — what to call it, how much it
            may spend — teach what an agent is by asking for it; a sentence
            above them explaining the concept is read by nobody who is already
            typing a name. */}
        <Stack gap="lg">
          <Stack gap="sm">
            <Text size="lg" fw={500} component="label" htmlFor="agent-name">
              Name your agent
            </Text>
            <TextInput
              id="agent-name"
              autoFocus
              size="md"
              placeholder="Accounts payable"
              value={name}
              error={error || undefined}
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            {/* Labelled, because an unlabelled row of pills under a text field
                is ambiguous — filters? tags? things already chosen? One word
                settles it, and it lets the chips shrink out of the field's way
                without becoming mystery furniture. */}
            <Group gap={8} align="center">
              <Text size="xs" c="dimmed" id="agent-name-suggestions">
                Suggestions
              </Text>
              <Group gap={6} role="group" aria-labelledby="agent-name-suggestions">
                {SUGGESTIONS.map((s) => (
                  <UnstyledButton key={s} className="suggest" onClick={() => setName(s)}>
                    {s}
                  </UnstyledButton>
                ))}
              </Group>
            </Group>
          </Stack>

          {/* Asked HERE rather than on a later screen, because an agent with no
              limit cannot pay anyone — creating one without this makes an object
              whose only possible next step is the step we did not ask for. */}
          <Stack gap="sm">
            <Text size="lg" fw={500}>
              How much may it spend?
            </Text>
            <Group grow align="flex-start">
              <TextInput
                size="md"
                placeholder="10.00"
                value={amount}
                onChange={(e) => setAmount(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
                rightSection={
                  <Text size="xs" c="dimmed" pr={6}>
                    {LIMIT_CURRENCY}
                  </Text>
                }
              />
              <Select
                size="md"
                data={WINDOWS}
                value={window}
                onChange={(v) => setWindow(v ?? 'MONTHLY')}
                allowDeselect={false}
              />
            </Group>
            {/* Read back as a sentence. Signing something you cannot restate is
                the failure this guards against, and the signature comes next. */}
            {amount.trim() && (
              <Text size="sm" c="dimmed">
                {name.trim() || 'This agent'} may spend up to{' '}
                <b>
                  {amount} {LIMIT_CURRENCY} {windowLabel}
                </b>
                , and never more.
              </Text>
            )}
          </Stack>

          {/* The question everyone actually has, answered next to the button. */}
          <Group gap="sm" wrap="nowrap" align="center" className="reassure">
            <IconLock size={17} style={{ flexShrink: 0 }} />
            <Text size="sm">
              Nothing moves until you sign this limit with your passkey — that is the next step.
            </Text>
          </Group>
        </Stack>
      </Modal.Body>
      <Modal.Footer>
        <Group justify="flex-end" gap="sm" align="center" wrap="nowrap">
          <Button size="sm" variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={create} loading={busy} disabled={!ready}>
            Create agent
          </Button>
        </Group>
      </Modal.Footer>
    </Modal>
  )
}
