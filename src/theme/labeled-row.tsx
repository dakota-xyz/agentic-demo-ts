import { Divider, Group, Stack, Text } from '@mantine/core'

/**
 * A dimmed label on the left, a value on the right. Used on the integrations
 * panel to lay out connection details.
 */
export function LabeledRow({
  border = false,
  children,
  label,
}: {
  border?: boolean
  children: React.ReactNode
  label: React.ReactNode
}) {
  return (
    <Stack gap="xs">
      <Group gap="md" justify="space-between">
        <Text c="dimmed" fz="sm">
          {label}
        </Text>
        {children}
      </Group>
      {border && <Divider />}
    </Stack>
  )
}
