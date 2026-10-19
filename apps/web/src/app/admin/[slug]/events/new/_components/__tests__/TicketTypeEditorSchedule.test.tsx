import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TicketTypeEditor } from "../TicketTypeEditor";

/**
 * The scheduled-price-change SEAM, end to end through the real component.
 *
 * The pure resolver is covered by `ticket-type-schedule.test.ts`. What this
 * file pins is what the pure test cannot see:
 *
 *  - the affordance is COLLAPSED by default, in both the add and edit forms;
 *  - the add path sends the two columns TOGETHER, or two nulls, never one;
 *  - unchecking sends the null PAIR (the clear), and also wipes the fields so
 *    a re-check can't resurrect a removed price;
 *  - an UNTOUCHED edit sends `undefined` for both, so an unrelated rename
 *    cannot destroy a stored schedule;
 *  - the read-back renders the resolved instant on the EVENT's clock, both
 *    while typing and when a SAVED schedule is re-opened (Q-002);
 *  - an unreadable/ambiguous price stops the submit instead of banking a
 *    number.
 *
 * Mocks are ENUMERATED, never a catch-all Proxy: a proxy answers `then`, which
 * makes the module namespace look like a thenable and hangs `import()`.
 * `../ticket-type-schedule`, `@/lib/money/parse-money-input` and
 * `../TicketScheduledPriceField` are deliberately NOT mocked — they are the
 * thing under test.
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

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  // Enter is wired to `onSubmitEditing` exactly as react-native-web wires it on
  // a single-line input — the one path that reaches `handleAdd` while the
  // footer button is disabled, and therefore how these tests prove the
  // handler's own refusal still exists underneath the disabled button.
  TextInput: ({
    value,
    onChangeText,
    onSubmitEditing,
    testId,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
    onSubmitEditing?: () => void;
    testId?: string;
  }) => (
    <input
      data-testid={testId}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmitEditing?.();
      }}
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
      getEventFeePreview: { useQuery: () => ({ data: undefined }) },
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

const openAddForm = (name = "GA", capacity = "100") => {
  fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
  type("ticket-type-add-name", name);
  type("ticket-type-add-capacity", capacity);
};

const submitAdd = () =>
  fireEvent.click(screen.getByTestId("ticket-type-add-submit"));

/** Reach `handleAdd` past the (now blockable) footer button — see the mock. */
const submitAddViaEnter = () =>
  fireEvent.keyDown(screen.getByTestId("ticket-type-add-capacity"), {
    key: "Enter",
  });

const enableSchedule = (prefix: "add" | "edit") =>
  fireEvent.click(screen.getByTestId(`ticket-type-${prefix}-schedule-toggle`));

describe("TicketTypeEditor — the schedule affordance is collapsed by default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNSCHEDULED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    updateMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("shows only the unchecked box on the add form — no price, no date", () => {
    openAddForm();
    expect(
      screen.getByTestId("ticket-type-add-schedule-toggle"),
    ).toHaveAttribute("data-checked", "false");
    expect(
      screen.queryByTestId("ticket-type-add-schedule-panel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("ticket-type-add-schedule-price"),
    ).not.toBeInTheDocument();
  });

  it("shows only the unchecked box on the edit form", () => {
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(
      screen.getByTestId("ticket-type-edit-schedule-toggle"),
    ).toHaveAttribute("data-checked", "false");
    expect(
      screen.queryByTestId("ticket-type-edit-schedule-panel"),
    ).not.toBeInTheDocument();
  });

  it("expands to price + date once checked", () => {
    openAddForm();
    enableSchedule("add");
    expect(
      screen.getByTestId("ticket-type-add-schedule-panel"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-add-schedule-price"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-add-schedule-at"),
    ).toBeInTheDocument();
  });
});

