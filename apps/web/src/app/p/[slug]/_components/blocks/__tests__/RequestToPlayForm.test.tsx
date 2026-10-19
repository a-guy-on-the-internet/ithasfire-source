import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RequestToPlayPanel with intents (venue-confirmation-and-booking-intents
 * spec): the intent picker filters ONE form; PERFORM is today's pitch (byte-
 * identical payload, plus the calendar it was picked against); RENT/USE is
 * the room-hire variant, open to any human, carrying the new wire fields.
 */

const testMocks = vi.hoisted(() => ({
  statusUseQuery: vi.fn(),
  defaultsUseQuery: vi.fn(),
  optionsUseQuery: vi.fn(),
  availabilityUseQuery: vi.fn(),
  createMutate: vi.fn(),
  owners: vi.fn(),
  searchUseQuery: vi.fn(),
  setModeMutate: vi.fn(),
  setModePending: { value: false },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      performers: {
        getMyStatus: { getData: vi.fn(), setData: vi.fn(), invalidate: vi.fn() },
      },
    }),
    performers: {
      getMyStatus: { useQuery: testMocks.statusUseQuery },
      setMode: {
        useMutation: () => ({
          mutate: testMocks.setModeMutate,
          isPending: testMocks.setModePending.value,
        }),
      },
      getBookingDefaults: { useQuery: testMocks.defaultsUseQuery },
    },
    bookingRequests: {
      create: {
        useMutation: () => ({ mutate: testMocks.createMutate, isPending: false }),
      },
    },
    places: {
      getBookingOptions: { useQuery: testMocks.optionsUseQuery },
      getBookingAvailability: { useQuery: testMocks.availabilityUseQuery },
    },
    search: {
      autocompleteAdmin: { useQuery: testMocks.searchUseQuery },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => testMocks.owners(),
}));

vi.mock("@th/ui", () => ({
  Spinner: () => null,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Money: { format: (cents: number) => `$${(cents / 100).toFixed(2)}` },
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

// The stats line and the availability picker have their own suites; here they
// only need to stay out of the way. The picker stub echoes the calendar AND
// the mode it was handed, so the "one state value feeds both ends" invariant
// and "RENT/USE gets the date-only calendar" are both visible here.
vi.mock("../RequestToPlayStatsLine", () => ({
  RequestToPlayStatsLine: () => null,
}));
// `importOriginal` keeps the REAL `bookingAvailabilityInput` — the whole
// point of that export is that both forms build one identical query key, so
// stubbing it here would hide the bug it exists to prevent.
vi.mock("../BookingDatePicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../BookingDatePicker")>()),
  BookingDatePicker: ({
    calendarId,
    mode,
    max,
    value,
    onChange,
  }: {
    calendarId?: string;
    mode?: "date" | "dateTime";
    max: number;
    value: string[];
    onChange: (next: string[]) => void;
  }) => (
    <input
      aria-label="dates"
      data-calendar={calendarId ?? ""}
      data-mode={mode ?? "dateTime"}
      data-max={String(max)}
      value={value[0] ?? ""}
      onChange={(e) => onChange([e.target.value])}
    />
  ),
}));

import { RequestToPlayPanel } from "../RequestToPlayForm";

const PLACE_ID = "place-1";

const MAIN = {
  id: "cal-main",
  name: "Main",
  isDefault: true,
  acceptsPerform: true,
  acceptsRent: true,
  acceptsUse: false,
  rentalRateCents: 50_000,
  rentalRateCurrency: "usd",
  rentalRateVisible: true,
  spaces: [
    { id: "space-a", name: "Room A" },
    { id: "space-b", name: "Room B" },
  ],
};
const LATE = {
  ...MAIN,
  id: "cal-late",
  name: "Late Night",
  isDefault: false,
  acceptsRent: false,
  rentalRateCents: null,
  rentalRateCurrency: null,
  rentalRateVisible: false,
  spaces: [{ id: "space-a", name: "Room A" }],
};
/** A second calendar that DOES rent, so the RENT form gets a real select. */
const LOFT = {
  ...LATE,
  id: "cal-loft",
  name: "Loft",
  acceptsRent: true,
  spaces: [{ id: "space-loft", name: "Loft" }],
};
/**
 * Says it rents, but has no active room. Pre-ruling debt: the writes that
 * could produce it are all refused since 2026-09-23, so the booking surfaces
 * treat what is left as invalid data and withhold RENT/USE.
 */
const ROOMLESS = {
  ...MAIN,
  id: "cal-floor",
  name: "Whole floor",
  isDefault: false,
  rentalRateVisible: false,
  spaces: [] as { id: string; name: string }[],
};

function mockOptions(
  calendars: unknown[],
  extra: { isClaimed?: boolean; acceptsBookingRequests?: boolean } = {},
) {
  testMocks.optionsUseQuery.mockReturnValue({
    data: {
      placeId: PLACE_ID,
      isClaimed: extra.isClaimed ?? true,
      acceptsBookingRequests: extra.acceptsBookingRequests ?? true,
      calendars,
    },
    isPending: false,
    isSuccess: true,
    isError: false,
  });
}

