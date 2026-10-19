import { describe, expect, it } from "vitest";

import {
  MAX_BLACKOUT_RANGE_DAYS,
  blackoutCreateFields,
  blackoutRowsForScope,
  calendarHasNoActiveSpaces,
  expandDateRange,
  hoursUpsertFields,
  isLastActiveSpace,
  isOvernight,
  openWindowsForDay,
  parseDateInput,
  windowError,
  type AvailabilityRowLike,
} from "../venue-calendars-helpers";

const row = (over: Partial<AvailabilityRowLike>): AvailabilityRowLike => ({
  id: Math.random().toString(36).slice(2),
  calendarId: null,
  dayOfWeek: null,
  date: null,
  startTime: null,
  endTime: null,
  note: null,
  isOpen: true,
  ...over,
});

describe("isOvernight", () => {
  it("treats a close at or before the open as running past midnight", () => {
    expect(isOvernight("18:00", "02:00")).toBe(true);
    expect(isOvernight("18:00", "18:00")).toBe(true);
  });

  it("is a normal evening otherwise", () => {
    expect(isOvernight("18:00", "23:00")).toBe(false);
    expect(isOvernight("14:00", "17:00")).toBe(false);
  });
});

describe("windowError", () => {
  it("accepts an overnight window — it is a real night, not a mistake", () => {
    expect(windowError("18:00", "02:00")).toBeNull();
  });

  it("rejects a zero-length window", () => {
    expect(windowError("20:00", "20:00")).toBe("empty");
  });

  it("rejects a time that isn't HH:MM", () => {
    expect(windowError("6pm", "23:00")).toBe("invalid");
    expect(windowError("25:00", "26:00")).toBe("invalid");
  });
});

describe("openWindowsForDay (scope-aware)", () => {
  const rows = [
    row({ calendarId: "cal-1", dayOfWeek: 0, startTime: "19:00", endTime: "22:00" }),
    row({ calendarId: "cal-1", dayOfWeek: 0, startTime: "14:00", endTime: "17:00" }),
    // Same weekday, DIFFERENT scope — must never bleed into cal-1's grid.
    row({ calendarId: "cal-2", dayOfWeek: 0, startTime: "10:00", endTime: "12:00" }),
    // Place-wide weekly window ("All calendars" scope).
    row({ calendarId: null, dayOfWeek: 0, startTime: "09:00", endTime: "11:00" }),
    row({ calendarId: "cal-1", dayOfWeek: 2, startTime: "18:00", endTime: "23:00" }),
    // A blackout date, not a weekly window.
    row({ calendarId: "cal-1", date: new Date(2026, 8, 1), isOpen: false }),
  ];

  it("returns every window on that weekday in the scope, earliest first", () => {
    // Two windows on one day is the whole point — a matinee and an evening.
    expect(
      openWindowsForDay(rows, "cal-1", 0).map((r) => r.startTime),
    ).toEqual(["14:00", "19:00"]);
  });

  it("keeps scopes apart: the place-wide grid edits only calendarId-null rows", () => {
    expect(openWindowsForDay(rows, null, 0).map((r) => r.startTime)).toEqual([
      "09:00",
    ]);
    expect(openWindowsForDay(rows, "cal-2", 0)).toHaveLength(1);
  });

  it("ignores other weekdays and one-off dates", () => {
    expect(openWindowsForDay(rows, "cal-1", 2)).toHaveLength(1);
    expect(openWindowsForDay(rows, "cal-1", 1)).toHaveLength(0);
  });
});

describe("blackoutRowsForScope", () => {
  const placeWide = row({
    calendarId: null,
    date: new Date(2026, 8, 17),
    isOpen: false,
  });
  const cal1Only = row({
    calendarId: "cal-1",
    date: new Date(2026, 8, 1),
    isOpen: false,
  });
  const cal2Only = row({
    calendarId: "cal-2",
    date: new Date(2026, 8, 4),
    isOpen: false,
  });
  const rows = [
    placeWide,
    cal1Only,
    cal2Only,
    row({ calendarId: "cal-1", dayOfWeek: 5, startTime: "18:00", endTime: "02:00" }),
    // An open one-off date is an override, not a blackout.
    row({ calendarId: "cal-1", date: new Date(2026, 8, 9), isOpen: true }),
  ];

  it("shows a calendar's own blackouts AND place-wide ones (they close it too), in date order", () => {
    expect(blackoutRowsForScope(rows, "cal-1").map((r) => r.id)).toEqual([
      cal1Only.id,
      placeWide.id,
    ]);
  });

  it("the All-calendars scope lists only place-wide rows", () => {
    expect(blackoutRowsForScope(rows, null).map((r) => r.id)).toEqual([
      placeWide.id,
    ]);
  });
});

