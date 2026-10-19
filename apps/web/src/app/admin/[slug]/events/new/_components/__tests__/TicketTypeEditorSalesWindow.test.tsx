import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TicketTypeEditor } from "../TicketTypeEditor";
import { findTicketTypePreset } from "../ticket-type-presets";

/**
 * The sales-window SEAM, end to end through the real component (FR-013).
 *
 * The pure resolver is covered by `ticket-type-sales-window.test.ts`. What this
 * file pins is what the pure test cannot see:
 *
 *  - the affordance is COLLAPSED by default, in both the add and edit forms;
 *  - NFR-001: a tier with no window sends the payload it sent BEFORE this
 *    feature existed — the two keys are absent, not null;
 *  - each bound can be set ALONE, and both together with open < close;
 *  - a zero-width or inverted pair is refused inline AND stops the submit, so
 *    TICKET_TYPE_SALES_WINDOW_INVALID is unreachable;
 *  - an UNTOUCHED edit sends `undefined` for both bounds, so an unrelated
 *    rename cannot destroy a stored window;
 *  - the read-back renders on the EVENT's clock, while typing and when a SAVED
 *    window is re-opened;
 *  - the control stays mounted for a PAY WHAT YOU WANT tier, unlike the
 *    scheduled price.
 *
 * Mocks are ENUMERATED, never a catch-all Proxy: a proxy answers `then`, which
 * makes the module namespace look like a thenable and hangs `import()`.
 * `../ticket-type-sales-window`, `../ticket-type-schedule` and
 * `../TicketSalesWindowField` are deliberately NOT mocked — they are the thing
 * under test.
 */

const upsertMutate = vi.fn();
const updateMutate = vi.fn();
const toastDanger = vi.fn();
const toastSuccess = vi.fn();

/** The event under edit lives on Central time; the runner does not. */
const EVENT_TIMEZONE = "America/Chicago";

const queryState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  timezone: "America/Chicago" as string | null,
  /** `Event.startsAt` — the EVENT_START anchor for FR-012 preset windows. */
  startsAt: new Date("2026-10-02T01:00:00.000Z") as Date | null,
}));