describe("TicketTypeEditor — add path sends both columns or neither", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNSCHEDULED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("sends the null PAIR when the affordance is untouched", async () => {
    openAddForm();
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });
  });

  it("sends BOTH, with the instant resolved in the EVENT's timezone", async () => {
    openAddForm();
    type("ticket-type-add-price", "12.00");
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20.00");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      priceCents: 1200,
      scheduledPriceCents: 2000,
      // Midnight Central (CDT, UTC-5) on 2026-10-03. Browser-local
      // arithmetic cannot produce this under an arbitrary runner TZ.
      scheduledPriceAt: "2026-10-03T05:00:00.000Z",
    });
  });

  it("accepts 0 as the new price — a tier that becomes free at T", async () => {
    openAddForm();
    type("ticket-type-add-price", "12.00");
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "0");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    const sent = upsertMutate.mock.calls[0]![0];
    // Not collapsed with "unset": the DATE must still be present.
    expect(sent.scheduledPriceCents).toBe(0);
    expect(sent.scheduledPriceAt).toBe("2026-10-03T05:00:00.000Z");
  });

  it("unchecking CLEARS both fields and submits the null pair", async () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20.00");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    // Uncheck — the explicit "remove the schedule" gesture.
    enableSchedule("add");
    // Re-checking must NOT resurrect the removed price.
    enableSchedule("add");
    expect(screen.getByTestId("ticket-type-add-schedule-price")).toHaveValue(
      "",
    );
    expect(screen.getByTestId("ticket-type-add-schedule-at")).toHaveValue("");

    // Uncheck again and submit.
    enableSchedule("add");
    submitAdd();
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });
  });

  it("refuses a date with no price — never a half-configuration", async () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");

    // The button used to stay enabled here: the form showed nothing wrong,
    // took the click, and only then produced a toast. Now the panel says what
    // is missing and the button reflects it.
    expect(
      screen.getByTestId("ticket-type-add-schedule-error"),
    ).toHaveTextContent("admin.ttSchedulePriceRequiredMessage");
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    submitAdd();
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger).not.toHaveBeenCalled();

    submitAddViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "ticket-schedule-invalid",
      title: "admin.ttScheduleIncompleteTitle",
      message: "admin.ttSchedulePriceRequiredMessage",
    });
  });

  it("refuses a price with no date", async () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20.00");
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    submitAddViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      message: "admin.ttScheduleAtRequiredMessage",
    });
  });

  it("re-enables Add as soon as the schedule is complete — no over-disabling", async () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    type("ticket-type-add-schedule-price", "20.00");
    expect(
      screen.queryByTestId("ticket-type-add-schedule-error"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-type-add-submit")).not.toBeDisabled();

    submitAdd();
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
  });

  it("refuses an ambiguous scheduled price instead of banking a guess", async () => {
    // "1,500" is $1500 to an en typist and $1.50 to an es one.
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "1,500");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    submitAddViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      title: "admin.ttInvalidAmountTitle",
      message: "admin.ttAmbiguousAmountMessage",
    });
  });

  it("banks an es comma decimal as typed", async () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20,50");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      scheduledPriceCents: 2050,
    });
  });
});

describe("TicketTypeEditor — the FR-007 read-back", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNSCHEDULED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("states the resolved moment on the EVENT's clock, zone included", () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20.00");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");

    const readback = screen.getByTestId("ticket-type-add-schedule-readback");
    // The i18n mock echoes `key|{args}`, so this asserts BOTH that the copy is
    // translated and exactly what was interpolated.
    expect(readback).toHaveTextContent("admin.ttScheduleReadback");
    expect(readback).toHaveTextContent("$20.00");
    expect(readback).toHaveTextContent("Sat, Oct 3, 12:00 AM CDT");
  });

  it("shows CST, not CDT, for a moment on the other side of the transition", () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20.00");
    type("ticket-type-add-schedule-at", "2026-12-03T00:00");
    expect(
      screen.getByTestId("ticket-type-add-schedule-readback"),
    ).toHaveTextContent("CST");
  });

  it("warns, but does not block, when the moment has already passed", async () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "20.00");
    type("ticket-type-add-schedule-at", "2020-01-01T00:00");
    expect(
      screen.getByTestId("ticket-type-add-schedule-past"),
    ).toHaveTextContent("admin.ttSchedulePastWarning");

    submitAdd();
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0].scheduledPriceCents).toBe(2000);
  });

  it("renders no read-back while the price is unreadable", () => {
    openAddForm();
    enableSchedule("add");
    type("ticket-type-add-schedule-price", "nonsense");
    type("ticket-type-add-schedule-at", "2026-10-03T00:00");
    expect(
      screen.queryByTestId("ticket-type-add-schedule-readback"),
    ).not.toBeInTheDocument();
  });
});

