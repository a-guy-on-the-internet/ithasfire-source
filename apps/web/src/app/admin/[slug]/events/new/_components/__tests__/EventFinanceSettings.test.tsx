import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { EventFinanceSettings } from "../EventFinanceSettings";

// Plain-DOM stand-ins for the design system. `t` renders the key plus its
// `date` argument so the computed date is visible; `fmt.dateTime` is real
// Intl, so the time-zone handling under test is the real one.
vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    styled: () => Stack,
    useTheme: () => ({}),
    XStack: Stack,
    YStack: Stack,
  };
});
vi.mock("lucide-react", () => ({ Banknote: () => null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "demo" }) }));
vi.mock("@th/ui", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useTranslations:
    () => (key: string, params?: { date?: string; label?: string }) =>
      params?.date
        ? `${key} ${params.date}`
        : params?.label
          ? `${key} ${params.label}`
          : key,
  useFormatters: () => ({
    dateTime: (d: Date, o?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", o).format(d),
  }),
}));

describe("EventFinanceSettings expected payout", () => {
  it("ASAP is labelled 'day after' and dated from the event END, read in the event's zone", () => {
    // Saturday 8pm–11pm in Los Angeles ends Sunday 1am Central, so core's
    // ASAP (day after the end, Central) is Monday. Reading the end from the
    // start, or in the browser's zone, would land on Sunday.
    render(
      <EventFinanceSettings
        eventId="e1"
        payoutSchedule="ASAP"
        eventStartsAt="2026-10-10T20:00"
        eventEndsAt="2026-10-10T23:00"
        eventTimezone="America/Los_Angeles"
      />,
    );
    expect(
      screen.getByText("admin.ebPayoutValue admin.ebPayoutSchedAsapNextDay"),
    ).toBeTruthy();
    expect(
      screen.getByText("admin.ebPayoutExpected Mon, Oct 12, 2026"),
    ).toBeTruthy();
  });

  it("WEEK_OF_EVENT on a Saturday rolls to the following Sunday", () => {
    render(
      <EventFinanceSettings
        eventId="e1"
        payoutSchedule="WEEK_OF_EVENT"
        eventStartsAt="2026-10-10T19:00"
        eventEndsAt="2026-10-10T21:00"
        eventTimezone="America/Chicago"
      />,
    );
    expect(
      screen.getByText("admin.ebPayoutExpected Sun, Oct 18, 2026"),
    ).toBeTruthy();
  });

  it("no date yet: the 'set a date' line, not a guess", () => {
    render(
      <EventFinanceSettings
        eventId="e1"
        payoutSchedule="ONE_WEEK_AFTER"
        eventTimezone="America/Chicago"
      />,
    );
    expect(screen.getByText("admin.ebPayoutSetDate")).toBeTruthy();
  });
});