const UNWINDOWED_ROW = {
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
  salesOpenAt: null,
  salesCloseAt: null,
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
  // a single-line input. It is the ONE path that reaches `handleAdd` /
  // `handleSaveEdit` while the footer button is disabled, so it is how these
  // tests prove the handler's own refusal is still there underneath the
  // disabled button rather than replaced by it.
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
            ? {
                timezone: queryState.timezone,
                currency: "usd",
                startsAt: queryState.startsAt,
              }
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
/**
 * One button per preset id, wired to the REAL catalog entry, so the FR-012
 * block at the bottom of this file can drive the editor's actual
 * `handleSelectPreset` seam. The real picker's dropdown mechanics are covered
 * by `TicketTypePresetPicker.test.tsx`; what this stand-in preserves is the
 * only thing that matters here — the preset object that reaches the callback.
 */
vi.mock("../TicketTypePresetPicker", () => ({
  TicketTypePresetPicker: ({
    onSelect,
  }: {
    onSelect: (preset: unknown) => void;
  }) => (
    <>
      {["ga", "advance", "door"].map((id) => (
        <button
          key={id}
          type="button"
          data-testid={`preset-${id}`}
          onClick={() => onSelect(findTicketTypePreset(id as never))}
        />
      ))}
    </>
  ),
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

/**
 * Reach `handleAdd` WITHOUT the footer button — Enter in the capacity field.
 *
 * The button is disabled whenever the form is in a refusable state, so a click
 * can no longer exercise the handler's own guards. They still have to hold:
 * `onSubmitEditing` bypasses the button entirely, and a future caller might too.
 */
const submitAddViaEnter = () =>
  fireEvent.keyDown(screen.getByTestId("ticket-type-add-capacity"), {
    key: "Enter",
  });

const submitEditViaEnter = () =>
  fireEvent.keyDown(screen.getByTestId("ticket-type-edit-capacity"), {
    key: "Enter",
  });

const enableWindow = (prefix: "add" | "edit") =>
  fireEvent.click(screen.getByTestId(`ticket-type-${prefix}-window-toggle`));

describe("TicketTypeEditor — the window affordance is collapsed by default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNWINDOWED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    updateMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("shows only the unchecked box on the add form — no dates", () => {
    openAddForm();
    expect(screen.getByTestId("ticket-type-add-window-toggle")).toHaveAttribute(
      "data-checked",
      "false",
    );
    expect(
      screen.queryByTestId("ticket-type-add-window-panel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("ticket-type-add-window-open"),
    ).not.toBeInTheDocument();
  });

  it("shows only the unchecked box on the edit form", () => {
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(
      screen.getByTestId("ticket-type-edit-window-toggle"),
    ).toHaveAttribute("data-checked", "false");
    expect(
      screen.queryByTestId("ticket-type-edit-window-panel"),
    ).not.toBeInTheDocument();
  });

  it("expands to two date fields and the half-open explanation once checked", () => {
    openAddForm();
    enableWindow("add");
    expect(
      screen.getByTestId("ticket-type-add-window-panel"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-add-window-open"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-add-window-close"),
    ).toBeInTheDocument();
    // The boundary is EXPLAINED, not merely enforced — the organizer setting an
    // advance/door pair cannot get it right without this.
    expect(
      screen.getByTestId("ticket-type-add-window-boundary-note"),
    ).toHaveTextContent("admin.ttWindowBoundaryNote");
  });
});

/**
 * The zone footnote belongs to the FORM, not to a panel.
 *
 * Observed with both timing panels expanded: "Times are on the event's clock
 * (America/Chicago)." rendered once per panel — the same sentence twice, a few
 * lines apart, which reads as a rendering fault rather than emphasis.
 */
describe("TicketTypeEditor — one timezone note per form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNWINDOWED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  const zoneNotes = () =>
    screen.queryAllByTestId(/^ticket-type-add-(schedule|window)-zone-note$/);

  it("renders it ONCE when both panels are open", () => {
    openAddForm();
    fireEvent.click(screen.getByTestId("ticket-type-add-schedule-toggle"));
    enableWindow("add");

    expect(
      screen.getByTestId("ticket-type-add-schedule-panel"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-add-window-panel"),
    ).toBeInTheDocument();
    expect(zoneNotes()).toHaveLength(1);
    // Kept on the LOWER panel, so it still sits directly under a set of times.
    expect(
      screen.getByTestId("ticket-type-add-window-zone-note"),
    ).toHaveTextContent("admin.ttWindowZoneNote");
  });

  it("still renders it when only the SCHEDULE panel is open", () => {
    openAddForm();
    fireEvent.click(screen.getByTestId("ticket-type-add-schedule-toggle"));
    expect(zoneNotes()).toHaveLength(1);
    expect(
      screen.getByTestId("ticket-type-add-schedule-zone-note"),
    ).toHaveTextContent("admin.ttScheduleZoneNote");
  });

  it("still renders it when only the WINDOW panel is open", () => {
    openAddForm();
    enableWindow("add");
    expect(zoneNotes()).toHaveLength(1);
  });

  it("renders none while both panels are collapsed", () => {
    openAddForm();
    expect(zoneNotes()).toHaveLength(0);
  });

  it("keeps it to one on the EDIT form too", () => {
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-schedule-toggle"));
    enableWindow("edit");
    expect(
      screen.queryAllByTestId(/^ticket-type-edit-(schedule|window)-zone-note$/),
    ).toHaveLength(1);
  });
});

describe("TicketTypeEditor — the bounds are independent on the add path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNWINDOWED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("NFR-001: an untouched control sends NO window keys at all", async () => {
    openAddForm();
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    const sent = upsertMutate.mock.calls[0]![0];
    // Not `null` — ABSENT. A tier with no window submits the payload this form
    // submitted before the feature existed, key for key.
    expect(Object.hasOwn(sent, "salesOpenAt")).toBe(false);
    expect(Object.hasOwn(sent, "salesCloseAt")).toBe(false);
  });

  it("sends an OPEN bound alone, resolved in the EVENT's timezone", async () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-09T10:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      // 10:00 Central (CDT, UTC-5). Browser-local arithmetic cannot produce
      // this under an arbitrary runner TZ.
      salesOpenAt: "2026-10-09T15:00:00.000Z",
      salesCloseAt: null,
    });
  });

  it("sends a CLOSE bound alone", async () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-close", "2026-10-10T18:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      salesOpenAt: null,
      salesCloseAt: "2026-10-10T23:00:00.000Z",
    });
  });

  it("sends BOTH when open is before close", async () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-09T10:00");
    type("ticket-type-add-window-close", "2026-10-10T18:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      salesOpenAt: "2026-10-09T15:00:00.000Z",
      salesCloseAt: "2026-10-10T23:00:00.000Z",
    });
  });

  it("refuses an INVERTED window inline AND disables the Add button", async () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-10T18:00");
    type("ticket-type-add-window-close", "2026-10-09T10:00");

    // Inline, before anyone presses anything...
    expect(
      screen.getByTestId("ticket-type-add-window-error"),
    ).toHaveTextContent("admin.ttWindowOrderMessage");
    // ...and the button agrees. The observed defect was exactly this pair
    // disagreeing: the panel said "this will fail" while the footer still
    // invited the click that would fail.
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    // A click on a disabled button does nothing at all.
    submitAdd();
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger).not.toHaveBeenCalled();

    // The handler's own refusal is still there for the paths that bypass the
    // button (Enter in the capacity field).
    submitAddViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "ticket-window-invalid",
      title: "admin.ttWindowInvalidTitle",
      message: "admin.ttWindowOrderMessage",
    });
  });

  it("refuses a ZERO-WIDTH window in its OWN words — not the inverted copy", async () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-09T10:00");
    type("ticket-type-add-window-close", "2026-10-09T10:00");

    // One string used to cover both orderings, so an organizer who set the pair
    // BACKWARDS was told they had entered the same moment twice.
    const inline = screen.getByTestId("ticket-type-add-window-error");
    expect(inline).toHaveTextContent("admin.ttWindowZeroWidthMessage");
    expect(inline).not.toHaveTextContent("admin.ttWindowOrderMessage");
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    submitAddViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      message: "admin.ttWindowZeroWidthMessage",
    });
  });

  it("refuses a ticked-but-empty control rather than silently sending nothing", async () => {
    openAddForm();
    enableWindow("add");

    // Disabled, with the reason on screen — a dead button and no explanation
    // would just move the dead end.
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();
    expect(
      screen.getByTestId("ticket-type-add-window-error"),
    ).toHaveTextContent("admin.ttWindowEmptyMessage");

    submitAddViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(upsertMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      message: "admin.ttWindowEmptyMessage",
    });
  });

  it("re-enables the Add button the moment the window becomes valid", async () => {
    // The other half of the contract: do NOT over-disable. A form that only
    // ever greys the button out is as broken as one that never does.
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-10T18:00");
    type("ticket-type-add-window-close", "2026-10-09T10:00");
    expect(screen.getByTestId("ticket-type-add-submit")).toBeDisabled();

    type("ticket-type-add-window-close", "2026-10-11T10:00");
    expect(
      screen.queryByTestId("ticket-type-add-window-error"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket-type-add-submit")).not.toBeDisabled();

    submitAdd();
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
  });

  it("leaves the Add button alone for a tier with no window at all", () => {
    // The overwhelming majority of tiers. An untouched control must not gate
    // anything.
    openAddForm();
    expect(screen.getByTestId("ticket-type-add-submit")).not.toBeDisabled();
  });

  it("unchecking CLEARS both fields and goes back to sending nothing", async () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-09T10:00");
    enableWindow("add"); // uncheck — the explicit removal
    enableWindow("add"); // re-check must NOT resurrect the removed bound
    expect(screen.getByTestId("ticket-type-add-window-open")).toHaveValue("");

    enableWindow("add"); // off again
    submitAdd();
    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(Object.hasOwn(upsertMutate.mock.calls[0]![0], "salesOpenAt")).toBe(
      false,
    );
  });

  it("stays available for a PAY WHAT YOU WANT tier", async () => {
    // Unlike the scheduled price, a window is about
    // sellability, not amount — and `upsertTicketType` deliberately does not
    // clear it for ADJUSTABLE.
    openAddForm();
    fireEvent.click(screen.getByText("Pay What You Want"));
    expect(
      screen.queryByTestId("ticket-type-add-schedule-toggle"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-add-window-toggle"),
    ).toBeInTheDocument();

    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-09T10:00");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      pricingMode: "ADJUSTABLE",
      salesOpenAt: "2026-10-09T15:00:00.000Z",
    });
  });
});