function mockStatus(
  performerEnabled: boolean,
  orgs: { ownerId: string; enabled: boolean }[] = [],
) {
  testMocks.statusUseQuery.mockReturnValue({
    data: {
      human: { ownerId: "human-1", enabled: performerEnabled, statsEligible: false },
      orgs,
    },
    isLoading: false,
    isError: false,
  });
}

function fillSpaceForm(overrides: Partial<Record<string, string>> = {}) {
  const values = {
    date: "2027-03-06",
    start: "19:00",
    end: "23:00",
    purpose: "Album release party",
    ...overrides,
  };
  // The day comes from the availability calendar now, not a date field.
  fireEvent.change(screen.getByLabelText("dates"), {
    target: { value: values.date },
  });
  fireEvent.change(screen.getByLabelText("admin.bkFormStartLabel"), {
    target: { value: values.start },
  });
  fireEvent.change(screen.getByLabelText("admin.bkFormEndLabel"), {
    target: { value: values.end },
  });
  fireEvent.change(screen.getByLabelText("admin.bkFormPurposeLabel"), {
    target: { value: values.purpose },
  });
}

const submit = (name: string) =>
  fireEvent.submit(screen.getByRole("form", { name }));

describe("RequestToPlayPanel — intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.owners.mockReturnValue({
      ownersWithSlugs: [
        {
          kind: "human",
          humanId: "human-1",
          humanName: "Jo Requester",
          humanUsername: "jo",
          avatarUrl: null,
          adminSlug: "@jo",
        },
      ],
      isPending: false,
      isError: false,
    });
    testMocks.defaultsUseQuery.mockReturnValue({ data: undefined });
    testMocks.searchUseQuery.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPending: true,
      isError: false,
    });
    testMocks.availabilityUseQuery.mockReturnValue({
      data: { timezone: "America/Chicago", days: [] },
      isError: false,
    });
    mockOptions([MAIN, LATE]);
    mockStatus(true);
  });

  it("opens on PERFORM for a performer and offers only what the calendars accept", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    const group = screen.getByRole("radiogroup", { name: "admin.bkIntentLabel" });
    const radios = screen.getAllByRole("radio");
    expect(group).toBeInTheDocument();
    // USE is offered by no calendar → two segments, not three.
    expect(radios.map((r) => r.textContent)).toEqual([
      "admin.bkIntentPerform",
      "admin.bkIntentRent",
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("form", { name: "admin.peBlockKindRequestToPlay" }),
    ).toBeInTheDocument();
    // Two calendars take pitches → the calendar select shows, default first.
    expect(screen.getByLabelText("admin.bkFormCalendarLabel")).toHaveValue(
      "cal-main",
    );
    // The picker is fed the SAME calendar the mutation will route to.
    expect(screen.getByLabelText("dates")).toHaveAttribute(
      "data-calendar",
      "cal-main",
    );
  });

  it("switching to Rent swaps in the space variant with the visible rate", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: "admin.bkIntentRent" }));

    expect(
      screen.getByRole("form", { name: "admin.bkIntentRent" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("form", { name: "admin.peBlockKindRequestToPlay" }),
    ).not.toBeInTheDocument();
    // Only Main rents → no calendar SELECT, but the name is printed: the
    // rate hangs off the calendar, so the requester has to see which one.
    expect(
      screen.queryByLabelText("admin.bkFormCalendarLabel"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(
      screen.getByText("admin.bkFormRentalRate rate=$500.00"),
    ).toBeInTheDocument();
    // No pitch fields on a room hire.
    expect(
      screen.queryByLabelText("admin.bkFormMessageLabel"),
    ).not.toBeInTheDocument();
  });

  it("defaults to RENT for a non-performer, with no performer-mode gate", () => {
    mockStatus(false);
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    expect(
      screen.getByRole("form", { name: "admin.bkIntentRent" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("admin.bkPerformerModeRequiredTitle"),
    ).not.toBeInTheDocument();
    // …and picking Play here opens the pitch itself (lineup v2 D3: the mode
    // gates the sender's own row on the bill, not sending), with the bill's
    // "I'm on the bill" off and the one-click enable beside it.
    fireEvent.click(screen.getByRole("radio", { name: "admin.bkIntentPerform" }));
    expect(
      screen.getByRole("form", { name: "admin.peBlockKindRequestToPlay" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("admin.bkPerformerModeRequiredTitle"),
    ).not.toBeInTheDocument();
    const self = screen.getByRole("checkbox", { name: /admin.bkBillSelfLabel/ });
    expect(self).not.toBeChecked();
    expect(self).toBeDisabled();
  });

  it("honours the trigger's intent and hides the picker when only one is offered", () => {
    mockOptions([{ ...MAIN, acceptsPerform: false }]);
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(
      screen.getByRole("form", { name: "admin.bkIntentRent" }),
    ).toBeInTheDocument();
  });

  it("asks for NO room: it prints the calendar's rooms, read-only, and says who picks", () => {
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    // No control of any kind for the room — not a select, not a button.
    expect(
      screen.queryByLabelText("admin.bkFormSpaceLabel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Room A" }),
    ).not.toBeInTheDocument();
    // Main's two rooms, printed, plus the line saying what happens next.
    expect(
      screen.getByText("admin.bkFormRooms rooms=Room A · Room B"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("admin.bkFormRoomsHint"),
    ).toBeInTheDocument();
  });

  it("takes its day from the availability calendar, in date-only mode, one day", () => {
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    const picker = screen.getByLabelText("dates");
    expect(picker).toHaveAttribute("data-mode", "date");
    expect(picker).toHaveAttribute("data-max", "1");
    // Same calendar the mutation routes to — the picker's INVARIANT.
    expect(picker).toHaveAttribute("data-calendar", "cal-main");
  });

  it("RENT requires a window and a purpose before anything is sent", () => {
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    fillSpaceForm({ date: "", purpose: "" });
    submit("admin.bkIntentRent");
    expect(screen.getByRole("alert")).toHaveTextContent("admin.bkErrWindow");

    fillSpaceForm({ purpose: "" });
    submit("admin.bkIntentRent");
    expect(screen.getByRole("alert")).toHaveTextContent("admin.bkErrPurpose");

    expect(testMocks.createMutate).not.toHaveBeenCalled();
  });

  it("RENT sends the calendar, the place-local window, the purpose and attendance — and no room", () => {
    const onSuccess = vi.fn();
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={onSuccess} />,
    );

    fillSpaceForm();
    fireEvent.change(screen.getByLabelText(/admin.bkFormAttendanceLabel/), {
      target: { value: "40" },
    });
    submit("admin.bkIntentRent");

    expect(testMocks.createMutate).toHaveBeenCalledTimes(1);
    const [input, handlers] = testMocks.createMutate.mock.calls[0]!;
    expect(input).toEqual({
      performerOwnerType: "human",
      performerOwnerId: "human-1",
      placeId: PLACE_ID,
      intent: "RENT",
      calendarId: "cal-main",
      // 7pm–11pm Chicago (CST) as instants — never the host's zone.
      requestedStartsAt: "2027-03-07T01:00:00.000Z",
      requestedEndsAt: "2027-03-07T05:00:00.000Z",
      purpose: "Album release party",
      expectedAttendance: 40,
    });
    // The room is the venue's call at accept, so none is named here.
    expect(input).not.toHaveProperty("spaceId");
    // Nothing PERFORM-shaped rides along, and no visibility hint (v1 drops it).
    expect(input).not.toHaveProperty("message");
    expect(input).not.toHaveProperty("preferredDates");
    expect(input).not.toHaveProperty("visibilityHint");

    handlers.onSuccess();
    expect(onSuccess).toHaveBeenCalledWith({ intent: "RENT" });
  });

  it("flags an overnight window under the time inputs", () => {
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );
    fillSpaceForm({ start: "20:00", end: "01:00" });
    expect(screen.getByText(/admin.bkFormEndsNextDay/)).toBeInTheDocument();
  });

  it("PERFORM sends today's payload byte-for-byte, plus the calendar it was pitched against", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("admin.bkFormMessageLabel"), {
      target: { value: "We are a four-piece surf-rock band from town." },
    });
    fireEvent.change(screen.getByLabelText("dates"), {
      target: { value: "2027-08-01" },
    });
    submit("admin.peBlockKindRequestToPlay");

    expect(testMocks.createMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.createMutate.mock.calls[0]![0]).toEqual({
      performerOwnerType: "human",
      performerOwnerId: "human-1",
      placeId: PLACE_ID,
      calendarId: "cal-main",
      message: "We are a four-piece surf-rock band from town.",
      preferredDates: ["2027-08-01"],
    });
  });

  it("PERFORM on a pre-hierarchy place (no calendars) stays unrouted", () => {
    mockOptions([]);
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("admin.bkFormMessageLabel"), {
      target: { value: "We are a four-piece surf-rock band from town." },
    });
    fireEvent.change(screen.getByLabelText("dates"), {
      target: { value: "2027-08-01" },
    });
    submit("admin.peBlockKindRequestToPlay");

    expect(testMocks.createMutate.mock.calls[0]![0]).not.toHaveProperty(
      "calendarId",
    );
  });

  it("a calendar with NO active room is NOT offered for RENT — the panel falls back to the pitch", () => {
    // Room gate restored 2026-09-23 (reverses the 09-22 drop): a roomless
    // calendar is invalid data, so a RENT request against it — which could
    // only ever mint spaceless — is never offered.
    mockOptions([ROOMLESS]);
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    expect(
      screen.queryByRole("form", { name: "admin.bkIntentRent" }),
    ).not.toBeInTheDocument();
    // PERFORM is ungated — a night on the bill needs no room — so the pitch
    // is what the reader gets instead of a dead end.
    expect(
      screen.getByRole("form", { name: "admin.peBlockKindRequestToPlay" }),
    ).toBeInTheDocument();
  });

  it("switching the calendar DROPS the picked day and moves the picker together — the invariant under change", () => {
    mockOptions([MAIN, LOFT]);
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    // Two calendars rent → a real select this time.
    const select = screen.getByLabelText("admin.bkFormCalendarLabel");
    expect(select).toHaveValue("cal-main");
    fireEvent.change(screen.getByLabelText("dates"), {
      target: { value: "2027-03-06" },
    });
    expect(screen.getByLabelText("dates")).toHaveValue("2027-03-06");

    fireEvent.change(select, { target: { value: "cal-loft" } });

    // The day was validated against Main's nights; it must not survive.
    expect(screen.getByLabelText("dates")).toHaveValue("");
    // …and the picker now shows Loft's nights, not Main's.
    expect(screen.getByLabelText("dates")).toHaveAttribute(
      "data-calendar",
      "cal-loft",
    );
    expect(
      screen.getByText("admin.bkFormRooms rooms=Loft"),
    ).toBeInTheDocument();
  });

  it("a calendar that stops accepting RENT under the form takes the picked day with it", () => {
    // `usePlaceBookingOptions` refetches on window focus: the list can lose
    // the chosen calendar while a day is already picked. The resync effect
    // must clear the day too, or the request routes to a calendar the day
    // was never checked against (BOOKING_DATE_UNAVAILABLE).
    mockOptions([MAIN, LOFT]);
    const { rerender } = render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("dates"), {
      target: { value: "2027-03-06" },
    });
    expect(screen.getByLabelText("dates")).toHaveAttribute(
      "data-calendar",
      "cal-main",
    );

    mockOptions([{ ...MAIN, acceptsRent: false }, LOFT]);
    rerender(
      <RequestToPlayPanel placeId={PLACE_ID} intent="RENT" onSuccess={vi.fn()} />,
    );

    expect(screen.getByLabelText("dates")).toHaveAttribute(
      "data-calendar",
      "cal-loft",
    );
    expect(screen.getByLabelText("dates")).toHaveValue("");
  });

  it("says the venue is not taking requests when nothing is offered", () => {
    mockOptions([{ ...MAIN, acceptsPerform: false, acceptsRent: false }]);
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    expect(screen.getByText("admin.bkErrNotAccepting")).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
});

