'use client'

import {
  Alert,
  Box,
  Center,
  CloseButton,
  Group,
  Loader,
  Modal as MantineModal,
  Stack,
  Title,
} from '@mantine/core'

/**
 * The app's modal: a compound component — `<Modal>` with `Modal.Header`,
 * `Modal.Body` and `Modal.Footer` — over Mantine's Modal, with a fixed dark
 * chrome: a slate-90 sheet capped at 75vh, its own title bar with a close button
 * (Mantine's built-in header is hidden), a scrollable padded body, and a
 * right-aligned footer with a top border.
 */

const overlayProps = { backgroundOpacity: 0.4, blur: 2 }

const modalStyles = {
  content: {
    backgroundColor: '#121111',
    border: '1px solid #464543',
    display: 'flex',
    flexDirection: 'column' as const,
    maxHeight: '75vh',
    minHeight: 0,
  },
  body: {
    padding: 0,
    minHeight: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  // We render our own header (Modal.Header), so hide Mantine's.
  header: { display: 'none' },
}

interface ModalProps {
  opened: boolean
  onClose: () => void
  size?: string | number
  children: React.ReactNode
}

function ModalBase({ children, onClose, opened, size = 'lg' }: ModalProps) {
  return (
    <MantineModal
      centered
      opened={opened}
      onClose={onClose}
      size={size}
      overlayProps={overlayProps}
      styles={modalStyles}
      zIndex={200}
    >
      {children}
    </MantineModal>
  )
}

function ModalHeader({
  children,
  onClose,
  style,
}: {
  children: React.ReactNode
  onClose?: () => void
  style?: React.CSSProperties
}) {
  return (
    <Group
      style={{
        backgroundColor: '#121111',
        borderBottom: '1px solid #464543',
        padding: '8px 24px',
        flexShrink: 0,
        justifyContent: 'space-between',
        alignItems: 'center',
        minHeight: '60px',
        ...style,
      }}
    >
      <Title order={5}>{children}</Title>
      {onClose && <CloseButton onClick={onClose} aria-label="Close modal" />}
    </Group>
  )
}

function ModalBody({
  children,
  error,
  loading,
}: {
  children?: React.ReactNode
  error?: React.ReactNode
  loading?: boolean
}) {
  if (loading) {
    return (
      <Center style={{ flex: 1, minHeight: 120 }}>
        <Loader />
      </Center>
    )
  }
  if (error) {
    return (
      <Box p="lg">
        <Alert color="blaze" variant="light">
          {error}
        </Alert>
      </Box>
    )
  }
  return (
    <Stack style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <Box p="lg" mih={0} style={{ flex: 1, overflowY: 'auto' }}>
        {children}
      </Box>
    </Stack>
  )
}

function ModalFooter({
  children,
  style,
}: {
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <Group
      justify="flex-end"
      style={{
        backgroundColor: '#121111',
        borderTop: '1px solid #464543',
        padding: '1rem',
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </Group>
  )
}

export const Modal = Object.assign(ModalBase, {
  Header: ModalHeader,
  Body: ModalBody,
  Footer: ModalFooter,
})
