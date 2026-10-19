import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wire-level pins for the re-targeted availability editors and the spaces
 * section (venue-hierarchy Step 7). The real components mount; only the
 * chrome (tamagui, @th/ui primitives) and the transport are mocked — the
 * assertions are on the EXACT mutation payloads, because the payload shape IS
 * the contract this step had to honour:
 *  - upsertCalendarAvailability is a FULL-PUT (isOpen always present),
 *  - dayOfWeek XOR date,
 *  - "All calendars" = calendarId null (ONE place-wide row),
 *  - an update restates the ROW's own scope (immutable after create).
 */

const testMocks = vi.hoisted(() => ({
  upsertMutate: vi.fn(),
  deleteMutate: vi.fn(),
  createSpaceMutate: vi.fn(),
  updateSpaceMutate: vi.fn(),
  setSpaceStatusMutate: vi.fn(),
  /** Captured so a test can drive the real component's onError branch. */
  setSpaceStatusOptions: { onError: undefined } as {
    onError?: (err: unknown) => void;
  },
  createCalendarAsync: vi.fn(),
  updateCalendarAsync: vi.fn(),
  assignSpacesAsync: vi.fn(),
  invalidateAvailability: vi.fn(),
  invalidateSpaces: vi.fn(),
  invalidateCalendars: vi.fn(),
  refetchAvailability: vi.fn(),
  refetchSpaces: vi.fn(),
  refetchCalendars: vi.fn(),
  toastDanger: vi.fn(),
}));

// Mutable per-test payloads. The useQuery mocks read these at every render, so
// a test (or a mutateAsync implementation) can change them mid-flight to model
// what a refetch would return.
let availabilityRows: unknown[] = [];
let spaceRows: unknown[] = [];
let calendarRows: unknown[] = [];
let availabilityError: Error | null = null;
let spacesError: Error | null = null;

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        listCalendarAvailability: {
          invalidate: testMocks.invalidateAvailability,
        },
        listSpaces: { invalidate: testMocks.invalidateSpaces },
        listCalendars: { invalidate: testMocks.invalidateCalendars },
      },
    }),
    places: {
      listCalendarAvailability: {
        useQuery: () => ({
          data: availabilityError ? undefined : availabilityRows,
          isPending: false,
          error: availabilityError,
          refetch: testMocks.refetchAvailability,
        }),
      },
      listSpaces: {
        useQuery: () => ({
          data: spacesError ? undefined : spaceRows,
          isPending: false,
          error: spacesError,
          refetch: testMocks.refetchSpaces,
        }),
      },
      listCalendars: {
        useQuery: () => ({
          data: calendarRows,
          isPending: false,
          error: null,
          refetch: testMocks.refetchCalendars,
        }),
      },
      upsertCalendarAvailability: {
        useMutation: () => ({
          mutate: testMocks.upsertMutate,
          isPending: false,
        }),
      },
      deleteCalendarAvailability: {
        useMutation: () => ({
          mutate: testMocks.deleteMutate,
          isPending: false,
        }),
      },
      createSpace: {
        useMutation: () => ({
          mutate: testMocks.createSpaceMutate,
          isPending: false,
        }),
      },
      updateSpace: {
        useMutation: () => ({
          mutate: testMocks.updateSpaceMutate,
          isPending: false,
        }),
      },
      setSpaceStatus: {
        useMutation: (options?: { onError?: (err: unknown) => void }) => {
          testMocks.setSpaceStatusOptions.onError = options?.onError;
          return {
            mutate: testMocks.setSpaceStatusMutate,
            isPending: false,
          };
        },
      },
      createCalendar: {
        useMutation: () => ({
          mutateAsync: testMocks.createCalendarAsync,
          isPending: false,
        }),
      },
      updateCalendar: {
        useMutation: () => ({
          mutateAsync: testMocks.updateCalendarAsync,
          isPending: false,
        }),
      },
      assignCalendarSpaces: {
        useMutation: () => ({
          mutateAsync: testMocks.assignSpacesAsync,
          isPending: false,
        }),
      },
    },
  },
}));

