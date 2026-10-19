import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommunityRecurrenceSummary } from "@/server/events";
import type { DateRsvpRecurrence, DateRsvpRow } from "../use-date-rsvp-list";

/**
 * Regression suite for the 52-row wall: a weekly open mic ("Grown and Sexy Open
 * Mic at Carol Ann's", every Wednesday 8:00 PM) carries 52 upcoming dates, and
 * the old list painted every one as a full-width row with its own 150px accent
 * button — 3,589px of list at 1440w, 5,253px at 390w, and "SIGN IN TO RSVP"
 * printed 52 times to a signed-out reader.
 *
 * These assert COUNTS and accessible NAMES, never snapshots: the numbers are the
 * contract ("at most 7 toggles collapsed", "exactly 1 sign-in affordance"), and
 * a snapshot would go green on any rearrangement that reintroduced the wall.
 */

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../CommunityDateList.module.css", () => ({
  default: new Proxy({} as Record<string, string>, {
    get: (_target, key) => String(key),
  }),
}));

// The REAL en catalog through the REAL ICU translator, so every assertion below
// is about a string a reader actually sees — a dictionary stub would let a typo'd
// or missing key pass (there is no locale fallback in this repo: a missing key
// renders the raw key string).
vi.mock("@th/ui", async () => {
  const React = await import("react");
  const { createTranslator } = await import("@th/locale");
  const enMessages = (await import("@/i18n/messages/en")).default;
  const translator = createTranslator(
    "en-US",
    enMessages as unknown as Parameters<typeof createTranslator>[1],
  );

  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      "aria-hidden"?: boolean;
    }) =>
      React.createElement(
        "span",
        { "aria-hidden": rest["aria-hidden"] },
        children,
      ),
    useTranslations: () => translator.t,
    useFormatters: () => ({
      locale: translator.locale,
      dateTime: translator.formatDate,
    }),
  };
});

/**
 * The hook's whole return value. `recurrence` and `truncated` are part of it
 * deliberately: the component reads the cadence and the horizon from the HOOK,
 * beside the rows they describe, never from its own props — the props are only
 * the seed, and they ride an edge-cached document the query's payload does not.
 * See "reads the loaded list, not the seeded props" below.
 */
const hook = vi.hoisted(() => ({
  rows: [] as DateRsvpRow[],
  recurrence: null as DateRsvpRecurrence | null,
  truncated: false,
  nextScheduledEventDateId: null as string | null,
  hasRecurrenceRule: true,
  sessionPending: false,
  isSignedIn: true,
  pendingIds: new Set<string>() as ReadonlySet<string>,
  toggle: vi.fn(),
}));

vi.mock("../use-date-rsvp-list", () => ({
  useDateRsvpList: () => hook,
}));

/**
 * The moderator half. Its real implementation probes
 * `community.checkModeratorAccess` from the CLIENT, after first paint — it can
 * never ride the edge-cached event document — so here it is a flag; the probe
 * itself is pinned in `use-date-moderation.test.tsx`.
 */
const moderation = vi.hoisted(() => ({
  isModerator: false,
  pendingIds: new Set<string>() as ReadonlySet<string>,
  callOff: vi.fn(),
  putBack: vi.fn(),
}));

vi.mock("../use-date-moderation", () => ({
  useDateModeration: () => moderation,
}));

/**
 * The confirm step, stubbed to its BEHAVIOUR and nothing else: a real dialog
 * element with two real buttons wired to the real callbacks, so every assertion
 * below is about something a moderator can actually press. The @th/ui Modal it
 * normally renders brings Tamagui with it, which this file deliberately does
 * not mount (see the @th/ui mock above).
 */
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title} data-testid="confirm-dialog">
        <p>{description}</p>
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { CommunityDateList } from "../CommunityDateList";

// ── Fixtures ────────────────────────────────────────────────────────────────

const TZ = "America/Chicago";

const WEEKLY: DateRsvpRecurrence = {
  freq: "WEEKLY",
  interval: 1,
  byday: ["WE"],
  until: null,
};

/**
 * The same summary in its RSC → island wire shape (`until` as an ISO string).
 * The hook revives it; the PROP carries the string.
 */
const asSeed = (
  r: DateRsvpRecurrence | null,
): CommunityRecurrenceSummary | null =>
  r ? { ...r, until: r.until ? r.until.toISOString() : null } : null;

