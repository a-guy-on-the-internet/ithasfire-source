import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// `splits.listForOrder` is ADMIN-only, but /platform/orders is open to ADMIN,
// SUPPORT and DEVELOPER. The behaviour under test is therefore as much about
// the query that must NOT be fired as it is about the table that renders when
// it is.
// ─────────────────────────────────────────────────────────────────────────────

type SplitsQueryState = {
  data?: {
    orderId: string;
    splits: Array<{
      id: string;
      payeeId: string;
      amountCents: number;
      payee: {
        id: string;
        subjectType: string;
        subjectId: string;
        stripeAccountId: string | null;
        payoutsEnabled: boolean;
      };
    }>;
    totalCents: number;
  };
  isLoading: boolean;
  isError: boolean;
  error: unknown;
};

const staffState: { roles: string[]; isLoading: boolean } = {
  roles: ["ADMIN"],
  isLoading: false,
};

const splitsState: { current: SplitsQueryState } = {
  current: { isLoading: false, isError: false, error: null },
};

/** Every `useQuery` call made against `splits.listForOrder`, options included. */
const splitsQueryCalls = vi.fn();

vi.mock("tamagui", async () => {
  const React = await import("react");
  // Props are forwarded selectively: tamagui style props are not valid DOM
  // attributes, but `id` / `role` / `aria-*` are exactly what the assertions
  // about duplicate ids and the error alert depend on.
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const passthrough: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === "id" || key === "role" || key.startsWith("aria-")) {
        passthrough[key] = value;
      }
    }
    return React.createElement("div", passthrough, children);
  };
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => {
  const Text = ({
    children,
    id,
    role,
    tone,
  }: {
    children?: ReactNode;
    id?: string;
    role?: string;
    tone?: string;
  }) => (
    <span id={id} role={role} data-tone={tone}>
      {children}
    </span>
  );
  return {
    Text,
    Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
      <span data-tone={tone}>{children}</span>
    ),
    useTranslations: () => (key: string) => {
      const dict: Record<string, string> = {
        "admin.plSplits": "Revenue Splits",
        "admin.plSplitsPayee": "Payee",
        "admin.plSplitsAmount": "Amount",
        "admin.plSplitsTotal": "Split total",
        "admin.plSplitsEmpty": "No splits recorded for this order.",
        "admin.plSplitsLoading": "Loading splits…",
        "admin.plSplitsError": "Couldn't load splits.",
        "admin.plSplitsAdminOnly":
          "Split amounts are visible to platform admins.",
        "admin.plSplitsPayoutsOff": "Payouts off",
        "admin.pstPayoutKindOrg": "Group",
        "admin.pstPayoutKindHuman": "Human",
        // Deliberately Spanish: `formatErrorMessage` also carries an ENGLISH
        // fallback dictionary, so only non-English catalog copy proves which
        // of the two resolved the code.
        "errors.orderNotFound": "Pedido no encontrado.",
      };
      // A missing key resolves to the key itself, same as the real translator
      // — which is exactly how `formatErrorMessage` detects a catalog miss.
      return dict[key] ?? key;
    },
  };
});

// The mandatory money primitive, stubbed to the `${currency}:${cents}` shape
// the sibling platform tests use — the assertions are about WHICH amounts land
// where, not about Intl's output on the runner.
vi.mock("../../../_components/MoneyText", () => ({
  MoneyText: ({ cents, currency }: { cents: number; currency?: string }) => (
    <span data-testid="money">{`${currency}:${cents}`}</span>
  ),
}));

vi.mock("@/lib/format", () => ({
  truncateId: (id: string) => `${id.slice(0, 8)}...`,
  truncateProviderId: (id: string) => id,
}));

// `@/lib/format-error-message` is deliberately NOT mocked. It has no imports,
// and stubbing it to `(e) => e.message` is precisely what hid this component
// calling it WITHOUT a translator: the stub ignored the second argument, so an
// untranslated coded error looked identical to a translated one.

