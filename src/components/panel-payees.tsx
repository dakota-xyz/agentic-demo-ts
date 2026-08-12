'use client'

import { useEffect, useState } from 'react'
import { Badge, Card, Group, Loader, Stack, Text } from '@/theme/ui'
import { ChainIcon } from './chain-icon'
import { CopyAddress, shortAddr } from './copy-address'

// Everyone the agents can pay.
//
// Payees are created automatically the first time an agent pays someone new, so
// this page is mostly a receipt of what the conversations built. That is worth
// showing: it is the evidence that "pay Acme" became a durable, reusable payee
// rather than a string in a chat log.

interface Destination {
  id?: string
  address: string
  network: string
  family: string
}

interface Payee {
  id?: string
  name?: string
  status?: string
  destinations: Destination[]
}

export function PayeesPanel() {
  const [payees, setPayees] = useState<Payee[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/recipients')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error)
        setPayees(d.payees ?? [])
      })
      // Never a silent empty list: "no payees" and "we could not fetch them"
      // look identical on screen and mean very different things.
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) {
    return (
      <Stack gap="xs" pt="xl" align="center" ta="center">
        <Text fw={500}>Couldn’t load your payees</Text>
        <Text size="sm" c="dimmed" maw={420}>
          {error}
        </Text>
      </Stack>
    )
  }

  if (payees === null) {
    return (
      <Group gap={8} justify="center" py="xl">
        <Loader size="xs" color="sierra" />
        <Text size="sm" c="dimmed">
          Loading payees…
        </Text>
      </Group>
    )
  }

  if (payees.length === 0) {
    return (
      <Stack gap="xs" pt="xl" align="center" ta="center">
        <Text fz={32} lh={1}>
          ◇
        </Text>
        <Text fw={500}>No payees yet</Text>
        <Text size="sm" c="dimmed" maw={440}>
          Ask an agent to pay someone new and they appear here — saved
          automatically, so the next payment to them needs only a name.
        </Text>
      </Stack>
    )
  }

  return (
    <Stack gap="md" className="scroll-pane" style={{ flex: 1, minHeight: 0 }}>
      <Text size="sm" c="dimmed">
        Everyone your agents can pay. Added automatically the first time an agent pays
        someone new.
      </Text>

      <Stack gap="sm">
        {payees.map((p) => (
          <Card key={p.id} bg="slate.8" p="md" withBorder>
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Text fw={500}>{p.name}</Text>
                {p.status && (
                  <Badge
                    color={p.status.toLowerCase() === 'active' ? 'evergreen' : 'slate'}
                    variant="light"
                  >
                    {p.status}
                  </Badge>
                )}
              </Group>

              {p.destinations.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No addresses saved yet.
                </Text>
              ) : (
                <Stack gap={6}>
                  {p.destinations.map((d, i) => (
                    <Group key={d.id ?? i} gap={8} wrap="nowrap">
                      <ChainIcon family={d.family} size={15} />
                      <Text size="sm" c="dimmed" style={{ width: 150, flexShrink: 0 }}>
                        {d.network || d.family}
                      </Text>
                      <CopyAddress address={d.address} display={shortAddr(d.address)} />
                    </Group>
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>
        ))}
      </Stack>
    </Stack>
  )
}
