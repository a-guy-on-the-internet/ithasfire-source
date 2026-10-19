import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TicketTypeEditor } from "../TicketTypeEditor";

/**
 * Pay What You Want has no list price: the buyer names it (within the
 * minimum), and `upsertTicketType` stores 0 for ADJUSTABLE whatever it is
 * sent. So neither the add nor the edit form may show a "Price ($)" field in
 * that mode — it was shown, unused — and both must still send `priceCents: 0`.
 *
 * Mock scaffolding copied from `TicketTypeEditorSchedule.test.tsx` (the one
 * that already drives the edit form off `listTicketTypesForEdit` rows).
 */

const upsertMutate = vi.fn();
const updateMutate = vi.fn();
const toastDanger = vi.fn();
const toastSuccess = vi.fn();

/** The event under edit lives on Central time; the runner does not. */
const EVENT_TIMEZONE = "America/Chicago";

/**
 * Mutable query state, hoisted so the `vi.mock` factory below can close over
 * it. Lets one test swap in a row that already HAS a stored schedule without a
 * second mock module.
 */
const queryState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  timezone: "America/Chicago" as string | null,
  feePreview: undefined as unknown,
}));

const UNSCHEDULED_ROW = {
  id: "tt_1",
  name: "Early Bird",
  priceCents: 1200,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE",
  seatSectionId: null,
  layoutSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  effectivePriceCents: 1200,
};

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    onPress,
    "data-testid": testId,
    "aria-checked": ariaChecked,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "data-testid"?: string;
    "aria-checked"?: boolean;
  }) => (
    <div
      data-testid={testId}
      data-checked={String(ariaChecked)}
      onClick={onPress}
    >
      {children}
    </div>
  );
  return {
    XStack: passthrough,
    YStack: passthrough,
    styled: () => passthrough,
    useTheme: () => ({}),
  };
});

vi.mock("lucide-react", () => {
  const icon = () => <span />;
  return {
    Plus: icon,
    Ticket: icon,
    Edit3: icon,
    Trash2: icon,
    X: icon,
    Check: icon,
    Info: icon,
    DollarSign: icon,
    UserCheck: icon,
    Repeat: icon,
    CreditCard: icon,
    ExternalLink: icon,
    CalendarClock: icon,
    CalendarRange: icon,
    AlertTriangle: icon,
  };
});

// `vi.mock` factories are hoisted above the imports, so the forwardRef helper
// is hoisted too and reaches React through a dynamic require.
const { forwardRefForMock } = vi.hoisted(() => ({
  forwardRefForMock: function forwardRefForMock<P, R>(
    render: (props: P, ref: React.Ref<R>) => React.ReactElement,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("react") as typeof React).forwardRef<R, P>(
      render as React.ForwardRefRenderFunction<R, React.PropsWithoutRef<P>>,
    );
  },
}));

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    id,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    id?: string;
    "data-testid"?: string;
  }) => (
    <span id={id} data-testid={testId}>
      {children}
    </span>
  ),
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  // Enter is wired to `onSubmitEditing` exactly as react-native-web wires it on
  // a single-line input — the one path that reaches `handleAdd` while the
  // footer button is disabled, and therefore how these tests prove the
  // handler's own refusal still exists underneath the disabled button.
  // forwardRef + aria passthrough, like the real TextInput: the editor
  // focuses a refused field and links it to its inline message.
  TextInput: forwardRefForMock(
    (
      {
        value,
        onChangeText,
        onSubmitEditing,
        testId,
        "aria-invalid": ariaInvalid,
        "aria-describedby": ariaDescribedBy,
      }: {
        value?: string;
        onChangeText?: (v: string) => void;
        onSubmitEditing?: () => void;
        testId?: string;
        "aria-invalid"?: boolean;
        "aria-describedby"?: string;
      },
      ref: React.Ref<HTMLInputElement>,
    ) => (
      <input
        ref={ref}
        data-testid={testId}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        value={value ?? ""}
        onChange={(e) => onChangeText?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmitEditing?.();
        }}
      />
    ),
  ),
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  useNotify: () => ({
    toast: { success: toastSuccess, danger: toastDanger },
  }),
  // Echo the key + its args so an assertion can tell i18n copy from a
  // hardcoded literal AND read what was interpolated into the read-back.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}|${JSON.stringify(values)}` : key,
  useFormatters: () => ({
    currency: (n: number) => `$${n.toFixed(2)}`,
    // The REAL Intl formatter: the read-back's whole job is to prove the
    // instant landed on the event's clock, so stubbing it away would test
    // nothing.
    dateTime: (value: Date, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listTicketTypesForEdit: { invalidate: vi.fn(), cancel: vi.fn() },
        getEventFeePreview: {
          invalidate: vi.fn(),
          cancel: vi.fn(),
          getData: vi.fn(),
          setData: vi.fn(),
        },
      },
    }),
    events: {
      listTicketTypesForEdit: {
        useQuery: () => ({
          data: { ticketTypes: queryState.rows },
          isPending: false,
        }),
      },
      getEventForEdit: {
        useQuery: () => ({
          data: queryState.timezone
            ? { timezone: queryState.timezone, currency: "usd" }
            : undefined,
        }),
      },
      getEventFeePreview: {
        useQuery: () => ({ data: queryState.feePreview }),
      },
    },
    ticketTypes: {
      upsertTicketType: {
        useMutation: () => ({ mutateAsync: upsertMutate, isPending: false }),
      },
      updateTicketType: {
        useMutation: () => ({ mutateAsync: updateMutate, isPending: false }),
      },
      deleteTicketType: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
  },
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: false } }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "org" }) }));

