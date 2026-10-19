import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Payout lines for a viewer who may NOT edit terms (the act side, or any
 * party outside DRAFT): the share is plain text, and there is no edit,
 * remove, add-payee, or apply-counter affordance anywhere. The editor on a
 * DRAFT gets all of them. `mayEdit` comes from the server
 * (`bookingAgreements.get`), so this proves the prop is honoured — the rule
 * itself is pinned in core.
 */

const KEEP = (k: string) =>
  k === "id" || k === "role" || k === "disabled" || k.startsWith("aria-");

function domProps(rest: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (KEEP(k)) safe[k] = v;
    else if (k === "testID" || k === "testId") safe["data-testid"] = v;
  }
  return safe;
}

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  }),
  Spinner: () => <span data-testid="spinner" />,
  Badge: ({ children }: any) => <span>{children}</span>,
  Button: ({ children, onPress, ...rest }: any) => (
    <button onClick={onPress} {...domProps(rest)}>
      {children}
    </button>
  ),
  Text: ({ children, tag, htmlFor, ...rest }: any) =>
    tag === "label" ? (
      <label htmlFor={htmlFor} {...domProps(rest)}>
        {children}
      </label>
    ) : (
      <span {...domProps(rest)}>{children}</span>
    ),
  TextInput: ({ value, onChangeText, ...rest }: any) => (
    <input
      value={value}
      onChange={(e) => onChangeText?.(e.target.value)}
      {...domProps(rest)}
    />
  ),
}));

vi.mock("tamagui", () => {
  const passthrough = () => (props: any) => {
    const { children, ...rest } = props;
    return <div {...domProps(rest)}>{children}</div>;
  };
  return { XStack: passthrough(), YStack: passthrough() };
});

vi.mock("lucide-react", () => {
  const icon = () => <span aria-hidden="true" />;
  return { Pencil: icon, Plus: icon, Trash2: icon };
});

vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="confirm-dialog" /> : null,
}));

vi.mock(
  "@/app/admin/[slug]/events/new/_components/HumanSearchCombobox",
  () => ({
    HumanSearchCombobox: ({ testId }: { testId?: string }) => (
      <input data-testid={testId} />
    ),
  }),
);

vi.mock("@/trpc", () => {
  // Inline: `vi.mock` is hoisted, so a top-level helper is not yet defined.
  const mutation = () => ({
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  });
  return {
    trpc: {
      bookingAgreements: { upsertLine: mutation(), removeLine: mutation() },
      payoutTerms: { confirmPayoutLine: mutation() },
    },
  };
});

import { PayoutLinesSection } from "../PayoutLinesSection";

const LINE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LINE = {
  id: LINE_ID,
  payeeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subjectType: "human" as const,
  subjectId: "77777777-7777-4777-8777-777777777777",
  displayName: "Sax Player",
  payeeStatus: "ACTIVE" as const,
  percent: 10,
  floorCents: 0,
  capPercent: null,
  priority: 0,
  requiresConfirmation: true,
  confirmationStatus: "COUNTERED" as const,
  confirmedAt: null,
  counterPercentBps: 1500,
  counterNote: "Fifteen is the going rate for a full set.",
};

type Props = React.ComponentProps<typeof PayoutLinesSection>;

function renderSection(overrides: Partial<Props> = {}) {
  return render(
    <PayoutLinesSection
      agreementId="11111111-1111-4111-8111-111111111111"
      status="DRAFT"
      lines={[LINE]}
      mayEdit
      viewer={{ humanId: null, adminOrgIds: [] }}
      onRefresh={vi.fn()}
      onActionError={vi.fn()}
      {...overrides}
    />,
  );
}

describe("PayoutLinesSection — read-only terms (mayEdit=false)", () => {
  it("shows the share as text with no edit / remove / add affordances", () => {
    renderSection({ mayEdit: false });

    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.queryByTestId(`ba-line-edit-${LINE_ID}`)).toBeNull();
    expect(screen.queryByTestId(`ba-line-remove-${LINE_ID}`)).toBeNull();
    expect(screen.queryByTestId(`ba-line-apply-counter-${LINE_ID}`)).toBeNull();
    expect(screen.queryByTestId("ba-add-line")).toBeNull();
    expect(screen.queryByTestId("ba-add-payee-search")).toBeNull();
    expect(screen.queryByTestId("ba-add-percent")).toBeNull();
  });

  it("still shows the open counter-ask — visible to every viewer of the line", () => {
    renderSection({ mayEdit: false });
    expect(screen.getByTestId(`ba-line-counter-ask-${LINE_ID}`)).toBeInTheDocument();
  });

  it("is read-only even on DRAFT (the act side of a linked agreement)", () => {
    renderSection({ mayEdit: false, status: "DRAFT" });
    expect(screen.queryByTestId(`ba-line-edit-${LINE_ID}`)).toBeNull();
    expect(screen.queryByTestId("ba-add-line")).toBeNull();
  });
});

describe("PayoutLinesSection — editor on a DRAFT", () => {
  it("renders edit, remove, and the add-payee form", () => {
    renderSection();

    expect(screen.getByTestId(`ba-line-edit-${LINE_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ba-line-remove-${LINE_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId("ba-add-line")).toBeInTheDocument();
    expect(screen.getByTestId("ba-add-payee-search")).toBeInTheDocument();
  });

  it("locks the rows outside DRAFT even for the editor", () => {
    renderSection({ status: "PROPOSED" });
    expect(screen.queryByTestId(`ba-line-edit-${LINE_ID}`)).toBeNull();
    expect(screen.queryByTestId("ba-add-line")).toBeNull();
  });
});