// CalendarsManager reads its ids off the route.
vi.mock("next/navigation", () => ({
  useParams: () => ({
    slug: "dev-login",
    placeId: "55555555-5555-4555-8555-555555555555",
  }),
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    testID,
  }: {
    children?: ReactNode;
    testID?: string;
  }) => <div data-testid={testID}>{children}</div>;
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  // Booking-group controls. `id` is forwarded on the switch on purpose: the
  // visible label is a `<label for>` and a mock that dropped the id would let
  // an unlabelled switch pass. The test id is `${testId}-track`, matching the
  // real Switch's track button, so a selector that works here works in the
  // browser.
  Switch: ({
    id,
    checked,
    disabled,
    onCheckedChange,
    testId,
  }: {
    id?: string;
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    testId?: string;
  }) => (
    <input
      type="checkbox"
      role="switch"
      id={id}
      data-testid={testId ? `${testId}-track` : undefined}
      checked={!!checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
    />
  ),
  AmountInput: ({
    id,
    value,
    onChangeText,
    disabled,
    testID,
    "aria-invalid": ariaInvalid,
    "aria-describedby": ariaDescribedBy,
  }: {
    id?: string;
    value?: string;
    onChangeText?: (v: string) => void;
    disabled?: boolean;
    testID?: string;
    "aria-invalid"?: boolean;
    "aria-describedby"?: string;
  }) => (
    <input
      id={id}
      data-testid={testID ?? id}
      value={value ?? ""}
      disabled={disabled}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      onChange={(e) => onChangeText?.(e.currentTarget.value)}
    />
  ),
  Money: { format: (cents: number) => `$${cents / 100}` },
  Button: ({
    children,
    disabled,
    onPress,
    testID,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  LabeledTextInput: ({
    name,
    label,
    value,
    onChangeText,
    type,
  }: {
    name?: string;
    label?: string;
    value?: string;
    onChangeText?: (v: string) => void;
    type?: string;
  }) => (
    <label>
      {label}
      <input
        data-testid={name}
        type={type ?? "text"}
        value={value ?? ""}
        onChange={(e) => onChangeText?.(e.currentTarget.value)}
      />
    </label>
  ),
  CharCountTextarea: ({
    id,
    value,
    onChange,
  }: {
    id?: string;
    value?: string;
    onChange?: (v: string) => void;
  }) => (
    <textarea
      data-testid={id}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.currentTarget.value)}
    />
  ),
  Checkbox: ({
    id,
    label,
    checked,
    disabled,
    onCheckedChange,
  }: {
    id?: string;
    label?: string;
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <label>
      {label}
      <input
        data-testid={id}
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
      />
    </label>
  ),
  // Mirrors the real hidden-native-<select> contract: without `id` /
  // `aria-label` / `aria-describedby` on the focusable element these tests
  // would pass on an unlabelled control.
  StyledSelect: ({
    value,
    options,
    onChange,
    testId,
    selectId,
    ariaLabel,
    ariaDescribedBy,
  }: {
    value?: string;
    options?: { value: string; label: string }[];
    onChange?: (value: string) => void;
    testId?: string;
    selectId?: string;
    ariaLabel?: string;
    ariaDescribedBy?: string;
  }) => (
    <select
      data-testid={testId}
      id={selectId}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.currentTarget.value)}
    >
      {(options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  Spinner: () => <span>loading…</span>,
  // `id` is forwarded on purpose: the scope statement is the aria-describedby
  // target for the scope select, and a mock that drops it would let a broken
  // association pass.
  Text: ({
    children,
    id,
    testID,
  }: {
    children?: ReactNode;
    id?: string;
    testID?: string;
  }) => (
    <span id={id} data-testid={testID}>
      {children}
    </span>
  ),
  useFormatters: () => ({
    locale: "en",
    number: (value: number) => String(value),
    currency: (cents: number) => String(cents),
    // Deterministic, locale-free stand-in — the assertions only need dates to
    // be present and distinguishable.
    dateTime: (value: Date | number | string) =>
      new Date(value).toISOString().slice(0, 10),
    getRawMessage: () => undefined,
  }),
  useNotify: () => ({ toast: { danger: testMocks.toastDanger } }),
  useLocale: () => "en",
  // Renders ICU arguments inline so per-row accessible names stay
  // distinguishable in assertions (`key a=1 b=2`), keys without values as-is.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values
      ? `${key} ${Object.entries(values)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")}`
      : key,
}));

import { CalendarBlackoutEditor } from "../CalendarBlackoutEditor";
import { CalendarHoursEditor } from "../CalendarHoursEditor";
import { CalendarsManager } from "../CalendarsManager";
import { CalendarsSection } from "../CalendarsSection";
import { SpacesSection } from "../SpacesSection";

const PLACE_ID = "55555555-5555-4555-8555-555555555555";
const CAL_ID = "11111111-1111-4111-8111-111111111111";

const weeklyRow = {
  id: "row-1",
  placeId: PLACE_ID,
  calendarId: CAL_ID,
  dayOfWeek: 5,
  date: null,
  startTime: "18:00",
  endTime: "23:00",
  isOpen: true,
  note: "door at 17:30",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeSpace = (id: string, name: string, status: "ACTIVE" | "RETIRED") => ({
  id,
  placeId: PLACE_ID,
  name,
  capacity: null,
  sortOrder: 0,
  status,
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  availabilityRows = [];
  spaceRows = [];
  calendarRows = [];
  availabilityError = null;
  spacesError = null;
});

describe("CalendarBlackoutEditor — scope + full-PUT create", () => {
  it("an 'All calendars' blackout fires ONE place-wide row: calendarId null, isOpen false, date XOR dayOfWeek", () => {
    render(
      <CalendarBlackoutEditor
        placeId={PLACE_ID}
        scope={null}
        scopeLabel="All calendars"
      />,
    );

    fireEvent.change(screen.getByTestId("blackout-from"), {
      target: { value: "2026-09-17" },
    });
    fireEvent.click(screen.getByTestId("blackout-add"));

    expect(testMocks.upsertMutate).toHaveBeenCalledTimes(1);
    const payload = testMocks.upsertMutate.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      placeId: PLACE_ID,
      calendarId: null,
      dayOfWeek: null,
      isOpen: false,
      startTime: null,
      endTime: null,
      note: null,
    });
    expect(payload.date).toBeInstanceOf(Date);
    expect((payload.date as Date).getDate()).toBe(17);
    // FULL-PUT: isOpen must be PRESENT, not defaulted away.
    expect(Object.hasOwn(payload, "isOpen")).toBe(true);
  });

  it("a calendar-scoped blackout carries that calendarId", () => {
    render(
      <CalendarBlackoutEditor
        placeId={PLACE_ID}
        scope={CAL_ID}
        scopeLabel="Live Music"
      />,
    );

    fireEvent.change(screen.getByTestId("blackout-from"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.click(screen.getByTestId("blackout-add"));

    expect(testMocks.upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: CAL_ID, isOpen: false }),
    );
  });

  it("keeps the typed dates/note until the create SUCCEEDS (a failed add must not discard them)", () => {
    render(
      <CalendarBlackoutEditor
        placeId={PLACE_ID}
        scope={null}
        scopeLabel="All calendars"
      />,
    );

    fireEvent.change(screen.getByTestId("blackout-from"), {
      target: { value: "2026-09-17" },
    });
    fireEvent.change(screen.getByTestId("blackout-note"), {
      target: { value: "Private hire" },
    });
    fireEvent.click(screen.getByTestId("blackout-add"));

    // The mocked mutate never resolves — the form must still hold the input.
    expect(screen.getByTestId("blackout-from")).toHaveValue("2026-09-17");
    expect(screen.getByTestId("blackout-note")).toHaveValue("Private hire");
  });

  it("a failed read renders error + retry, NOT an empty list with a live add form", () => {
    availabilityError = new Error("Availability read failed upstream");
    render(
      <CalendarBlackoutEditor
        placeId={PLACE_ID}
        scope={null}
        scopeLabel="All calendars"
      />,
    );

    expect(
      screen.getByText("Availability read failed upstream"),
    ).toBeInTheDocument();
    // "No blackout dates yet" would be a lie, and the add form invites
    // duplicate rows once the error clears.
    expect(screen.queryByText("admin.peBlackoutEmpty")).toBeNull();
    expect(screen.queryByTestId("blackout-add")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "admin.placesRetry" }));
    expect(testMocks.refetchAvailability).toHaveBeenCalledTimes(1);
  });

  it("states the active scope VISIBLY — above the list and in the add form", () => {
    render(
      <CalendarBlackoutEditor
        placeId={PLACE_ID}
        scope={null}
        scopeLabel="All calendars"
      />,
    );

    // Two write surfaces (the existing-rows list with its Remove buttons, and
    // the add form) — each names the scope. Announced-only was the bug.
    expect(
      screen.getAllByText("admin.calMgrScopeAppliesTo scope=All calendars"),
    ).toHaveLength(2);
  });

  it("shows a place-wide row (chip-marked) inside a calendar scope — the venue IS closed that night", () => {
    availabilityRows = [
      {
        ...weeklyRow,
        id: "blk-1",
        calendarId: null,
        dayOfWeek: null,
        date: new Date(2026, 8, 17),
        isOpen: false,
        note: null,
      },
    ];
    render(
      <CalendarBlackoutEditor
        placeId={PLACE_ID}
        scope={CAL_ID}
        scopeLabel="Live Music"
      />,
    );

    // The All-calendars chip marks the row's wider origin.
    expect(screen.getByText("admin.calMgrScopeAll")).toBeInTheDocument();
  });
});

