/**
 * The builder's "your request wasn't sent" notice.
 *
 * What this pins:
 *   1. Every variant renders the SHIPPED en copy, with the venue named first
 *      where the venue is the subject — a renamed key or argument fails here.
 *   2. The sender-side variant links to the right performer settings for the
 *      owner the event is saved under, and withholds an org link it cannot
 *      build rather than pointing at `/admin/undefined/…`.
 *   3. The live region is the statement only; the link sits outside it.
 *   4. The drive hooks (`data-testid`, `data-code`) are on the root.
 *
 * MOCKS: tamagui / @th/ui reduced to DOM elements forwarding data-, aria-
 * and role attributes; `useTranslations` interpolates the REAL en catalog.
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
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("lucide-react", async () => {
  const React = await import("react");
  return {
    ArrowRight: () => React.createElement("svg", { "data-icon": "arrow-right" }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) =>
      React.createElement("span", { "data-testid": rest["data-testid"] }, children),
    NextLinkAnchor: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children?: ReactNode;
      [k: string]: unknown;
    }) => React.createElement("a", { href, "data-testid": rest["data-testid"] }, children),
    useTranslations:
      () => (key: string, args?: Record<string, string | number>) => {
        const [ns, leaf] = key.split(".");
        const section = (en as Record<string, Record<string, string>>)[ns as string];
        const template = section?.[leaf as string];
        if (typeof template !== "string") throw new Error(`missing message: ${key}`);
        return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
          String(args?.[name] ?? `{${name}}`),
        );
      },
  };
});

const { EventFirstSkipNotice } = await import("../EventFirstSkipNotice");
type Skip = Parameters<typeof EventFirstSkipNotice>[0]["skip"];

const PLACE = "00000000-0000-4000-8000-0000000000c1";

const skipped = (overrides: Partial<Skip> = {}): Skip => ({
  outcome: "skipped",
  reason: "venue_not_accepting",
  code: "PLACE_NOT_ACCEPTING_REQUESTS",
  message: "booking_requests_unconfigured",
  placeId: PLACE,
  placeName: "Stubb's BBQ",
  intent: "PERFORM",
  ...overrides,
});

const headline = () => screen.getByTestId("event-first-skip-notice-headline");
const note = () => screen.getByTestId("event-first-skip-notice-note");

describe("EventFirstSkipNotice", () => {
  it("no hours: names the venue, says the request wasn't sent and the event is saved", () => {
    render(<EventFirstSkipNotice skip={skipped()} ownerType="human" />);

    const root = screen.getByTestId("event-first-skip-notice");
    expect(root).toHaveAttribute("data-code", "PLACE_NOT_ACCEPTING_REQUESTS");
    expect(root).toHaveAttribute("data-variant", "noHours");
    expect(headline()).toHaveTextContent(
      "Stubb's BBQ hasn’t set its opening hours yet, so your request wasn’t sent.",
    );
    expect(note()).toHaveTextContent(
      "Your event is saved. Ask them directly, or try again once they’ve set hours.",
    );
    expect(screen.queryByTestId("event-first-skip-notice-performer-link")).toBeNull();
  });

  it("closed date: names the venue and points at the date", () => {
    render(
      <EventFirstSkipNotice
        skip={skipped({ code: "BOOKING_DATE_UNAVAILABLE", message: "BOOKING_DATE_UNAVAILABLE" })}
        ownerType="human"
      />,
    );

    expect(screen.getByTestId("event-first-skip-notice")).toHaveAttribute(
      "data-code",
      "BOOKING_DATE_UNAVAILABLE",
    );
    expect(headline()).toHaveTextContent(
      "Stubb's BBQ isn’t open on that date, so your request wasn’t sent.",
    );
    expect(note()).toHaveTextContent(
      "Your event is saved. Pick another date or ask them directly.",
    );
  });

  it.each([
    ["paused (bare code)", { code: "PLACE_NOT_ACCEPTING_REQUESTS", message: "PLACE_NOT_ACCEPTING_REQUESTS" }],
    ["unverified", { code: "PLACE_NOT_VERIFIED", message: "PLACE_NOT_VERIFIED" }],
    ["calendar rejects intent", { code: "INVALID_INPUT", message: "calendar_rejects_intent" }],
  ])("%s: says the venue isn't taking requests right now", (_label, wire) => {
    render(<EventFirstSkipNotice skip={skipped(wire)} ownerType="human" />);

    expect(screen.getByTestId("event-first-skip-notice")).toHaveAttribute("data-code", wire.code);
    expect(headline()).toHaveTextContent(
      "Stubb's BBQ isn’t taking requests right now, so your request wasn’t sent.",
    );
    expect(note()).toHaveTextContent("Your event is saved.");
  });

  it("no performer mode: tells the sender to turn it on and links a human to account settings", () => {
    render(
      <EventFirstSkipNotice
        skip={skipped({
          reason: "sender_not_eligible",
          code: "PERFORMER_MODE_REQUIRED",
          message: "PERFORMER_MODE_REQUIRED",
        })}
        ownerType="human"
      />,
    );

    expect(headline()).toHaveTextContent(
      "Turn on performer mode to ask places from the builder.",
    );
    expect(note()).toHaveTextContent("Your event is saved.");
    const link = screen.getByTestId("event-first-skip-notice-performer-link");
    expect(link).toHaveAttribute("href", "/account/settings/performer");
    expect(link).toHaveTextContent("Performer settings");
    // Live region = statement only; the link is a sibling outside it.
    const status = screen.getByTestId("event-first-skip-notice-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toContainElement(headline());
    expect(status).toContainElement(note());
    expect(status).not.toContainElement(link);
  });

  it("no performer mode under an ORG links to that org's settings, and withholds the link without a slug", () => {
    const skip = skipped({
      reason: "sender_not_eligible",
      code: "PERFORMER_MODE_REQUIRED",
      message: "PERFORMER_MODE_REQUIRED",
    });
    const { unmount } = render(
      <EventFirstSkipNotice skip={skip} ownerType="org" slug="acme" />,
    );
    expect(screen.getByTestId("event-first-skip-notice-performer-link")).toHaveAttribute(
      "href",
      "/admin/acme/settings/performer",
    );
    unmount();

    render(<EventFirstSkipNotice skip={skip} ownerType="org" />);
    expect(screen.queryByTestId("event-first-skip-notice-performer-link")).toBeNull();
    // The statement still renders — only the link is withheld.
    expect(headline()).toHaveTextContent("Turn on performer mode");
  });

  it("falls back to 'This place' when the wire carries no name, keeping the sentence", () => {
    render(<EventFirstSkipNotice skip={skipped({ placeName: null })} ownerType="human" />);

    expect(headline()).toHaveTextContent(
      "This place hasn’t set its opening hours yet, so your request wasn’t sent.",
    );
  });
});