describe("hoursUpsertFields (FULL-PUT semantics)", () => {
  it("always includes isOpen and restates every field (a partial patch could silently reopen a row)", () => {
    const fields = hoursUpsertFields({
      scope: "cal-1",
      dayOfWeek: 5,
      startTime: "18:00",
      endTime: "23:00",
    });
    expect(fields).toEqual({
      calendarId: "cal-1",
      dayOfWeek: 5,
      date: null,
      startTime: "18:00",
      endTime: "23:00",
      isOpen: true,
      note: null,
    });
    expect(Object.hasOwn(fields, "isOpen")).toBe(true);
  });

  it("is dayOfWeek XOR date: a weekly window carries dayOfWeek and a null date, never both", () => {
    const fields = hoursUpsertFields({
      scope: null,
      dayOfWeek: 0,
      startTime: "12:00",
      endTime: "16:00",
    });
    expect(fields.dayOfWeek).toBe(0);
    expect(fields.date).toBeNull();
  });

  it("a create at the All-calendars scope writes ONE place-wide row (calendarId null)", () => {
    expect(
      hoursUpsertFields({
        scope: null,
        dayOfWeek: 3,
        startTime: "18:00",
        endTime: "23:00",
      }).calendarId,
    ).toBeNull();
  });

  it("an update keeps the ROW's scope (immutable after create), even if the UI scope drifted", () => {
    const existing = row({
      id: "row-1",
      calendarId: "cal-1",
      dayOfWeek: 5,
      startTime: "18:00",
      endTime: "23:00",
      note: "door at 17:30",
    });
    const fields = hoursUpsertFields({
      scope: null, // UI somehow on "All calendars"
      dayOfWeek: 5,
      startTime: "19:00",
      endTime: "23:00",
      row: existing,
    });
    expect(fields.calendarId).toBe("cal-1");
    // The note survives the full-PUT (nothing is dropped by restating).
    expect(fields.note).toBe("door at 17:30");
  });
});

describe("blackoutCreateFields (FULL-PUT semantics)", () => {
  it("an All-calendars blackout is ONE row with calendarId null and isOpen false", () => {
    const date = new Date(2026, 8, 17);
    expect(
      blackoutCreateFields({ scope: null, date, note: "Private hire" }),
    ).toEqual({
      calendarId: null,
      dayOfWeek: null,
      date,
      startTime: null,
      endTime: null,
      isOpen: false,
      note: "Private hire",
    });
  });

  it("is date XOR dayOfWeek: a blackout carries the date and a null dayOfWeek", () => {
    const fields = blackoutCreateFields({
      scope: "cal-1",
      date: new Date(2026, 8, 1),
      note: null,
    });
    expect(fields.dayOfWeek).toBeNull();
    expect(fields.date).not.toBeNull();
    expect(fields.calendarId).toBe("cal-1");
  });
});

describe("parseDateInput", () => {
  it("builds the date at LOCAL midnight", () => {
    // `new Date("2026-09-01")` parses as UTC and lands on Aug 31 for anyone
    // west of Greenwich — the venue would black out the wrong night.
    const parsed = parseDateInput("2026-09-01");
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(8);
    expect(parsed?.getDate()).toBe(1);
    expect(parsed?.getHours()).toBe(0);
  });

  it("rejects anything that isn't YYYY-MM-DD", () => {
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("09/01/2026")).toBeNull();
  });
});