describe("CalendarHoursEditor — full-PUT update", () => {
  it("a time edit restates the WHOLE row (id, row's own calendarId, isOpen, note) on blur", () => {
    availabilityRows = [weeklyRow];
    render(
      <CalendarHoursEditor
        placeId={PLACE_ID}
        scope={CAL_ID}
        scopeLabel="Live Music"
      />,
    );

    const start = screen.getByDisplayValue("18:00");
    fireEvent.change(start, { target: { value: "19:00" } });
    fireEvent.blur(start);

    expect(testMocks.upsertMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.upsertMutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      id: "row-1",
      calendarId: CAL_ID, // the ROW's scope — immutable after create
      dayOfWeek: 5,
      date: null,
      startTime: "19:00",
      endTime: "23:00",
      isOpen: true, // full-PUT: never omitted
      note: "door at 17:30", // restated, not dropped
    });
  });

  it("opening a day at the All-calendars scope creates a place-wide window", () => {
    render(
      <CalendarHoursEditor
        placeId={PLACE_ID}
        scope={null}
        scopeLabel="All calendars"
      />,
    );

    // Seven closed days render seven Open buttons; any of them will do.
    const openButtons = screen.getAllByRole("button", {
      name: /peHoursOpenDay/,
    });
    fireEvent.click(openButtons[0]!);

    expect(testMocks.upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        calendarId: null,
        date: null,
        isOpen: true,
      }),
    );
    expect(typeof testMocks.upsertMutate.mock.calls[0]?.[0]?.dayOfWeek).toBe(
      "number",
    );
  });

  it("two windows on one weekday announce DISTINCT names — the time range is part of each label", () => {
    availabilityRows = [
      weeklyRow,
      { ...weeklyRow, id: "row-2", startTime: "12:00", endTime: "15:00" },
    ];
    render(
      <CalendarHoursEditor
        placeId={PLACE_ID}
        scope={CAL_ID}
        scopeLabel="Live Music"
      />,
    );

    const labels = Array.from(
      document.querySelectorAll("[aria-label]"),
      (el) => el.getAttribute("aria-label") ?? "",
    ).filter((label) => /peHours(OpensAt|ClosesAt|RemoveWindow)/.test(label));

    // 2 windows × (opens-at input, closes-at input, remove button)…
    expect(labels).toHaveLength(6);
    // …and no two of the six may collide.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a failed read renders error + retry, NOT 'every day closed' with live Open buttons", () => {
    availabilityError = new Error("Availability read failed upstream");
    render(
      <CalendarHoursEditor
        placeId={PLACE_ID}
        scope={CAL_ID}
        scopeLabel="Live Music"
      />,
    );

    expect(
      screen.getByText("Availability read failed upstream"),
    ).toBeInTheDocument();
    // An owner who "re-opens" days over a transient error creates duplicate
    // rows once it clears — the day grid must not render at all.
    expect(
      screen.queryAllByRole("button", {
        name: /peHoursOpenDay|peHoursCloseDay|peHoursAddWindow/,
      }),
    ).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "admin.placesRetry" }));
    expect(testMocks.refetchAvailability).toHaveBeenCalledTimes(1);
  });

  it("states the active scope VISIBLY, not only inside aria-labels", () => {
    render(
      <CalendarHoursEditor
        placeId={PLACE_ID}
        scope={null}
        scopeLabel="All calendars"
      />,
    );

    expect(
      screen.getByText("admin.calMgrScopeAppliesTo scope=All calendars"),
    ).toBeInTheDocument();
  });

  it("another scope's windows never render in this grid", () => {
    availabilityRows = [{ ...weeklyRow, calendarId: "other-cal" }];
    render(
      <CalendarHoursEditor
        placeId={PLACE_ID}
        scope={CAL_ID}
        scopeLabel="Live Music"
      />,
    );

    expect(screen.queryByDisplayValue("18:00")).toBeNull();
  });
});

