import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Render pins for the booking stage rail.
 *
 * The DECISION table lives in `booking-stage-rail.test.ts` — this file only
 * asserts what reaches the DOM: which bar carries which state, that the arc is
 * captioned exactly once, and that every visual part is hidden from assistive
 * tech so the caption cannot be double-announced or contradicted.
 *
 * These tests mock the design system away, so they can see NONE of: legibility,
 * bar contrast, overflow at 320px, or how the rail sits among its neighbours in
 * a table cell. Those were checked in a browser; green here is not evidence for
 * them.
 */

type AnyProps = { children?: ReactNode; [key: string]: unknown };

// The stack/text mocks below pass `data-testid` / `data-state` / `aria-hidden`
// / `title` straight through: a props-dropping mock would make every
// `data-state` and aria-hidden check here a false negative. They are DUPLICATED
// per factory on purpose — `vi.mock` is hoisted above every top-level binding,
// so a shared helper is a TDZ error at mock time, not a lint nit.
vi.mock("tamagui", () => {
  const Stack = ({ children, ...rest }: AnyProps) => (
    <div
      data-testid={rest["data-testid"] as string | undefined}
      data-state={rest["data-state"] as string | undefined}
      aria-hidden={rest["aria-hidden"] as boolean | undefined}
      title={rest.title as string | undefined}
      role={rest.role as string | undefined}
    >
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Text: ({ children, ...rest }: AnyProps) => (
    <span
      data-testid={rest["data-testid"] as string | undefined}
      aria-hidden={rest["aria-hidden"] as boolean | undefined}
    >
      {children}
    </span>
  ),
  useFormatters: () => ({
    dateTime: (d: Date) =>
      `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`,
    locale: "en",
  }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && Object.keys(values).length > 0
      ? `${key}(${Object.values(values).join("|")})`
      : key,
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span data-testid="alert-triangle" />,
}));

import {
  BookingStageRail,
  type BookingStageRailProps,
} from "../BookingStageRail";

const BASE: BookingStageRailProps = {
  status: "PENDING",
  agreementStatus: null,
  eventId: null,
  eventStatus: null,
  eventStartsAt: null,
  preferredDates: [],
  testIdBase: "row",
};

function renderRail(overrides: Partial<BookingStageRailProps> = {}) {
  return render(<BookingStageRail {...BASE} {...overrides} />);
}

const barState = (key: "request" | "agreement" | "event") =>
  screen.getByTestId(`row-stage-rail-bar-${key}`).getAttribute("data-state");

const barStates = () =>
  (["request", "agreement", "event"] as const).map(barState);

describe("BookingStageRail", () => {
  describe("compact (the list row)", () => {
    it("draws three bars and leads with the stage the booking is at", () => {
      renderRail({ status: "PENDING" });
      expect(barStates()).toEqual(["current", "upcoming", "upcoming"]);
      expect(screen.getByText("admin.bkStageRequest")).toBeTruthy();
      expect(screen.getByText("admin.bkStatusPending")).toBeTruthy();
    });

    it("leads with the agreement once one is out for review", () => {
      renderRail({ status: "ACCEPTED", agreementStatus: "PROPOSED" });
      expect(barStates()).toEqual(["done", "current", "upcoming"]);
      expect(screen.getByText("admin.bkStageAgreement")).toBeTruthy();
      expect(screen.getByText("admin.bkStageAgrProposed")).toBeTruthy();
      // The compact form shows ONE leg — the other two would be a wall in a
      // list of twenty.
      expect(screen.queryByText("admin.bkStageRequest")).toBeNull();
    });

    it("leads with the event, and prints the booked date on the row", () => {
      renderRail({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
        preferredDates: ["2026-09-19"],
      });
      expect(barStates()).toEqual(["done", "done", "current"]);
      expect(screen.getByText("admin.eventStatusDraft")).toBeTruthy();
      expect(screen.getByText("2026-09-19")).toBeTruthy();
    });

    it("separates a published event from a draft one", () => {
      renderRail({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "PUBLISHED",
        eventStartsAt: new Date(2026, 8, 19),
      });
      expect(screen.getByText("admin.eventStatusPublished")).toBeTruthy();
    });

    it.each(["DECLINED", "WITHDRAWN"] as const)(
      "renders %s as a whole-rail terminal state",
      (status) => {
        renderRail({ status });
        expect(barStates()).toEqual(["stopped", "upcoming", "upcoming"]);
      },
    );

    it("marks a booked date the act never asked for, with a hover title", () => {
      renderRail({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
        preferredDates: ["2026-09-18", "2026-09-25"],
      });
      const marker = screen.getByTestId("row-stage-rail-off-pitch");
      expect(marker.getAttribute("title")).toBe("admin.bkStageDateOffPitch");
    });

    it("stays quiet when the booked date is one of the asks", () => {
      renderRail({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 25),
        preferredDates: ["2026-09-18", "2026-09-25"],
      });
      expect(screen.queryByTestId("row-stage-rail-off-pitch")).toBeNull();
    });
  });

  describe("full (the expanded detail)", () => {
    it("shows all three legs at once", () => {
      renderRail({
        variant: "full",
        status: "ACCEPTED",
        agreementStatus: "DRAFT",
      });
      expect(barStates()).toEqual(["done", "current", "upcoming"]);
      expect(screen.getByText("admin.bkStageRequest")).toBeTruthy();
      expect(screen.getByText("admin.bkStageAgreement")).toBeTruthy();
      expect(screen.getByText("admin.bkStageEvent")).toBeTruthy();
      expect(screen.getByText("admin.bkStatusAccepted")).toBeTruthy();
      expect(screen.getByText("admin.bkStageAgrDraft")).toBeTruthy();
      expect(screen.getByText("admin.bkStageNotYet")).toBeTruthy();
    });

    it("says 'never reached' rather than 'not yet' on a dead booking", () => {
      renderRail({ variant: "full", status: "DECLINED" });
      expect(screen.getAllByText("admin.bkStageNotReached")).toHaveLength(2);
      expect(screen.queryByText("admin.bkStageNotYet")).toBeNull();
    });

    it("spells out the off-pitch booked date instead of only marking it", () => {
      renderRail({
        variant: "full",
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: new Date(2026, 8, 19),
        preferredDates: ["2026-09-18"],
      });
      expect(screen.getByTestId("row-stage-rail-off-pitch")).toBeTruthy();
      expect(screen.getByText("admin.bkStageDateOffPitch")).toBeTruthy();
    });
  });

  describe("accessibility", () => {
    it.each(["compact", "full"] as const)(
      "captions the %s rail once, and hides every visual part behind it",
      (variant) => {
        const { container } = renderRail({
          variant,
          status: "ACCEPTED",
          agreementStatus: "ACCEPTED",
          eventId: "e1",
          eventStatus: "DRAFT",
          eventStartsAt: new Date(2026, 8, 19),
          preferredDates: ["2026-09-18"],
        });

        const summary = screen.getByTestId("row-stage-rail-summary");
        expect(summary.textContent).toBe(
          "admin.bkStageSummary(admin.bkStatusAccepted|admin.bkStageAgrAccepted|" +
            "admin.bkStageEventWithDate(admin.eventStatusDraft|2026-09-19)) " +
            "admin.bkStageDateOffPitch",
        );

        // Everything that is not the caption sits under an aria-hidden
        // ancestor, so the rail announces its state exactly once. Without
        // this the row reads the bars' empty divs and then repeats the same
        // three state words a second time.
        const rail = screen.getByTestId("row-stage-rail");
        for (const node of Array.from(rail.children)) {
          if (node === summary) continue;
          expect(node.getAttribute("aria-hidden")).toBe("true");
        }
        expect(
          container.querySelectorAll("[data-testid$='-summary']"),
        ).toHaveLength(1);
      },
    );

    it("takes no progressbar or tablist role — a rail is a picture, not a control", () => {
      const { container } = renderRail({ variant: "full" });
      expect(container.querySelector("[role='progressbar']")).toBeNull();
      expect(container.querySelector("[role='tablist']")).toBeNull();
      expect(container.querySelector("[role='tab']")).toBeNull();
    });

    it("announces the terminal state in words, not only by dimming the bars", () => {
      renderRail({ status: "WITHDRAWN" });
      expect(screen.getByTestId("row-stage-rail-summary").textContent).toBe(
        "admin.bkStageSummary(admin.bkStatusWithdrawn|admin.bkStageNotReached|" +
          "admin.bkStageNotReached)",
      );
    });
  });

  describe("degraded data", () => {
    it("renders an all-null projection without crashing", () => {
      renderRail({
        status: "ACCEPTED",
        agreementStatus: null,
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
      expect(barStates()).toEqual(["current", "upcoming", "upcoming"]);
    });

    it("renders an agreement status this build has never heard of", () => {
      renderRail({
        status: "ACCEPTED",
        // Deliberately outside the union — a rollback behind a newer writer
        // must not blank an inbox.
        agreementStatus:
          "TIME_TRAVELLED" as BookingStageRailProps["agreementStatus"],
      });
      expect(screen.getByText("admin.bkStageUnknownState")).toBeTruthy();
      expect(barStates()).toEqual(["done", "current", "upcoming"]);
    });

    it("drops an unparseable event start rather than printing 'Invalid Date'", () => {
      renderRail({
        status: "ACCEPTED",
        agreementStatus: "ACCEPTED",
        eventId: "e1",
        eventStatus: "DRAFT",
        eventStartsAt: "not-a-date",
        preferredDates: ["2026-09-18"],
      });
      expect(screen.queryByText(/Invalid Date/)).toBeNull();
      expect(screen.queryByTestId("row-stage-rail-off-pitch")).toBeNull();
    });
  });
});