/**
 * `n` consecutive Wednesdays at 8:00 PM America/Chicago, starting 2026-09-16.
 * 20:00 CDT is 01:00 UTC the next day; the instants are built in UTC so the
 * fixture does not depend on the machine's clock zone.
 */
function wednesdays(n: number): DateRsvpRow[] {
  const rows: DateRsvpRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const startsAt = new Date(Date.UTC(2026, 8, 17, 1, 0, 0));
    startsAt.setUTCDate(startsAt.getUTCDate() + 7 * i);
    rows.push({
      eventDateId: `date-${i}`,
      startsAt,
      endsAt: null,
      viewerRsvped: false,
      status: "SCHEDULED",
    });
  }
  return rows;
}

/**
 * Occurrences at 8:00 PM America/Chicago on the given days of September 2026.
 * Sep 14 is a Monday, 16 a Wednesday, 18 a Friday — so a day list builds a
 * multi-weekday rule. 20:00 CDT is 01:00 UTC the NEXT day; built in UTC so the
 * fixture does not depend on the machine's clock zone.
 */
function septemberDays(days: number[]): DateRsvpRow[] {
  return days.map((day, i) => ({
    eventDateId: `date-${i}`,
    startsAt: new Date(Date.UTC(2026, 8, day + 1, 1, 0, 0)),
    endsAt: null,
    viewerRsvped: false,
    status: "SCHEDULED" as const,
  }));
}

/**
 * Renders with the seed props and the hook's return value AGREEING — the normal
 * case, and what every test that is not about drift wants. The component reads
 * the hook, so the hook is set here too.
 */
function renderList(
  props: Partial<{
    recurrence: DateRsvpRecurrence | null;
    timezone?: string;
    datesTruncated: boolean;
  }> = {},
) {
  const recurrence =
    "recurrence" in props ? (props.recurrence ?? null) : WEEKLY;
  const truncated = props.datesTruncated ?? false;
  hook.recurrence = recurrence;
  hook.truncated = truncated;

  return render(
    <CommunityDateList
      eventId="event-1"
      initialDates={[]}
      timezone={TZ}
      recurrence={asSeed(recurrence)}
      datesTruncated={truncated}
      nextScheduledEventDateId={hook.nextScheduledEventDateId}
      hasRecurrenceRule={hook.hasRecurrenceRule}
    />,
  );
}

beforeEach(() => {
  hook.rows = wednesdays(52);
  hook.recurrence = WEEKLY;
  hook.truncated = false;
  // `date-0` in both fixtures. The section LEADS with this id, never with
  // `rows[0]` — a called-off night sorts first like any other.
  hook.nextScheduledEventDateId = "date-0";
  hook.hasRecurrenceRule = true;
  hook.sessionPending = false;
  hook.isSignedIn = true;
  hook.pendingIds = new Set<string>();
  hook.toggle = vi.fn();
  moderation.isModerator = false;
  moderation.pendingIds = new Set<string>();
  moderation.callOff = vi.fn();
  moderation.putBack = vi.fn();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CommunityDateList — collapsed density", () => {
  it("renders at most 7 RSVP toggles for 52 upcoming dates", () => {
    renderList();

    // One per-date toggle in the NEXT card + six "THEN" chips. `pressed` only
    // matches controls carrying aria-pressed, i.e. exactly the RSVP toggles.
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(7);
    // …plus the disclosure, and nothing else. 8, not 53.
    expect(screen.getAllByRole("button")).toHaveLength(8);
  });

  it("leads with the next date and the cadence, not an enumeration", () => {
    renderList();

    const cadence = screen.getByTestId("community-date-cadence");
    expect(cadence).toHaveTextContent("Every Wednesday, 8:00 PM");
    // The horizon describes the SAME set the disclosure holds.
    expect(cadence).toHaveTextContent("52 dates through Sep 2027");

    expect(screen.getByText("Wed, Sep 16 · 8:00 PM")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "I'm going on Wed, Sep 16 · 8:00 PM",
      }),
    ).toBeInTheDocument();
  });

  it("omits the cadence line when there is no recurrence to summarise", () => {
    renderList({ recurrence: null });

    expect(screen.queryByTestId("community-date-cadence")).toBeNull();
    expect(screen.queryByText(/^Every /)).toBeNull();
    // The rest of the section still works — only the sentence is gone.
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(7);
  });

  it("names the weekday in the cadence line for a weekly rule", () => {
    renderList({ recurrence: { ...WEEKLY, byday: ["WE"] } });

    expect(screen.getByTestId("community-date-cadence")).toHaveTextContent(
      /Every Wednesday/,
    );
  });

  it("states the interval for an every-other-week rule", () => {
    renderList({ recurrence: { ...WEEKLY, interval: 2 } });

    expect(screen.getByTestId("community-date-cadence")).toHaveTextContent(
      "Every 2 weeks on Wednesday, 8:00 PM",
    );
  });
});