describe("expandDateRange", () => {
  it("includes both ends", () => {
    const dates = expandDateRange("2026-09-01", "2026-09-03");
    expect(dates.map((d) => d.getDate())).toEqual([1, 2, 3]);
  });

  it("refuses a backwards range", () => {
    expect(expandDateRange("2026-09-05", "2026-09-01")).toEqual([]);
  });

  it("refuses a range past the cap, so a mistyped year can't fire hundreds of writes", () => {
    expect(expandDateRange("2026-09-01", "2027-09-01")).toEqual([]);
    // …but the cap itself is allowed.
    const end = new Date(2026, 8, 1);
    end.setDate(end.getDate() + MAX_BLACKOUT_RANGE_DAYS - 1);
    const iso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    expect(expandDateRange("2026-09-01", iso)).toHaveLength(
      MAX_BLACKOUT_RANGE_DAYS,
    );
  });
});

describe("isLastActiveSpace", () => {
  const active = (id: string) => ({ id, status: "ACTIVE" as const });
  const retired = (id: string) => ({ id, status: "RETIRED" as const });

  it("flags the only active space (retire must be disabled with a reason)", () => {
    expect(isLastActiveSpace([active("a"), retired("b")], "a")).toBe(true);
  });

  it("does not flag when another active space remains", () => {
    expect(isLastActiveSpace([active("a"), active("b")], "a")).toBe(false);
  });

  it("never flags a retired space", () => {
    expect(isLastActiveSpace([active("a"), retired("b")], "b")).toBe(false);
  });
});

describe("calendarHasNoActiveSpaces", () => {
  it("warns for a calendar joined only to retired spaces", () => {
    expect(
      calendarHasNoActiveSpaces({
        spaces: [{ id: "a", status: "RETIRED" }],
      }),
    ).toBe(true);
  });

  it("warns for a calendar with no spaces at all", () => {
    expect(calendarHasNoActiveSpaces({ spaces: [] })).toBe(true);
  });

  it("stays quiet while any joined space is active", () => {
    expect(
      calendarHasNoActiveSpaces({
        spaces: [
          { id: "a", status: "RETIRED" },
          { id: "b", status: "ACTIVE" },
        ],
      }),
    ).toBe(false);
  });
});

// ── Booking config layer (venue-confirmation-and-booking-intents spec) ──────

import {
  BOOKING_CONFIG_DEFAULTS,
  bookingConfigPatch,
  bookingFormFromConfig,
  centsToAmountInput,
  intentSummaryParts,
  rentalRateCurrencyOptions,
  rentalRateFieldFromError,
  resolveRentalRate,
  type BookingConfigLike,
} from "../venue-calendars-helpers";

const storedConfig = (over: Partial<BookingConfigLike> = {}): BookingConfigLike => ({
  ...BOOKING_CONFIG_DEFAULTS,
  ...over,
});

describe("bookingFormFromConfig", () => {
  it("opens on the spec defaults — Play on, Rent and Use off, USD, blank rate", () => {
    expect(bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS)).toEqual({
      acceptsPerform: true,
      acceptsRent: false,
      acceptsUse: false,
      rentalRateAmount: "",
      rentalRateCurrency: "USD",
      rentalRateVisible: false,
    });
  });

  it("carries a stored rate into the field as major units", () => {
    const form = bookingFormFromConfig(
      storedConfig({
        acceptsRent: true,
        rentalRateCents: 50000,
        rentalRateCurrency: "MXN",
      }),
    );
    expect(form.rentalRateAmount).toBe("500.00");
    expect(form.rentalRateCurrency).toBe("MXN");
  });
});

describe("centsToAmountInput", () => {
  it("renders cents as a two-decimal string; only NULL is blank — a stored $0 is '0.00'", () => {
    expect(centsToAmountInput(50000)).toBe("500.00");
    expect(centsToAmountInput(1999)).toBe("19.99");
    expect(centsToAmountInput(null)).toBe("");
    expect(centsToAmountInput(0)).toBe("0.00");
  });
});