/* ── The bill (lineup-booking-requests v3, board F1) ───────────────────── */

const ORG_SALLOWS = "org-sallows";

function fillPitch() {
  fireEvent.change(screen.getByLabelText("admin.bkFormMessageLabel"), {
    target: { value: "We are a four-piece surf-rock band from town." },
  });
  fireEvent.change(screen.getByLabelText("dates"), {
    target: { value: "2027-08-01" },
  });
}

const nameInput = () =>
  screen.getByRole("combobox", { name: "admin.bkBillNameLabel" });

function addByName(name: string, extra: { link?: string; role?: string } = {}) {
  fireEvent.change(nameInput(), { target: { value: name } });
  if (extra.link !== undefined) {
    fireEvent.change(screen.getByLabelText(/admin.bkBillLinkLabel/), {
      target: { value: extra.link },
    });
  }
  if (extra.role) {
    fireEvent.change(screen.getByLabelText("admin.bkBillRoleLabel"), {
      target: { value: extra.role },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "admin.bkBillAddButton" }));
}

const sentBill = () =>
  (testMocks.createMutate.mock.calls[0]![0] as { bill?: unknown }).bill;

describe("RequestToPlayPanel — the bill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    testMocks.owners.mockReturnValue({
      ownersWithSlugs: [
        {
          kind: "human",
          humanId: "human-1",
          humanName: "Jo Requester",
          humanUsername: "jo",
          avatarUrl: null,
          adminSlug: "@jo",
        },
      ],
      isPending: false,
      isError: false,
    });
    testMocks.defaultsUseQuery.mockReturnValue({ data: undefined });
    testMocks.searchUseQuery.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPending: true,
      isError: false,
    });
    testMocks.availabilityUseQuery.mockReturnValue({
      data: { timezone: "America/Chicago", days: [] },
      isError: false,
    });
    mockOptions([MAIN]);
    mockStatus(true);
  });

  it("starts with the performer on it, at 01, headlining, and sends nothing extra", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    const self = screen.getByRole("checkbox", { name: /admin.bkBillSelfLabel/ });
    expect(self).toBeChecked();
    expect(self).toBeEnabled();
    const bill = screen.getByRole("list", { name: /admin.bkBillHeading/ });
    expect(bill).toHaveTextContent("01");
    expect(bill).toHaveTextContent("Jo Requester");
    expect(bill).toHaveTextContent("admin.bkBillHeadlining");
    expect(screen.getByText("admin.bkBillCount count=1 max=12")).toBeInTheDocument();

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(testMocks.createMutate.mock.calls[0]![0]).not.toHaveProperty("bill");
  });

  it("adds a by-name act with a link and a role, reading 'By name', and sends it after the sender", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    addByName("Junebug Radio", { link: "https://junebug.example", role: "DJ" });

    const rows = within(screen.getByRole("list", { name: /admin.bkBillHeading/ }))
      .getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("02");
    expect(rows[1]).toHaveTextContent("Junebug Radio");
    expect(rows[1]).toHaveTextContent("admin.bkBillSourceExternal");
    expect(rows[1]).toHaveTextContent("admin.ebLineupRoleDj");
    // Never "joined", never "confirmed".
    expect(rows[1]).not.toHaveTextContent(/confirm|join/i);

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(sentBill()).toEqual({
      includeSelf: true,
      acts: [
        {
          kind: "external",
          name: "Junebug Radio",
          url: "https://junebug.example",
          role: "DJ",
        },
      ],
    });
  });

  it("refuses a by-name link that is not http(s), inline, and clears it on input", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    addByName("Junebug Radio", { link: "junebug.example" });

    const link = screen.getByLabelText(/admin.bkBillLinkLabel/);
    expect(link).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("admin.bkBillErrLink")).toBeInTheDocument();
    fireEvent.change(link, { target: { value: "https://junebug.example" } });
    expect(screen.queryByText("admin.bkBillErrLink")).not.toBeInTheDocument();
  });

  it("searches people AND groups, picks a group by keyboard, and tags it as 'Will be asked to join'", () => {
    vi.useFakeTimers();
    testMocks.searchUseQuery.mockReturnValue({
      data: {
        suggestions: [
          // The sender is never offered: the switch is how they go on.
          { type: "human", id: "h1", humanId: "human-1", title: "Jo Requester", subtitle: null, helper: null, username: "jo", profileSlug: null },
          { type: "organization", id: "o1", orgId: ORG_SALLOWS, title: "The Sallows", subtitle: "Nashville", helper: null, slug: "sallows" },
        ],
      },
      isFetching: false,
      isPending: false,
      isError: false,
    });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Sall" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(testMocks.searchUseQuery).toHaveBeenLastCalledWith(
      { query: "Sall", types: ["human", "organization"], limit: 8 },
      expect.objectContaining({ enabled: true }),
    );
    expect(nameInput()).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "admin.bkBillNameLabel" });
    expect(nameInput()).toHaveAttribute("aria-controls", listbox.id);
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("The Sallows");
    expect(options[0]).toHaveTextContent("admin.bkBillResultGroup");

    fireEvent.keyDown(nameInput(), { key: "ArrowDown" });
    expect(nameInput()).toHaveAttribute("aria-activedescendant", options[0]!.id);
    fireEvent.keyDown(nameInput(), { key: "Enter" });

    expect(nameInput()).toHaveValue("The Sallows");
    // A tagged act links to its own page: no link field.
    expect(screen.queryByLabelText(/admin.bkBillLinkLabel/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillAddButton" }));

    const rows = within(screen.getByRole("list", { name: /admin.bkBillHeading/ }))
      .getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("admin.bkBillSourceTagged");
    vi.useRealTimers();

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(sentBill()).toEqual({
      includeSelf: true,
      acts: [{ kind: "tagged", orgId: ORG_SALLOWS, role: "PERFORMER" }],
    });
  });

  it("says so when the search fails, and still takes the name as typed", () => {
    vi.useFakeTimers();
    testMocks.searchUseQuery.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPending: false,
      isError: true,
    });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Ines Farrow" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("status")).toHaveTextContent("admin.bkBillSearchError");
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillAddButton" }));
    expect(screen.getByRole("list", { name: /admin.bkBillHeading/ })).toHaveTextContent(
      "Ines Farrow",
    );
  });

  it("reorders with Move up / Move down, named by act, and sends the new order", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    addByName("Paper Moth");
    addByName("The Sallows");

    expect(
      screen.getByRole("button", { name: "admin.bkBillMoveUp name=Paper Moth" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "admin.bkBillMoveDown name=The Sallows" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "admin.bkBillMoveUp name=The Sallows" }),
    );
    expect(
      screen.getByRole("button", { name: "admin.bkBillMoveDown name=The Sallows" }),
    ).toHaveFocus();
    expect(screen.getByText("admin.bkBillMoved name=The Sallows position=2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillRemove name=Paper Moth" }));
    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(sentBill()).toEqual({
      includeSelf: true,
      acts: [{ kind: "external", name: "The Sallows", role: "PERFORMER" }],
    });
  });

  it("refuses the same act twice", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    addByName("Paper Moth");
    addByName("paper moth");
    expect(screen.getByText("admin.bkBillErrDuplicate")).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: /admin.bkBillHeading/ })).getAllByRole("listitem"),
    ).toHaveLength(2);
  });

  it("an OTHER role reveals Role name and sends it as the label", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    fireEvent.change(nameInput(), { target: { value: "Ines Farrow" } });
    fireEvent.change(screen.getByLabelText("admin.bkBillRoleLabel"), {
      target: { value: "OTHER" },
    });
    fireEvent.change(screen.getByLabelText(/admin.bkBillRoleNameLabel/), {
      target: { value: "Stage manager" },
    });
    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillAddButton" }));
    expect(screen.getByRole("list", { name: /admin.bkBillHeading/ })).toHaveTextContent(
      "Stage manager",
    );
    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(sentBill()).toEqual({
      includeSelf: true,
      acts: [
        { kind: "external", name: "Ines Farrow", role: "OTHER", customRoleLabel: "Stage manager" },
      ],
    });
  });

  it("stops adding at 12 rows, the sender included", () => {
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    for (let i = 1; i <= 11; i++) addByName(`Act ${i}`);

    expect(screen.getByText("admin.bkBillCount count=12 max=12")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "admin.bkBillNameLabel" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("admin.bkBillFull").length).toBeGreaterThan(0);
  });

  it("a promoter without performer mode: off and disabled, one-click enable, sends includeSelf:false", () => {
    mockStatus(false);
    render(
      <RequestToPlayPanel placeId={PLACE_ID} intent="PERFORM" onSuccess={vi.fn()} />,
    );

    const self = screen.getByRole("checkbox", { name: /admin.bkBillSelfLabel/ });
    expect(self).toBeDisabled();
    expect(self).not.toBeChecked();
    expect(self).toHaveAccessibleDescription("admin.bkBillSelfNeedsPerformerMode");
    expect(screen.getByText("admin.bkBillEmpty")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "admin.bkEnablePerformerMode" }));
    expect(testMocks.setModeMutate).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: "human-1",
      enabled: true,
    });

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(sentBill()).toEqual({ includeSelf: false, acts: [] });
  });

  it("an org sender without performer mode is offered, after the performer, and enables as the org", () => {
    mockStatus(true, [{ ownerId: "org-lowlight", enabled: false }]);
    testMocks.owners.mockReturnValue({
      ownersWithSlugs: [
        { kind: "human", humanId: "human-1", humanName: "Jo Requester", humanUsername: "jo", avatarUrl: null, adminSlug: "@jo" },
        { kind: "org", orgId: "org-lowlight", orgName: "Lowlight Collective", role: "OWNER", adminSlug: "lowlight" },
      ],
      isPending: false,
      isError: false,
    });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    const senderSelect = screen.getByLabelText("admin.bkFormSenderLabel");
    expect(senderSelect).toHaveValue("human:human-1");
    fireEvent.change(senderSelect, { target: { value: "org:org-lowlight" } });
    expect(screen.getByRole("checkbox", { name: /admin.bkBillSelfLabel/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "admin.bkEnablePerformerMode" }));
    expect(testMocks.setModeMutate).toHaveBeenCalledWith({
      ownerType: "org",
      ownerId: "org-lowlight",
      enabled: true,
    });
  });

  it("maps the server's bill refusal to readable copy", () => {
    testMocks.createMutate.mockImplementation(
      (_vars: unknown, opts: { onError: (e: unknown) => void }) =>
        opts.onError({
          message: "ACT_NOT_TAGGABLE",
          data: { appCode: "ACT_NOT_TAGGABLE", meta: { reason: "not_taggable" } },
        }),
    );
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(screen.getByRole("alert")).toHaveTextContent("admin.bkErrBillNotTaggable");
  });
});