vi.mock("@/trpc", () => ({
  trpc: {
    platform: {
      checkStaffAccess: {
        useQuery: () => ({
          data: staffState.isLoading
            ? undefined
            : { allowed: true, roles: staffState.roles, actorHumanId: "a" },
          isLoading: staffState.isLoading,
        }),
      },
    },
    splits: {
      listForOrder: {
        useQuery: (
          input: { orderId: string },
          opts?: { enabled?: boolean },
        ) => {
          splitsQueryCalls(input, opts);
          // Mirrors react-query: a disabled query is pending but NOT loading,
          // and never holds data or an error.
          if (!opts?.enabled) {
            return {
              data: undefined,
              isLoading: false,
              isError: false,
              error: null,
            };
          }
          return splitsState.current;
        },
      },
    },
  },
}));

import { OrderSplitsSection } from "../OrderSplitsSection";

const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
const ORG_ID = "2b7f0a11-1111-4c22-9999-aaaabbbbcccc";
const BUYER_ID = "4d4d4d4d-2222-4c22-9999-ddddeeeeffff";

const props = {
  orderId: ORDER_ID,
  currency: "usd",
  orgId: ORG_ID,
  orgName: "Drkmttr",
  buyerHumanId: BUYER_ID,
  buyerName: "Mika Vigeant",
};

const orgSplit = {
  id: "11111111-1111-4111-8111-111111111111",
  payeeId: "99999999-1111-4111-8111-111111111111",
  amountCents: 4200,
  payee: {
    id: "99999999-1111-4111-8111-111111111111",
    subjectType: "ORGANIZATION",
    subjectId: ORG_ID,
    stripeAccountId: "acct_1ABCDEFGHIJKLMNO",
    payoutsEnabled: true,
  },
};

const humanSplit = {
  id: "22222222-2222-4222-8222-222222222222",
  payeeId: "88888888-2222-4222-8222-222222222222",
  amountCents: 800,
  payee: {
    id: "88888888-2222-4222-8222-222222222222",
    subjectType: "HUMAN",
    subjectId: "77777777-3333-4333-8333-333333333333",
    stripeAccountId: null,
    payoutsEnabled: false,
  },
};

const loaded = (
  splits: Array<typeof orgSplit | typeof humanSplit>,
): SplitsQueryState => ({
  data: {
    orderId: ORDER_ID,
    splits,
    totalCents: splits.reduce((sum, s) => sum + s.amountCents, 0),
  },
  isLoading: false,
  isError: false,
  error: null,
});

beforeEach(() => {
  staffState.roles = ["ADMIN"];
  staffState.isLoading = false;
  splitsState.current = loaded([orgSplit, humanSplit]);
  splitsQueryCalls.mockClear();
});

