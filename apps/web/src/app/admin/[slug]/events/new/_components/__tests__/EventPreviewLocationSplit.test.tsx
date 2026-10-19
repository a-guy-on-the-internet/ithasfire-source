/**
 * `EventPreview`'s LOCATION wiring — the community head / fact-rail split.
 *
 * The community page head prints WHERE as a short recognition line and the fact
 * rail prints the full street address. This preview fed both from a single
 * `location` string, and quick-create geocodes one string into `addressText`
 * AND the location label — so a quick-created listing printed byte-identical
 * text in both places, which is the exact duplication the community head was
 * built to remove. MEASURED in `?view=preview` on a draft listing.
 *
 * The TICKETED layout reads the same three props (`location` / `address` /
 * `venueName`), so the new derivation is scoped to `communityLayout`. That
 * scoping was verified byte-for-byte: a verbatim copy of the pre-change
 * component was rendered beside this one against the ticketed fixture below and
 * their `container.innerHTML` compared (and the gate proved real by planting a
 * break — removing the `communityLayout` guard — and watching it fail). The
 * copy is temporary scaffolding and is gone; what survives is the ticketed
 * assertion it protected.
 *
 * `EventContent` is stubbed to a node that SERIALISES every prop it is given,
 * so these assertions read the data contract rather than the styling layer.
 */
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS = /^(data-|aria-)|^(id|role|style|title|tabIndex|type|href)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => makeStack("div"),
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children }: { children?: ReactNode }) =>
      React.createElement("span", null, children),
    Spinner: () => null,
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/trpc", () => {
  const query = () => ({ data: undefined, isSuccess: false, isError: false });
  return {
    trpc: {
      events: {
        listTicketTypesForEdit: { useQuery: query },
        getEventFeePreview: { useQuery: query },
      },
      eventHumans: { list: { useQuery: query } },
      tags: { getEventTags: { useQuery: query } },
      platform: { getFooterDefaults: { useQuery: query } },
    },
  };
});

vi.mock("../prose-editor", () => ({
  proseMirrorDocToHtml: () => "<p>body</p>",
}));

// Serialise every prop so the innerHTML diff sees the data contract, not just
// the chrome around it.
vi.mock("@/components/events/EventContent", async () => {
  const React = await import("react");
  return {
    EventContent: (props: Record<string, unknown>) =>
      React.createElement(
        "div",
        { "data-testid": "event-content-props" },
        JSON.stringify(
          Object.fromEntries(
            Object.entries(props)
              .filter(([, v]) => typeof v !== "function")
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      ),
  };
});

import { EventPreview } from "../EventPreview";

const TICKETED = {
  title: "Ticketed Show",
  startsAt: "2026-11-04T20:00:00.000Z",
  endsAt: "2026-11-04T22:30:00.000Z",
  // What EventBuilder passes today: `thPlaceName ?? addressText`.
  location: "The Blue Room",
  bodyContent: { type: "doc", content: [] } as never,
  eventId: "evt-1",
  currency: "USD",
  addressText: "1604 8th Ave S, Nashville, TN 37203",
  timezone: "America/Chicago",
  organizerName: "Ithas Fire Demo Org",
  communityLayout: false,
} as const;

const NEW_ONLY = {
  venueName: "The Blue Room",
  locality: "Nashville",
  region: "TN",
  postalCode: "37203",
  countryCode: "US",
} as const;

describe("EventPreview — head vs fact rail", () => {
  it("routes the free-form location string through on a ticketed event", () => {
    const { getByTestId } = render(<EventPreview {...TICKETED} {...NEW_ONLY} />);
    const props = JSON.parse(getByTestId("event-content-props").textContent!);
    expect(props.location).toBe("The Blue Room");
    expect(props.address).toBeUndefined();
    expect(props.venueName).toBeUndefined();
  });

  it("splits head (short) from fact rail (full) on a community listing", () => {
    const { getByTestId } = render(
      <EventPreview
        {...TICKETED}
        {...NEW_ONLY}
        communityLayout
        // The real quick-create shape: the geocode lands WHOLE in addressText.
        location="Springwater, 115 27th Avenue North, Nashville, TN 37203"
        addressText="Springwater, 115 27th Avenue North, Nashville, TN 37203"
        venueName={undefined}
      />,
    );
    const props = JSON.parse(getByTestId("event-content-props").textContent!);
    expect(props.location).toBe("Nashville, TN");
    expect(props.address).toBe(
      "Springwater, 115 27th Avenue North, Nashville, TN 37203, US",
    );
    // …and the head is the SHORT recognition line, not the rail's string.
    expect(props.location).not.toBe(props.address);
  });
});