/**
 * The server truncates twice — `MAX_DATES = 60`, AND materialisation stops at 60
 * occurrences inside a 12-month window — and the client cannot see either cap
 * from the rows alone. So the last LOADED date is only the end of the series
 * when the server says the list reached it. Without that signal the seeded
 * weekly open mic (open-ended, no UNTIL) read "52 DATES THROUGH SEP 2027",
 * telling a reader that an ongoing Wednesday night ends next September.
 */
describe("CommunityDateList — truncated vs complete list", () => {
  it("drops the horizon entirely when the list does not reach the end", () => {
    renderList({ datesTruncated: true });

    const cadence = screen.getByTestId("community-date-cadence");
    // The cadence itself is unchanged — the rule is known, only its end is not.
    expect(cadence).toHaveTextContent("Every Wednesday, 8:00 PM");
    expect(cadence).toHaveTextContent("Next 52 dates");
    // No end date is stated, in any phrasing.
    expect(cadence).not.toHaveTextContent(/through/i);
    expect(cadence).not.toHaveTextContent("Sep 2027");
  });

  it("does not promise a complete list in the disclosure when truncated", () => {
    renderList({ datesTruncated: true });

    const trigger = screen.getByRole("button", { name: "Show more dates" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /All 52 dates/ })).toBeNull();

    fireEvent.click(trigger);
    // The scroller's accessible name drops "All" too.
    expect(
      screen.getByRole("group", { name: "Upcoming dates" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "All upcoming dates" }),
    ).toBeNull();
  });

  it("keeps the horizon when the loaded list IS the whole series", () => {
    renderList({ datesTruncated: false });

    const cadence = screen.getByTestId("community-date-cadence");
    expect(cadence).toHaveTextContent("52 dates through Sep 2027");
    expect(cadence).not.toHaveTextContent("Next 52 dates");
    expect(
      screen.getByRole("button", { name: "All 52 dates" }),
    ).toBeInTheDocument();
  });
});

/**
 * The seeded props and the loaded rows come from DIFFERENT places: the props ride
 * the event-page document, which is edge-cached (`s-maxage=120,
 * stale-while-revalidate=300`), and the rows ride an uncached query. So they
 * disagree for minutes at a time, and a section that takes its rows from one and
 * its sentences from the other describes a list that is not on screen.
 *
 * Both assertions below are the realistic staleness: a moderator replaces a
 * bounded rule with an open-ended one, the document in the cache still says
 * "complete", and the fresh payload says otherwise.
 */
describe("CommunityDateList — cadence and horizon follow the rows", () => {
  it("reads the horizon from the loaded list, not from the seeded prop", () => {
    hook.truncated = true;
    render(
      <CommunityDateList
        eventId="event-1"
        initialDates={[]}
        timezone={TZ}
        recurrence={asSeed(WEEKLY)}
        // The stale edge-cached document: it still thinks the series ends.
        datesTruncated={false}
      />,
    );

    const cadence = screen.getByTestId("community-date-cadence");
    expect(cadence).toHaveTextContent("Next 52 dates");
    expect(cadence).not.toHaveTextContent(/through/i);
    // …and the disclosure cannot promise a count it does not hold either.
    expect(
      screen.getByRole("button", { name: "Show more dates" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All 52 dates/ })).toBeNull();
  });

  it("reads the cadence from the loaded list, not from the seeded prop", () => {
    hook.recurrence = { ...WEEKLY, interval: 2 };
    render(
      <CommunityDateList
        eventId="event-1"
        initialDates={[]}
        timezone={TZ}
        // Stale: the cached document was published under a weekly rule.
        recurrence={asSeed(WEEKLY)}
        datesTruncated={false}
      />,
    );

    expect(screen.getByTestId("community-date-cadence")).toHaveTextContent(
      "Every 2 weeks on Wednesday, 8:00 PM",
    );
  });

  it("drops the cadence line when the loaded list has no rule, whatever the prop said", () => {
    hook.recurrence = null;
    render(
      <CommunityDateList
        eventId="event-1"
        initialDates={[]}
        timezone={TZ}
        recurrence={asSeed(WEEKLY)}
        datesTruncated={false}
      />,
    );

    expect(screen.queryByTestId("community-date-cadence")).toBeNull();
  });
});

