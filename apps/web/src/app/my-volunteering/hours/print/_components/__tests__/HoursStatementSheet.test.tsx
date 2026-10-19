import React from "react";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";

/**
 * The hours statement is handed to a school registrar, a court officer or a
 * grant administrator, so the assertions that matter are about what the
 * document is allowed to CLAIM:
 *  - only shifts recorded as checked in reach the paper,
 *  - a shift with no hours figure prints, and cannot read as 0.0,
 *  - no language implying Ithas Fire verified or certified the work,
 *  - the total is the sum of the rows above it and nothing else.
 *
 * Note what a jsdom test CANNOT see: `@media print`, `@page`, the repeating
 * <thead>, or whether the sheet renders dark-on-white under a dark account
 * theme. Those are verified in a real browser with
 * `page.emulateMedia({ media: "print" })`.
 */

const commitmentsQuery = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const session = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      signups: {
        listMyCommitments: { useQuery: () => commitmentsQuery.current },
      },
    },
  },
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => session.current },
}));

/**
 * Real `@th/ui` except the Tamagui `Button`, which needs a TamaguiProvider /
 * theme jsdom has no business booting. `useTranslations` and `useFormatters`
 * stay REAL, so the copy under test is the shipped copy.
 */
vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  return {
    ...actual,
    Button: ({
      children,
      tabIndex,
      ...rest
    }: { children?: ReactNode; tabIndex?: number } & Record<
      string,
      unknown
    >) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (key.startsWith("data-") || key.startsWith("aria-")) {
          domProps[key] = value;
        }
      }
      // `tabIndex` is forwarded explicitly, unlike the rest of the Tamagui
      // surface: the back link's second tab stop is a real defect this file
      // guards, and a stub that swallowed the prop would report it fixed.
      return (
        <button {...domProps} tabIndex={tabIndex}>
          {children}
        </button>
      );
    },
  };
});

import { HoursStatementSheet } from "../HoursStatementSheet";

/** Shared catalog + the app's overrides — the same merge the stories use. */
const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const renderSheet = () =>
  render(
    <TranslationProvider locale="en" messages={messages}>
      <HoursStatementSheet />
    </TranslationProvider>,
  );

type Row = Record<string, unknown>;

const row = (over: Row & { signupId: string }): Row => ({
  status: "CHECKED_IN",
  source: "EVENT_SHIFT",
  claimId: null,
  occurrenceId: null,
  cadence: null,
  title: "Nashville Punk Fest",
  roleName: "Door",
  shiftLabel: null,
  startsAt: null,
  endsAt: null,
  eventId: "evt_1",
  eventSlug: "nashville-punk-fest",
  eventTimezone: "America/Chicago",
  addressText: null,
  askId: null,
  hoursWorked: null,
  hoursCredited: 4,
  checkedInAt: new Date("2026-03-14T18:00:00Z"),
  createdAt: new Date("2026-03-01T00:00:00Z"),
  smsOptIn: false,
  hasContactPhone: false,
  textRemindersOffered: false,
  reminderAnchor: null,
  ...over,
});

/**
 * One claimed date of a standing ask. Mirrors the read model's occurrence-row
 * contract: ask-path `source`, `occurrenceId`/`claimId` set, no venue zone,
 * no shift label, and hours derived from the OCCURRENCE window.
 */
const occurrenceRow = (
  over: Row & { signupId: string; claimId: string },
): Row =>
  row({
    source: "ASK_WINDOW",
    occurrenceId: `occ-${over.claimId}`,
    cadence: "RECURRING",
    title: "Thursday Door Crew",
    roleName: "Door",
    shiftLabel: null,
    eventId: null,
    eventSlug: null,
    eventTimezone: null,
    askId: "ask-standing",
    ...over,
  });

const setRows = (rows: Row[]) => {
  commitmentsQuery.current = { data: rows, isLoading: false, error: null };
};

beforeEach(() => {
  session.current = {
    isPending: false,
    data: { user: { name: "Liam Nguyen", email: "liam.nguyen@example.com" } },
  };
  setRows([
    row({ signupId: "s1", hoursCredited: 4 }),
    row({
      signupId: "s2",
      hoursCredited: 2.5,
      title: "Riverside Cleanup",
      roleName: "Setup",
      shiftLabel: "Morning",
      checkedInAt: new Date("2026-05-02T14:00:00Z"),
    }),
  ]);
});

