import { forwardRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Minimal DOM stand-ins (pattern: components/__tests__/AdminTableParts.test.tsx).
vi.mock("@th/ui", () => ({
  Button: ({ children, onPress, tag: _tag, ...rest }: any) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k === "testID") safe["data-testid"] = v;
      else if (k === "disabled" || k.startsWith("aria-")) safe[k] = v;
    }
    return (
      <button onClick={onPress} {...safe}>
        {children}
      </button>
    );
  },
  Text: ({ children, ...rest }: any) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k === "id" || k === "role" || k.startsWith("aria-")) safe[k] = v;
    }
    return <span {...safe}>{children}</span>;
  },
  NextLinkAnchor: forwardRef<HTMLAnchorElement, any>(
    ({ href, children, style }, ref) => (
      <a ref={ref} href={href} style={style}>
        {children}
      </a>
    ),
  ),
}));

vi.mock("tamagui", () => {
  // React 19: `ref` arrives as a plain prop, so forwarding it (and
  // `tabIndex`) is what lets the notice's own focus fallback be observed.
  const passthrough = () => (props: any) => {
    const { children, testID, ref, ...rest } = props;
    const cleaned: Record<string, unknown> = {};
    if (testID) cleaned["data-testid"] = testID;
    for (const [k, v] of Object.entries(rest)) {
      if (k === "id" || k === "role" || k === "tabIndex" || k.startsWith("aria-"))
        cleaned[k] = v;
    }
    return (
      <div ref={ref} {...cleaned}>
        {children}
      </div>
    );
  };
  return { XStack: passthrough(), YStack: passthrough() };
});

import { CreateEventOutcomeNotice } from "../CreateEventOutcomeNotice";

describe("CreateEventOutcomeNotice", () => {
  it("announces the lines_unconfirmed caveat via role=status and links the event", () => {
    render(
      <CreateEventOutcomeNotice
        outcome={{
          eventId: "evt-1",
          alreadyLinked: false,
          finalized: false,
          finalizeBlocked: "lines_unconfirmed",
        }}
        eventHref="/admin/venue-co/events/evt-1"
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Event created — finalize when payouts are confirmed",
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/admin/venue-co/events/evt-1");
  });

  it("renders the payee_not_ready variant with its detail line", () => {
    render(
      <CreateEventOutcomeNotice
        outcome={{
          eventId: "evt-2",
          alreadyLinked: false,
          finalized: false,
          finalizeBlocked: "payee_not_ready",
        }}
        eventHref="/admin/@me/events/evt-2"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Event created — finalize when payees are ready",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "payee can receive payouts",
    );
  });

  it("renders the requester_owned variant without an Open-event link and focuses the notice", () => {
    render(
      <CreateEventOutcomeNotice
        outcome={{
          eventId: "evt-4",
          alreadyLinked: false,
          finalized: false,
          finalizeBlocked: "requester_owned",
        }}
        eventHref="/admin/venue-co/events/evt-4"
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Event created in the requester's admin");
    expect(status).toHaveTextContent("nothing to finalize on your side");
    // The venue cannot open the requester's admin — no dead link.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(status);
  });

  it("offers the conversation for a requester-owned draft when the caller can link it, and focuses that", () => {
    render(
      <CreateEventOutcomeNotice
        outcome={{
          eventId: "evt-5",
          alreadyLinked: false,
          finalized: false,
          finalizeBlocked: "requester_owned",
        }}
        eventHref="/admin/venue-co/events/evt-5"
        threadHref="/admin/venue-co/bookings?request=req-1"
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/admin/venue-co/bookings?request=req-1");
    expect(link).toHaveTextContent("Open the conversation");
    // Never the venue-slug event href for this variant.
    expect(document.querySelector('a[href*="/events/"]')).toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it("ignores threadHref on the venue-owned variants", () => {
    render(
      <CreateEventOutcomeNotice
        outcome={{
          eventId: "evt-6",
          alreadyLinked: false,
          finalized: false,
          finalizeBlocked: "payee_not_ready",
        }}
        eventHref="/admin/venue-co/events/evt-6"
        threadHref="/admin/venue-co/bookings?request=req-1"
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/admin/venue-co/events/evt-6");
  });

  it("moves focus to the Open-event link on mount", () => {
    render(
      <CreateEventOutcomeNotice
        outcome={{
          eventId: "evt-3",
          alreadyLinked: true,
          finalized: false,
          finalizeBlocked: "lines_unconfirmed",
        }}
        eventHref="/admin/venue-co/events/evt-3"
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("link"));
  });
});
