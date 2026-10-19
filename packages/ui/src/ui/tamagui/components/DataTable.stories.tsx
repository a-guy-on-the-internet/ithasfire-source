import type { Meta, StoryObj } from "@storybook/react";

import { DataTable, type DataTableColumn } from "./data/DataTable";

type Row = {
  id: string;
  purchaser: string;
  total: string;
};

const columns: Array<DataTableColumn<Row>> = [
  {
    id: "purchaser",
    header: "Purchaser",
    cell: (row) => row.purchaser,
    align: "left",
    width: 60,
  },
  {
    id: "total",
    header: "Total",
    cell: (row) => row.total,
    align: "right",
    width: 40,
  },
];

const rows: Row[] = [
  { id: "o_1", purchaser: "Ada Lovelace", total: "$120.00" },
  { id: "o_2", purchaser: "Grace Hopper", total: "$80.00" },
  { id: "o_3", purchaser: "Katherine Johnson", total: "$200.00" },
];

const meta: Meta<typeof DataTable<Row>> = {
  title: "components/DataTable",
  component: DataTable,
  args: {
    columns,
    rows,
    getRowKey: (row) => row.id,
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    rows: [],
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};

export const LoadingTableSkeleton: Story = {
  args: {
    isLoading: true,
    loadingRowCount: 4,
    rowActions: {
      render: () => <button type="button">Edit</button>,
    },
  },
};

export const WithRowActions: Story = {
  render: () => {
    return (
      <DataTable
        testIdBase="datatable"
        columns={[
          {
            id: "purchaser",
            header: "Purchaser",
            cell: (row: any) => row.purchaser,
          },
          { id: "total", header: "Total", cell: (row: any) => row.total },
        ]}
        rows={[{ id: "o_1", purchaser: "Ada Lovelace", total: "$120.00" }]}
        getRowKey={(row: any) => row.id}
        rowActions={{
          render: (row) => (
            <button
              type="button"
              onClick={() => {
                // eslint-disable-next-line no-console
                console.log("edit", row);
              }}
            >
              Edit
            </button>
          ),
        }}
      />
    );
  },
};

export const SortableWithCarets: Story = {
  render: () => (
    <DataTable<Row>
      testIdBase="sortable"
      columns={[
        {
          id: "purchaser",
          header: "Purchaser",
          cell: (row) => row.purchaser,
          sortValue: (row) => row.purchaser,
          width: 60,
        },
        {
          id: "total",
          header: "Total",
          cell: (row) => row.total,
          sortValue: (row) => Number(row.total.replace(/[^0-9.]/g, "")),
          align: "right",
          width: 40,
        },
      ]}
      rows={rows}
      getRowKey={(row) => row.id}
      clientSort
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Sortable columns show a persistent muted double-caret; click a header to see the active column render in accentText with only the active-direction caret. Right-aligned columns get tabular-nums.",
      },
    },
  },
};

type StackedRow = {
  id: string;
  purchaser: string;
  email: string;
  total: string;
};

const stackedRows: StackedRow[] = [
  {
    id: "o_1",
    purchaser: "Ada Lovelace",
    email: "ada@example.com",
    total: "$120.00",
  },
  {
    id: "o_2",
    purchaser: "Grace Hopper",
    email: "grace@example.com",
    total: "$80.00",
  },
  {
    id: "o_3",
    purchaser: "Katherine Johnson",
    email: "katherine@example.com",
    total: "$200.00",
  },
];

const stackedColumns: Array<DataTableColumn<StackedRow>> = [
  {
    id: "purchaser",
    header: "Purchaser",
    truncate: false,
    cell: (row) => (
      <div>
        <div style={{ fontWeight: 600 }}>{row.purchaser}</div>
        {/* Second line opts into collapsing under density="compact". */}
        <div className="dt-cell-sub" style={{ fontSize: 12, opacity: 0.7 }}>
          {row.email}
        </div>
      </div>
    ),
    width: 60,
  },
  {
    id: "total",
    header: "Total",
    cell: (row) => row.total,
    align: "right",
    width: 40,
  },
];

export const ComfortableDensity: Story = {
  render: () => (
    <DataTable<StackedRow>
      testIdBase="comfortable"
      columns={stackedColumns}
      rows={stackedRows}
      getRowKey={(row) => row.id}
    />
  ),
};

export const CompactDensity: Story = {
  render: () => (
    <DataTable<StackedRow>
      testIdBase="compact"
      columns={stackedColumns}
      rows={stackedRows}
      getRowKey={(row) => row.id}
      density="compact"
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'density="compact" tightens cell padding and hides cell content marked with the `dt-cell-sub` class (the email line above).',
      },
    },
  },
};

export const ScrollContainer: Story = {
  render: () => {
    const wideColumns: Array<DataTableColumn<Row>> = Array.from(
      { length: 8 },
      (_, i) => ({
        id: `col-${i}`,
        header: `Column ${i + 1}`,
        cell: (row) => `${row.purchaser} ${i + 1}`,
        noWrap: true,
      }),
    );
    return (
      <div style={{ maxWidth: 480 }}>
        <DataTable<Row>
          testIdBase="scroller"
          columns={wideColumns}
          rows={rows}
          getRowKey={(row) => row.id}
          scrollContainer
        />
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "By default DataTable relies on an ancestor scroll container (so its sticky header works). `scrollContainer` opts standalone usages into a built-in overflow:auto wrapper.",
      },
    },
  },
};