/**
 * The weekday NAMES are read off real occurrences (locale-correct for free), but
 * the RULE decides how many there should be. Printing the ones that happen to be
 * left is how "Every Monday and Wednesday" ends up describing a MO,WE,FR night.
 */
describe("CommunityDateList — weekly day list", () => {
  const THREE_DAY: DateRsvpRecurrence = {
    freq: "WEEKLY",
    interval: 1,
    byday: ["MO", "WE", "FR"],
    until: null,
  };

  it("names every day of a three-day rule, in week order", () => {
    // Ascending occurrences start on a WEDNESDAY, so occurrence order is
    // Wed → Fri → Mon. The sentence must still read Monday-first.
    hook.rows = septemberDays([16, 18, 21, 23, 25, 28, 30]);
    renderList({ recurrence: THREE_DAY });

    expect(screen.getByTestId("community-date-cadence")).toHaveTextContent(
      "Every Monday, Wednesday, and Friday, 8:00 PM",
    );
  });

  it("orders a two-day rule by week, not by which day comes next", () => {
    hook.rows = septemberDays([16, 21, 23, 28, 30]);
    renderList({ recurrence: { ...THREE_DAY, byday: ["MO", "WE"] } });

    expect(screen.getByTestId("community-date-cadence")).toHaveTextContent(
      "Every Monday and Wednesday, 8:00 PM",
    );
  });

  it("omits the day list rather than under-report a three-day rule", () => {
    // A MO,WE,FR listing whose remaining occurrences are only Mondays and
    // Wednesdays: naming two of three days would be confidently wrong.
    hook.rows = septemberDays([16, 21, 23, 28, 30]);
    renderList({ recurrence: THREE_DAY });

    const cadence = screen.getByTestId("community-date-cadence");
    // The time survives — that half is still true.
    expect(cadence).toHaveTextContent("Every week, 8:00 PM");
    expect(cadence).not.toHaveTextContent(/Monday|Wednesday|Friday/);
  });

  it("keeps the interval in the day-less fallback", () => {
    hook.rows = septemberDays([16, 21, 23]);
    renderList({ recurrence: { ...THREE_DAY, interval: 2 } });

    const cadence = screen.getByTestId("community-date-cadence");
    expect(cadence).toHaveTextContent("Every 2 weeks, 8:00 PM");
    expect(cadence).not.toHaveTextContent(/Monday|Wednesday|Friday/);
  });
});

describe("CommunityDateList — small N", () => {
  it("shows no disclosure when every date is already visible", () => {
    hook.rows = wednesdays(2);
    renderList();

    expect(screen.queryByTestId("community-date-disclosure")).toBeNull();
    // Next card + the one remaining chip. No empty drawer, no stub.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("Sep 23")).toBeInTheDocument();
  });

  it("keeps the disclosure once a date would be hidden", () => {
    hook.rows = wednesdays(8);
    renderList();

    expect(
      screen.getByRole("button", { name: "All 8 dates" }),
    ).toBeInTheDocument();
  });
});