/* ── F1 fix round: races, sender identity, the 12-row invariant ─────────── */

const LOWLIGHT = "org-lowlight";
const OWNERS_WITH_LOWLIGHT = {
  ownersWithSlugs: [
    { kind: "human", humanId: "human-1", humanName: "Jo Requester", humanUsername: "jo", avatarUrl: null, adminSlug: "@jo" },
    { kind: "org", orgId: LOWLIGHT, orgName: "Lowlight Collective", role: "OWNER", adminSlug: "lowlight" },
  ],
  isPending: false,
  isError: false,
};

describe("RequestToPlayPanel — the bill, fix round", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    testMocks.setModePending.value = false;
    testMocks.owners.mockReturnValue(OWNERS_WITH_LOWLIGHT);
    testMocks.defaultsUseQuery.mockReturnValue({ data: undefined });
    testMocks.searchUseQuery.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPending: true,
      isError: false,
    });
    testMocks.availabilityUseQuery.mockReturnValue({
      data: { timezone: "America/Chicago", days: [] },
      isError: false,
    });
    mockOptions([MAIN]);
  });

  it("W1: does not send while performer mode is being turned on, and shows the submit as pending", () => {
    mockStatus(false);
    testMocks.setModePending.value = true;
    render(<RequestToPlayPanel placeId={PLACE_ID} intent="PERFORM" onSuccess={vi.fn()} />);

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(testMocks.createMutate).not.toHaveBeenCalled();
    const form = screen.getByRole("form", { name: "admin.peBlockKindRequestToPlay" });
    const send = within(form).getAllByRole("button").find((b) => b.getAttribute("type") === "submit");
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("aria-busy", "true");
  });

  it("W7: waits for the owners' names instead of printing fallback labels", () => {
    mockStatus(true, [{ ownerId: LOWLIGHT, enabled: true }]);
    testMocks.owners.mockReturnValue({ ownersWithSlugs: undefined, isPending: true, isError: false });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    expect(screen.getByText("common.loading")).toBeInTheDocument();
    expect(screen.queryByLabelText("admin.bkFormSenderLabel")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.bkSenderOrgFallback")).not.toBeInTheDocument();
  });

  it("W2: a pinned sender that leaves the list is an error, never a silent switch", () => {
    mockStatus(true, [{ ownerId: LOWLIGHT, enabled: true }]);
    const { rerender } = render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("admin.bkFormSenderLabel"), {
      target: { value: `org:${LOWLIGHT}` },
    });

    mockStatus(true);
    testMocks.owners.mockReturnValue({ ...OWNERS_WITH_LOWLIGHT, ownersWithSlugs: OWNERS_WITH_LOWLIGHT.ownersWithSlugs.slice(0, 1) });
    rerender(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("admin.bkBillSenderGone");
    expect(screen.getByLabelText("admin.bkFormSenderLabel")).toHaveValue("");
    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(testMocks.createMutate).not.toHaveBeenCalled();
  });

  it("W3: twelve acts, then a switch to a performer, keeps the bill at 12 and leaves the switch off", () => {
    // The org performs; the person does not. The org leads the list.
    mockStatus(false, [{ ownerId: LOWLIGHT, enabled: true }]);
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    const senderSelect = screen.getByLabelText("admin.bkFormSenderLabel");
    expect(senderSelect).toHaveValue(`org:${LOWLIGHT}`);
    fireEvent.change(senderSelect, { target: { value: "human:human-1" } });
    for (let i = 1; i <= 12; i++) addByName(`Act ${i}`);
    expect(screen.getByText("admin.bkBillCount count=12 max=12")).toBeInTheDocument();

    fireEvent.change(senderSelect, { target: { value: `org:${LOWLIGHT}` } });
    const self = screen.getByRole("checkbox", { name: /admin.bkBillSelfLabel/ });
    expect(self).not.toBeChecked();
    expect(screen.getByText("admin.bkBillCount count=12 max=12")).toBeInTheDocument();

    // Freeing a row does NOT silently put the sender back on.
    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillRemove name=Act 12" }));
    expect(self).not.toBeChecked();
    expect(self).toBeEnabled();

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    const bill = sentBill() as { includeSelf: boolean; acts: unknown[] };
    expect(bill.includeSelf).toBe(false);
    expect(bill.acts).toHaveLength(11);
  });

  it("W3: a tag that becomes the sender after a switch is flagged on its row", () => {
    vi.useFakeTimers();
    mockStatus(true, [{ ownerId: LOWLIGHT, enabled: true }]);
    testMocks.searchUseQuery.mockReturnValue({
      data: {
        suggestions: [
          { type: "organization", id: "o1", orgId: LOWLIGHT, title: "Lowlight Collective", subtitle: null, helper: null, slug: "lowlight" },
        ],
      },
      isFetching: false,
      isPending: false,
      isError: false,
    });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Lowl" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.keyDown(nameInput(), { key: "ArrowDown" });
    fireEvent.keyDown(nameInput(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillAddButton" }));
    vi.useRealTimers();
    expect(screen.queryByText("admin.bkBillRowIsSender")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("admin.bkFormSenderLabel"), {
      target: { value: `org:${LOWLIGHT}` },
    });
    const row = within(screen.getByRole("list", { name: "admin.bkBillHeading" }))
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("Lowlight Collective") && li.textContent.includes("admin.bkBillSourceTagged"));
    expect(row).toHaveTextContent("admin.bkBillRowIsSender");
  });
});