describe("SpacesSection — last-active-space guard", () => {
  const space = (id: string, name: string, status: "ACTIVE" | "RETIRED") => ({
    id,
    placeId: PLACE_ID,
    name,
    capacity: null,
    sortOrder: 0,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("disables Retire (with the inline reason) on the only active space", () => {
    spaceRows = [
      space("r1", "Main Space", "ACTIVE"),
      space("r2", "Patio", "RETIRED"),
    ];
    render(<SpacesSection placeId={PLACE_ID} />);

    expect(screen.getByTestId("space-retire-r1")).toBeDisabled();
    expect(
      screen.getByText("admin.calMgrLastActiveSpaceHint"),
    ).toBeInTheDocument();
  });

  it("lets a non-last active space retire, and a retired one reactivate", () => {
    spaceRows = [
      space("r1", "Main Space", "ACTIVE"),
      space("r2", "Back Bar", "ACTIVE"),
    ];
    render(<SpacesSection placeId={PLACE_ID} />);

    const retire = screen.getByTestId("space-retire-r2");
    expect(retire).not.toBeDisabled();
    fireEvent.click(retire);
    expect(testMocks.setSpaceStatusMutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      spaceId: "r2",
      status: "RETIRED",
    });
  });

  it("reactivates a retired space", () => {
    spaceRows = [
      space("r1", "Main Space", "ACTIVE"),
      space("r2", "Patio", "RETIRED"),
    ];
    render(<SpacesSection placeId={PLACE_ID} />);

    fireEvent.click(
      screen.getByRole("button", { name: /calMgrReactivate — Patio/ }),
    );
    expect(testMocks.setSpaceStatusMutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      spaceId: "r2",
      status: "ACTIVE",
    });
  });

  // ── Named-calendar refusal (owner ruling 2026-09-23) ──────────────────────
  // The per-calendar arm of the invariant cannot be pre-disabled here (this
  // section does not hold the calendar/space joins), so the server refusal has
  // to carry the answer. `meta.calendars` is what makes it an answer.

  const retireBlocked = (calendars: { id: string; name: string }[]) =>
    Object.assign(new Error("CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR"), {
      data: {
        appCode: "CANNOT_RETIRE_LAST_ACTIVE_SPACE_ON_CALENDAR",
        meta: { placeId: PLACE_ID, spaceId: "r2", calendars },
      },
    });

  it("names the blocking calendar in the toast instead of a generic failure", () => {
    spaceRows = [
      space("r1", "Main Space", "ACTIVE"),
      space("r2", "Patio", "ACTIVE"),
    ];
    render(<SpacesSection placeId={PLACE_ID} />);

    testMocks.setSpaceStatusOptions.onError?.(
      retireBlocked([{ id: "cal-1", name: "Patio Sessions" }]),
    );

    expect(testMocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "admin.calMgrRetireBlockedByCalendars count=1 names=Patio Sessions",
      }),
    );
  });

  it("joins several blocking calendars into one sentence", () => {
    spaceRows = [
      space("r1", "Main Space", "ACTIVE"),
      space("r2", "Patio", "ACTIVE"),
    ];
    render(<SpacesSection placeId={PLACE_ID} />);

    testMocks.setSpaceStatusOptions.onError?.(
      retireBlocked([
        { id: "cal-1", name: "Patio Sessions" },
        { id: "cal-2", name: "Brunch" },
      ]),
    );

    expect(testMocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "admin.calMgrRetireBlockedByCalendars count=2 names=Patio Sessions and Brunch",
      }),
    );
  });

  it("falls back to the catalog sentence for any OTHER failure", () => {
    spaceRows = [space("r1", "Main Space", "ACTIVE")];
    render(<SpacesSection placeId={PLACE_ID} />);

    testMocks.setSpaceStatusOptions.onError?.(
      Object.assign(new Error("CANNOT_RETIRE_LAST_ACTIVE_SPACE"), {
        data: { appCode: "CANNOT_RETIRE_LAST_ACTIVE_SPACE" },
      }),
    );

    // Falls through `formatErrorMessage` (which this file's stub translator
    // reports as an unmapped key, hence the generic sentence) — the point is
    // that it does NOT print the named-calendar copy.
    const message = testMocks.toastDanger.mock.calls[0]![0].message as string;
    expect(message).not.toContain("calMgrRetireBlockedByCalendars");
    expect(message).toBe(
      "Something went wrong. Please try again or contact support.",
    );
  });

  it("a failed read renders error + retry, NOT an empty list with a live add form", () => {
    spacesError = new Error("Spaces read failed upstream");
    render(<SpacesSection placeId={PLACE_ID} />);

    expect(screen.getByText("Spaces read failed upstream")).toBeInTheDocument();
    // A live "Add space" over a transient error duplicates the space once the
    // error clears.
    expect(screen.queryByTestId("space-add")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "admin.placesRetry" }));
    expect(testMocks.refetchSpaces).toHaveBeenCalledTimes(1);
  });
});

