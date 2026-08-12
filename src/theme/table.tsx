'use client'

import { DataTable, type DataTableProps } from 'mantine-datatable'

/**
 * The app's data table: a thin wrapper over `mantine-datatable`'s `DataTable`,
 * carrying the app's defaults and prop names — a transparent background, hover
 * highlight, no borders, `loading` (mapped to datatable's `fetching`),
 * `customEmptyState` (mapped to `noRecordsText`), and an `onRowClick` shaped
 * `({ record })` rather than datatable's `({ record, index, event })`. Kept
 * generic so call sites write `<Table<Row> …>` and get typed columns.
 */
export type TableProps<T> = Omit<DataTableProps<T>, 'onRowClick'> & {
  loading?: boolean
  customEmptyState?: React.ReactNode
  onRowClick?: (info: { record: T }) => void
}

export function Table<T>({
  onRowClick,
  loading,
  customEmptyState,
  minHeight = 300,
  ...rest
}: TableProps<T>) {
  const emptyState =
    customEmptyState === undefined
      ? {}
      : typeof customEmptyState === 'string'
        ? { noRecordsText: customEmptyState }
        : { emptyState: customEmptyState }

  // Cast at the boundary: DataTableProps is a columns-XOR-groups discriminated
  // union, which a spread cannot narrow. The call-site props stay fully typed
  // through TableProps; only this hand-off is cast.
  const props = {
    backgroundColor: 'transparent',
    highlightOnHover: true,
    withRowBorders: false,
    withTableBorder: false,
    fetching: loading,
    minHeight,
    ...emptyState,
    onRowClick: onRowClick ? ({ record }: { record: T }) => onRowClick({ record }) : undefined,
    ...rest,
  } as unknown as DataTableProps<T>

  return <DataTable<T> {...props} />
}