describe("TicketTypeEditor — the window read-back", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.rows = [UNWINDOWED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    upsertMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  it("states each bound on the EVENT's clock, zone abbreviation included", () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-10-09T10:00");
    type("ticket-type-add-window-close", "2026-10-10T18:00");

    const opens = screen.getByTestId("ticket-type-add-window-open-readback");
    expect(opens).toHaveTextContent("admin.ttWindowOpensReadback");
    expect(opens).toHaveTextContent("Fri, Oct 9, 10:00 AM CDT");

    const closes = screen.getByTestId("ticket-type-add-window-close-readback");
    expect(closes).toHaveTextContent("Sat, Oct 10, 6:00 PM CDT");
  });

  it("shows CST, not CDT, for a moment on the other side of the transition", () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "2026-12-03T00:00");
    expect(
      screen.getByTestId("ticket-type-add-window-open-readback"),
    ).toHaveTextContent("CST");
  });

  it("renders no read-back while a bound is unreadable", () => {
    openAddForm();
    enableWindow("add");
    type("ticket-type-add-window-open", "not-a-date");
    expect(
      screen.queryByTestId("ticket-type-add-window-open-readback"),
    ).not.toBeInTheDocument();
  });
});

describe("TicketTypeEditor — the edit path never destroys a stored window", () => {
  /** 10:00–18:00 Central on 2026-10-09/10 — the instants the add tests write. */
  const WINDOWED_ROW = {
    ...UNWINDOWED_ROW,
    salesOpenAt: new Date("2026-10-09T15:00:00.000Z"),
    salesCloseAt: new Date("2026-10-10T23:00:00.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
    updateMutate.mockResolvedValue({});
  });

  it("omits BOTH bounds when the control was never touched", async () => {
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.salesOpenAt).toBeUndefined();
    expect(sent.salesCloseAt).toBeUndefined();
  });

  it("does not destroy the window when saved while the timezone is loading", async () => {
    // The control is disabled and seeds empty in this window. Sending nulls
    // here would put a deliberately-held-back tier on sale immediately.
    queryState.rows = [WINDOWED_ROW];
    queryState.timezone = null;
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.salesOpenAt).toBeUndefined();
    expect(sent.salesCloseAt).toBeUndefined();
  });

  it("seeds the control ENABLED, with the organizer's wall clock", () => {
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));

    expect(
      screen.getByTestId("ticket-type-edit-window-toggle"),
    ).toHaveAttribute("data-checked", "true");
    // 15:00Z read on Central = 10:00. A browser-local seed under the runner's
    // TZ would produce some other wall clock here.
    expect(screen.getByTestId("ticket-type-edit-window-open")).toHaveValue(
      "2026-10-09T10:00",
    );
    expect(screen.getByTestId("ticket-type-edit-window-close")).toHaveValue(
      "2026-10-10T18:00",
    );
  });

  it("seeds a SINGLE stored bound as enabled with the other field blank", () => {
    queryState.rows = [{ ...WINDOWED_ROW, salesCloseAt: null }];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(
      screen.getByTestId("ticket-type-edit-window-toggle"),
    ).toHaveAttribute("data-checked", "true");
    expect(screen.getByTestId("ticket-type-edit-window-close")).toHaveValue("");
  });

  it("clears ONE bound and keeps the other — a supported edit, not a half-config", async () => {
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    type("ticket-type-edit-window-close", "");
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.salesOpenAt).toBe("2026-10-09T15:00:00.000Z");
    expect(sent.salesCloseAt).toBeNull();
  });

  it("unchecking a seeded window sends BOTH nulls — the removal path", async () => {
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-window-toggle"));
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const sent = updateMutate.mock.calls[0]![0];
    expect(sent.salesOpenAt).toBeNull();
    expect(sent.salesCloseAt).toBeNull();
  });

  it("refuses an inverted edit before it reaches the server", async () => {
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    type("ticket-type-edit-window-open", "2026-10-11T10:00");

    // Same contract as the add path: the inline refusal and the Save button
    // are computed from ONE resolution, so they cannot disagree.
    expect(
      screen.getByTestId("ticket-type-edit-window-error"),
    ).toHaveTextContent("admin.ttWindowOrderMessage");
    expect(screen.getByTestId("ticket-type-edit-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(toastDanger).not.toHaveBeenCalled();

    submitEditViaEnter();
    await waitFor(() => expect(toastDanger).toHaveBeenCalledTimes(1));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(toastDanger.mock.calls[0]![0]).toMatchObject({
      id: "edit-ticket-window-invalid",
      message: "admin.ttWindowOrderMessage",
    });
  });

  it("keeps Save alive for an UNTOUCHED window on an otherwise valid edit", () => {
    // The disable is gated on the same `touched` latch the submit is: an
    // untouched control sends nothing and validates nothing, so it must never
    // be able to strand an organizer who only wanted to rename a tier.
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    expect(screen.getByTestId("ticket-type-edit-save")).not.toBeDisabled();
  });

  it("re-enables Save once the edited window is valid again", () => {
    queryState.rows = [WINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    type("ticket-type-edit-window-open", "2026-10-11T10:00");
    expect(screen.getByTestId("ticket-type-edit-save")).toBeDisabled();
    type("ticket-type-edit-window-open", "2026-10-09T10:00");
    expect(screen.getByTestId("ticket-type-edit-save")).not.toBeDisabled();
  });

  it("sets a window on a tier that had none", async () => {
    queryState.rows = [UNWINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    fireEvent.click(screen.getByTestId("ticket-type-edit-btn"));
    enableWindow("edit");
    type("ticket-type-edit-window-open", "2026-10-09T10:00");
    fireEvent.click(screen.getByTestId("ticket-type-edit-save"));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({
      salesOpenAt: "2026-10-09T15:00:00.000Z",
      salesCloseAt: null,
    });
  });
});

describe("TicketTypeEditor — a saved window shows on the ticket list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.timezone = EVENT_TIMEZONE;
  });

  it("renders the range on the event's clock without opening the editor", () => {
    queryState.rows = [
      {
        ...UNWINDOWED_ROW,
        salesOpenAt: new Date("2026-10-09T15:00:00.000Z"),
        salesCloseAt: new Date("2099-10-10T23:00:00.000Z"),
      },
    ];
    render(<TicketTypeEditor eventId="evt_1" />);
    const row = screen.getByTestId("ticket-type-row-window");
    expect(row).toHaveTextContent("admin.ttWindowSummaryRange");
    expect(row).toHaveTextContent("Fri, Oct 9, 10:00 AM CDT");
  });

  it("uses PAST tense once the closing bound has elapsed", () => {
    queryState.rows = [
      {
        ...UNWINDOWED_ROW,
        salesOpenAt: null,
        salesCloseAt: new Date("2020-01-01T00:00:00.000Z"),
      },
    ];
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(screen.getByTestId("ticket-type-row-window")).toHaveTextContent(
      "admin.ttWindowSummaryEnded",
    );
  });

  it("shows nothing for an unwindowed tier", () => {
    queryState.rows = [UNWINDOWED_ROW];
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(
      screen.queryByTestId("ticket-type-row-window"),
    ).not.toBeInTheDocument();
  });

  it("withholds the line rather than showing it on the WRONG clock", () => {
    queryState.rows = [
      {
        ...UNWINDOWED_ROW,
        salesOpenAt: new Date("2099-10-09T15:00:00.000Z"),
        salesCloseAt: null,
      },
    ];
    queryState.timezone = null;
    render(<TicketTypeEditor eventId="evt_1" />);
    expect(
      screen.queryByTestId("ticket-type-row-window"),
    ).not.toBeInTheDocument();
  });
});

