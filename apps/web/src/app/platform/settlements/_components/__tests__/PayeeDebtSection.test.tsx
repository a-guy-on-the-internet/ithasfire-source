import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Section tests for "Payees in debt". `@th/ui` and tamagui are mocked to
 * bare DOM so the assertions are about THIS surface: which rows render,
 * where the owner links go, the warning tone on "None", the empty state,
 * and the hand-rolled cursor paging.
 */

const testState = vi.hoisted(() => ({
  data: null as unknown,
  isLoading: false,
  isError: false,
  error: null as unknown,
  dataUpdatedAt: 1,
  fetch: vi.fn(),
  refetch: vi.fn(),
  isFetching: false,
  isMobile: false,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    tag,
    ...rest
  }: {
    children?: ReactNode;
    tag?: string;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k.startsWith("aria-") || k === "role" || k === "id") domProps[k] = v;
    }
    return React.createElement(tag ?? "div", domProps, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

// The design-system `Money` is not in main yet; PayeeDebtSection renders the local
// `MoneyText` stand-in (platform/_components/MoneyText.tsx). Stub it with the
// same `${currency}:${cents}` shape the assertions below were written against.
vi.mock("../../../_components/MoneyText", () => ({
  MoneyText: ({
    cents,
    currency,
    tone,
    fontFamily,
  }: {
    cents: number;
    currency?: string;
    tone?: string;
    fontFamily?: string;
  }) => (
    <span data-tone={tone} data-font={fontFamily}>
      {`${currency}:${cents}`}
    </span>
  ),
}));

vi.mock("@th/ui", () => {
  const Text = ({
    children,
    tone,
    color,
    tag,
    id,
    role,
    title,
  }: {
    children?: ReactNode;
    tone?: string;
    color?: string;
    tag?: string;
    id?: string;
    role?: string;
    title?: string;
  }) => {
    const Tag = (tag ?? "span") as "span";
    return (
      <Tag data-tone={tone} data-color={color} id={id} role={role} title={title}>
        {children}
      </Tag>
    );
  };
  const Money = ({
    cents,
    currency,
    tone,
    fontFamily,
  }: {
    cents: number;
    currency?: string;
    tone?: string;
    fontFamily?: string;
  }) => (
    <span data-tone={tone} data-font={fontFamily}>
      {`${currency}:${cents}`}
    </span>
  );
  return {
    Text,
    Money,
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone} data-testid="debt-badge">
        {children}
      </span>
    ),
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled}>
        {children}
      </button>
    ),
    NextLinkAnchor: ({
      href,
      children,
      "aria-label": ariaLabel,
    }: {
      href: string;
      children?: ReactNode;
      "aria-label"?: string;
    }) => (
      <a href={href} aria-label={ariaLabel}>
        {children}
      </a>
    ),
    DataTable: ({
      columns,
      rows,
      getRowKey,
      emptyState,
      isLoading,
      renderMobileCard,
    }: {
      columns: Array<{ id: string; header: ReactNode; cell: (row: unknown) => ReactNode }>;
      rows: unknown[];
      getRowKey: (row: unknown, i: number) => string;
      emptyState?: ReactNode;
      isLoading?: boolean;
      renderMobileCard?: (row: unknown) => ReactNode;
    }) =>
      testState.isMobile ? (
        <div data-testid="debt-cards">
          {rows.map((row, i) => (
            <div key={getRowKey(row, i)} data-testid={`debt-card-${getRowKey(row, i)}`}>
              {renderMobileCard?.(row)}
            </div>
          ))}
        </div>
      ) : (
        <table data-testid="debt-table" data-loading={isLoading ? "1" : "0"}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.id}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td>{emptyState}</td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={getRowKey(row, i)} data-testid={`debt-row-${getRowKey(row, i)}`}>
                  {columns.map((c) => (
                    <td key={c.id} data-col={c.id}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      ),
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({
      dateTime: (d: Date) => d.toISOString(),
      currency: (n: number) => String(n),
    }),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      platform: { listPayeeDebtPositions: { fetch: testState.fetch } },
    }),
    platform: {
      listPayeeDebtPositions: {
        useQuery: () => ({
          data: testState.data,
          isLoading: testState.isLoading,
          isError: testState.isError,
          error: testState.error,
          dataUpdatedAt: testState.dataUpdatedAt,
          refetch: testState.refetch,
          isFetching: testState.isFetching,
        }),
      },
    },
  },
}));

