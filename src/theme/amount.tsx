import { Text, type TextProps } from '@mantine/core'

/**
 * A money figure.
 *
 * Renders monospaced with two fraction digits, and colours/sign it by
 * transaction direction: deposits and rewards read positive (evergreen /
 * sierra), withdrawals negative (blaze). A null value shows an em dash.
 */
export interface AmountProps extends Omit<TextProps, 'children'> {
  value?: number | string | null
  prefix?: string
  suffix?: string
  size?: string
  transactionType?: 'Deposit' | 'Reward' | 'Withdrawal' | string
}

export function Amount({
  prefix = '$',
  size = 'sm',
  suffix = '',
  transactionType,
  value,
  ...textProps
}: AmountProps) {
  if (value === null || value === undefined) {
    return (
      <Text ff="monospace" size={size} {...textProps}>
        —
      </Text>
    )
  }

  const formatted = Math.abs(Number(value)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const base = `${prefix || ''}${formatted}${suffix ? ` ${suffix}` : ''}`

  let displayText = base
  let color = textProps.c
  if (transactionType === 'Deposit') {
    displayText = `+ ${base}`
    color = '#83957e' // evergreen40
  } else if (transactionType === 'Reward') {
    displayText = `+ ${base}`
    color = '#b9825b' // sierra30
  } else if (transactionType === 'Withdrawal') {
    displayText = `- ${base}`
    color = '#c48184' // blaze20
  } else if (Number(value) < 0) {
    displayText = `- ${base}`
  }

  return (
    <Text ff="monospace" size={size} {...textProps} c={color}>
      {displayText}
    </Text>
  )
}
