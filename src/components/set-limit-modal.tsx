'use client'

import { useState } from 'react'
import { Button, Group, Modal, Select, Stack, Text, TextInput } from '@/theme/ui'
import { notifications } from '@mantine/notifications'
import { LIMIT_CURRENCY } from '@/lib/money'

// Granting an agent its standing authority.
//
// Everything else in this app drafts a limit as a side effect of asking for a
// payment. This is the other direction: decide up front how much the agent may
// spend, sign it once, and let it work inside that. The agent never has to ask
// again, and nothing it proposes can exceed what is set here.
//
// The form is deliberately two fields. A limit that takes a page to express is
// one nobody will read back before signing, and this is the single screen where
// the visitor is deciding how much money a machine may move without them.
//
// Which stablecoin, on which chain, is NOT asked. That is a fact about how this
// deployment is plumbed and the person setting a limit has no basis to choose
// it — putting "Ethereum Sepolia" on this screen makes it about our
// infrastructure rather than their money. See lib/money.

const WINDOWS = [
  { value: 'DAILY', label: 'per day' },
  { value: 'WEEKLY', label: 'per week' },
  { value: 'MONTHLY', label: 'per month' },
  { value: 'NONE', label: 'in total, ever' },
]

export function SetLimitModal({
  agentId,
  agentName,
  existing = [],
  onClose,
  onCreated,
}: {
  agentId: string
  agentName: string
  /** Limits already signed and in force, in plain English. */
  existing?: string[]
  onClose: () => void
  onCreated: () => void
}) {
  const [amount, setAmount] = useState('')
  const [window, setWindow] = useState('MONTHLY')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const windowLabel = WINDOWS.find((w) => w.value === window)?.label ?? ''

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amount.trim(), window }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'could not create that limit')
      notifications.show({
        color: 'canyon',
        title: 'Limit created',
        message:
          existing.length > 0
            ? 'Sign it to make it the only limit — the previous one is revoked as you do.'
            : 'Sign it with your passkey to give the agent this authority.',
      })
      onCreated()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>Set a spend limit</Modal.Header>
      <Modal.Body>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            How much <b>{agentName}</b> may spend without asking you again. It can never exceed
            this, whatever it is told to do.
          </Text>

          {/* Limits ADD UP — they do not replace each other.
              A new one does not narrow an old one, so an agent with a 5/month
              limit and a 500/week limit can spend 500 a week. That is the
              opposite of what someone setting a smaller limit expects, and the
              platform cannot revoke the old one on its own: revoking is a
              signature, which only this person can produce. So the choice is
              named here, before the second one exists. */}
          {existing.length > 0 && (
            <Stack gap={4} p="sm" style={{ background: 'var(--mantine-color-canyon-7)', borderRadius: 8 }}>
              <Text size="sm" fw={500} c="canyon.0">
                {agentName} already has {existing.length === 1 ? 'a limit' : `${existing.length} limits`} in force
              </Text>
              {existing.map((line, i) => (
                <Text key={i} size="xs" c="canyon.0">
                  {line}
                </Text>
              ))}
              <Text size="xs" c="canyon.0" mt={4}>
                Signing the new one <b>revokes {existing.length === 1 ? 'it' : 'them'}</b>, so this
                becomes the only ceiling. Each revocation is its own passkey prompt.
              </Text>
            </Stack>
          )}

          <Group grow align="flex-start">
            <TextInput
              label="Amount"
              placeholder="10.00"
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
              rightSection={
                <Text size="xs" c="dimmed" pr={6}>
                  {LIMIT_CURRENCY}
                </Text>
              }
            />
            <Select
              label="Resets"
              data={WINDOWS}
              value={window}
              onChange={(v) => setWindow(v ?? 'MONTHLY')}
              allowDeselect={false}
            />
          </Group>

          {/* Read the rule back in the words a person would use. Signing
              something you cannot restate is the failure this prevents. */}
          {amount && (
            <Text size="sm">
              →{' '}
              <b>
                {agentName} may spend up to {amount} {LIMIT_CURRENCY} {windowLabel}.
              </b>
            </Text>
          )}

          {error && (
            <Text size="sm" c="blaze.1">
              {error}
            </Text>
          )}

        </Stack>
      </Modal.Body>
      {/* In Modal.Footer, like every other modal here. `subtle` rather than
          `default` for Cancel: an outlined button carries a 1px border that a
          filled one does not, so side by side they rendered different heights. */}
      <Modal.Footer>
        {/* Same explicit size on both. Variants differ in whether they draw a
            border, and letting each size itself put them a couple of pixels
            apart. */}
        <Group justify="flex-end" gap="sm" align="center" wrap="nowrap">
          <Button size="sm" variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} loading={busy} disabled={!amount.trim()}>
            Create limit
          </Button>
        </Group>
      </Modal.Footer>
    </Modal>
  )
}