/* ── F1 round 3: background-refetch errors, the pinned default sender ───── */

describe("RequestToPlayPanel — round 3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    testMocks.setModePending.value = false;
    testMocks.owners.mockReturnValue(OWNERS_WITH_LOWLIGHT);
    testMocks.defaultsUseQuery.mockReturnValue({ data: undefined });
    testMocks.searchUseQuery.mockReturnValue({
      data: undefined,
      isFetching: false,
      isPending: true,
      isError: false,
    });
    testMocks.availabilityUseQuery.mockReturnValue({
      data: { timezone: "America/Chicago", days: [] },
      isError: false,
    });
    mockOptions([MAIN]);
  });

  it("W-A: a failed BACKGROUND refetch (data still cached) keeps the filled form and its bill", () => {
    mockStatus(true);
    const { rerender } = render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    fillPitch();
    addByName("Junebug Radio");

    // react-query v5: a failed refetch flips isError while `data` stays.
    const status = testMocks.statusUseQuery.mock.results.at(-1)!.value as { data: unknown };
    testMocks.statusUseQuery.mockReturnValue({ data: status.data, isLoading: false, isError: true });
    testMocks.owners.mockReturnValue({
      ...OWNERS_WITH_LOWLIGHT,
      data: { owners: OWNERS_WITH_LOWLIGHT.ownersWithSlugs },
      isError: true,
    });
    // …and the place's booking options: all three load gates covered.
    const lastOptions = testMocks.optionsUseQuery.mock.results.at(-1)!.value as Record<string, unknown>;
    testMocks.optionsUseQuery.mockReturnValue({ ...lastOptions, isError: true });
    rerender(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);

    expect(screen.queryByText("admin.bkErrGeneric")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.bkPanelLoadError")).not.toBeInTheDocument();
    expect(screen.getByLabelText("admin.bkFormMessageLabel")).toHaveValue(
      "We are a four-piece surf-rock band from town.",
    );
    expect(screen.getByRole("list", { name: "admin.bkBillHeading" })).toHaveTextContent(
      "Junebug Radio",
    );
  });

  it("D3: a LOAD failure with no data says it couldn't load (not 'couldn't send') and Retry refetches what failed", () => {
    mockStatus(true);
    const refetch = vi.fn();
    testMocks.owners.mockReturnValue({
      ownersWithSlugs: undefined,
      data: undefined,
      isPending: false,
      isError: true,
      isFetching: false,
      refetch,
    });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("admin.bkPanelLoadError");
    expect(screen.queryByText("admin.bkErrGeneric")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "admin.bkPanelLoadRetry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("form", { name: "admin.peBlockKindRequestToPlay" }),
    ).not.toBeInTheDocument();
  });

  it("W-B: the untouched default sender stays the person when an org gains performer mode and sorts first", () => {
    mockStatus(false, [{ ownerId: LOWLIGHT, enabled: false }]);
    const { rerender } = render(<RequestToPlayPanel placeId={PLACE_ID} intent="PERFORM" onSuccess={vi.fn()} />);
    expect(screen.getByLabelText("admin.bkFormSenderLabel")).toHaveValue("human:human-1");

    // No change event: the org turns performer mode on and now leads the list.
    mockStatus(false, [{ ownerId: LOWLIGHT, enabled: true }]);
    rerender(<RequestToPlayPanel placeId={PLACE_ID} intent="PERFORM" onSuccess={vi.fn()} />);
    const options = within(screen.getByLabelText("admin.bkFormSenderLabel")).getAllByRole("option");
    expect(options[0]).toHaveValue(`org:${LOWLIGHT}`);
    expect(screen.getByLabelText("admin.bkFormSenderLabel")).toHaveValue("human:human-1");

    fillPitch();
    submit("admin.peBlockKindRequestToPlay");
    expect(testMocks.createMutate.mock.calls[0]![0]).toMatchObject({
      performerOwnerType: "human",
      performerOwnerId: "human-1",
    });
  });
});