vi.mock("@/lib/format", () => ({
  fmtDateShort: (_fmt: unknown, d: Date | string | null) =>
    d ? `short:${new Date(d).toISOString().slice(0, 10)}` : "—",
  truncateId: (id: string) => (id.length > 8 ? `${id.slice(0, 8)}...` : id),
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("@/lib/app-error", () => ({
  getAppErrorCode: (err: unknown) =>
    (err as { data?: { appCode?: string } })?.data?.appCode ?? null,
}));

import { PayeeDebtSection, ownerHref } from "../PayeeDebtSection";

const ORG_ROW = {
  payeeId: "payee-org",
  subjectType: "ORGANIZATION" as const,
  subjectId: "11111111-1111-4111-8111-111111111111",
  ownerLabel: "DRKMTTR",
  ownerSlug: "drkmttr",
  currency: "usd",
  payableCents: -12_000,
  debtSinceAt: "2026-08-01T00:00:00.000Z",
  lastDebitType: "DISPUTE_DEBIT" as const,
  lastDebitAt: "2026-08-01T00:00:00.000Z",
  disputeDebitCents: 12_000,
  refundDebitCents: 0,
  openDisputeCount: 2,
  upcomingEventCount: 3,
  nextEventAt: "2026-10-01T20:00:00.000Z",
};

const HUMAN_ROW = {
  payeeId: "payee-human",
  subjectType: "HUMAN" as const,
  subjectId: "22222222-2222-4222-8222-222222222222",
  ownerLabel: "Sole Artist",
  ownerSlug: null,
  currency: "usd",
  payableCents: -500,
  debtSinceAt: null,
  lastDebitType: "REFUND_DEBIT" as const,
  lastDebitAt: "2026-08-15T00:00:00.000Z",
  disputeDebitCents: 0,
  refundDebitCents: 500,
  openDisputeCount: 0,
  upcomingEventCount: 0,
  nextEventAt: null,
};

beforeEach(() => {
  testState.data = { items: [ORG_ROW, HUMAN_ROW], nextCursor: null, total: 2 };
  testState.isLoading = false;
  testState.isError = false;
  testState.error = null;
  testState.dataUpdatedAt = 1;
  testState.isMobile = false;
  testState.isFetching = false;
  testState.fetch.mockReset();
  testState.refetch.mockReset();
});

describe("PayeeDebtSection", () => {
  it("renders one row per (payee, currency) with the owner link, the debt in the error tone, and the debit split", () => {
    render(<PayeeDebtSection />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Payees in debt" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("debt-badge")).toHaveTextContent("2");
    expect(screen.getByTestId("debt-badge")).toHaveAttribute("data-tone", "danger");
    // Headers say exactly what is measured.
    expect(
      screen.getByRole("columnheader", { name: "Upcoming ticketed events" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Disputes (lifetime)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: /^First unrecovered debit \(Approximate/ }),
    ).toBeInTheDocument();

    const orgRow = screen.getByTestId("debt-row-payee-org:usd");
    const orgLink = screen.getByRole("link", { name: "DRKMTTR, USD ledger" });
    expect(orgLink).toHaveAttribute("href", "/admin/drkmttr");
    expect(orgRow).toContainElement(orgLink);

    // Owes = the magnitude of the negative payable, red-toned, mono.
    const owes = orgRow.querySelector('[data-col="owes"] span');
    expect(owes).toHaveTextContent("usd:12000");
    expect(owes).toHaveAttribute("data-tone", "error");
    expect(owes).toHaveAttribute("data-font", "$mono");

    expect(orgRow.querySelector('[data-col="since"]')).toHaveTextContent(
      "short:2026-08-01",
    );
    expect(orgRow.querySelector('[data-col="lastDebit"]')).toHaveTextContent(
      "Dispute",
    );
    expect(orgRow.querySelector('[data-col="disputeDebits"]')).toHaveTextContent(
      "usd:12000",
    );
    expect(orgRow.querySelector('[data-col="refundDebits"]')).toHaveTextContent(
      "usd:0",
    );
    expect(
      screen.getByRole("link", {
        name: "2 open for DRKMTTR — open the dispute desk",
      }),
    ).toHaveAttribute("href", "/platform/disputes");
    expect(orgRow.querySelector('[data-col="upcoming"]')).toHaveTextContent(
      "3Next short:2026-10-01",
    );
  });

  it("links a human owner to the platform humans search and renders 'None' in the warning tone when nothing is upcoming", () => {
    render(<PayeeDebtSection />);

    const humanRow = screen.getByTestId("debt-row-payee-human:usd");
    expect(
      screen.getByRole("link", { name: "Sole Artist, USD ledger" }),
    ).toHaveAttribute("href", "/platform/humans?q=Sole%20Artist");

    const upcoming = humanRow.querySelector('[data-col="upcoming"] span');
    expect(upcoming).toHaveTextContent("None");
    expect(upcoming).toHaveAttribute("data-tone", "warning");

    // Pending-hold-only debt has no journal crossing: "since" is a dash.
    expect(humanRow.querySelector('[data-col="since"]')).toHaveTextContent("—");
    // Zero open disputes is a muted number, not a link.
    expect(
      screen.queryByRole("link", { name: /Sole Artist — open the dispute desk/ }),
    ).not.toBeInTheDocument();
    expect(humanRow.querySelector('[data-col="openDisputes"]')).toHaveTextContent(
      "0",
    );
  });

  it("renders a pending-hold-only cell as a warning 'Held' badge with the amount muted, not as red Owes", () => {
    testState.data = {
      items: [
        {
          ...HUMAN_ROW,
          payeeId: "payee-held",
          ownerLabel: "Held Venue",
          debtSinceAt: null,
          lastDebitType: null,
          lastDebitAt: null,
          refundDebitCents: 0,
          payableCents: -3_000,
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayeeDebtSection />);
    const row = screen.getByTestId("debt-row-payee-held:usd");
    const badge = row.querySelector('[data-col="owes"] [data-testid="debt-badge"]');
    expect(badge).toHaveTextContent("Held");
    expect(badge).toHaveAttribute("data-tone", "warning");
    expect(row.querySelector('[data-col="owes"]')).toHaveTextContent("(dispute pending)");
    const amount = row.querySelector('[data-col="owes"] span[data-font="$mono"]');
    expect(amount).toHaveTextContent("usd:3000");
    expect(amount).toHaveAttribute("data-tone", "muted");
    expect(row.querySelector('[data-col="since"]')).toHaveTextContent("—");
    expect(row.querySelector('[data-col="lastDebit"]')).toHaveTextContent("—");
  });

  it("renders the statement-timeout error inline with a retry that refetches", () => {
    testState.data = null;
    testState.isError = true;
    testState.error = Object.assign(new Error("payee_ledger_debt_positions_timeout"), {
      data: { appCode: "SERVICE_UNAVAILABLE" },
    });
    render(<PayeeDebtSection />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Debt view timed out — try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry debt view" }));
    expect(testState.refetch).toHaveBeenCalledTimes(1);
    // Ordinary errors do not get the timeout copy.
    expect(screen.queryByText("payee_ledger_debt_positions_timeout")).not.toBeInTheDocument();
  });

  it("shows the empty state when nobody owes anything", () => {
    testState.data = { items: [], nextCursor: null, total: 0 };
    render(<PayeeDebtSection />);
    expect(
      screen.getByText("No payee owes the platform anything."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("debt-badge")).toHaveTextContent("0");
    expect(screen.getByTestId("debt-badge")).toHaveAttribute("data-tone", "neutral");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("surfaces a query error", () => {
    testState.data = null;
    testState.isError = true;
    testState.error = new Error("ledger unavailable");
    render(<PayeeDebtSection />);
    expect(screen.getByText("ledger unavailable")).toBeInTheDocument();
  });

  it("loads the next cursor page on demand and appends it", async () => {
    testState.data = { items: [ORG_ROW], nextCursor: "c1", total: 2 };
    testState.fetch.mockResolvedValueOnce({
      items: [HUMAN_ROW],
      nextCursor: null,
      total: 1,
    });
    render(<PayeeDebtSection />);

    const more = screen.getByRole("button", { name: "Load more payees in debt" });
    await act(async () => {
      fireEvent.click(more);
    });

    expect(testState.fetch).toHaveBeenCalledWith({ cursor: "c1", limit: 25 });
    await waitFor(() =>
      expect(screen.getByTestId("debt-row-payee-human:usd")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("debt-row-payee-org:usd")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more payees in debt" }),
    ).not.toBeInTheDocument();
  });

  it("reports a load-more failure inline and keeps the button", async () => {
    testState.data = { items: [ORG_ROW], nextCursor: "c1", total: 2 };
    testState.fetch.mockRejectedValueOnce(new Error("cursor expired"));
    render(<PayeeDebtSection />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Load more payees in debt" }),
      );
    });

    expect(await screen.findByText("cursor expired")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Load more payees in debt" }),
    ).toBeInTheDocument();
  });

  it("card mode puts the Held badge on its own line under the owner row", () => {
    testState.isMobile = true;
    testState.data = {
      items: [
        {
          ...HUMAN_ROW,
          payeeId: "payee-held",
          ownerLabel: null,
          debtSinceAt: null,
          lastDebitType: null,
          lastDebitAt: null,
          refundDebitCents: 0,
          payableCents: -1_250,
          currency: "mxn",
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayeeDebtSection />);
    const card = screen.getByTestId("debt-card-payee-held:mxn");
    const badges = card.querySelectorAll('[data-testid="debt-badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("Held");
    expect(card).toHaveTextContent("(dispute pending)");
    expect(card).toHaveTextContent("mxn:1250");
    expect(card).toHaveTextContent("22222222...");
  });

  it("renders card mode on phones with the same owner link and warning tone", () => {
    testState.isMobile = true;
    render(<PayeeDebtSection />);

    const card = screen.getByTestId("debt-card-payee-human:usd");
    expect(card).toContainElement(
      screen.getByRole("link", { name: "Sole Artist, USD ledger" }),
    );
    const none = Array.from(card.querySelectorAll("span")).find(
      (el) => el.textContent === "None",
    );
    expect(none).toHaveAttribute("data-tone", "warning");
    expect(card).toHaveTextContent("First unrecovered debit —");
    // Card mode: label + count on one line, the next date as its own line.
    const orgCard = screen.getByTestId("debt-card-payee-org:usd");
    expect(orgCard).toHaveTextContent("Upcoming ticketed3");
    expect(orgCard).toHaveTextContent("Next short:2026-10-01");
    expect(card).toHaveTextContent("Last debit: Refund short:2026-08-15");
  });
});

describe("PayeeDebtSection — cash sale debt", () => {
  it("names a door cash sale's fee + tax as the last debit", () => {
    testState.isMobile = true;
    testState.data = {
      items: [
        {
          ...HUMAN_ROW,
          payeeId: "payee-cash",
          lastDebitType: "CASH_SALE_DEBIT" as const,
          refundDebitCents: 0,
        },
      ],
      nextCursor: null,
      total: 1,
    };
    render(<PayeeDebtSection />);

    expect(screen.getByTestId("debt-card-payee-cash:usd")).toHaveTextContent(
      "Last debit: Cash sale short:2026-08-15",
    );
  });
});

describe("ownerHref", () => {
  const base = { ...HUMAN_ROW, debtSinceAt: null, lastDebitAt: null, nextEventAt: null };
  it("has no link for a slugless organisation or a nameless human", () => {
    expect(
      ownerHref({ ...base, subjectType: "ORGANIZATION", ownerSlug: null }),
    ).toBeNull();
    expect(ownerHref({ ...base, subjectType: "HUMAN", ownerLabel: "  " })).toBeNull();
  });
  it("URL-encodes the organisation slug", () => {
    expect(
      ownerHref({ ...base, subjectType: "ORGANIZATION", ownerSlug: "a/b c" }),
    ).toBe("/admin/a%2Fb%20c");
  });
});