describe("OrderSplitsSection", () => {
  it("shows the split rows, payee identities and total to an ADMIN", () => {
    render(<OrderSplitsSection {...props} />);

    expect(screen.getByText("Revenue Splits (2)")).toBeInTheDocument();
    // The org payee is named from the order row it already has in hand.
    expect(screen.getByText("Drkmttr")).toBeInTheDocument();
    // A payee the order cannot name falls back to its kind, never a blank.
    expect(screen.getByText("Human")).toBeInTheDocument();

    expect(screen.getByText("usd:4200")).toBeInTheDocument();
    expect(screen.getByText("usd:800")).toBeInTheDocument();
    expect(screen.getByText("Split total")).toBeInTheDocument();
    expect(screen.getByText("usd:5000")).toBeInTheDocument();

    // The exception is badged; the healthy payee is not.
    expect(screen.getAllByText("Payouts off")).toHaveLength(1);

    expect(splitsQueryCalls).toHaveBeenCalledWith(
      { orderId: ORDER_ID },
      expect.objectContaining({ enabled: true }),
    );
  });

  it("never fires the ADMIN-only query for a SUPPORT actor", () => {
    staffState.roles = ["SUPPORT"];

    render(<OrderSplitsSection {...props} />);

    expect(splitsQueryCalls).toHaveBeenCalled();
    for (const [, opts] of splitsQueryCalls.mock.calls) {
      expect(opts).toMatchObject({ enabled: false });
    }
  });

  it("tells a SUPPORT actor the section is admin-only instead of erroring", () => {
    staffState.roles = ["SUPPORT"];

    render(<OrderSplitsSection {...props} />);

    expect(
      screen.getByText("Split amounts are visible to platform admins."),
    ).toBeInTheDocument();
    // No manufactured failure: no alert, no error copy, no amounts.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load splits.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("money")).not.toBeInTheDocument();
    // And it must not read as "this order has no splits" either.
    expect(
      screen.queryByText("No splits recorded for this order."),
    ).not.toBeInTheDocument();
  });

  it("does the same for a DEVELOPER actor", () => {
    staffState.roles = ["DEVELOPER"];

    render(<OrderSplitsSection {...props} />);

    expect(
      screen.getByText("Split amounts are visible to platform admins."),
    ).toBeInTheDocument();
    for (const [, opts] of splitsQueryCalls.mock.calls) {
      expect(opts).toMatchObject({ enabled: false });
    }
  });

  it("renders an empty state, not a failure, for an order with no splits", () => {
    splitsState.current = loaded([]);

    render(<OrderSplitsSection {...props} />);

    expect(screen.getByText("Revenue Splits (0)")).toBeInTheDocument();
    expect(
      screen.getByText("No splits recorded for this order."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Payee")).not.toBeInTheDocument();
  });

  it("surfaces a load failure as an alert naming the section", () => {
    // Already-human server copy is passed through verbatim by the real
    // formatter, so the alert reads "<section failed> <why>".
    splitsState.current = {
      isLoading: false,
      isError: true,
      error: new Error("Splits are temporarily unavailable."),
    };

    render(<OrderSplitsSection {...props} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load splits.");
    expect(alert).toHaveTextContent("Splits are temporarily unavailable.");
  });

  it("resolves a coded failure through the i18n catalog, not English copy", () => {
    // The regression: `formatErrorMessage(error)` called WITHOUT the
    // translator never consults `errors.*`, so an `es` admin got hardcoded
    // English next to a Spanish page — announced only by a console.warn, which
    // is not Sentry-captured.
    splitsState.current = {
      isLoading: false,
      isError: true,
      error: new Error("ORDER_NOT_FOUND"),
    };

    render(<OrderSplitsSection {...props} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Pedido no encontrado.");
    // Not the generic English fallback the no-translator path lands on.
    expect(alert).not.toHaveTextContent(
      "Something went wrong. Please try again or contact support.",
    );
  });

  it("shows loading while the role probe is still in flight", () => {
    // The regression this guards: deriving "not an admin" from an unresolved
    // role probe flashes the admin-only note at an actual admin.
    staffState.isLoading = true;

    render(<OrderSplitsSection {...props} />);

    expect(screen.getByText("Loading splits…")).toBeInTheDocument();
    expect(
      screen.queryByText("Split amounts are visible to platform admins."),
    ).not.toBeInTheDocument();
  });

  it("shows loading while the splits query itself is in flight", () => {
    splitsState.current = { isLoading: true, isError: false, error: null };

    render(<OrderSplitsSection {...props} />);

    expect(screen.getByText("Loading splits…")).toBeInTheDocument();
  });

  it("scopes the section heading id by order, since panels stack", () => {
    // Several order panels can be expanded at once; an unscoped id would be
    // duplicated in the document and break `aria-labelledby`.
    const { container } = render(<OrderSplitsSection {...props} />);

    expect(
      container.querySelector(`#order-splits-heading-${ORDER_ID}`),
    ).not.toBeNull();
    expect(
      container.querySelector(
        `[aria-labelledby="order-splits-heading-${ORDER_ID}"]`,
      ),
    ).not.toBeNull();
  });
});
