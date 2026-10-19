/**
 * What the schedule list actually RENDERS.
 *
 * The real `@th/ui` + Tamagui stack, and the real EN catalogue, deliberately
 * unmocked. A mocked design system renders the exact class of defect this file
 * exists to catch (labels that collapse into one string, a control that loses
 * its accessible name), and a mocked translator would let a missing catalogue
 * key pass green while the page paints `moderation.schedYourRsvp` at a
 * moderator.
 */
import type { ReactElement } from "react";
import {
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

import {
  ScheduleDateList,
  type ScheduleRow,
} from "../ScheduleDateList";

const TIMEZONE = "America/Chicago";

const wrap = (ui: ReactElement) => (
  <IthasFireProvider>
    <TranslationProvider locale="en-US" messages={enMessages}>
      {ui}
    </TranslationProvider>
  </IthasFireProvider>
);

const render = (ui: ReactElement) => rtlRender(wrap(ui));

/** Three Wednesdays across a month boundary, as the API returns them. */
const ROWS: ScheduleRow[] = [
  {
    eventDateId: "d1",
    startsAt: new Date("2026-09-24T01:00:00.000Z"),
    status: "SCHEDULED",
    viewerRsvped: false,
  },
  {
    eventDateId: "d2",
    startsAt: new Date("2026-10-01T01:00:00.000Z"),
    status: "SCHEDULED",
    viewerRsvped: true,
  },
  {
    eventDateId: "d3",
    startsAt: new Date("2026-10-08T01:00:00.000Z"),
    status: "CANCELLED",
    viewerRsvped: false,
  },
];

const NONE: ReadonlySet<string> = new Set();

const list = (over: Partial<Parameters<typeof ScheduleDateList>[0]> = {}) => (
  <ScheduleDateList
    rows={ROWS}
    timezone={TIMEZONE}
    locale="en-US"
    doomedIds={NONE}
    outOfReachIds={NONE}
    pendingIds={NONE}
    onCallOff={vi.fn()}
    onPutBack={vi.fn()}
    {...over}
  />
);

describe("ScheduleDateList", () => {
  it("groups by the LISTING's month, not the runtime's", () => {
    // 2026-10-01T01:00Z is 8:00 PM on SEPTEMBER 30 in Chicago. Grouping on the
    // instant's UTC month would file it under October and print a Wednesday
    // that is not there.
    render(list());
    const heads = screen
      .getAllByText(/\d{4}$/)
      .map((el) => el.textContent);
    expect(heads).toEqual(["September 2026", "October 2026"]);
  });

  it("renders every date venue-local, with the instant on the <time> element", () => {
    const { container } = render(list());
    const times = [...container.querySelectorAll("time")];
    expect(times.map((el) => el.textContent)).toEqual([
      "Wed, Sep 23 · 8:00 PM",
      "Wed, Sep 30 · 8:00 PM",
      "Wed, Oct 7 · 8:00 PM",
    ]);
    // The visible text is Central; the attribute is the unambiguous instant.
    expect(times[0]?.getAttribute("datetime")).toBe("2026-09-24T01:00:00.000Z");
  });

  it("folds the date into each control's accessible name", () => {
    // The visible label is "Call off" on every live row, so the name is the
    // only thing that tells a screen-reader user WHICH night they are ending.
    render(list());
    expect(
      screen.getByRole("button", { name: "Call off Wed, Sep 23 · 8:00 PM" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Put Wed, Oct 7 · 8:00 PM back on" }),
    ).toBeTruthy();
  });

  it("offers PUT BACK — never CALL OFF — on a night that is already off", () => {
    render(list());
    const cancelledRow = screen
      .getAllByTestId("schedule-date-row")
      .find((row) => row.getAttribute("data-status") === "CANCELLED");
    expect(cancelledRow).toBeTruthy();
    const scope = within(cancelledRow!);
    expect(scope.getByTestId("schedule-date-put-back")).toBeTruthy();
    expect(scope.queryByTestId("schedule-date-call-off")).toBeNull();
    // The strike is decoration and announces nothing; the word is what a
    // screen reader reads, so it has to be in the DOM.
    expect(scope.getByText("Called off")).toBeTruthy();
  });

  it("labels the viewer's OWN rsvp as theirs — never as an anonymous count", () => {
    // FR-004: no endpoint exposes a per-date RSVP count, so an unqualified
    // "RSVP" here would be read as "somebody is going" and would be a claim
    // this page cannot make.
    render(list());
    expect(screen.getByText("Your RSVP")).toBeTruthy();
    expect(screen.queryByText(/^RSVP$/)).toBeNull();
  });

  it("marks the rows a staged rule change would take off, and only those", () => {
    render(list({ doomedIds: new Set(["d1"]) }));
    const rows = screen.getAllByTestId("schedule-date-row");
    expect(rows.map((r) => r.getAttribute("data-doomed"))).toEqual([
      "true",
      null,
      null,
    ]);
    expect(screen.getAllByText("Comes off")).toHaveLength(1);
  });

  it("says WHY a date comes off when the cap — not the rule — took it", () => {
    // The rule still wants this date; one expansion pass just cannot reach it.
    // A second, muted tag qualifies the first rather than replacing it.
    render(
      list({
        doomedIds: new Set(["d1", "d2"]),
        outOfReachIds: new Set(["d2"]),
      }),
    );
    expect(screen.getAllByText("Comes off")).toHaveLength(2);
    const outOfReach = screen.getAllByText("Out of reach");
    expect(outOfReach).toHaveLength(1);
    const rows = screen.getAllByTestId("schedule-date-row");
    expect(rows.map((r) => r.getAttribute("data-out-of-reach"))).toEqual([
      null,
      "true",
      null,
    ]);
  });

  it("never marks an already-cancelled row as coming off", () => {
    // It is not on the schedule to be taken off, and double-marking it would
    // imply the rule change is about to destroy something that is already off.
    render(list({ doomedIds: new Set(["d3"]) }));
    expect(screen.queryByText("Comes off")).toBeNull();
  });

  it("keeps an in-flight control in the tab order", () => {
    // `disabled` would yank it out mid-write and drop keyboard focus to
    // <body>; `aria-disabled` announces the state and keeps the node.
    render(list({ pendingIds: new Set(["d1"]) }));
    const button = screen.getByRole("button", {
      name: "Call off Wed, Sep 23 · 8:00 PM",
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("is a labelled, focusable scrollport", () => {
    // It scrolls, and a keyboard reader who has tabbed past the last visible
    // control needs a way to reach the rest of it.
    render(list());
    const scroller = screen.getByTestId("schedule-date-list");
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(scroller.getAttribute("role")).toBe("group");
    expect(scroller.getAttribute("aria-label")).toBe(
      "Every loaded date on this schedule",
    );
  });

  it("offers no PUT BACK on a taken-down or ended listing, and keeps the tag", () => {
    render(list({ canPutBack: false }));
    expect(screen.queryByTestId("schedule-date-put-back")).toBeNull();
    const rows = screen.getAllByTestId("schedule-date-row");
    expect(within(rows[2]!).getByText("Called off")).toBeTruthy();
    // Nights still scheduled keep their control.
    expect(screen.getAllByTestId("schedule-date-call-off")).toHaveLength(2);
  });

  it("on a closed listing, focus lands on the row once its Call off is gone", () => {
    const { rerender } = render(list({ canPutBack: false }));
    const callOff = screen.getAllByTestId("schedule-date-call-off")[0]!;
    callOff.focus();
    fireEvent.click(callOff);
    // The confirm dialog and the write happen above this component; the
    // re-read brings the night back CANCELLED and the button unmounts.
    callOff.blur();
    const after = ROWS.map((r) =>
      r.eventDateId === "d1" ? { ...r, status: "CANCELLED" as const } : r,
    );
    rerender(wrap(list({ rows: after, canPutBack: false })));
    const row = screen.getAllByTestId("schedule-date-row")[0]!;
    expect(within(row).queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("Keep this date drops the pressed id, so a later re-read does not steal focus", () => {
    const { rerender } = render(list({ canPutBack: false }));
    fireEvent.click(screen.getAllByTestId("schedule-date-call-off")[0]!);
    // Confirm opens, then closes with the night never pending: Keep.
    rerender(wrap(list({ canPutBack: false, callOffConfirmOpen: true })));
    rerender(wrap(list({ canPutBack: false, callOffConfirmOpen: false })));
    // Another moderator cancels that night; the re-read brings it back CANCELLED.
    (document.activeElement as HTMLElement | null)?.blur();
    const after = ROWS.map((r) =>
      r.eventDateId === "d1" ? { ...r, status: "CANCELLED" as const } : r,
    );
    rerender(wrap(list({ rows: after, canPutBack: false })));
    expect(document.activeElement).toBe(document.body);
  });

  it("on a closed listing the focus-target row names itself: date and state", () => {
    render(list({ canPutBack: false }));
    const row = screen.getAllByTestId("schedule-date-row")[2]!;
    expect(row.getAttribute("aria-label")).toMatch(/, called off$/);
    expect(screen.getAllByTestId("schedule-date-row")[0]!.hasAttribute("aria-label")).toBe(false);
  });

  it("Confirm keeps the id: the night comes back CANCELLED and its row takes focus", () => {
    const { rerender } = render(list({ canPutBack: false }));
    const callOff = screen.getAllByTestId("schedule-date-call-off")[0]!;
    callOff.focus();
    fireEvent.click(callOff);
    rerender(wrap(list({ canPutBack: false, callOffConfirmOpen: true })));
    // Confirmed: the confirm closes in the same render the night goes pending.
    rerender(
      wrap(
        list({
          canPutBack: false,
          callOffConfirmOpen: false,
          pendingIds: new Set(["d1"]),
        }),
      ),
    );
    callOff.blur();
    const after = ROWS.map((r) =>
      r.eventDateId === "d1" ? { ...r, status: "CANCELLED" as const } : r,
    );
    rerender(wrap(list({ rows: after, canPutBack: false, pendingIds: new Set(["d1"]) })));
    expect(document.activeElement).toBe(screen.getAllByTestId("schedule-date-row")[0]);
  });
});
