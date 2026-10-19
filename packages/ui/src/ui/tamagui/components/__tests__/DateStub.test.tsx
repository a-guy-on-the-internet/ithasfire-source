import { screen } from "@testing-library/react";

import { renderWithProvider } from "../../../../../test/utils";
import {
  DateStub,
  formatStubDateParts,
} from "../events/DateStub";

/**
 * The Date Stub — the in-app half of the default event artwork.
 *
 * Deliberately rendered through the REAL provider (`renderWithProvider`), not
 * against mocked DS atoms: a mocked `Text` would pass over markup that never
 * paints, which is the failure mode this package has already shipped once.
 */

// A Thursday. 2026-09-10T23:30:00Z is still Sep 10 in Chicago (18:30) and
// already Sep 11 in Berlin (01:30) — so any test using it proves the zone
// actually travelled rather than agreeing by luck. NEVER derived from the
// machine's local zone.
const THU_LATE_UTC = new Date("2026-09-10T23:30:00.000Z");

/**
 * 01:30 UTC on the 11th = 20:30 on the 10th in Chicago, 03:30 on the 11th in
 * Berlin. Any assertion on this instant tells UTC apart from a Western machine
 * zone, which is what the fallback tests need: "it fell back to UTC" and "it
 * quietly used wherever this ran" produce DIFFERENT answers here.
 */
const ROLLOVER_UTC = new Date("2026-09-11T01:30:00.000Z");

describe("formatStubDateParts", () => {
  it("reads the instant in the supplied IANA zone", () => {
    expect(formatStubDateParts(THU_LATE_UTC, "America/Chicago")).toEqual({
      weekday: "THU",
      day: "10",
      month: "SEP",
    });
    // Same instant, a zone that has already rolled over.
    expect(formatStubDateParts(THU_LATE_UTC, "Europe/Berlin")).toEqual({
      weekday: "FRI",
      day: "11",
      month: "SEP",
    });
  });

  it("falls back to UTC — never the machine's zone — for an absent or unusable zone", () => {
    const utc = { weekday: "FRI", day: "11", month: "SEP" };
    expect(formatStubDateParts(ROLLOVER_UTC)).toEqual(utc);
    expect(formatStubDateParts(ROLLOVER_UTC, null)).toEqual(utc);
    expect(formatStubDateParts(ROLLOVER_UTC, "   ")).toEqual(utc);
    // `Intl` throws a RangeError on this; the PNG's luxon twin returns an
    // invalid DateTime. Both degrade to UTC rather than to "Invalid Date".
    expect(formatStubDateParts(ROLLOVER_UTC, "Not/AZone")).toEqual(utc);
    // And the same instant really is a different DAY somewhere real, so the
    // four answers above cannot be UTC by coincidence.
    expect(formatStubDateParts(ROLLOVER_UTC, "America/Chicago")).toEqual({
      weekday: "THU",
      day: "10",
      month: "SEP",
    });
  });

  it("accepts an ISO string or an epoch and never throws on junk", () => {
    expect(formatStubDateParts("2026-09-10T23:30:00.000Z", "UTC")).toEqual({
      weekday: "THU",
      day: "10",
      month: "SEP",
    });
    expect(formatStubDateParts(THU_LATE_UTC.getTime(), "UTC")?.day).toBe("10");

    expect(formatStubDateParts(null)).toBeNull();
    expect(formatStubDateParts(undefined)).toBeNull();
    expect(formatStubDateParts("")).toBeNull();
    expect(formatStubDateParts("not a date")).toBeNull();
    expect(formatStubDateParts(new Date("nope"))).toBeNull();
  });
});

