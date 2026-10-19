/**
 * The zone must never move silently — this pins that it is always stated, and
 * that the move itself is announced when it happens.
 *
 * MOCKS (enumerated deliberately; a catch-all Proxy that answers `then` turns
 * the module namespace into a thenable and hangs vitest):
 *   - `tamagui`: XStack / YStack / styled → plain divs that forward data-* and
 *     aria-* so the live region and test ids are assertable.
 *   - `@th/ui`: Text → <span>, useTranslations → a real ICU-ish interpolator
 *     over the REAL en catalog, so the assertions are on shipped copy rather
 *     than on a stub. If a key or an argument name drifts, this fails.
 * Nothing else is mocked.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import en from "@/i18n/messages/en";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex)$/;
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return React.createElement("div", domProps, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    useTranslations: () => (key: string, args?: Record<string, string>) => {
      const [ns, leaf] = key.split(".");
      const section = (en as Record<string, Record<string, string>>)[
        ns as string
      ];
      const template = section?.[leaf as string];
      if (typeof template !== "string") {
        throw new Error(`missing message: ${key}`);
      }
      return template.replace(
        /\{(\w+)\}/g,
        (_m, name: string) => args?.[name] ?? `{${name}}`,
      );
    },
  };
});

const { EventTimezoneNote } = await import("../EventTimezoneNote");

describe("EventTimezoneNote", () => {
  it("always states the zone the organizer is typing in", () => {
    render(<EventTimezoneNote timezone="America/Chicago" adoptedFrom={null} />);

    const note = screen.getByTestId("event-timezone-note");
    expect(note).toHaveTextContent("America/Chicago");
    // Nothing was adopted, so nothing is announced as a change.
    expect(
      screen.queryByTestId("event-timezone-note-adopted"),
    ).not.toBeInTheDocument();
  });

  it("is a polite live region so an adoption triggered by the venue field (further down the form) is announced", () => {
    render(<EventTimezoneNote timezone="America/Chicago" adoptedFrom={null} />);

    const note = screen.getByTestId("event-timezone-note");
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveAttribute("aria-live", "polite");
  });

  it("names the venue and spells out the wall-clock interpretation when the zone adopts", () => {
    render(
      <EventTimezoneNote
        timezone="America/New_York"
        adoptedFrom={{ kind: "venue", name: "Bowery Ballroom" }}
      />,
    );

    const adopted = screen.getByTestId("event-timezone-note-adopted");
    expect(adopted).toHaveTextContent("America/New_York");
    expect(adopted).toHaveTextContent("Bowery Ballroom");
    // The decision, stated to the organizer: the reading is kept.
    expect(adopted).toHaveTextContent("8:00 PM means 8:00 PM at the place");

    // The standing line switches to the venue phrasing rather than repeating.
    expect(screen.getByTestId("event-timezone-note")).toHaveTextContent(
      "the place’s local time",
    );
  });

  it("names no venue — but still spells out the interpretation — when the zone adopts from a freeform address", () => {
    render(
      <EventTimezoneNote
        timezone="America/New_York"
        adoptedFrom={{ kind: "address" }}
      />,
    );

    const adopted = screen.getByTestId("event-timezone-note-adopted");
    expect(adopted).toHaveTextContent("America/New_York");
    expect(adopted).toHaveTextContent("the local time at this address");
    // Same decision, stated the same way — only the noun changes.
    expect(adopted).toHaveTextContent("8:00 PM means 8:00 PM at the address");
    // A freeform address has no name, so the copy must not leave a hole where
    // {venue} would have gone.
    expect(adopted).not.toHaveTextContent("{venue}");

    expect(screen.getByTestId("event-timezone-note")).toHaveTextContent(
      "the local time at this address",
    );
  });

  it("honours a caller-supplied test id (quick create renders the same note)", () => {
    render(
      <EventTimezoneNote
        timezone="America/New_York"
        adoptedFrom={{ kind: "venue", name: "Bowery Ballroom" }}
        testId="quick-create-timezone-note"
      />,
    );

    expect(
      screen.getByTestId("quick-create-timezone-note-adopted"),
    ).toBeInTheDocument();
  });
});