describe("CalendarsSection — one-write create, two-write update, ≥1 space", () => {
  const createdCalendar = {
    id: "cal-new",
    placeId: PLACE_ID,
    name: "Supper Club",
    slug: "supper-club",
    description: null,
    defaultStartTime: null,
    isDefault: false,
    spaces: [],
  };

  it("create sends spaceIds in the SAME write and never follows up with assignCalendarSpaces", async () => {
    spaceRows = [
      makeSpace("r1", "Main Space", "ACTIVE"),
      makeSpace("r2", "Patio", "ACTIVE"),
    ];
    testMocks.createCalendarAsync.mockImplementation(async () => {
      // Model the refetch: the created calendar is what the list now returns.
      calendarRows = [createdCalendar];
      return createdCalendar;
    });

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Supper Club" },
    });
    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    fireEvent.click(screen.getByTestId("new-calendar-space-r2"));
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    await waitFor(() => {
      expect(testMocks.createCalendarAsync).toHaveBeenCalledTimes(1);
    });
    expect(testMocks.createCalendarAsync).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      name: "Supper Club",
      spaceIds: ["r1", "r2"],
    });
    // The row and its spaces are joined server-side in one transaction — a
    // second write here would re-open the "created but unassigned" window.
    expect(testMocks.assignSpacesAsync).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    });
    expect(testMocks.toastDanger).not.toHaveBeenCalled();
    expect(screen.getByTestId("calendar-card-supper-club")).toBeInTheDocument();
  });

  it("create is disabled (with the inline reason) until at least one space is picked", () => {
    spaceRows = [makeSpace("r1", "Main Space", "ACTIVE")];

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Supper Club" },
    });

    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
    expect(screen.getByText("admin.calMgrSpacesRequired")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    expect(screen.getByTestId("calendar-create-submit")).not.toBeDisabled();
    expect(screen.queryByText("admin.calMgrSpacesRequired")).toBeNull();

    // Un-ticking the only space re-arms the gate.
    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
    expect(testMocks.createCalendarAsync).not.toHaveBeenCalled();
  });

  it("ticking ONLY a retired room does not arm Create — one join is not one active space", () => {
    // Owner ruling 2026-09-23. The checklist lists retired rooms on purpose
    // (an owner keeps or un-joins them), so a tick-count gate would arm the
    // button here and round-trip the owner to CALENDAR_REQUIRES_ACTIVE_SPACE.
    spaceRows = [
      makeSpace("r1", "Main Space", "ACTIVE"),
      makeSpace("r2", "Demolished Annex", "RETIRED"),
    ];

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Annex Nights" },
    });

    fireEvent.click(screen.getByTestId("new-calendar-space-r2"));
    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
    expect(screen.getByText("admin.calMgrSpacesRequired")).toBeInTheDocument();

    // Adding a live room alongside it is legal — that is how history is kept.
    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    expect(screen.getByTestId("calendar-create-submit")).not.toBeDisabled();
    expect(screen.queryByText("admin.calMgrSpacesRequired")).toBeNull();
  });

  it("Save is disabled when an edit would leave the calendar with only retired rooms", () => {
    spaceRows = [
      makeSpace("r1", "Main Space", "ACTIVE"),
      makeSpace("r2", "Demolished Annex", "RETIRED"),
    ];
    calendarRows = [
      {
        ...createdCalendar,
        spaces: [
          makeSpace("r1", "Main Space", "ACTIVE"),
          makeSpace("r2", "Demolished Annex", "RETIRED"),
        ],
      },
    ];

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    expect(screen.getByTestId("calendar-save-supper-club")).not.toBeDisabled();

    // Un-tick the only ACTIVE room, leaving the retired one ticked: the tick
    // count is still 1, but the calendar would have nowhere to put an event.
    fireEvent.click(screen.getByTestId("calendar-cal-new-space-r1"));
    expect(screen.getByTestId("calendar-save-supper-club")).toBeDisabled();
    expect(screen.getByText("admin.calMgrSpacesRequired")).toBeInTheDocument();
    expect(testMocks.assignSpacesAsync).not.toHaveBeenCalled();
  });

  it("a venue with no spaces at all is told to add one in the Spaces section — not left with a dead Create", () => {
    spaceRows = [];

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Supper Club" },
    });

    expect(screen.getByTestId("calendar-create-submit")).toBeDisabled();
    expect(screen.getByText("admin.calMgrSpacesNoneYet")).toBeInTheDocument();
    expect(screen.queryByText("admin.calMgrSpacesRequired")).toBeNull();
  });

  it("Save is disabled when an edit would leave the calendar with zero spaces", () => {
    spaceRows = [makeSpace("r1", "Main Space", "ACTIVE")];
    calendarRows = [
      { ...createdCalendar, spaces: [makeSpace("r1", "Main Space", "ACTIVE")] },
    ];

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    expect(screen.getByTestId("calendar-save-supper-club")).not.toBeDisabled();

    // Un-tick the calendar's only space: assignCalendarSpaces rejects an
    // empty set, so the form must not offer the write.
    fireEvent.click(screen.getByTestId("calendar-cal-new-space-r1"));
    expect(screen.getByTestId("calendar-save-supper-club")).toBeDisabled();
    expect(screen.getByText("admin.calMgrSpacesRequired")).toBeInTheDocument();
    expect(testMocks.updateCalendarAsync).not.toHaveBeenCalled();
  });

  it("a create failure keeps the create form (nothing exists yet) and reports the create error", async () => {
    spaceRows = [makeSpace("r1", "Main Space", "ACTIVE")];
    testMocks.createCalendarAsync.mockRejectedValue(
      new Error("Create failed upstream"),
    );

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Supper Club" },
    });
    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    await waitFor(() => {
      expect(testMocks.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "calendar-create-failed" }),
      );
    });
    expect(screen.getByTestId("calendar-create-form")).toBeInTheDocument();
    // The typed name survives for the retry.
    expect(screen.getByTestId("new-calendar-name")).toHaveValue("Supper Club");
  });

  it("an update whose space re-assignment fails stays in edit mode and reports the SPACES failure", async () => {
    spaceRows = [makeSpace("r1", "Main Space", "ACTIVE")];
    calendarRows = [createdCalendar];
    testMocks.updateCalendarAsync.mockResolvedValue(createdCalendar);
    testMocks.assignSpacesAsync.mockRejectedValue(
      new Error("Space assignment failed upstream"),
    );

    render(<CalendarsSection placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId("calendar-cal-new-space-r1"));
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));

    await waitFor(() => {
      expect(testMocks.toastDanger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "calendar-spaces-assign-failed" }),
      );
    });
    expect(testMocks.toastDanger).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "calendar-update-failed" }),
    );
    // Still editing — Save retries just the assignment.
    expect(screen.getByTestId("calendar-save-supper-club")).toBeInTheDocument();
  });
});