describe("DateStub", () => {
  it("renders the date column in the artifact's order — DOW, DD, MO", () => {
    const { container } = renderWithProvider(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "America/Chicago")}
        title="Comedy Night at Larry's"
        venueLine="Larry's · Nashville, TN"
      />,
    );

    const text = container.textContent ?? "";
    const dow = text.indexOf("THU");
    const dd = text.indexOf("10");
    const mo = text.indexOf("SEP");

    expect(dow).toBeGreaterThanOrEqual(0);
    expect(dd).toBeGreaterThan(dow);
    expect(mo).toBeGreaterThan(dd);
    // And the body follows the whole column.
    expect(text.indexOf("Comedy Night at Larry's")).toBeGreaterThan(mo);
  });

  it("renders the place line as given, and omits the row entirely when there is none", () => {
    const { rerender } = renderWithProvider(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Basement Show"
        venueLine="The Basement East · Nashville, TN"
      />,
    );
    expect(
      screen.getByText("The Basement East · Nashville, TN"),
    ).toBeInTheDocument();

    // Degraded to city/state only — the normal case, since a venue name is
    // disclosure-gated server-side.
    rerender(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Basement Show"
        venueLine="Nashville, TN"
      />,
    );
    expect(screen.getByText("Nashville, TN")).toBeInTheDocument();

    // Nothing disclosed at all: no row, no placeholder, no empty node.
    rerender(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Basement Show"
        venueLine=""
      />,
    );
    expect(screen.queryByText("Nashville, TN")).not.toBeInTheDocument();
    expect(screen.getByText("Basement Show")).toBeInTheDocument();
  });

  it("says TBA rather than throwing when the date is missing or unparseable", () => {
    expect(() =>
      renderWithProvider(
        <DateStub
          date={formatStubDateParts(undefined)}
          title="Date TBA Show"
          venueLine="Nashville, TN"
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("TBA")).toBeInTheDocument();
    // The rest of the artifact still renders — the column frames either way.
    expect(screen.getByText("Date TBA Show")).toBeInTheDocument();
    expect(screen.getByText("Nashville, TN")).toBeInTheDocument();
  });

  it("clamps a long title and truncates a long place line instead of overflowing", () => {
    renderWithProvider(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="An Extremely Long Event Title That Would Otherwise Run Straight Off The Edge Of The Art Window And Keep Going"
        venueLine="The Blue Room at Third Man Records · Nashville, TN"
        testId="stub"
      />,
    );

    const title = screen.getByText(/An Extremely Long Event Title/);
    // Three-line clamp on web (the artifact's `.t`), matching EventCard's
    // established `TWO_LINE_TITLE_CLAMP` pattern.
    expect(title).toHaveStyle({ overflow: "hidden" });
    expect(title.style.getPropertyValue("-webkit-line-clamp")).toBe("3");

    // The place line is one line, ellipsised — it is the smallest thing on the
    // card and must never push the title off.
    const venue = screen.getByText(
      "The Blue Room at Third Man Records · Nashville, TN",
    );
    expect(venue).toHaveStyle({
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
  });

  it("is hidden from assistive tech — it restates text the surface already prints", () => {
    renderWithProvider(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Comedy Night"
        venueLine="Nashville, TN"
        testId="stub"
      />,
    );

    const root = screen.getByTestId("stub");
    expect(root).toHaveAttribute("aria-hidden", "true");
    // Every glyph it draws sits UNDER that root, so a card cannot announce its
    // title, date and venue twice. (`toBeVisible` is the wrong check here — it
    // reports CSS visibility, not the accessibility tree.)
    for (const label of ["THU", "10", "SEP", "Comedy Night", "Nashville, TN"]) {
      const hidden = screen.getByText(label).closest('[aria-hidden="true"]');
      // (The date column carries its own `aria-hidden`, so the nearest hidden
      // ancestor is sometimes the column and sometimes the root — either way
      // the root is hiding everything.)
      expect(hidden === root || root.contains(hidden)).toBe(true);
    }
  });

  it("paints from theme TOKENS, so the artwork follows the viewer's theme", () => {
    // The whole reason this exists alongside the Open Graph PNG. Tamagui emits
    // token-NAMED atomic classes that resolve through CSS vars, and puts the
    // active theme on an ancestor — so "it flips" is provable as: the stub's
    // own classes name tokens (never literals), and the theme wrapper differs.
    const seen: string[] = [];

    for (const theme of ["stub", "ember", "swiss"] as const) {
      const { container, unmount } = renderWithProvider(
        <DateStub
          date={formatStubDateParts(THU_LATE_UTC, "UTC")}
          title="Comedy Night"
          venueLine="Nashville, TN"
          testId="stub"
        />,
        { providerProps: { theme } },
      );

      const root = screen.getByTestId("stub");
      const column = root.firstElementChild as HTMLElement;

      // The fill and its declared foreground travel as a UNIT — migrate one
      // without the other and they drift apart in some theme.
      expect(root.className).toContain("_bg-surface");
      expect(column.className).toContain("_bg-structure");
      expect(column.className).toContain("_brc-surface");
      // The perforation is the RIGHT edge only. `borderStyle: dashed` applies
      // to the whole box in React Native, and the three sides with no declared
      // width then fall to CSS's initial `border-width: medium` (3px) painted
      // in `currentColor`. MEASURED in a real browser: that framed the column
      // in white dashes on Ember. `borderWidth: 0` is what holds them shut.
      expect(column.className).toContain("_btw-0px");
      expect(column.className).toContain("_borderBottomWidth-0px");
      expect(column.className).toContain("_borderLeftWidth-0px");
      expect(column.className).toContain("_brw-2px");
      expect(screen.getByText("10").className).toContain("_col-onStructure");
      expect(screen.getByText("THU").className).toContain("_col-onStructure");
      expect(screen.getByText("SEP").className).toContain("_col-onStructure");
      // No raw hex / rgba anywhere in the emitted classes.
      expect(root.outerHTML).not.toMatch(/#[0-9a-f]{6}\b/i);
      expect(root.outerHTML).not.toMatch(/rgba?\(/i);

      const themed = container.querySelector(".is_Theme") as HTMLElement;
      seen.push(
        [...themed.classList].find((c) => c.startsWith("t_")) ?? "none",
      );
      unmount();
    }

    expect(seen).toEqual(["t_stub", "t_ember", "t_swiss"]);
  });

  it("carries a status note under the place line when one is supplied", () => {
    const { rerender } = renderWithProvider(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Comedy Night"
        venueLine="Nashville, TN"
        note="SOLD OUT"
        testId="stub"
      />,
    );
    const text = screen.getByTestId("stub").textContent ?? "";
    // Last, under the place line — it is the quietest thing on the artifact.
    expect(text.indexOf("SOLD OUT")).toBeGreaterThan(
      text.indexOf("Nashville, TN"),
    );

    rerender(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Comedy Night"
        venueLine="Nashville, TN"
        testId="stub"
      />,
    );
    expect(screen.getByTestId("stub").textContent).not.toContain("SOLD OUT");
  });

  it("keeps its body announceable, and its date column hidden, when it is the carrier", () => {
    // `decorative={false}` is for the surface that prints NOTHING else — the
    // poster card. The column stays hidden either way: "THU" / "10" / "SEP" as
    // three spoken fragments is worse than the place line saying the time.
    renderWithProvider(
      <DateStub
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Comedy Night"
        venueLine="6:30 PM · Nashville, TN"
        decorative={false}
        testId="stub"
      />,
    );

    const root = screen.getByTestId("stub");
    expect(root).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText("Comedy Night").closest("[aria-hidden]")).toBeNull();
    expect(
      screen.getByText("6:30 PM · Nashville, TN").closest("[aria-hidden]"),
    ).toBeNull();
    for (const fragment of ["THU", "10", "SEP"]) {
      expect(
        screen.getByText(fragment).closest('[aria-hidden="true"]'),
      ).not.toBeNull();
    }
  });

  it("tears down to the date column alone when the slot is too narrow to split", () => {
    renderWithProvider(
      <DateStub
        layout="column"
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        title="Comedy Night"
        venueLine="Nashville, TN"
        note="SOLD OUT"
        testId="stub"
      />,
    );

    const root = screen.getByTestId("stub");
    // The column fills the frame and the perforation goes — there is nothing
    // on the other side of it any more.
    expect(root.children).toHaveLength(1);
    expect((root.firstElementChild as HTMLElement).className).toContain(
      "is_DateStubColumn",
    );
    expect(root.textContent).toBe("THU10SEP");
    // The body's rows are GONE, not merely hidden: a 64px thumbnail rendering
    // a hyphenated title off-screen is worse than not rendering it.
    expect(screen.queryByText("Comedy Night")).not.toBeInTheDocument();
    expect(screen.queryByText("Nashville, TN")).not.toBeInTheDocument();
    expect(screen.queryByText("SOLD OUT")).not.toBeInTheDocument();
  });

  it("keeps a perforated edge at hero scale, and none in a thumbnail", () => {
    // The hero is the torn stub full-bleed, so the tear cannot be a border
    // between two panels — it is an INSET rule with a sliver of field beyond
    // it, which is what makes the frame read as "the rest was torn off here"
    // rather than as a dashed box.
    const { unmount } = renderWithProvider(
      <DateStub
        layout="column"
        size="xl"
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        testId="hero"
      />,
    );
    const tear = screen
      .getByTestId("hero")
      .querySelector(".is_DateStubTear") as HTMLElement | null;
    expect(tear).not.toBeNull();
    expect(tear?.className).toContain("_brw-2px");
    // Same zeroing as the column: a declared `borderStyle` otherwise promotes
    // the undeclared sides to CSS's initial `medium` (3px) in `currentColor`.
    expect(tear?.className).toContain("_btw-0px");
    unmount();

    // A 64-96px dense thumbnail gets none — a rule inset into that frame eats a
    // sixth of it to draw something nobody can resolve.
    renderWithProvider(
      <DateStub
        layout="column"
        size="md"
        date={formatStubDateParts(THU_LATE_UTC, "UTC")}
        testId="thumb"
      />,
    );
    expect(
      screen.getByTestId("thumb").querySelector(".is_DateStubTear"),
    ).toBeNull();
  });

  it("scales through the ramp without changing the composition", () => {
    for (const size of ["sm", "md", "lg", "heroCompact", "xl"] as const) {
      const { unmount } = renderWithProvider(
        <DateStub
          date={formatStubDateParts(THU_LATE_UTC, "UTC")}
          title="Comedy Night"
          venueLine="Nashville, TN"
          size={size}
          testId={`stub-${size}`}
        />,
      );
      const text = screen.getByTestId(`stub-${size}`).textContent ?? "";
      expect(text).toContain("THU");
      expect(text).toContain("SEP");
      expect(text).toContain("Comedy Night");
      unmount();
    }
  });
});