describe("TicketTypeEditor — edit path never destroys a stored schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNSCHEDULED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    updateMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("omits BOTH columns when the control was never touched", async () => {
    // The load-bearing case: `listTicketTypesForEdit` does not return the
    // schedule columns yet, so the control always seeds disabled. If an
    // untouched control sent nulls, this capacity edit would silently delete a
    // live scheduled price change.
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    // Save the row exactly as loaded — the everyday "I opened the editor and
    // pressed Save" path, which must be a no-op for the schedule.
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent).toMatchObject({ ticketTypeId: "tt_1", capacity: 100 });
    expect(sent.scheduledPriceCents).toBeUndefined();
    expect(sent.scheduledPriceAt).toBeUndefined();
  });

  it("sends BOTH once the organizer sets one", async () => {
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    enableSchedule("edit");
    type("ticket-type-edit-schedule-price", "20.00");
    type("ticket-type-edit-schedule-at", "2026-10-03T00:00");
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({
      scheduledPriceCents: 2000,
      scheduledPriceAt: "2026-10-03T05:00:00.000Z",
    });
  });

  it("sends the null PAIR when the organizer touches and then clears it", async () => {
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    enableSchedule("edit"); // on
    type("ticket-type-edit-schedule-price", "20.00");
    enableSchedule("edit"); // off — the explicit removal
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.scheduledPriceCents).toBeNull();
    expect(sent.scheduledPriceAt).toBeNull();
  });

  it("refuses a half-configured edit before it reaches the server", async () => {
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    enableSchedule("edit");
    type("ticket-type-edit-schedule-price", "20.00");

    expect(screen.getByTestId("ticket-type-edit-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(toastDanger).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("ticket-type-edit-capacity"), {
      key: "Enter",
    });
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "edit-ticket-schedule-invalid",
      message: "admin.ttScheduleAtRequiredMessage",
    });
  });

  it("keeps Save alive for an UNTOUCHED schedule", () => {
    // Gated on the same `touched` latch the submit uses: an untouched control
    // sends nothing and validates nothing, so it must never block a rename.
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(screen.getByTestId("ticket-type-edit-save")).not.toBeDisabled();
  });
});

describe("TicketTypeEditor — Q-002: a SAVED schedule reads back", () => {
  /** Midnight Central on 2026-10-03 — the same instant the add tests write. */
  const SCHEDULED_ROW = {
    ...UNSCHEDULED_ROW,
    scheduledPriceCents: 2000,
    scheduledPriceAt: new Date("2026-10-03T05:00:00.000Z"),
    effectivePriceCents: 1200,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [SCHEDULED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    updateMutate.mockResolvedValue({});
  });

  it("shows the schedule on the list row, on the event's clock", () => {
    render(<TicketTypeEditor eventId="evt_1" />);
    const row = screen.getByTestId("ticket-type-row-schedule");
    expect(row).toHaveTextContent("admin.ttScheduleReadback");
    expect(row).toHaveTextContent("$20.00");
    expect(row).toHaveTextContent("Sat, Oct 3, 12:00 AM CDT");
  });

  it("seeds the edit control ENABLED, with the organizer's wall clock", () => {
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));

    expect(
      screen.getByTestId("ticket-type-edit-schedule-toggle"),
    ).toHaveAttribute("data-checked", "true");
    expect(screen.getByTestId("ticket-type-edit-schedule-price")).toHaveValue(
      "20.00",
    );
    // 05:00Z read on Central = midnight. A browser-local seed under the
    // runner's TZ would produce some other wall clock here.
    expect(screen.getByTestId("ticket-type-edit-schedule-at")).toHaveValue(
      "2026-10-03T00:00",
    );
  });

  it("seeds a stored 0 as an enabled free-after-T schedule", () => {
    queryState.rows = [{ ...SCHEDULED_ROW, scheduledPriceCents: 0 }];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(
      screen.getByTestId("ticket-type-edit-schedule-toggle"),
    ).toHaveAttribute("data-checked", "true");
    expect(screen.getByTestId("ticket-type-edit-schedule-price")).toHaveValue(
      "0.00",
    );
  });

  it("re-saving an untouched seeded schedule leaves the stored pair alone", async () => {
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.scheduledPriceCents).toBeUndefined();
    expect(sent.scheduledPriceAt).toBeUndefined();
  });

  it("unchecking a seeded schedule sends the null PAIR — the removal path", async () => {
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-schedule-toggle"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.scheduledPriceCents).toBeNull();
    expect(sent.scheduledPriceAt).toBeNull();
  });

  it("hides the row read-back rather than showing it on the WRONG clock", () => {
    // Timezone still in flight. A schedule rendered against a fallback zone
    // would be actively misleading — the one thing FR-007 can't tolerate — so
    // it is withheld until the event's zone is known.
    queryState.timezone = null;
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(
      screen.queryByTestId("ticket-type-row-schedule"),
    ).not.toBeInTheDocument();
  });

  it("does not destroy the schedule when saved while the timezone is loading", async () => {
    // The control is disabled and seeds empty in this window. Sending nulls
    // here would delete a live price flip on an edit meant as a rename.
    queryState.timezone = null;
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.scheduledPriceCents).toBeUndefined();
    expect(sent.scheduledPriceAt).toBeUndefined();
  });
});