describe("CommunityDateList — signed out", () => {
  beforeEach(() => {
    hook.isSignedIn = false;
  });

  it("offers exactly ONE sign-in affordance in the whole section", () => {
    renderList();

    expect(
      screen.getAllByRole("button", { name: /sign in to rsvp/i }),
    ).toHaveLength(1);
    // The only other control is the disclosure.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "All 52 dates" }),
    ).toBeInTheDocument();
    // Nothing is a two-state control without a viewer to have an opinion.
    expect(screen.queryAllByRole("button", { pressed: false })).toHaveLength(0);
  });

  it("renders the following dates as labels, not per-date buttons", () => {
    renderList();

    expect(screen.getByText("Sep 23")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sep 23/ })).toBeNull();
  });

  it("still boxes each following date so the row reads as a list of dates", () => {
    renderList();

    // Bare text ran the six dates together into one line ("Sep 23  Sep 30
    // Oct 7 …") and stranded "Oct 28" alone on a second row at 390px. The box
    // itself lives in the stylesheet (the hairline border + the chip's padding
    // and 40px geometry); what this asserts is that each date carries the class
    // that paints it — and that keeping the box did NOT turn it into a control.
    for (const label of ["Sep 23", "Sep 30", "Oct 7"]) {
      const date = screen.getByText(label);
      expect(date.className).toContain("staticDate");
      expect(date.tagName).toBe("SPAN");
      // Non-interactive and out of the tab order: no role, no tabindex.
      expect(date).not.toHaveAttribute("tabindex");
      expect(date).not.toHaveAttribute("role");
      expect(date).not.toHaveAttribute("aria-pressed");
    }
  });

  it("routes the one CTA through the sign-in path", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: /sign in to rsvp/i }));

    // `toggle` is what owns the showSignInOverlay redirect.
    expect(hook.toggle).toHaveBeenCalledTimes(1);
    expect(hook.toggle).toHaveBeenCalledWith(hook.rows[0]);
  });

  it("still shows the full list, month-grouped and label-only", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));

    const panel = screen.getByTestId("community-date-all-panel");
    expect(within(panel).getByText("September 2026")).toBeInTheDocument();
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("CommunityDateList — disclosure", () => {
  it("is closed by default and genuinely hidden", () => {
    renderList();

    const trigger = screen.getByRole("button", { name: "All 52 dates" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    const panel = screen.getByTestId("community-date-all-panel");
    expect(panel).toHaveAttribute("hidden");
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
  });

  it("reveals all 52 dates grouped by month when opened", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));

    const trigger = screen.getByRole("button", { name: "Hide dates" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const panel = screen.getByTestId("community-date-all-panel");
    expect(panel).not.toHaveAttribute("hidden");

    // 52 row toggles in the panel + the 7 above it.
    expect(
      within(panel).getAllByRole("button", { pressed: false }),
    ).toHaveLength(52);
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(59);

    // Month group headers, with that month's count.
    expect(within(panel).getByText("September 2026")).toBeInTheDocument();
    expect(within(panel).getByText("October 2026")).toBeInTheDocument();
    expect(within(panel).getByText("September 2027")).toBeInTheDocument();
    // Sep 16 / 23 / 30 — three Wednesdays in the first month.
    expect(within(panel).getByText("3 dates")).toBeInTheDocument();

    // Rows read forwards, and drop the clock the cadence line already states —
    // `{weekday, day}` alone would render "16 Wed" in en-US, so the month stays.
    expect(within(panel).getByText("Wed, Sep 16")).toBeInTheDocument();
    expect(within(panel).queryByText(/Sep 16 · 8:00 PM/)).toBeNull();

    // Every row keeps a per-date accessible name.
    expect(
      within(panel).getByRole("button", {
        name: "I'm going on Wed, Sep 23 · 8:00 PM",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the time in each row when there is no cadence line to carry it", () => {
    renderList({ recurrence: null });

    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));

    const panel = screen.getByTestId("community-date-all-panel");
    expect(
      within(panel).getByText("Wed, Sep 16 · 8:00 PM"),
    ).toBeInTheDocument();
  });

  it("collapses again, re-hiding the panel", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide dates" }));

    expect(screen.getByTestId("community-date-all-panel")).toHaveAttribute(
      "hidden",
    );
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(7);
  });
});

describe("CommunityDateList — in-flight and going states", () => {
  it("marks a pending toggle aria-disabled, never natively disabled", () => {
    hook.pendingIds = new Set(["date-0"]);
    renderList();

    const primary = screen.getByRole("button", {
      name: "I'm going on Wed, Sep 16 · 8:00 PM",
    });
    // Native `disabled` would yank it out of the tab order mid-mutation and
    // drop keyboard focus to <body>.
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(primary).toHaveAttribute("aria-busy", "true");
    expect(primary).not.toBeDisabled();
  });

  it("holds every toggle inert while the session is still resolving", () => {
    hook.sessionPending = true;
    renderList();

    for (const button of screen.getAllByRole("button", { pressed: false })) {
      expect(button).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("reports a going date as pressed, with its own accessible name", () => {
    const rows = wednesdays(52);
    rows[1] = { ...rows[1]!, viewerRsvped: true };
    hook.rows = rows;
    renderList();

    const chip = screen.getByRole("button", {
      name: "Going on Wed, Sep 23 · 8:00 PM",
    });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveAttribute("data-going", "true");
  });
});

/**
 * A moderator called one night off. The strike-through is EVENT-INTRINSIC — it
 * rides the same edge-cached document as the dates themselves — so it is shown
 * to everyone, signed in or not. Dropping the row instead would say "that date
 * was never on the schedule" when what happened is "that date is off", and the
 * person who heard "it's on Wednesday" gets silence.
 */
describe("CommunityDateList — a called-off night", () => {
  /** 52 Wednesdays with `n` cancelled from the top. */
  function withCancelled(n: number): DateRsvpRow[] {
    return wednesdays(52).map((row, i) =>
      i < n ? { ...row, status: "CANCELLED" as const } : row,
    );
  }

  it("leads with the first SCHEDULED date, not with row zero", () => {
    hook.rows = withCancelled(1);
    hook.nextScheduledEventDateId = "date-1";
    renderList();

    // Sep 16 is off; the card must not advertise it.
    expect(screen.getByText("Wed, Sep 23 · 8:00 PM")).toBeInTheDocument();
    expect(screen.queryByText("Wed, Sep 16 · 8:00 PM")).toBeNull();
    expect(
      screen.getByRole("button", { name: "I'm going on Wed, Sep 23 · 8:00 PM" }),
    ).toBeInTheDocument();
  });

  it("keeps the called-off night visible, marked, and ahead of the lead", () => {
    hook.rows = withCancelled(1);
    hook.nextScheduledEventDateId = "date-1";
    renderList();

    // It stays in chronological order, where it visibly explains why the lead
    // skipped forward.
    const chips = screen.getByRole("group", { name: "Then" });
    expect(within(chips).getByText("Sep 16")).toBeInTheDocument();
    // The word, not just the strike: `text-decoration` announces nothing.
    expect(within(chips).getAllByText("Called off")).toHaveLength(1);
  });

  it("marks it for a SIGNED-OUT reader too", () => {
    hook.isSignedIn = false;
    hook.rows = withCancelled(1);
    hook.nextScheduledEventDateId = "date-1";
    renderList();

    expect(screen.getByText("Called off")).toBeInTheDocument();
    expect(screen.getByText("Sep 16").className).toContain("struck");
  });

  it("offers no RSVP control on it, at any density", () => {
    hook.rows = withCancelled(1);
    hook.nextScheduledEventDateId = "date-1";
    renderList();

    // The lead + five live chips = 6 toggles, not 7: the cancelled date took a
    // slot in the row but carries no control.
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /Sep 16/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));
    const panel = screen.getByTestId("community-date-all-panel");
    // 51 row toggles for 52 rows.
    expect(
      within(panel).getAllByRole("button", { pressed: false }),
    ).toHaveLength(51);
    expect(within(panel).getAllByText("Called off")).toHaveLength(1);
  });
});

/**
 * The zero-dates ruling. With no upcoming SCHEDULED occurrence a recurring
 * listing states which of the two things is true — and NEVER falls back to the
 * event-level RSVP button, whose `Event.startsAt` by then is a past or
 * synthetic instant: that button offers "I'm going" on a night that already
 * happened, which is the defect this branch exists to remove.
 */
describe("CommunityDateList — no upcoming scheduled dates", () => {
  beforeEach(() => {
    hook.nextScheduledEventDateId = null;
    hook.hasRecurrenceRule = true;
  });

  it("says the next dates are being scheduled when the series runs on", () => {
    hook.rows = [];
    hook.truncated = true;
    renderList({ datesTruncated: true });

    expect(screen.getByTestId("community-date-notice")).toHaveTextContent(
      "Next dates are being scheduled.",
    );
    expect(screen.queryByText("This series has ended.")).toBeNull();
  });

  it("says the series has ended when it really has", () => {
    hook.rows = [];
    hook.truncated = false;
    renderList({ datesTruncated: false });

    expect(screen.getByTestId("community-date-notice")).toHaveTextContent(
      "This series has ended.",
    );
  });

  it("offers NO rsvp control and no sign-in hint in either state", () => {
    hook.rows = [];
    hook.truncated = true;
    renderList({ datesTruncated: true });

    expect(screen.queryAllByTestId("community-date-rsvp")).toHaveLength(0);
    expect(screen.queryByText(/Sign in to RSVP/)).toBeNull();
    expect(screen.queryByText(/Only you can see this/)).toBeNull();
  });

  it("still states the cadence over the remaining called-off nights", () => {
    // The top-up job has not run; every materialised night was called off.
    hook.rows = wednesdays(3).map((row) => ({
      ...row,
      status: "CANCELLED" as const,
    }));
    hook.truncated = true;
    renderList({ datesTruncated: true });

    const cadence = screen.getByTestId("community-date-cadence");
    expect(cadence).toHaveTextContent("Every Wednesday, 8:00 PM");
    // No horizon: both phrasings would count nights that are not happening.
    expect(cadence).not.toHaveTextContent(/dates/i);
    // …and the nights themselves are still on the page, marked.
    expect(screen.getAllByText("Called off")).toHaveLength(3);
  });

  it("renders nothing at all when the listing has no rule", () => {
    // A single-date listing: the page's own RsvpButton is the right control,
    // and this section must not print "this series has ended" over it.
    hook.rows = [];
    hook.hasRecurrenceRule = false;
    const { container } = renderList();

    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * The moderator strip. It is rendered from a CLIENT-side probe, after first
 * paint — the event page is edge-cached with no Cookie in its Vary, so a single
 * moderator warming a colo would otherwise hand "Call off" buttons to every
 * anonymous reader served from it.
 */
describe("CommunityDateList — moderator controls", () => {
  beforeEach(() => {
    moderation.isModerator = true;
  });

  it("shows nothing moderator-shaped to an ordinary viewer", () => {
    moderation.isModerator = false;
    renderList();

    expect(screen.queryByTestId("community-date-mod-bar")).toBeNull();
    expect(screen.queryAllByTestId("community-date-call-off")).toHaveLength(0);
    expect(screen.queryAllByTestId("community-date-put-back")).toHaveLength(0);
  });

  it("names the role and the way out to the full surface, and nothing else", () => {
    renderList();

    const bar = screen.getByTestId("community-date-mod-bar");
    expect(bar).toHaveTextContent("Moderator");
    expect(
      screen.getByRole("link", { name: /Manage schedule/ }),
    ).toHaveAttribute("href", "/moderate/listings/event-1/schedule");
    // No sentence explaining that the reader is a moderator: the stamp says it,
    // and at 240px that sentence cost the bar a third line.
    expect(bar).not.toHaveTextContent(/maintain/i);
  });

  it("puts a call-off on the lead date", () => {
    renderList();

    expect(screen.getAllByTestId("community-date-call-off")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Call off Wed, Sep 16 · 8:00 PM" }),
    ).toBeInTheDocument();
  });

  it("leaves the 'then' chips exactly as every other viewer sees them", () => {
    // The chip row is a GLANCE surface — "when is this on next" — and a
    // moderator reads this page before they operate it. A destructive control on
    // each of six chips turns the summary into a control panel, and it cost 328px
    // of extra section at 320px. Both real jobs are still served: "this Wednesday
    // is off" is the NEXT card, "the third Wednesday in March is off" is the
    // disclosure.
    renderList();

    const chips = screen.getByRole("group", { name: "Then" });
    expect(within(chips).queryAllByTestId("community-date-call-off")).toHaveLength(
      0,
    );
    expect(within(chips).queryAllByTestId("community-date-put-back")).toHaveLength(
      0,
    );
    // Only the six RSVP toggles, same as any signed-in viewer.
    expect(within(chips).getAllByRole("button")).toHaveLength(6);
    expect(
      within(chips).queryByRole("button", { name: /Call off/ }),
    ).toBeNull();
  });

  it("puts one on every row of the full list", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));

    const panel = screen.getByTestId("community-date-all-panel");
    expect(
      within(panel).getAllByTestId("community-date-call-off"),
    ).toHaveLength(52);
  });

  it("does not call off on the first press — it asks first", () => {
    renderList();

    fireEvent.click(
      screen.getByRole("button", { name: "Call off Wed, Sep 16 · 8:00 PM" }),
    );

    // Calling a night off emails everyone holding a live RSVP on it. One stray
    // tap must not send that mail.
    expect(moderation.callOff).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", {
      name: "Call off this date?",
    });
    // The confirm states the OUTCOME, including the part that cannot be undone.
    expect(dialog).toHaveTextContent("Wed, Sep 16 · 8:00 PM");
    expect(dialog).toHaveTextContent(/everyone who RSVP'd is emailed/i);
    expect(dialog).toHaveTextContent(/You can put it back/i);
  });

  it("calls it off once confirmed", () => {
    renderList();

    fireEvent.click(
      screen.getByRole("button", { name: "Call off Wed, Sep 16 · 8:00 PM" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Call off" }));

    expect(moderation.callOff).toHaveBeenCalledTimes(1);
    expect(moderation.callOff).toHaveBeenCalledWith("date-0");
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("sends nothing when the moderator keeps the date", () => {
    renderList();

    fireEvent.click(
      screen.getByRole("button", { name: "Call off Wed, Sep 16 · 8:00 PM" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep this date" }));

    expect(moderation.callOff).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("offers PUT BACK on a called-off night, with no confirm", () => {
    hook.rows = wednesdays(52).map((row, i) =>
      i === 1 ? { ...row, status: "CANCELLED" as const } : row,
    );
    renderList();

    // The called-off night is visible in the chip row — struck and marked — but
    // the control for it lives on its full-width row in the disclosure.
    const chips = screen.getByRole("group", { name: "Then" });
    expect(within(chips).getByText("Called off")).toBeInTheDocument();
    expect(within(chips).queryAllByTestId("community-date-put-back")).toHaveLength(
      0,
    );

    fireEvent.click(screen.getByRole("button", { name: "All 52 dates" }));
    const panel = screen.getByTestId("community-date-all-panel");
    const putBack = within(panel).getByRole("button", {
      name: "Put Wed, Sep 23 · 8:00 PM back on",
    });
    fireEvent.click(putBack);

    // Restoring is additive and reversible — no dialog stands between.
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(moderation.putBack).toHaveBeenCalledWith("date-1");
    // …and it is the ONLY one: 51 live rows carry a call-off, this one does not.
    expect(within(panel).getAllByTestId("community-date-put-back")).toHaveLength(
      1,
    );
    expect(within(panel).getAllByTestId("community-date-call-off")).toHaveLength(
      51,
    );
  });

  it("marks an in-flight control aria-disabled, never natively disabled", () => {
    moderation.pendingIds = new Set(["date-0"]);
    renderList();

    const control = screen.getByRole("button", {
      name: "Call off Wed, Sep 16 · 8:00 PM",
    });
    // Native `disabled` would yank it out of the tab order mid-write and drop
    // keyboard focus to <body>.
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveAttribute("aria-busy", "true");
    expect(control).not.toBeDisabled();
  });

  it("reaches a drained listing's called-off nights through the disclosure", () => {
    hook.rows = wednesdays(20).map((row) => ({
      ...row,
      status: "CANCELLED" as const,
    }));
    hook.nextScheduledEventDateId = null;
    hook.truncated = true;
    renderList({ datesTruncated: true });

    // No NEXT card to hang a control on, so the six visible nights carry none.
    expect(screen.getByTestId("community-date-notice")).toBeInTheDocument();
    expect(screen.queryAllByTestId("community-date-put-back")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show more dates" }));
    const panel = screen.getByTestId("community-date-all-panel");
    expect(within(panel).getAllByTestId("community-date-put-back")).toHaveLength(
      20,
    );
  });

  it("still reaches every night when the list is too short to hide anything", () => {
    // Taking call-off off the chips created a state with no inline way out:
    // every remaining night called off, few enough that nothing is hidden, and
    // so no NEXT card to hang a control on either. The moderator could SEE a
    // called-off night and have no way to put it back. For a moderator the
    // panel is not "the rest of the list", it is the control surface, so it is
    // offered whatever the count. Do not fold this back into the count test.
    hook.rows = wednesdays(3).map((row) => ({
      ...row,
      status: "CANCELLED" as const,
    }));
    hook.nextScheduledEventDateId = null;
    hook.truncated = true;
    renderList({ datesTruncated: true });

    // It promises the COUNT, not "more dates": the panel holds every loaded row
    // here, so "Show more dates" would be the actual lie. `truncated` is a claim
    // about the schedule, and the drained notice above already refuses a horizon.
    const trigger = screen.getByRole("button", { name: "All 3 dates" });
    fireEvent.click(trigger);

    const panel = screen.getByTestId("community-date-all-panel");
    expect(within(panel).getAllByTestId("community-date-put-back")).toHaveLength(
      3,
    );
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Put Wed, Sep 16 · 8:00 PM back on",
      }),
    );
    expect(moderation.putBack).toHaveBeenCalledWith("date-0");
  });

  it("offers no such drawer to an ordinary viewer on a short list", () => {
    // The moderator clause must not leak: 3 dates with nothing hidden should
    // still read as deliberate for everyone else, not as a collapsed empty
    // drawer holding the same three rows.
    moderation.isModerator = false;
    hook.rows = wednesdays(3);
    renderList();

    expect(screen.queryByTestId("community-date-disclosure")).toBeNull();
  });
});