describe("resolveRentalRate — the client half of the pair rule", () => {
  it("a blank amount is 'no rate stated': both halves null", () => {
    expect(resolveRentalRate("", "USD")).toEqual({
      ok: true,
      rentalRateCents: null,
      rentalRateCurrency: null,
    });
    expect(resolveRentalRate("   ", "USD")).toEqual({
      ok: true,
      rentalRateCents: null,
      rentalRateCurrency: null,
    });
  });

  it("a typed amount travels with its currency, in cents", () => {
    expect(resolveRentalRate("500", "USD")).toEqual({
      ok: true,
      rentalRateCents: 50000,
      rentalRateCurrency: "USD",
    });
    expect(resolveRentalRate("15,50", "EUR")).toEqual({
      ok: true,
      rentalRateCents: 1550,
      rentalRateCurrency: "EUR",
    });
  });

  it("refuses an ambiguous amount rather than guessing ($1,500 vs $1.50)", () => {
    expect(resolveRentalRate("1,500", "USD")).toEqual({
      ok: false,
      field: "amount",
      messageKey: "admin.calMgrRentalRateAmbiguous",
    });
  });

  it("refuses unreadable and negative amounts with their own copy", () => {
    expect(resolveRentalRate("abc", "USD")).toMatchObject({
      ok: false,
      field: "amount",
      messageKey: "admin.calMgrRentalRateInvalid",
    });
    expect(resolveRentalRate("-5", "USD")).toMatchObject({
      ok: false,
      field: "amount",
      messageKey: "admin.calMgrRentalRateNegative",
    });
  });

  it("an amount without a 3-letter currency is a CURRENCY error — the server's pair rule, caught first", () => {
    expect(resolveRentalRate("500", "")).toEqual({
      ok: false,
      field: "currency",
      messageKey: "admin.calMgrRentalRateCurrencyRequired",
    });
    expect(resolveRentalRate("500", "usd")).toMatchObject({ ok: false, field: "currency" });
  });
});

describe("bookingConfigPatch — diff, never full-put", () => {
  it("an untouched group sends NOTHING (existing calendars stay byte-identical)", () => {
    const form = bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS);
    expect(bookingConfigPatch(form, BOOKING_CONFIG_DEFAULTS)).toEqual({
      ok: true,
      patch: {},
    });
  });

  it("a flipped toggle sends only that toggle", () => {
    const form = { ...bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS), acceptsUse: true };
    expect(bookingConfigPatch(form, BOOKING_CONFIG_DEFAULTS)).toEqual({
      ok: true,
      patch: { acceptsUse: true },
    });
  });

  it("Rent on with a rate sends the rate as a PAIR alongside the toggle", () => {
    const form = {
      ...bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS),
      acceptsRent: true,
      rentalRateAmount: "500",
    };
    expect(bookingConfigPatch(form, BOOKING_CONFIG_DEFAULTS)).toEqual({
      ok: true,
      patch: { acceptsRent: true, rentalRateCents: 50000, rentalRateCurrency: "USD" },
    });
  });

  it("Rent on with the rate left blank sends just the toggle — no rate stated is the default", () => {
    const form = { ...bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS), acceptsRent: true };
    expect(bookingConfigPatch(form, BOOKING_CONFIG_DEFAULTS)).toEqual({
      ok: true,
      patch: { acceptsRent: true },
    });
  });

  it("a stored $0 rate survives an untouched save (blank would have re-resolved to 'no rate' and wiped it)", () => {
    const current = storedConfig({
      acceptsRent: true,
      rentalRateCents: 0,
      rentalRateCurrency: "USD",
    });
    const form = bookingFormFromConfig(current);
    expect(form.rentalRateAmount).toBe("0.00");
    expect(bookingConfigPatch(form, current)).toEqual({ ok: true, patch: {} });
  });

  it("clearing a stored rate sends BOTH halves as null", () => {
    const current = storedConfig({
      acceptsRent: true,
      rentalRateCents: 50000,
      rentalRateCurrency: "USD",
    });
    const form = { ...bookingFormFromConfig(current), rentalRateAmount: "" };
    expect(bookingConfigPatch(form, current)).toEqual({
      ok: true,
      patch: { rentalRateCents: null, rentalRateCurrency: null },
    });
  });

  it("with Rent OFF the hidden rate fields are neither validated nor sent — the stored rate survives", () => {
    const current = storedConfig({
      acceptsRent: true,
      rentalRateCents: 50000,
      rentalRateCurrency: "USD",
      rentalRateVisible: true,
    });
    const form = {
      ...bookingFormFromConfig(current),
      acceptsRent: false,
      rentalRateAmount: "1,500", // would be ambiguous if it were read
      rentalRateVisible: false, // hidden with the panel; not sent either
    };
    expect(bookingConfigPatch(form, current)).toEqual({
      ok: true,
      patch: { acceptsRent: false },
    });
  });

  it("a bad amount stops the patch with a field error", () => {
    const form = {
      ...bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS),
      acceptsRent: true,
      rentalRateAmount: "1,500",
    };
    expect(bookingConfigPatch(form, BOOKING_CONFIG_DEFAULTS)).toEqual({
      ok: false,
      field: "amount",
      messageKey: "admin.calMgrRentalRateAmbiguous",
    });
  });

  it("the public-rate toggle only travels while Rent is on", () => {
    const on = {
      ...bookingFormFromConfig(BOOKING_CONFIG_DEFAULTS),
      acceptsRent: true,
      rentalRateVisible: true,
    };
    expect(bookingConfigPatch(on, BOOKING_CONFIG_DEFAULTS)).toEqual({
      ok: true,
      patch: { acceptsRent: true, rentalRateVisible: true },
    });
  });
});