describe("HoursStatementSheet", () => {
  it("prints one row per checked-in shift and nothing else", () => {
    setRows([
      row({ signupId: "checked", status: "CHECKED_IN" }),
      row({ signupId: "approved", status: "APPROVED" }),
      row({ signupId: "pending", status: "PENDING" }),
      row({ signupId: "noshow", status: "NO_SHOW" }),
    ]);

    renderSheet();

    expect(
      screen.getByTestId("hours-statement-row-checked"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("hours-statement-row-approved")).toBeNull();
    expect(screen.queryByTestId("hours-statement-row-pending")).toBeNull();
    expect(screen.queryByTestId("hours-statement-row-noshow")).toBeNull();
  });

  it("prints EVERY claimed date of a standing ask, not one row per signup", () => {
    // THE regression this block exists for. A standing volunteer commits to
    // dated slots via `VolunteerOccurrenceClaim`, and the read model emits one
    // row per claimed occurrence — so `signupId` REPEATS. Keying the table on
    // it hands React duplicate keys and silently drops the repeats, which
    // undercounts exactly the volunteers with the most hours: the weekly
    // regulars this document matters most to.
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });

    setRows([
      occurrenceRow({
        signupId: "standing-1",
        claimId: "claim-a",
        hoursCredited: 3,
        checkedInAt: new Date("2026-01-08T23:00:00Z"),
      }),
      occurrenceRow({
        signupId: "standing-1", // ← same parent signup
        claimId: "claim-b",
        hoursCredited: 3,
        checkedInAt: new Date("2026-01-15T23:00:00Z"),
      }),
      occurrenceRow({
        signupId: "standing-1", // ← and again
        claimId: "claim-c",
        hoursCredited: 3.5,
        checkedInAt: new Date("2026-01-22T23:00:00Z"),
      }),
    ]);

    const { container } = renderSheet();

    // All three dates reach the paper…
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(
      screen.getByTestId("hours-statement-row-claim-a"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("hours-statement-row-claim-b"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("hours-statement-row-claim-c"),
    ).toBeInTheDocument();

    // …the total counts all three…
    expect(screen.getByTestId("hours-statement-total-hours")).toHaveTextContent(
      "9.50",
    );
    expect(
      screen.getByTestId("hours-statement-total-shifts"),
    ).toHaveTextContent("Across 3 shifts");

    // …and React never complained about duplicate keys.
    const keyWarning = errors
      .flat()
      .some(
        (arg) => typeof arg === "string" && /same key|duplicate/i.test(arg),
      );
    expect(keyWarning).toBe(false);

    spy.mockRestore();
  });

  it("does not count a claimed-but-not-worked date as a shift", () => {
    // The read model reports an un-checked-in claim as APPROVED even when the
    // PARENT signup is CHECKED_IN, precisely so a future Thursday someone
    // merely claimed cannot be billed as worked. The statement's status filter
    // must keep honouring that rather than "recovering" the row.
    setRows([
      occurrenceRow({
        signupId: "standing-1",
        claimId: "worked",
        hoursCredited: 3,
        checkedInAt: new Date("2026-01-08T23:00:00Z"),
      }),
      occurrenceRow({
        signupId: "standing-1",
        claimId: "claimed-only",
        status: "APPROVED",
        hoursCredited: 3,
        checkedInAt: null,
      }),
    ]);

    renderSheet();

    expect(
      screen.getByTestId("hours-statement-row-worked"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("hours-statement-row-claimed-only")).toBeNull();
    expect(screen.getByTestId("hours-statement-total-hours")).toHaveTextContent(
      "3.00",
    );
  });

  it("names the time zone its dates are in — paper cannot re-render elsewhere", () => {
    // Older asks have no zone, so some rows carry `eventTimezone: null`; the
    // sheet puts every date in the viewer's zone. A registrar reading it
    // months later has to be able to tell WHICH zone that was.
    const { container } = renderSheet();

    // `timeZoneName: "short"` appends e.g. "UTC" / "CDT" after the clock time.
    expect(screen.getByTestId("hours-statement-stamp").textContent).toMatch(
      /^Generated .+\d{1,2}:\d{2}\s?(AM|PM)\s\S+/,
    );
    expect(
      container.querySelector(".th-hours-sheet__footer"),
    ).toHaveTextContent(/dates above are shown in that same time zone/i);
  });

  it("totals exactly the hours in the rows above it", () => {
    renderSheet();

    expect(screen.getByTestId("hours-statement-total-hours")).toHaveTextContent(
      "6.50",
    );
    expect(
      screen.getByTestId("hours-statement-total-shifts"),
    ).toHaveTextContent("Across 2 shifts");
  });

  it("prints hours at 2dp so the column aligns AND adds up by hand", () => {
    // The regression this guards: at one decimal a 5.25-hour shift printed as
    // "5.3", so a reader adding the column got a different answer from the
    // total underneath it. `creditedHours` already rounds every row to 2dp
    // before anything sums it, so 2dp is exact and the column must reconcile.
    setRows([
      row({ signupId: "a", hoursCredited: 5.25 }),
      row({ signupId: "b", hoursCredited: 3.5 }),
      row({ signupId: "c", hoursCredited: 4 }),
    ]);

    const { container } = renderSheet();

    const figures = Array.from(
      container.querySelectorAll(".th-hours-row__hours"),
    ).map((el) => el.textContent ?? "");

    expect(figures).toEqual(["5.25", "3.50", "4.00"]);
    // Fixed digits ⇒ every string has its decimal point in the same place from
    // the right, which is what makes a right-aligned column line up.
    for (const figure of figures) {
      expect(figure).toMatch(/^\d+\.\d{2}$/);
    }

    // …and the printed total is exactly the sum of the printed rows.
    const printedSum = figures.reduce((sum, f) => sum + Number(f), 0);
    expect(screen.getByTestId("hours-statement-total-hours")).toHaveTextContent(
      printedSum.toFixed(2),
    );
  });

  it("prints a shift with no hours figure, and never lets it read as 0.0", () => {
    setRows([
      row({ signupId: "s1", hoursCredited: 4 }),
      row({
        signupId: "ask",
        source: "ASK_WINDOW",
        hoursCredited: null,
        title: "Standing door help",
      }),
    ]);

    const { container } = renderSheet();

    const askRow = screen.getByTestId("hours-statement-row-ask");
    // The row is on the paper — it happened.
    expect(within(askRow).getByText("Standing door help")).toBeInTheDocument();
    // …but carries no numeral at all, and says so to a screen reader.
    expect(askRow.querySelector(".th-hours-row__hours")).toBeNull();
    expect(askRow.querySelector(".th-hours-row__nohours")).not.toBeNull();
    expect(askRow).toHaveTextContent(/No hours figure recorded/i);

    // The hours CELL of that row contains no digit whatsoever. Stronger than
    // checking for the literal "0.00": the requirement is that the reader
    // cannot mistake the row for a zero-hour shift by any reading.
    const hoursCell = askRow.querySelector("td:nth-child(4)");
    expect(hoursCell?.textContent ?? "").not.toMatch(/\d/);

    // The total is unchanged by it, and the footnote explains the dash.
    expect(screen.getByTestId("hours-statement-total-hours")).toHaveTextContent(
      "4.00",
    );
    const footnote = screen.getByTestId("hours-statement-footnote");
    // States the OBSERVATION (no recorded length) and not a cause. An earlier
    // draft blamed "an ongoing volunteer commitment", which is reachable-false:
    // a ONE_TIME ask checked in at ask level whose role has no `defaultHours`
    // lands here too, and nothing about it was ongoing. This document may only
    // claim what it knows.
    expect(footnote).toHaveTextContent(/no recorded length/i);
    expect(footnote).not.toHaveTextContent(/ongoing/i);
    // Nothing anywhere on the sheet reads as a zero-hour figure.
    expect(container.textContent).not.toMatch(/\b0\.00\b/);
  });

  it("states the period beside the TOTAL, not only in the page-1 header", () => {
    // A weekly regular's statement runs to several pages and the total lands on
    // the last one, where the header is long gone. Paper cannot be scrolled
    // back up: "236.25" with no range near it is indistinguishable from the
    // "12.75 hours this year" the volunteer's own page shows.
    renderSheet();

    const totalScope = screen.getByTestId("hours-statement-total-shifts");
    expect(totalScope).toHaveTextContent("Across 2 shifts");
    expect(totalScope.textContent).toMatch(/Mar 14, 2026\s*–\s*May 2, 2026/);
  });

  it("omits the footnote entirely when every shift carries hours", () => {
    renderSheet();

    expect(screen.queryByTestId("hours-statement-footnote")).toBeNull();
  });

  it("never claims the work was verified, certified or confirmed", () => {
    // The whole point of the document. Ithas Fire recorded a check-in; it did
    // not audit the work, and must not imply that it did.
    const { container } = renderSheet();

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/verif/i);
    expect(text).not.toMatch(/certif/i);
    expect(text).not.toMatch(/confirmed by/i);
    expect(text).toMatch(/recorded as checked in/i);
  });

  it("states the period it covers, derived from the rows on the sheet", () => {
    const { container } = renderSheet();

    const fields = container.querySelector(".th-hours-sheet__fields");
    expect(fields).not.toBeNull();
    expect(fields).toHaveTextContent("Liam Nguyen");
    // 14 Mar → 2 May 2026, the first and last shift printed below.
    expect(fields?.textContent).toMatch(/Mar 14, 2026\s*–\s*May 2, 2026/);
  });

  it("prints the volunteer's name and a generation timestamp", () => {
    renderSheet();

    expect(screen.getByTestId("hours-statement-stamp")).toHaveTextContent(
      /^Generated /,
    );
    expect(screen.getByText("Liam Nguyen")).toBeInTheDocument();
  });

  it("carries no QR and no signature line — we have no verification endpoint", () => {
    const { container } = renderSheet();

    expect(container.querySelector("img[src*='/tickets/qr/']")).toBeNull();
    expect(container.textContent).not.toMatch(/signature/i);
  });

  it("labels every column for the stacked narrow-screen layout", () => {
    // The narrow-screen rules replace the <thead> with per-cell `data-label`
    // content. A missing label leaves a bare value on a phone.
    const { container } = renderSheet();

    const cells = Array.from(
      container.querySelectorAll("tbody td"),
    ) as HTMLElement[];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute("data-label")).toBeTruthy();
    }
  });

  it("says nothing is on record rather than printing an empty sheet", () => {
    setRows([row({ signupId: "a", status: "APPROVED" })]);

    renderSheet();

    expect(screen.getByTestId("hours-statement-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("hours-statement-table")).toBeNull();
  });

  it("does NOT report a failed read as 'you have no recorded shifts'", () => {
    // Two very different reasons produce an empty row set. Telling a volunteer
    // their record is empty when we merely failed to fetch it is a confident
    // and wrong claim about their own history.
    commitmentsQuery.current = {
      data: undefined,
      isLoading: false,
      error: { message: "INTERNAL_SERVER_ERROR" },
    };

    renderSheet();

    expect(screen.getByTestId("hours-statement-error")).toBeInTheDocument();
    expect(screen.queryByTestId("hours-statement-empty")).toBeNull();
  });

  it("asks a signed-out visitor to sign in instead of spinning forever", () => {
    // This route bypasses AppAuthGate, so without this branch the disabled
    // query would leave the page in a permanent loading state.
    session.current = { isPending: false, data: null };
    commitmentsQuery.current = {
      data: undefined,
      isLoading: false,
      error: null,
    };

    renderSheet();

    expect(
      screen.getByTestId("hours-statement-signed-out"),
    ).toBeInTheDocument();
  });

  it("waits for the session before rendering a nameless document", () => {
    session.current = { isPending: true, data: undefined };
    commitmentsQuery.current = {
      data: undefined,
      isLoading: false,
      error: null,
    };

    renderSheet();

    expect(screen.getByTestId("hours-statement-loading")).toBeInTheDocument();
  });

  it("renders the SAME branch on the server pass whatever the session says", async () => {
    // THE HYDRATION GUARD. `authClient.useSession()` reports `isPending: true`
    // during SSR but can resolve synchronously on the client's FIRST render, so
    // branching on it directly made the server emit "Preparing your statement"
    // while the client emitted "Sign in to open your statement" — a real
    // hydration failure that regenerated the whole tree. It was found by
    // loading the route in a browser; RTL cannot see it, because `render()`
    // flushes effects before the first assertion.
    //
    // `renderToString` runs WITHOUT effects, which is exactly the condition the
    // server pass and the client's first render share. Whatever the session
    // store says, the output must be the loading notice — anything else means
    // the `hasMounted` guard has been removed and hydration will break again.
    const { renderToString } = await import("react-dom/server");

    for (const state of [
      { isPending: false, data: null },
      {
        isPending: false,
        data: { user: { name: "Liam Nguyen", email: "liam@example.com" } },
      },
      { isPending: true, data: undefined },
    ]) {
      session.current = state;

      const html = renderToString(
        <TranslationProvider locale="en" messages={messages}>
          <HoursStatementSheet />
        </TranslationProvider>,
      );

      expect(html).toContain("hours-statement-loading");
      expect(html).not.toContain("hours-statement-signed-out");
      expect(html).not.toContain("hours-statement-table");
    }
  });

  it("gives the back link a single tab stop, not two with the same name", () => {
    // `NextLinkAnchor` wrapping a `Button tag="span"` is the toolbar idiom on
    // ALL THREE print documents, and Tamagui's Button renders a FOCUSABLE span
    // even under `tag="span"` — so the anchor and its own label were two
    // consecutive tab stops reading "Back to my volunteering" both times.
    // Found by tabbing through the volunteer badge sheet in a browser; fixed
    // on every document that shares the idiom, and guarded on each so they
    // cannot drift back apart one at a time.
    renderSheet();

    const link = screen.getByRole("link", {
      name: /back to my volunteering/i,
    });
    expect(link.querySelector("[tabindex]")?.getAttribute("tabindex")).toBe(
      "-1",
    );
  });
});