describe("TicketTypeEditor — the row must not quote a price nobody pays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
    updateMutate.mockResolvedValue({});
  });

  it("leads with the EFFECTIVE price after a flip, keeping the old one beside it", () => {
    // Stored $12, resolved $20: without this the row read "$12" while the fee
    // block below it (computed from the resolved price) said "Buyer pays
    // $21.xx" and buyers were charged $20.
    queryState.rows = [
      {
        ...UNSCHEDULED_ROW,
        priceCents: 1200,
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2020-01-01T00:00:00.000Z"),
        effectivePriceCents: 2000,
      },
    ];
    render(<TicketTypeEditor eventId="evt_1" />);

    expect(screen.getByTestId("ticket-type-row-price")).toHaveTextContent(
      "$20.00",
    );
    expect(screen.getByTestId("ticket-type-row-price-was")).toHaveTextContent(
      "admin.ttPriceWas",
    );
    expect(screen.getByTestId("ticket-type-row-price-was")).toHaveTextContent(
      "$12.00",
    );
  });

  it("shows no 'was' when nothing has flipped", () => {
    queryState.rows = [UNSCHEDULED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(screen.getByTestId("ticket-type-row-price")).toHaveTextContent(
      "$12.00",
    );
    expect(
      screen.queryByTestId("ticket-type-row-price-was"),
    ).not.toBeInTheDocument();
  });

  it("uses PAST tense on the row summary once the flip has fired", () => {
    queryState.rows = [
      {
        ...UNSCHEDULED_ROW,
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2020-01-01T00:00:00.000Z"),
        effectivePriceCents: 2000,
      },
    ];
    render(<TicketTypeEditor eventId="evt_1" />);
    const summary = screen.getByTestId("ticket-type-row-schedule");
    expect(summary).toHaveTextContent("admin.ttScheduleReadbackApplied");
    expect(summary).not.toHaveTextContent("ttScheduleReadback|");
  });

  it("keeps FUTURE tense while the flip is still pending", () => {
    queryState.rows = [
      {
        ...UNSCHEDULED_ROW,
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2099-01-01T00:00:00.000Z"),
        effectivePriceCents: 1200,
      },
    ];
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(screen.getByTestId("ticket-type-row-schedule")).toHaveTextContent(
      "admin.ttScheduleReadback|",
    );
    expect(
      screen.queryByTestId("ticket-type-row-price-was"),
    ).not.toBeInTheDocument();
  });

  it("still shows the edit form's Price input as the STORED price after a flip", () => {
    // Load-bearing: the projection into the form must stay raw. Seeding the
    // resolved price would round-trip it back into `priceCents` on the next
    // save and collapse the schedule.
    queryState.rows = [
      {
        ...UNSCHEDULED_ROW,
        priceCents: 1200,
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2020-01-01T00:00:00.000Z"),
        effectivePriceCents: 2000,
      },
    ];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(screen.getByTestId("ticket-type-edit-schedule-price")).toHaveValue(
      "20.00",
    );
    // The stored list price, NOT 20.00.
    expect(screen.getByTestId("ticket-type-edit-price")).toHaveValue("12.00");
  });
});