describe("rentalRateCurrencyOptions", () => {
  it("offers the fixed list, USD first", () => {
    expect(rentalRateCurrencyOptions(null)[0]).toBe("USD");
    expect(rentalRateCurrencyOptions("EUR")).toEqual(rentalRateCurrencyOptions(null));
  });

  it("keeps an off-list stored currency selectable rather than silently relabelling the rate", () => {
    expect(rentalRateCurrencyOptions("AUD")[0]).toBe("AUD");
  });
});

describe("rentalRateFieldFromError — a server pair refusal lands on the field", () => {
  it("reads tRPC's Zod issue dump (update keeps the patch superRefine)", () => {
    const err = new Error(
      JSON.stringify([
        {
          code: "custom",
          message: "rental_rate_requires_amount_and_currency",
          path: ["patch", "rentalRateCurrency"],
        },
      ]),
    );
    expect(rentalRateFieldFromError(err)).toBe("currency");
  });

  it("reads the UN-prefixed path create's transport schema emits (no `patch` segment)", () => {
    const err = new Error(
      JSON.stringify([
        {
          code: "custom",
          message: "rental_rate_requires_amount_and_currency",
          path: ["rentalRateCurrency"],
        },
      ]),
    );
    expect(rentalRateFieldFromError(err)).toBe("currency");
  });

  it("reads a normalised data.zodError.fieldErrors map", () => {
    const err = {
      message: "BAD_REQUEST",
      data: { zodError: { fieldErrors: { "patch.rentalRateCents": ["x"] } } },
    };
    expect(rentalRateFieldFromError(err)).toBe("amount");
  });

  it("anything else is not a rate error (stays a toast)", () => {
    expect(rentalRateFieldFromError(new Error("NOT_RESOURCE_OWNER"))).toBeNull();
    expect(rentalRateFieldFromError(new Error("[not json"))).toBeNull();
    expect(rentalRateFieldFromError(null)).toBeNull();
  });
});

describe("intentSummaryParts — 'Play · Rent $500 · Use'", () => {
  const labels = {
    perform: "Play",
    rent: "Rent",
    rentWithRate: (rate: string) => `Rent ${rate}`,
    use: "Use",
  };
  const formatRate = (cents: number, currency: string) =>
    `${currency} ${cents / 100}`;

  it("lists only the accepted intents, in spec order", () => {
    expect(
      intentSummaryParts(
        storedConfig({ acceptsPerform: true, acceptsUse: true }),
        labels,
        formatRate,
      ),
    ).toEqual(["Play", "Use"]);
  });

  it("puts the rate on the Rent part when one is stated", () => {
    expect(
      intentSummaryParts(
        storedConfig({
          acceptsRent: true,
          rentalRateCents: 50000,
          rentalRateCurrency: "USD",
        }),
        labels,
        formatRate,
      ),
    ).toEqual(["Play", "Rent USD 500"]);
  });

  it("a Rent with no stated rate is just 'Rent'", () => {
    expect(
      intentSummaryParts(
        storedConfig({ acceptsPerform: false, acceptsRent: true }),
        labels,
        formatRate,
      ),
    ).toEqual(["Rent"]);
  });

  it("is empty when the calendar takes no requests", () => {
    expect(
      intentSummaryParts(storedConfig({ acceptsPerform: false }), labels, formatRate),
    ).toEqual([]);
  });
});
