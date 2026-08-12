'use client'

import { useState } from 'react'
import { Button, Group, Modal, Stack, Text } from '@/theme/ui'
import { notifications } from '@mantine/notifications'

// Retiring an agent.
//
// Two buttons. Typing the agent's name was friction without protection: an
// agent is cheap to remake, nothing it already paid is affected, and the person
// clicking is the same person who made it moments ago.
//
// What the dialog does carry is the CONSEQUENCE — what stops running — rather
// than "are you sure?", which asks the reader to supply the reasoning
// themselves.

export function DeleteAgentModal({
  agentId,
  agentName,
  scheduledCount,
  onClose,
  onDeleted,
}: {
  agentId: string
  agentName: string
  /** Payments that will stop if this goes ahead. */
  scheduledCount: number
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'could not revoke that agent')
      notifications.show({ color: 'evergreen', message: `${agentName} was revoked.` })
      onDeleted()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>Revoke {agentName}</Modal.Header>
      <Modal.Body>
        <Stack gap="md">
          <Text size="sm">
            This revokes <b>{agentName}</b> on the platform. Its spend limits stop authorising
            anything, and its chat history is removed.
          </Text>

          {scheduledCount > 0 && (
            <Text size="sm" c="canyon.0">
              {scheduledCount} scheduled payment{scheduledCount === 1 ? '' : 's'} will not run.
            </Text>
          )}

          <Text size="sm" c="dimmed">
            Payments it has already made are unaffected — they stay in Activity.
          </Text>

          {error && (
            <Text size="sm" c="blaze.1">
              {error}
            </Text>
          )}
        </Stack>
      </Modal.Body>
      <Modal.Footer>
        <Group justify="flex-end" gap="sm" align="center" wrap="nowrap">
          <Button size="sm" variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" color="blaze" onClick={() => void remove()} loading={busy}>
            Revoke agent
          </Button>
        </Group>
      </Modal.Footer>
    </Modal>
  )
}
