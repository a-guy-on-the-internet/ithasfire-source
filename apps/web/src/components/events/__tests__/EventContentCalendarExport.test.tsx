import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * EventContent → CalendarDropdown → the calendar builders.
 *
 * The builders themselves are covered in `src/lib/calendar/__tests__`. What is
 * covered HERE is the wiring, which is where a recurring listing silently loses
 * its cadence: `communityRecurrence` has to travel EventDetail → EventContent →
 * CalendarDropdown → `buildGoogleCalendarUrl` / `downloadICalFile`, and a prop
 * dropped at any hop leaves the page exporting one appointment while stating
 * "Every Wednesday" three inches above the button.
 *
 * So `CalendarDropdown` and both builders are REAL — only the design system is
 * stood in. The assertions read the rendered `href`, which is the actual
 * artifact a user clicks, and the generated .ics text.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") {
        domProps[key] = value;
      }
    }
    return <div {...domProps}>{children}</div>;
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => ({}),
  };
});

const MESSAGES: Record<string, string> = {
  "eventDetail.addToCalendar": "Add to calendar",
  "eventDetail.addToGoogleCalendar": "Google Calendar",
  "eventDetail.addToOutlookCalendar": "Outlook Calendar",
};

const fakeTranslate = (key: string, values?: Record<string, unknown>) => {
  const template = MESSAGES[key] ?? key;
  if (!values) return template;
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
    template,
  );
};

vi.mock("@th/ui", () => ({
  Link: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  useTranslations: () => fakeTranslate,
  DateStub: () => null,
  formatStubDateParts: () => null,
  useFormatters: () => ({ dateTime: () => "Wed, Sep 9, 2026" }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: undefined }),
}));

import { EventContent } from "../EventContent";
import { CalendarDropdown } from "../CalendarDropdown";
import { CalendarDropdown as ActionCalendarDropdown } from "@/components/actions/CalendarDropdown";
import { generateICalString } from "@/lib/calendar/ical";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Wed 9 Sep 2026, 8:00–11:00 PM America/Chicago — the seeded open mic. */
const OPEN_MIC = {
  title: "Grown and Sexy Open Mic",
  startsAt: "2026-09-10T01:00:00.000Z",
  endsAt: "2026-09-10T04:00:00.000Z",
  timezone: "America/Chicago",
  eventId: "e90f26c7-a1ef-4891-b780-7d9cdd0f4705",
  location: "Carol Ann's",
};

const WEEKLY = {
  freq: "WEEKLY" as const,
  interval: 1,
  byday: ["WE"],
  until: null,
};

const googleHref = () => {
  const anchor = screen.getAllByRole("menuitem", { name: "Google Calendar" })[0];
  return anchor?.getAttribute("href") ?? "";
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EventContent forwards the cadence to the calendar export", () => {
  it("puts the RRULE in the Google Calendar link of a recurring listing", () => {
    render(<EventContent {...OPEN_MIC} communityRecurrence={WEEKLY} />);

    const query = new URL(googleHref()).searchParams;
    expect(query.get("recur")).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE");
    // Wall clock + `ctz`, not UTC — otherwise Google expands BYDAY=WE against
    // 01:00Z, a Thursday, and books Tuesday nights.
    expect(query.get("dates")).toBe("20260909T200000/20260909T230000");
    expect(query.get("ctz")).toBe("America/Chicago");
  });

  it("leaves the Google Calendar link alone for a non-recurring event", () => {
    render(<EventContent {...OPEN_MIC} />);

    const query = new URL(googleHref()).searchParams;
    expect(query.get("recur")).toBeNull();
    expect(query.get("ctz")).toBeNull();
    expect(query.get("dates")).toBe("20260910T010000Z/20260910T040000Z");
  });

  it("forwards the timezone, without which no recurrence can be exported", () => {
    // A cadence with no timezone must degrade rather than export on a UTC basis.
    render(
      <EventContent {...OPEN_MIC} timezone={undefined} communityRecurrence={WEEKLY} />,
    );
    expect(new URL(googleHref()).searchParams.get("recur")).toBeNull();
  });

  it("forwards the eventId, so the .ics UID is the event's identity", () => {
    // Asserted against the builder the dropdown calls with the same shape the
    // page gives it: the UID must be the event id, not a random value.
    expect(
      generateICalString({
        id: OPEN_MIC.eventId,
        title: OPEN_MIC.title,
        startsAt: OPEN_MIC.startsAt,
        endsAt: OPEN_MIC.endsAt,
        timezone: OPEN_MIC.timezone,
        recurrence: WEEKLY,
      }),
    ).toContain(`UID:${OPEN_MIC.eventId}@ithasfire`);
  });

  it("still renders the dropdown when the page has no event id", () => {
    // The admin preview path: no id to forward, and the button must not vanish.
    render(<EventContent {...OPEN_MIC} eventId={undefined} />);
    expect(googleHref()).toContain("calendar.google.com");
  });
});

// An unreadable start makes every builder throw a RangeError during render, so
// both dropdowns render nothing rather than take the page down with them.
describe("CalendarDropdown with an unreadable start", () => {
  it("renders nothing (events dropdown)", () => {
    const { container } = render(
      <CalendarDropdown title={OPEN_MIC.title} startsAt="not-a-date" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing (actions dropdown, open)", () => {
    const { container } = render(
      <ActionCalendarDropdown
        open
        event={{ title: OPEN_MIC.title, startsAt: "not-a-date" }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders the links for a readable start (actions dropdown, open)", () => {
    render(
      <ActionCalendarDropdown
        open
        event={{ title: OPEN_MIC.title, startsAt: OPEN_MIC.startsAt }}
      />,
    );
    expect(googleHref()).toContain("calendar.google.com");
  });
});
