'use client'

import { Anchor, Button, Group, Modal, Stack, Text } from '@/theme/ui'
import { IconExternalLink } from '@tabler/icons-react'
import { CopyAddress } from './copy-address'
import type { WalletView } from './workspace'

const CIRCLE_FAUCET = 'https://faucet.circle.com'

/**
 * FundModal walks a visitor through Circle's hosted faucet.
 *
 * There is no automatic path: Circle's programmatic faucet
 * (POST /v1/faucet/drips) requires the CIRCLE ACCOUNT to be mainnet-verified,
 * even to hand out testnet tokens — no API key alone unlocks it. So rather than
 * a button that fails, this is an honest hand-off: four steps, the address ready
 * to copy, and a clear statement that the balance updates itself afterwards.
 *
 * The alternative — dropping a bare faucet link in a tooltip — loses people at
 * the moment the demo most needs them, because an unfunded treasury is what
 * makes everything after it look fake.
 */
export function FundModal({ wallets, onClose }: { wallets: WalletView[]; onClose: () => void }) {
  const evm = wallets.find((w) => w.network === 'evm')

  const steps = [
    {
      title: 'Open Circle’s testnet faucet',
      body: (
        <Anchor href={CIRCLE_FAUCET} target="_blank" rel="noopener noreferrer" size="sm">
          faucet.circle.com <IconExternalLink size={13} style={{ verticalAlign: '-2px' }} />
        </Anchor>
      ),
    },
    {
      title: 'Choose USDC on Ethereum Sepolia',
      body: (
        <Text size="sm" c="dimmed">
          The network has to match — USDC on any other chain will not cover a payment here.
        </Text>
      ),
    },
    {
      title: 'Paste your treasury address',
      body: evm ? (
        <CopyAddress address={evm.address} display={evm.address} />
      ) : (
        <Text size="sm" c="dimmed">
          Your wallet is still being provisioned — reopen this in a moment.
        </Text>
      ),
    },
    {
      title: 'Submit, then come back',
      body: (
        <Text size="sm" c="dimmed">
          It takes a minute or two to confirm. Your balance updates on its own — no need to
          reload.
        </Text>
      ),
    },
  ]

  return (
    <Modal opened onClose={onClose} size="md">
      <Modal.Header onClose={onClose}>Add test funds</Modal.Header>
      <Modal.Body>
        <Stack gap="lg">
          <Text size="md" c="dimmed">
            Test funds come from Circle’s public faucet. It takes about a minute.
          </Text>

          <Stack gap="md">
            {steps.map((s, i) => (
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
        </Stack>
      </Modal.Body>
      <Modal.Footer>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Modal.Footer>
    </Modal>
  )
}