vi.mock("../EventEditorSheet", () => ({ EventEditorSheet: () => null }));
vi.mock("../TicketTypeTemplateControls", () => ({
  TicketTypeTemplateControls: () => null,
}));
vi.mock("../TicketTypePresetPicker", () => ({
  TicketTypePresetPicker: () => null,
}));
vi.mock("../_form-bits", () => ({
  FieldLabel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  // The real one is a Tamagui styled("input"); a plain input keeps the
  // datetime-local value semantics this test drives.
  NativeDateTimeInput: ({
    value,
    onChange,
    "data-testid": testId,
  }: {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    "data-testid"?: string;
  }) => (
    <input
      type="datetime-local"
      data-testid={testId}
      value={value ?? ""}
      onChange={onChange}
    />
  ),
}));
vi.mock("../_mobile-bits", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    EditorCard: passthrough,
    EditorCardActions: passthrough,
    EditorCardMeta: passthrough,
    EditorCardTitle: passthrough,
  };
});

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

const PWYW_ROW = {
  ...UNSCHEDULED_ROW,
  id: "tt_pwyw",
  name: "Sliding scale",
  priceCents: 0,
  pricingMode: "ADJUSTABLE",
  minimumCents: 500,
  suggestedCents: 1500,
  effectivePriceCents: 0,
};

/** The pricing-mode toggle has no testId; it is identified by its label. */
const switchTo = (label: "Pay What You Want") => {
  const toggles = screen.getAllByText(label);
  fireEvent.click(toggles[toggles.length - 1]!);
};

describe("TicketTypeEditor — Price is hidden for Pay What You Want", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    updateMutate.mockResolvedValue({});
  });

  it("add form: Price shows for a fixed price and goes away for PWYW, which still sends 0", async () => {
    queryState.rows = [];
    render(<TicketTypeEditor eventId="evt_1" />);
    // No tiers yet → the empty state's "custom ticket" button opens the form.
    fireEvent.click(screen.getByTestId("ticket-type-custom-btn"));
    type("ticket-type-add-name", "Door");
    type("ticket-type-add-capacity", "100");
    // Fixed is the default, and it has a price.
    expect(screen.getByTestId("ticket-type-add-price")).toBeInTheDocument();
    // Typed BEFORE switching: a stale value must not ride along.
    type("ticket-type-add-price", "20.00");

    switchTo("Pay What You Want");
    expect(screen.queryByTestId("ticket-type-add-price")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.ttPrice")).not.toBeInTheDocument();
    type("ticket-type-add-minimum", "5.00");

    fireEvent.click(screen.getByTestId("ticket-type-add-submit"));
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      pricingMode: "ADJUSTABLE",
      priceCents: 0,
      minimumCents: 500,
    });
  });

  it("edit form: a PWYW tier opens with no Price field and saves priceCents 0", async () => {
    queryState.rows = [PWYW_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));

    expect(screen.getByTestId("ticket-type-edit-name")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-type-edit-price")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({
      pricingMode: "ADJUSTABLE",
      priceCents: 0,
      minimumCents: 500,
      suggestedCents: 1500,
    });
  });

  it("edit form: a fixed tier keeps its Price field until switched to PWYW", () => {
    queryState.rows = [UNSCHEDULED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));

    expect(screen.getByTestId("ticket-type-edit-price")).toBeInTheDocument();
    switchTo("Pay What You Want");
    expect(screen.queryByTestId("ticket-type-edit-price")).not.toBeInTheDocument();
  });
});

