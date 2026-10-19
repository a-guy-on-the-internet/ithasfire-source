import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TicketTypeEditor } from "../TicketTypeEditor";

/**
 * The `handleAdd` money wiring, end to end through the real component.
 *
 * The pure reader is covered by `ticket-amount-field.test.ts`; what this file
 * pins is the SEAM the pure test can't see — `parseAmountField`'s three-way
 * `number | null | undefined` return and what each arm does to the submit:
 *
 *  - blank price  → `priceCents: 0` is SENT (a blank price is a free ticket)
 *  - blank optional → `null` is SENT (not `0` — a $0 minimum is a real, and
 *    very different, pay-what-you-want setting)
 *  - unreadable   → the mutation is NEVER called, and the in-flight flag is
 *    never set, so the form stays usable
 *
 * Mocks follow the pattern already used by `AttendeeFeedbackTab.test.tsx` in
 * this directory. `@/lib/money/parse-money-input` and `./ticket-type-presets`
 * are deliberately NOT mocked — they are the thing under test.
 */

const upsertMutate = vi.fn();
const toastDanger = vi.fn();
const toastSuccess = vi.fn();

vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    onPress,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "data-testid"?: string;
  }) => (
    <div data-testid={testId} onClick={onPress}>
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

// Enumerated, NOT a catch-all Proxy: a proxy that answers every property also
// answers `then`, which makes the module namespace look like a thenable and
// hangs `import()` forever.
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
    // Scheduled price change (FR-005). Enumerated like the rest — a catch-all
    // Proxy would answer `then` and hang the dynamic import.
    CalendarClock: icon,
    CalendarRange: icon,
    AlertTriangle: icon,
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  TextInput: ({
    value,
    onChangeText,
    testId,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
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
  // Echo the key so an assertion can tell i18n copy from a hardcoded literal.
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({
    currency: (n: number) => `$${n.toFixed(2)}`,
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
        useQuery: () => ({ data: { ticketTypes: [] }, isPending: false }),
      },
      // Supplies `Event.timezone` to the scheduled-price control (FR-007).
      // The schedule assertions live in `TicketTypeEditorSchedule.test.tsx`;
      // this file only needs the query to exist so the editor renders.
      getEventForEdit: {
        useQuery: () => ({
          data: { timezone: "America/Chicago", currency: "usd" },
        }),
      },
      getEventFeePreview: { useQuery: () => ({ data: undefined }) },
    },
    ticketTypes: {
      upsertTicketType: {
        useMutation: () => ({ mutateAsync: upsertMutate, isPending: false }),
      },
      updateTicketType: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
      deleteTicketType: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
  },
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: { resale: true } }),
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

/** Open the add form and fill the two always-required fields. */
const openAddForm = (name = "GA", capacity = "100") => {
  fireEvent.click(screen.getByTestId("ticket-type-custom-btn"));
  type("ticket-type-add-name", name);
  type("ticket-type-add-capacity", capacity);
};

const submit = () => fireEvent.click(screen.getByTestId("ticket-type-add-submit"));

/** The pricing-mode toggle has no testId; it is identified by its label. */
const switchToPayWhatYouWant = () =>
  fireEvent.click(screen.getByText("Pay What You Want"));

describe("TicketTypeEditor — handleAdd money wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("sends a blank price as 0 — a blank price is a free ticket", async () => {
    openAddForm();
    submit();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      name: "GA",
      priceCents: 0,
      capacity: 100,
    });
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it("banks an es comma decimal as typed, not truncated at the comma", async () => {
    // The headline bug: parseFloat("15,50") === 15 quietly sold at $15.00.
    openAddForm();
    type("ticket-type-add-price", "15,50");
    submit();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({ priceCents: 1550 });
  });

  it("refuses an unreadable price: no mutation, no stuck in-flight state", async () => {
    openAddForm();
    type("ticket-type-add-price", "nonsense");
    submit();

    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    // A refusal must not leave `isAdding` latched — the organiser has to be
    // able to fix the typo and press Add again.
    expect(screen.getByTestId("ticket-type-add-submit")).not.toBeDisabled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "ticket-price-invalid",
      title: "admin.ttInvalidPriceTitle",
    });
  });

  it("refuses an unreadable resale cap without calling the mutation", async () => {
    openAddForm();
    type("ticket-type-add-price", "20.00");
    fireEvent.click(screen.getByTestId("ticket-type-add-resale-toggle"));
    type("ticket-type-add-resale-cap", "nonsense");
    submit();

    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("ticket-type-add-submit")).not.toBeDisabled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "ticket-resale-cap-invalid",
      title: "admin.ttInvalidAmountTitle",
    });
  });

  it("explains an ambiguous amount instead of guessing at it", async () => {
    openAddForm();
    type("ticket-type-add-price", "1,500");
    submit();

    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      message: "admin.ttAmbiguousAmountMessage",
    });
  });

  it("sends a blank minimum as null, never as 0", async () => {
    // `null` means "no minimum set"; `0` is an explicit free-floor PWYW tier.
    // Collapsing the two would silently change what buyers can pay.
    openAddForm();
    switchToPayWhatYouWant();
    type("ticket-type-add-suggested", "10.00");
    submit();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    const input = upsertMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.minimumCents).toBeNull();
    expect(input.suggestedCents).toBe(1000);
    expect(input.priceCents).toBe(0);
  });

  it("reads an explicit 0 minimum as 0, distinct from blank", async () => {
    openAddForm();
    switchToPayWhatYouWant();
    type("ticket-type-add-minimum", "0");
    submit();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]!.minimumCents).toBe(0);
  });

  it("does not refuse over a hidden field whose value is discarded", async () => {
    // Repro of a real trap: tick Allow resale, type a bad cap, then switch to
    // Pay What You Want. The cap UI disappears and the submit sends `null` for
    // it — so blocking on it would be an error toast about an invisible field.
    openAddForm();
    fireEvent.click(screen.getByTestId("ticket-type-add-resale-toggle"));
    type("ticket-type-add-resale-cap", "nonsense");
    switchToPayWhatYouWant();
    submit();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(toastDanger).not.toHaveBeenCalled();
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      resaleCapCents: null,
      resaleAllowed: false,
    });
  });
});
