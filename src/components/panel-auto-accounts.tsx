'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge, Card, Group, Loader, Stack, Table, Text, Tooltip } from '@/theme/ui'
import { autoAccountSentence } from '@/lib/proposal'

// Auto-accounts: how a crypto treasury pays a bank.
//
// One of these is created when a plan needs an asset or a rail the treasury
// does not hold. The agent's schedule pays the account's crypto DEPOSIT, and
// the provider converts and forwards — to a bank over ACH/wire (`offramp`), or
// to an address on another chain family (`swap`).
//
// The deposit address is the part worth surfacing. It looks like an ordinary
// payment destination in the scheduled list, and it is not: money arriving
// there does not stay there. This screen is where that indirection is visible,
// which is why the real destination is shown on the same row.

interface AutoAccount {
  id: string
  account_type?: string
  source_asset?: string
  destination_asset?: string
  source_network_id?: string
  source_crypto_address?: string
  rail?: string
  destination_rail?: string
  destination?: Record<string, unknown>
}

/** Where the money actually ends up, once converted. */
function destinationLabel(a: AutoAccount): string {
  const d = a.destination
  if (!d) return '—'
  const bank = (d.bank_name ?? d.account_holder_name) as string | undefined
  if (bank) {
    const last4 = String(d.account_number ?? '').slice(-4)
    return last4 ? `${bank} ····${last4}` : bank
  }
  const address = d.address as string | undefined
  if (address) {
    const net = d.network_id ? ` on ${String(d.network_id)}` : ''
    return `${address.slice(0, 10)}…${address.slice(-6)}${net}`
  }
  return '—'
}

export function AutoAccountsPanel() {
  const [accounts, setAccounts] = useState<AutoAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auto-accounts')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'could not load auto-accounts')
      setAccounts((body.accounts ?? []) as AutoAccount[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // load() clears the error and raises the spinner before its first await, which
    // is a fetch on mount. Deliberate.
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

  if (error) {
    return (
      <Card padding="md">
        <Text size="sm" c="blaze.1">
          {error}
        </Text>
      </Card>
    )
  }

  if (accounts.length === 0) {
    return (
      <Stack gap="xs" pt="xl" align="center" ta="center">
        <Text fz={32} lh={1}>
          ⇄
        </Text>
        <Text fw={500}>No convert-and-forward accounts</Text>
        <Text size="sm" c="dimmed" maw={460}>
          When a plan needs an asset or a rail your treasury does not hold — paying a bank by wire,
          or a payee on another chain — the agent creates one of these. Your payment goes to its
          deposit address, and it converts and forwards from there.
        </Text>
      </Stack>
    )
  }

  return (
    <Table<AutoAccount>
      records={accounts}
      minHeight={160}
      columns={[
        {
          accessor: 'source_asset',
          title: 'Converts',
          render: (a) => (
            <Stack gap={2}>
              <Text size="sm">{autoAccountSentence(a as unknown as Record<string, unknown>)}</Text>
              <Tooltip label="Account id" withArrow>
                <Text size="xs" c="dimmed" ff="var(--font-gt-america-mono)">
                  {a.id}
                </Text>
              </Tooltip>
            </Stack>
          ),
        },
        {
          accessor: 'source_crypto_address',
          title: 'Deposit address',
          width: 220,
          // The address the SCHEDULE pays. Money here is in transit, not at
          // rest — which is exactly what makes it worth labelling.
          render: (a) =>
            a.source_crypto_address ? (
              <Tooltip label={a.source_crypto_address} withArrow>
                <Text size="xs" ff="var(--font-gt-america-mono)" truncate>
                  {a.source_crypto_address}
                </Text>
              </Tooltip>
            ) : (
              <Text size="sm" c="dimmed">
                —
              </Text>
            ),
        },
        {
          accessor: 'destination',
          title: 'Forwards to',
          width: 240,
          render: (a) => (
            <Text size="sm" c="dimmed">
              {destinationLabel(a)}
            </Text>
          ),
        },
        {
          accessor: 'account_type',
          title: 'Type',
          width: 110,
          render: (a) => (
            <Badge color={a.account_type === 'offramp' ? 'canyon' : 'slate'} variant="light">
              {a.account_type ?? '—'}
            </Badge>
          ),
        },
      ]}
    />
  )
}