describe("TicketTypeEditor — PWYW minimum / suggestion are capped at $10,000.00", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    updateMutate.mockResolvedValue({});
  });

  it("add form: $10,000.01 shows the inline message and is never sent", async () => {
    queryState.rows = [];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-custom-btn"));
    type("ticket-type-add-name", "Door");
    type("ticket-type-add-capacity", "100");
    switchTo("Pay What You Want");

    type("ticket-type-add-suggested", "10000.01");
    const message = screen.getByTestId("ticket-type-add-suggested-above-cap");
    expect(message).toHaveTextContent("admin.ttPwywAboveCap");
    expect(message).toHaveTextContent("10000.00");

    fireEvent.click(screen.getByTestId("ticket-type-add-submit"));
    // Give a would-be mutation a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upsertMutate).not.toHaveBeenCalled();

    // Exactly the cap is fine.
    type("ticket-type-add-suggested", "10000");
    expect(
      screen.queryByTestId("ticket-type-add-suggested-above-cap"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ticket-type-add-submit"));
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      suggestedCents: 1_000_000,
    });
  });

  it("edit form: a $10,000.01 minimum shows the inline message and is never sent", async () => {
    queryState.rows = [PWYW_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));

    type("ticket-type-edit-minimum", "10,000.01");
    expect(
      screen.getByTestId("ticket-type-edit-minimum-above-cap"),
    ).toHaveTextContent("admin.ttPwywAboveCap");

    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("TicketTypeEditor — the builder's 'Buyer pays' includes tax", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
  });

  it("regression: shows the Tax line and the event page's all-in figure", () => {
    queryState.rows = [
      { ...UNSCHEDULED_ROW, id: "tt_ga", name: "General Admission", priceCents: 3500, effectivePriceCents: 3500 },
    ];
    // What getEventFeePreview now returns for a $35 PASS_THROUGH ticket at
    // 8.88% — the same numbers getCheckoutFeeRates quotes the event page
    // (pinned in core: fee-preview-matches-event-page.test.ts).
    queryState.feePreview = {
      eventId: "evt_1",
      feeMode: "PASS_THROUGH",
      policyRates: null,
      ticketBreakdowns: [
        {
          ticketTypeId: "tt_ga",
          name: "General Admission",
          unitPriceCents: 3500,
          platformFeeCents: 50,
          processorFeeCents: 147,
          taxEstimateCents: 311,
          buyerTotalCents: 4008,
          eventCreditCents: 3500,
        },
      ],
    };
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(screen.getByText(/admin\.ttFeeTax/)).toHaveTextContent("$3.11");
    // The fee is charged once, on top: the event is credited the full
    // price (docs/decisions/platform-fee-charged-once.md).
    expect(screen.getByTestId("tt-fee-event-credit")).toHaveTextContent(
      "admin.ttFeeEventCredit: $35.00",
    );
    expect(screen.getByText(/admin\.ttFeeBuyerTotal/)).toHaveTextContent(
      "$40.08",
    );
    // Our fee is called "Platform fee" (the owner's ruling — not the
    // catalog's older "Service fee"). The ABSORB "your cost" / "You get"
    // variant is gone with ABSORB (docs/decisions/absorb-removed.md).
    expect(screen.getByTestId("tt-fee-platform")).toHaveTextContent(
      "admin.ttFeePlatformFee",
    );
    expect(screen.getByTestId("tt-fee-platform")).not.toHaveTextContent(
      "YourCost",
    );
    expect(screen.queryByTestId("tt-fee-you-get")).not.toBeInTheDocument();
    queryState.feePreview = undefined;
  });
});

describe("TicketTypeEditor — an above-cap PWYW field is announced and focused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
  });

  it("aria-invalid + aria-describedby → the inline message; Save refused and focuses it", async () => {
    queryState.rows = [];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-custom-btn"));
    type("ticket-type-add-name", "Door");
    type("ticket-type-add-capacity", "100");
    switchTo("Pay What You Want");

    const minimum = screen.getByTestId("ticket-type-add-minimum");
    expect(minimum).not.toHaveAttribute("aria-invalid");
    type("ticket-type-add-minimum", "10000.01");
    expect(minimum).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByTestId("ticket-type-add-minimum-above-cap");
    expect(minimum).toHaveAttribute("aria-describedby", message.id);

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByTestId("ticket-type-add-submit"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(minimum);
  });
});