describe("RequestToPlayPanel — the bill's search popup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.setModePending.value = false;
    testMocks.owners.mockReturnValue(OWNERS_WITH_LOWLIGHT);
    testMocks.defaultsUseQuery.mockReturnValue({ data: undefined });
    testMocks.availabilityUseQuery.mockReturnValue({
      data: { timezone: "America/Chicago", days: [] },
      isError: false,
    });
    testMocks.searchUseQuery.mockReturnValue({
      data: { suggestions: [] },
      isFetching: false,
      isPending: false,
      isError: false,
    });
    mockOptions([MAIN]);
    mockStatus(true);
  });

  it("D2: adding the act clears the field AND closes the 'no one matches' popup", () => {
    vi.useFakeTimers();
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Junebug Radio" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("status")).toHaveTextContent("admin.bkBillSearchNoResults");

    fireEvent.click(screen.getByRole("button", { name: "admin.bkBillAddButton" }));
    expect(nameInput()).toHaveValue("");
    expect(screen.queryByText("admin.bkBillSearchNoResults")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("admin.bkBillSearchNoResults")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("D2: clearing the field by hand closes the popup at once", () => {
    vi.useFakeTimers();
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Junebug" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.change(nameInput(), { target: { value: "" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-expanded", "false");
    vi.useRealTimers();
  });
});

