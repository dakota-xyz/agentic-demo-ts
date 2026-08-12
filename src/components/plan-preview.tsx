'use client'

import { Stack, Text } from '@/theme/ui'
import {
  IconArrowsExchange,
  IconBuildingBank,
  IconCalendarEvent,
  IconPoint,
  IconShieldLock,
  IconUserPlus,
  IconWallet,
  type Icon as TablerIcon,
} from '@tabler/icons-react'
import { planSteps } from '@/lib/proposal'

// What the agent is about to do, before you agree to it.
//
// The agent's prose reply already describes the plan, but prose is not what you
// approve — the ACTIONS are, and they can differ from the sentence describing
// them. That gap matters most exactly where it is least visible: an offramp
// looks like an ordinary payment in prose, while the actions reveal that money
// is being converted and sent to a bank account.
//
// So every action gets a line, including ones this build does not recognise.
// Rendering nothing for an unknown action would let a plan do something the
// approver never saw, which is the failure this component exists to prevent.

const ICONS: Record<string, TablerIcon> = {
  create_recipient: IconUserPlus,
  create_crypto_destination: IconWallet,
  create_bank_destination: IconBuildingBank,
  create_mandate: IconShieldLock,
  create_scheduled_payments: IconCalendarEvent,
  create_auto_account: IconArrowsExchange,
}

export function PlanPreview({ plan }: { plan: readonly unknown[] }) {
  const steps = planSteps(plan)
  if (steps.length === 0) return null

  return (
    <Stack gap={10} className="plan-preview">
      {steps.map((step, i) => {
        const Icon = ICONS[step.type] ?? IconPoint
        return (
          <div key={i} className={`plan-step${step.sub ? ' is-sub' : ''}`}>
            <Icon size={15} stroke={1.7} className="plan-step-icon" />
            <div style={{ minWidth: 0 }}>
              <Text size="sm">
                <Text span fw={500}>
                  {step.title}
                </Text>
                {step.detail ? ` — ${step.detail}` : ''}
              </Text>
              {step.note && (
                <Text size="xs" c="dimmed" mt={2}>
                  {step.note}
                </Text>
              )}
            </div>
          </div>
        )
      })}
    </Stack>
  )
}
