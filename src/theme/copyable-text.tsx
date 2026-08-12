'use client'

import { ActionIcon, CopyButton, Group, Text, Tooltip } from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'

/**
 * Click-to-copy text.
 *
 * `value` is what lands on the clipboard; `displayValue` is what the reader sees
 * (a truncated address, a `#channel` label), falling back to `value`. The props
 * are limited to what the app uses: `monospace`, `displayValue`, `size`,
 * `showCopyIcon`.
 */
export interface CopyableTextProps {
  value: string
  displayValue?: string
  monospace?: boolean
  showCopyIcon?: boolean
  size?: string
}

export function CopyableText({
  value,
  displayValue,
  monospace = false,
  showCopyIcon = true,
  size = 'sm',
}: CopyableTextProps) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Text
        ff={monospace ? 'monospace' : undefined}
        fz={size}
        style={{ wordBreak: 'break-all' }}
      >
        {displayValue ?? value}
      </Text>
      {showCopyIcon && (
        <CopyButton value={value} timeout={2000}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                onClick={copy}
                aria-label="Copy"
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      )}
    </Group>
  )
}