/**
 * The availability scope defaults to PLACE-WIDE (`calendarId: null`) and that
 * default is deliberate — a per-calendar default would leave a newly-added
 * calendar with zero declared hours, and the no-declared-hours escape hatch in
 * `validate-booking-dates` then accepts any date for it. So the default stays
 * and the SCOPE has to be unmistakable instead: a venue owner reported setting
 * "calendar" hours that were silently venue-wide.
 *
 * Each assertion below fails on a specific regression:
 *  - the resolved statement disappearing (back to a bare select),
 *  - the place-wide / per-calendar treatments collapsing into one,
 *  - a write surface (hours grid, blackout list, blackout add form) losing its
 *    scope line,
 *  - the select losing its label or its description association.
 */
describe("CalendarsManager — the availability scope is stated, not just selectable", () => {
  const liveMusic = {
    id: CAL_ID,
    placeId: PLACE_ID,
    name: "Live Music",
    slug: "live-music",
    description: null,
    defaultStartTime: null,
    isDefault: true,
    spaces: [],
  };

  it("opens on the place-wide scope and SAYS so, at every write surface", () => {
    calendarRows = [liveMusic];
    render(<CalendarsManager />);

    // The broader scope carries the distinct treatment.
    expect(screen.getByTestId("availability-scope-all")).toBeInTheDocument();
    expect(screen.queryByTestId("availability-scope-calendar")).toBeNull();

    expect(
      screen.getByText("admin.calMgrScopeStatementAll"),
    ).toBeInTheDocument();

    // Hours heading, blackout heading, blackout add form.
    expect(
      screen.getAllByText(
        "admin.calMgrScopeAppliesTo scope=admin.calMgrScopeAll",
      ),
    ).toHaveLength(3);
  });

  it("picking a calendar re-states the narrower scope everywhere", () => {
    calendarRows = [liveMusic];
    render(<CalendarsManager />);

    fireEvent.change(screen.getByTestId("availability-scope"), {
      target: { value: CAL_ID },
    });

    expect(
      screen.getByTestId("availability-scope-calendar"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("availability-scope-all")).toBeNull();

    expect(
      screen.getByText(
        "admin.calMgrScopeStatementCalendar calendar=Live Music",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("admin.calMgrScopeStatementAll")).toBeNull();
    expect(
      screen.getAllByText("admin.calMgrScopeAppliesTo scope=Live Music"),
    ).toHaveLength(3);
  });

  it("the scope select is labelled and described BY the resolved statement", () => {
    calendarRows = [liveMusic];
    render(<CalendarsManager />);

    const select = screen.getByTestId("availability-scope");
    expect(select).toHaveAttribute("aria-label", "admin.calMgrScopeLabel");

    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The description must be the SENTENCE, not a stale/absent node — a
    // dangling aria-describedby announces nothing at all.
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      "admin.calMgrScopeStatementAll",
    );
  });

  it("falls back to place-wide (and says so) when the selected calendar disappears", () => {
    calendarRows = [liveMusic];
    const { rerender } = render(<CalendarsManager />);

    fireEvent.change(screen.getByTestId("availability-scope"), {
      target: { value: CAL_ID },
    });
    expect(
      screen.getByTestId("availability-scope-calendar"),
    ).toBeInTheDocument();

    // The calendar is deleted elsewhere: the editors must not keep claiming a
    // dead scope's name while writing place-wide rows.
    calendarRows = [];
    rerender(<CalendarsManager />);

    expect(screen.getByTestId("availability-scope-all")).toBeInTheDocument();
    expect(
      screen.getByText("admin.calMgrScopeStatementAll"),
    ).toBeInTheDocument();
  });
});

/**
 * Booking config layer (venue-confirmation-and-booking-intents spec —
 * "Calendar is the config layer"). What these pin:
 *  - the editor opens on the spec defaults (Play on, Rent/Use off) with the
 *    rate fields hidden,
 *  - Rent reveals rate + currency (USD default) + the public-rate toggle,
 *  - a save carries ONLY the booking fields that changed, the rate as a pair —
 *    so a calendar nobody touched sends exactly the pre-layer payload,
 *  - a rate refused by the server's pair rule lands on the FIELD, not a toast,
 *  - the list row summarises the intents in one line.
 */
describe("CalendarsSection — booking intents (calendar is the config layer)", () => {
  const CAL = "cal-book";
  const bookingCalendar = {
    id: CAL,
    placeId: PLACE_ID,
    name: "Supper Club",
    slug: "supper-club",
    description: null,
    defaultStartTime: null,
    isDefault: false,
    acceptsPerform: true,
    acceptsRent: false,
    acceptsUse: false,
    rentalRateCents: null,
    rentalRateCurrency: null,
    rentalRateVisible: false,
    rentalMode: "REQUEST",
    spaces: [makeSpace("r1", "Main Space", "ACTIVE")],
  };
  const P = `calendar-${CAL}`;

  beforeEach(() => {
    spaceRows = [makeSpace("r1", "Main Space", "ACTIVE")];
    calendarRows = [bookingCalendar];
    testMocks.updateCalendarAsync.mockResolvedValue(bookingCalendar);
  });

  it("opens on the spec defaults — Play on, Rent and Use off — with the rate fields hidden", () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));

    expect(screen.getByTestId(`${P}-intent-perform-track`)).toBeChecked();
    expect(screen.getByTestId(`${P}-intent-rent-track`)).not.toBeChecked();
    expect(screen.getByTestId(`${P}-intent-use-track`)).not.toBeChecked();
    expect(screen.queryByTestId(`${P}-rental`)).toBeNull();
    // The public verbs, as visible labels tied to their switches.
    expect(screen.getByText("admin.calMgrIntentPerformLabel")).toBeInTheDocument();
    expect(
      screen.getByText("admin.calMgrIntentPerformLabel").closest("label"),
    ).toHaveAttribute("for", `${P}-intent-perform`);
  });

  it("Rent reveals the rate, a currency defaulting to USD, and the public-rate toggle", () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));

    expect(screen.getByTestId(`${P}-rental`)).toBeInTheDocument();
    expect(screen.getByTestId(`${P}-rental-rate`)).toHaveValue("");
    expect(screen.getByTestId(`${P}-rental-currency`)).toHaveValue("USD");
    expect(screen.getByTestId(`${P}-rental-visible-track`)).not.toBeChecked();

    // Off again hides the panel; nothing about the rate is asserted on the wire.
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));
    expect(screen.queryByTestId(`${P}-rental`)).toBeNull();
  });

  it("save carries ONLY the changed booking fields, the rate as a pair in cents", async () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));
    fireEvent.change(screen.getByTestId(`${P}-rental-rate`), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByTestId(`${P}-rental-visible-track`));
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));

    await waitFor(() => {
      expect(testMocks.updateCalendarAsync).toHaveBeenCalledTimes(1);
    });
    expect(testMocks.updateCalendarAsync).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      calendarId: CAL,
      patch: {
        name: "Supper Club",
        description: null,
        defaultStartTime: null,
        acceptsRent: true,
        rentalRateVisible: true,
        rentalRateCents: 50000,
        rentalRateCurrency: "USD",
      },
    });
    expect(testMocks.toastDanger).not.toHaveBeenCalled();
  });

  it("an untouched booking group adds nothing — the pre-layer patch, byte for byte", async () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));

    await waitFor(() => {
      expect(testMocks.updateCalendarAsync).toHaveBeenCalledTimes(1);
    });
    expect(testMocks.updateCalendarAsync).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      calendarId: CAL,
      patch: { name: "Supper Club", description: null, defaultStartTime: null },
    });
  });

  it("a rate the server refuses as an incomplete pair lands on the field, not in a toast", async () => {
    // tRPC's own input validation: the update patch keeps its superRefine, so
    // the wire message is Zod's issue dump with the offending path.
    testMocks.updateCalendarAsync.mockRejectedValue(
      new Error(
        JSON.stringify([
          {
            code: "custom",
            message: "rental_rate_requires_amount_and_currency",
            path: ["patch", "rentalRateCurrency"],
          },
        ]),
      ),
    );

    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));
    fireEvent.change(screen.getByTestId(`${P}-rental-rate`), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));

    await waitFor(() => {
      expect(screen.getByTestId(`${P}-rental-rate-error`)).toHaveTextContent(
        "admin.calMgrRentalRatePairError",
      );
    });
    expect(testMocks.toastDanger).not.toHaveBeenCalled();
    // Still editing, and the currency select is described by the error.
    expect(screen.getByTestId("calendar-save-supper-club")).toBeInTheDocument();
    expect(screen.getByTestId(`${P}-rental-currency`)).toHaveAttribute(
      "aria-describedby",
      `${P}-rental-rate-error`,
    );

    // Editing the group clears the error (validate on submit, clear on input).
    fireEvent.change(screen.getByTestId(`${P}-rental-rate`), {
      target: { value: "600" },
    });
    expect(screen.queryByTestId(`${P}-rental-rate-error`)).toBeNull();
  });

  it("a refused rate moves focus to the field it is about", async () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));
    fireEvent.change(screen.getByTestId(`${P}-rental-rate`), {
      target: { value: "1,500" },
    });
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId(`${P}-rental-rate`));
    });
    // The field is described by the error AND the hint while invalid.
    expect(screen.getByTestId(`${P}-rental-rate`)).toHaveAttribute(
      "aria-describedby",
      `${P}-rental-rate-error ${P}-rental-rate-hint`,
    );

    // A server-side CURRENCY refusal lands focus on the select.
    testMocks.updateCalendarAsync.mockRejectedValue(
      new Error(
        JSON.stringify([
          { code: "custom", message: "x", path: ["patch", "rentalRateCurrency"] },
        ]),
      ),
    );
    fireEvent.change(screen.getByTestId(`${P}-rental-rate`), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId(`${P}-rental-currency`),
      );
    });
  });

  it("a rate error from an abandoned create does not follow the owner into Edit", () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Supper Club 2" },
    });
    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    fireEvent.click(screen.getByTestId("new-calendar-intent-rent-track"));
    fireEvent.change(screen.getByTestId("new-calendar-rental-rate"), {
      target: { value: "1,500" },
    });
    fireEvent.click(screen.getByTestId("calendar-create-submit"));
    expect(
      screen.getByTestId("new-calendar-rental-rate-error"),
    ).toBeInTheDocument();

    // Edit is reachable without cancelling the create first.
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    expect(screen.queryByTestId("calendar-create-form")).toBeNull();
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));
    expect(screen.queryByTestId(`${P}-rental-rate-error`)).toBeNull();
    expect(screen.queryByTestId("new-calendar-rental-rate-error")).toBeNull();
  });

  it("an ambiguous amount ($1,500 or $1.50?) is refused before anything reaches the wire", () => {
    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-edit-supper-club"));
    fireEvent.click(screen.getByTestId(`${P}-intent-rent-track`));
    fireEvent.change(screen.getByTestId(`${P}-rental-rate`), {
      target: { value: "1,500" },
    });
    fireEvent.click(screen.getByTestId("calendar-save-supper-club"));

    expect(screen.getByTestId(`${P}-rental-rate-error`)).toHaveTextContent(
      "admin.calMgrRentalRateAmbiguous",
    );
    expect(screen.getByTestId(`${P}-rental-rate`)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(testMocks.updateCalendarAsync).not.toHaveBeenCalled();
  });

  it("create sends a flipped intent and nothing else from the booking group", async () => {
    calendarRows = [];
    testMocks.createCalendarAsync.mockResolvedValue(bookingCalendar);

    render(<CalendarsSection placeId={PLACE_ID} />);
    fireEvent.click(screen.getByTestId("calendar-new"));
    fireEvent.change(screen.getByTestId("new-calendar-name"), {
      target: { value: "Supper Club" },
    });
    fireEvent.click(screen.getByTestId("new-calendar-space-r1"));
    fireEvent.click(screen.getByTestId("new-calendar-intent-use-track"));
    fireEvent.click(screen.getByTestId("calendar-create-submit"));

    await waitFor(() => {
      expect(testMocks.createCalendarAsync).toHaveBeenCalledTimes(1);
    });
    expect(testMocks.createCalendarAsync).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      name: "Supper Club",
      spaceIds: ["r1"],
      acceptsUse: true,
    });
  });

  it("the list row states the accepted intents in one line, with the rate", () => {
    calendarRows = [
      {
        ...bookingCalendar,
        acceptsRent: true,
        rentalRateCents: 50000,
        rentalRateCurrency: "USD",
      },
    ];
    render(<CalendarsSection placeId={PLACE_ID} />);

    expect(screen.getByTestId("calendar-intents-supper-club")).toHaveTextContent(
      "admin.calMgrIntentSummaryPerform · admin.calMgrIntentSummaryRentRate rate=$500",
    );
  });

  it("a calendar that takes no requests says so on its row", () => {
    calendarRows = [{ ...bookingCalendar, acceptsPerform: false }];
    render(<CalendarsSection placeId={PLACE_ID} />);

    expect(screen.getByTestId("calendar-intents-supper-club")).toHaveTextContent(
      "admin.calMgrIntentSummaryNone",
    );
  });
});
