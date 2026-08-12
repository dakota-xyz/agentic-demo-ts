// The app's single UI import.
//
// Most of the component surface is Mantine's, re-exported directly (Mantine is
// MIT). The handful of Dakota-specific components live alongside and are
// re-exported here too. The explicit re-exports below deliberately SHADOW the
// Mantine names of the same spelling: the app's `Modal` is the compound dark
// modal, and its `Table` is the data table — not Mantine's plain versions.
//
// One import means every call site names a single UI source rather than reaching
// into Mantine piecemeal.
export * from '@mantine/core'

export { DakotaUIProvider } from './provider'
export { CopyableText, type CopyableTextProps } from './copyable-text'
export { Modal } from './modal'
export { Table, type TableProps } from './table'
export { Amount, type AmountProps } from './amount'
export { LabeledRow } from './labeled-row'
export { AppLayout, AppHeader, AppNavbar } from './app-shell'