/**
 * FR-012 — picking a preset materializes its RELATIVE window into this form.
 *
 * The arithmetic is covered by `ticket-type-preset-schedule.test.ts` (and, one
 * layer down, by core's `template-relative-schedule.test.ts`). What only a
 * component test can see is the WIRING: that `handleSelectPreset` actually
 * seeds the window control, that a preset carrying nothing leaves an
 * organizer's own configuration alone, and that the seeded value survives to
 * the mutation as an instant on the venue's clock.
 *
 * The clock is pinned rather than left to the runner: a preset's window is
 * judged against `now`, so a suite that passes today and silently stops
 * exercising the seeded path next year is not a test.
 */
describe("TicketTypeEditor — FR-012 preset windows", () => {
  /** 2026-10-01, 20:00 America/Chicago. */
  const SHOW = new Date("2026-10-02T01:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    vi.clearAllMocks();
    queryState.rows = [UNWINDOWED_ROW];
    queryState.timezone = EVENT_TIMEZONE;
    queryState.startsAt = SHOW;
    upsertMutate.mockResolvedValue({});
    render(<TicketTypeEditor eventId="evt_1" />);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds Advance with a CLOSE 24h before the show, on the venue's clock", () => {
    fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
    fireEvent.click(screen.getByTestId("preset-advance"));

    expect(screen.getByTestId("ticket-type-add-window-toggle")).toHaveAttribute(
      "data-checked",
      "true",
    );
    expect(screen.getByTestId("ticket-type-add-window-close")).toHaveValue(
      "2026-09-30T20:00",
    );
    expect(screen.getByTestId("ticket-type-add-window-open")).toHaveValue("");
  });

  it("seeds Door with an OPEN at the same instant — the pair hands over cleanly", () => {
    fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
    fireEvent.click(screen.getByTestId("preset-door"));

    expect(screen.getByTestId("ticket-type-add-window-open")).toHaveValue(
      "2026-09-30T20:00",
    );
    expect(screen.getByTestId("ticket-type-add-window-close")).toHaveValue("");
  });

  it("submits the seeded bound as the instant it names", async () => {
    fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
    fireEvent.click(screen.getByTestId("preset-advance"));
    type("ticket-type-add-capacity", "50");
    submitAdd();

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0]![0]).toMatchObject({
      // 2026-09-30 20:00 CDT (UTC-5).
      salesCloseAt: "2026-10-01T01:00:00.000Z",
      salesOpenAt: null,
    });
  });

  it("SAYS SO when the event starts too soon for the preset's window", () => {
    // The trap this closes: Advance's elapsed close is DROPPED while Door's
    // lone elapsed open is KEPT, so inside 24h of doors Advance never stops
    // selling and Door is already live — both tiers sell at once and buyers
    // take the $12 advance over the $20 door. An un-ticked control looks
    // exactly like a preset that never carried timing, so the note is the
    // organizer's only signal.
    queryState.startsAt = new Date("2026-08-12T17:00:00.000Z"); // 2h out
    render(<TicketTypeEditor eventId="evt_1" />);
    const addButtons = screen.getAllByTestId("ticket-type-add-btn");
    fireEvent.click(addButtons[addButtons.length - 1]!);
    const presetButtons = screen.getAllByTestId("preset-advance");
    fireEvent.click(presetButtons[presetButtons.length - 1]!);

    const notes = screen.getAllByTestId(
      "ticket-type-add-preset-timing-dropped",
    );
    expect(notes[notes.length - 1]).toHaveTextContent(
      "admin.ttPresetTimingTooSoon",
    );
    const toggles = screen.getAllByTestId("ticket-type-add-window-toggle");
    expect(toggles[toggles.length - 1]).toHaveAttribute(
      "data-checked",
      "false",
    );
  });

  it("stays quiet when the preset's window materialized fine", () => {
    fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
    fireEvent.click(screen.getByTestId("preset-advance"));

    expect(
      screen.queryByTestId("ticket-type-add-preset-timing-dropped"),
    ).not.toBeInTheDocument();
  });

  it("stays quiet for a preset that never carried timing", () => {
    fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
    fireEvent.click(screen.getByTestId("preset-ga"));

    expect(
      screen.queryByTestId("ticket-type-add-preset-timing-dropped"),
    ).not.toBeInTheDocument();
  });

  it("clears the note when the add form is reset", () => {
    queryState.startsAt = new Date("2026-08-12T17:00:00.000Z");
    render(<TicketTypeEditor eventId="evt_1" />);
    const addButtons = screen.getAllByTestId("ticket-type-add-btn");
    fireEvent.click(addButtons[addButtons.length - 1]!);
    const presetButtons = screen.getAllByTestId("preset-advance");
    fireEvent.click(presetButtons[presetButtons.length - 1]!);
    const cancels = screen.getAllByTestId("ticket-type-add-cancel");
    fireEvent.click(cancels[cancels.length - 1]!);

    const reopen = screen.getAllByTestId("ticket-type-add-btn");
    fireEvent.click(reopen[reopen.length - 1]!);
    expect(
      screen.queryByTestId("ticket-type-add-preset-timing-dropped"),
    ).not.toBeInTheDocument();
  });

  it("NFR-001: a preset carrying no window leaves the control untouched", () => {
    fireEvent.click(screen.getByTestId("ticket-type-add-btn"));
    enableWindow("add");
    type("ticket-type-add-window-close", "2026-09-15T18:00");

    // GA says nothing about timing, so it must not wipe what the organizer set
    // merely because they went back to browse the presets.
    fireEvent.click(screen.getByTestId("preset-ga"));

    expect(screen.getByTestId("ticket-type-add-window-close")).toHaveValue(
      "2026-09-15T18:00",
    );
  });

  it("refuses to seed anything when the event's zone is unknown", () => {
    // Rendered under a known zone in beforeEach; re-render without one.
    queryState.timezone = null;
    render(<TicketTypeEditor eventId="evt_1" />);
    const addButtons = screen.getAllByTestId("ticket-type-add-btn");
    fireEvent.click(addButtons[addButtons.length - 1]!);
    const presetButtons = screen.getAllByTestId("preset-advance");
    fireEvent.click(presetButtons[presetButtons.length - 1]!);

    const toggles = screen.getAllByTestId("ticket-type-add-window-toggle");
    expect(toggles[toggles.length - 1]).toHaveAttribute(
      "data-checked",
      "false",
    );
  });
});
