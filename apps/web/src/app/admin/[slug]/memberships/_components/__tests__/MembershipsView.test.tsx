import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The spec's setup-visibility contract
 * (docs/specs/2026-08-05/completed/recurring-memberships.spec.md, "Dispute policy" +
 * "The $2 account fee"): the venue must have ACTIVELY seen both payout
 * policies — so they render in the empty/setup state AND stay visible as a
 * compact note once tiers exist. Plus the finance-role affordance split:
 * non-finance actors see the list, never the write affordances.
 */

interface MockColumn {
  id: string;
  header: ReactNode;
  cell: (row: unknown) => ReactNode;
}

interface MockDataTableProps {
  columns: MockColumn[];
  rows: unknown[];
  getRowKey: (row: unknown) => string;
  emptyState?: ReactNode;
  rowActions?: {
    header: ReactNode;
    width: number;
    render: (row: unknown) => ReactNode;
  };
}

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TIER_ID = "11111111-1111-4111-8111-111111111111";

const testState = vi.hoisted(() => ({
  items: [] as unknown[],
  canFinance: true,
}));

const activeTier = {
  id: TIER_ID,
  ownerOrgId: ORG_ID,
  ownerHumanId: null,
  name: "Sustaining Member",
  description: "Keeps the lights on.",
  priceCents: 1000,
  currency: "usd",
  interval: "MONTH",
  stripeProductId: null,
  stripePriceId: null,
  status: "ACTIVE",
  sortOrder: 0,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  benefits: [],
  memberCount: 4,
  priceLocked: true,
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-")) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => {
  const Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    {
      Panel,
      Header: ({ title }: { title?: string }) => <h2>{title}</h2>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  );
  return {
    Modal,
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    DataTable: (props: MockDataTableProps) => (
      <div data-testid="tiers-table">
        {props.rows.map((row) => (
          <div key={props.getRowKey(row)} data-testid="tier-row">
            {props.columns.map((col) => (
              <div key={col.id} data-testid={`cell-${col.id}`}>
                {col.cell(row)}
              </div>
            ))}
            {props.rowActions ? (
              <div data-testid="row-actions">{props.rowActions.render(row)}</div>
            ) : null}
          </div>
        ))}
      </div>
    ),
    Text: ({ children, id }: { children?: ReactNode; id?: string }) => (
      <span id={id}>{children}</span>
    ),
    TextInput: ({ value }: { value?: string }) => (
      <input readOnly value={value ?? ""} />
    ),
    Spinner: () => <span />,
    useFormatters: () => ({
      currency: (v: number) => `$${v.toFixed(2)}`,
      dateTime: () => "",
    }),
    useNotify: () => ({
      toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
    }),
    useTranslations: () => (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(" ")}` : key,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      memberships: { tiers: { list: { invalidate: vi.fn() } } },
    }),
    memberships: {
      tiers: {
        list: {
          useQuery: () => ({
            data: { items: testState.items },
            isLoading: false,
            error: null,
            refetch: vi.fn(),
          }),
        },
        publish: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
        archive: {
          useMutation: () => ({ mutate: vi.fn(), isPending: false }),
        },
      },
    },
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: {
      kind: "org",
      orgId: ORG_ID,
      orgName: "Acme Collective",
      orgSlug: "acme",
      role: "OWNER",
      avatarUrl: null,
      adminSlug: "acme",
    },
    normalizedSlug: "acme",
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/useAdminOwnerCapabilities", () => ({
  useAdminOwnerCapabilities: () => ({
    canEdit: testState.canFinance,
    canManage: testState.canFinance,
    canFinance: testState.canFinance,
  }),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div role="dialog">{title}</div> : null,
}));

vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: ({
    items,
    ariaLabel,
  }: {
    items: { key: string; label: string }[];
    ariaLabel: string;
  }) => (
    <div aria-label={ariaLabel} data-testid="row-action-menu">
      {items.map((item) => (
        <span key={item.key}>{item.label}</span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/AdminTableParts", () => ({
  TableContainer: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/app/admin/_components/AdminPageData", () => ({
  AdminPageData: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../../../_components/AdminPageHeader", () => ({
  AdminPageHeader: ({
    title,
    trailing,
  }: {
    title: string;
    trailing?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {trailing}
    </div>
  ),
}));

// Dialogs under their own test files — stub to keep this one about the view.
vi.mock("../TierFormDialog", () => ({
  TierFormDialog: () => <div data-testid="tier-form-dialog" />,
}));
vi.mock("../BenefitsDialog", () => ({
  BenefitsDialog: () => <div data-testid="benefits-dialog" />,
}));

import { MembershipsView } from "../MembershipsView";

describe("MembershipsView — policy visibility contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.items = [];
    testState.canFinance = true;
  });

  it("empty state: both policy statements + the first-tier CTA (no locked state)", () => {
    render(<MembershipsView />);

    expect(
      screen.getByText("adminMemberships.policyFeeBody"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("adminMemberships.policyDisputeBody"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /createFirstTier/ }),
    ).toBeInTheDocument();
    // Open to any payee: nothing gated, no unlock messaging.
    expect(screen.queryByText(/locked|unlock/i)).not.toBeInTheDocument();
  });

  it("with tiers: the policies STAY visible as the compact note beside the table", () => {
    testState.items = [activeTier];
    render(<MembershipsView />);

    // Both statements still on the page (spec: actively seen, not a one-off).
    expect(
      screen.getByText("adminMemberships.policyFeeBody"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("adminMemberships.policyDisputeBody"),
    ).toBeInTheDocument();

    // Row content: name, member count, benefits summary, status chip.
    expect(screen.getByText("Sustaining Member")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(
      screen.getByText("adminMemberships.statusActive"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("row-action-menu")).toBeInTheDocument();
  });

  it("non-finance roles: list visible, write affordances absent", () => {
    testState.items = [activeTier];
    testState.canFinance = false;
    render(<MembershipsView />);

    expect(screen.getByText("Sustaining Member")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /createTier/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-action-menu")).not.toBeInTheDocument();
  });
});
