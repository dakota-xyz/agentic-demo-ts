'use client'

import { useCallback, useEffect, useState } from 'react'
import { Avatar, Badge, Card, Group, Loader, Stack, Table, Text, Tooltip } from '@/theme/ui'
import { badgeTone } from '@/lib/tone'

// Who shares this account.
//
// The column that matters is "can sign". Enrolling a passkey is not the same as
// being able to authorise: the key also has to be in the treasury wallets'
// signer groups, and until it is, that person can approve a plan but not
// activate it. Showing only "has a passkey" would say someone is ready when
// they are not.

interface Member {
  email: string
  name?: string
  picture?: string
  canSign: boolean
  enrolled: boolean
  lastActive?: string
}

function when(iso?: string): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TeamPanel({ signedInAs }: { signedInAs: string }) {
  const [members, setMembers] = useState<Member[]>([])
  const [teamMode, setTeamMode] = useState(true)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/team')
      const body = await res.json()
      setTeamMode(body.teamMode !== false)
      setMembers((body.members ?? []) as Member[])
    } catch {
      setMembers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // load() sets state before its first await — a fetch on mount. Deliberate.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (loading) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    )
  }

  if (!teamMode) {
    return (
      <Card padding="lg">
        <Stack gap={4} align="center" ta="center">
          <Text fz={24} lh={1}>
            ◈
          </Text>
          <Text size="sm" fw={500}>
            This deployment is per-visitor
          </Text>
          <Text size="xs" c="dimmed" maw={460}>
            Everyone who signs in gets their own account — their own treasury, agents and payment
            history. A shared team account is a different deployment mode.
          </Text>
        </Stack>
      </Card>
    )
  }

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed" maw={720}>
        One account — same treasury, agents, payees and history — and anyone who can sign may
        activate a pending spend limit.
      </Text>

      <Table<Member & { id: string }>
        records={members.map((m) => ({ ...m, id: m.email }))}
        minHeight={160}
        columns={[
          {
            // The EMAIL is the identity here, so it is the only thing shown.
            // A display name is what Google happens to hold, not what grants
            // access — two people can carry the same one, and this account has
            // exactly that, which turned the name column into a puzzle about
            // which "Luis Castillo" could sign.
            accessor: 'email',
            title: 'Member',
            render: (m) => (
              <Group gap="sm" wrap="nowrap">
                <Avatar src={m.picture} size={28} radius="xl">
                  {m.email.slice(0, 1).toUpperCase()}
                </Avatar>
                <Text size="sm" truncate style={{ minWidth: 0 }}>
                  {m.email}
                </Text>
                {m.email === signedInAs && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    you
                  </Text>
                )}
              </Group>
            ),
          },
          {
            accessor: 'canSign',
            title: 'Signing',
            width: 170,
            render: (m) =>
              m.canSign ? (
                <Badge {...badgeTone('evergreen')}>can sign</Badge>
              ) : (
                <Tooltip
                  withArrow
                  multiline
                  w={280}
                  label={
                    m.enrolled
                      ? 'Has a passkey, but it is not attached to the treasury wallets yet — enrol again to attach it.'
                      : 'No passkey yet. They can approve plans, but cannot activate a spend limit until they enrol one.'
                  }
                >
                  <Badge {...badgeTone('canyon')}>{m.enrolled ? 'not attached' : 'no passkey'}</Badge>
                </Tooltip>
              ),
          },
          {
            accessor: 'lastActive',
            title: 'Last active',
            width: 140,
            render: (m) => (
              <Text size="sm" c="dimmed">
                {when(m.lastActive)}
              </Text>
            ),
          },
        ]}
      />
    </Stack>
  )
}