/* ── F1 round 4: a pending search never reopens after a deliberate close ── */

describe("RequestToPlayPanel — the bill's search, closed on purpose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.setModePending.value = false;
    testMocks.owners.mockReturnValue(OWNERS_WITH_LOWLIGHT);
    testMocks.defaultsUseQuery.mockReturnValue({ data: undefined });
    testMocks.availabilityUseQuery.mockReturnValue({
      data: { timezone: "America/Chicago", days: [] },
      isError: false,
    });
    testMocks.searchUseQuery.mockReturnValue({
      data: { suggestions: [] },
      isFetching: false,
      isPending: false,
      isError: false,
    });
    mockOptions([MAIN]);
    mockStatus(true);
  });

  it("typing then leaving the field inside the debounce never opens the popup", () => {
    vi.useFakeTimers();
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Junebug" } });
    // Tab to Link within 250ms.
    act(() => screen.getByLabelText(/admin.bkBillLinkLabel/).focus());
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-expanded", "false");
    vi.useRealTimers();
  });

  it("typing then Escape inside the debounce never opens the popup", () => {
    vi.useFakeTimers();
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    act(() => nameInput().focus());
    fireEvent.change(nameInput(), { target: { value: "Junebug" } });
    fireEvent.keyDown(nameInput(), { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(nameInput()).toHaveFocus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(nameInput()).toHaveAttribute("aria-expanded", "false");
    vi.useRealTimers();
  });
});
