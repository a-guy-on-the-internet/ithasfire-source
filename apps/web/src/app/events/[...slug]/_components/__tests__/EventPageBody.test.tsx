/**
 * `/events/[...slug]` is served `public, s-maxage=120, stale-while-revalidate=300`
 * with a `Vary` that contains no `Cookie`, so its HTML and RSC payload are
 * shared across every viewer behind a colo — and indexed. `EventPageBody` is
 * the seam where the two halves meet: the server hands it a payload resolved
 * for NOBODY, and it re-asks the viewer questions after first paint against
 * `POST /api/events/[eventId]/viewer-state`.
 *
 * These tests pin the properties that matter:
 *   - the FIRST render (the one that gets cached) carries the obscured
 *     location, no edit affordance and no RSVP seed;
 *   - a reveal is applied only on an explicit `location` from the endpoint,
 *     and every other outcome — empty state, HTTP error, network failure —
 *     leaves the redacted page standing;
 *   - JSON-LD is fed the PUBLIC event even after a reveal, because structured
 *     data rides the shared document.
 */
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

import type { EventPageData } from "@/server/event-page-data";
import type { EventViewerState } from "@/server/event-viewer-state";

const traceIgnoredError = vi.fn((_label: string) => vi.fn());
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => traceIgnoredError(label),
}));

// The session the hook keys its probe on. Mutated per test and re-read on
// every render; `rerender` after a change simulates a sign-out / sign-in.
let session: { isPending: boolean; data: { user: { id: string } } | null } = {
  isPending: false,
  data: null,
};
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => session },
}));

let capturedDetailProps: Record<string, any> = {};
let capturedJsonLdEvent: any = null;
let capturedJsonLdEnrichment: any = null;

vi.mock("../EventDetail", async () => {
  const React = await import("react");
  return {
    EventDetail: (props: Record<string, unknown>) => {
      capturedDetailProps = props;
      return React.createElement("div", { "data-testid": "event-detail" });
    },
  };
});

vi.mock("../EventJsonLd", async () => {
  const React = await import("react");
  return {
    EventJsonLd: ({
      event,
      enrichment,
    }: {
      event: unknown;
      enrichment?: unknown;
    }) => {
      capturedJsonLdEvent = event;
      capturedJsonLdEnrichment = enrichment;
      return React.createElement("script", { "data-testid": "jsonld" });
    },
  };
});

vi.mock("@/components/seo/EventBreadcrumbJsonLd", async () => {
  const React = await import("react");
  return { EventBreadcrumbJsonLd: () => React.createElement("script") };
});

vi.mock("../HeroBackdrop", async () => {
  const React = await import("react");
  return { HeroBackdrop: () => React.createElement("div") };
});

vi.mock("../VolunteerSection", async () => {
  const React = await import("react");
  return { VolunteerSection: () => React.createElement("div") };
});

vi.mock("../ResaleListingsSection", async () => {
  const React = await import("react");
  return {
    ResaleListingsSection: () =>
      React.createElement("div", { "data-testid": "resale" }),
  };
});

import { EventPageBody } from "../EventPageBody";

const OBSCURED_LOCATION = {
  latitude: 36.164,
  longitude: -86.789,
  isExact: false,
  radiusMeters: 800,
  areaLabel: "Nashville, TN",
};

const REVEALED_LOCATION = {
  addressLine1: "411 Hidden Barn Rd",
  city: "Nashville",
  region: "TN",
  postalCode: "37209",
  countryCode: "US",
  latitude: 36.1601234,
  longitude: -86.7891234,
  isExact: true,
};

const EMPTY_VIEWER_STATE: EventViewerState = {
  editHref: null,
  viewerHasTicket: false,
  location: null,
  viewerRsvped: null,
  dateRsvps: {},
  viewerArrivalAreas: null,
};

function pageData(overrides: Partial<EventPageData> = {}): EventPageData {
  return {
    eventId: "11111111-1111-4111-8111-111111111111",
    slug: "great-show",
    event: {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "great-show",
      url: "https://tickets.local/events/great-show",
      name: "Great Show",
      startsAt: new Date("2025-04-01T19:00:00.000Z"),
      status: "PUBLISHED",
      images: [],
      performers: [],
      location: OBSCURED_LOCATION,
      attendanceMode: "TICKETED",
      stewardship: "OWNED",
      visibility: "PUBLIC",
      organizerName: null,
      organizerHref: null,
      refundCutoffAt: null,
      venueConfirmed: false,
    },
    bodyContent: null,
    imageMap: {},
    audioItems: [],
    ticketTypes: [],
    eventHumans: [],
    tags: [],
    feeRates: null,
    seriesDates: [],
    communityDates: [],
    communityRecurrence: null,
    communityDatesTruncated: false,
    communityNextScheduledDateId: null,
    communityHasRecurrenceRule: false,
    hideTicketCta: false,
    sellabilityReason: "ok",
    waitlistOpen: false,
    waitlistDescription: null,
    suggestEditHref: null,
    resaleEnabled: false,
    arrivalAreas: [],
    jsonLdEnrichment: { organizer: null, fallbackImageUrl: null },
    ...overrides,
  } as EventPageData;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capturedDetailProps = {};
  capturedJsonLdEvent = null;
  capturedJsonLdEnrichment = null;
  traceIgnoredError.mockClear();
  session = { isPending: false, data: null };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const respond = (body: unknown, ok = true, status = 200) =>
  fetchMock.mockResolvedValue({ ok, status, json: async () => body });

describe("EventPageBody — the cacheable first render", () => {
  it("renders the OBSCURED location, no edit href and no RSVP seed", async () => {
    // Never resolves: this is the state of the document at the moment it is
    // stored at the edge.
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<EventPageBody data={pageData()} />);

    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
    expect(capturedDetailProps.editHref).toBeUndefined();
    expect(capturedDetailProps.viewerRsvped).toBeUndefined();
  });

  it("seeds every community date as not-going before the viewer is known", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(
      <EventPageBody
        data={pageData({
          communityDates: [
            {
              eventDateId: "d1",
              startsAt: "x",
              endsAt: null,
              status: "SCHEDULED",
            },
            {
              eventDateId: "d2",
              startsAt: "y",
              endsAt: null,
              status: "SCHEDULED",
            },
          ],
        })}
      />,
    );

    expect(capturedDetailProps.communityDates).toEqual([
      {
        eventDateId: "d1",
        startsAt: "x",
        endsAt: null,
        status: "SCHEDULED",
        viewerRsvped: false,
      },
      {
        eventDateId: "d2",
        startsAt: "y",
        endsAt: null,
        status: "SCHEDULED",
        viewerRsvped: false,
      },
    ]);
  });

  it("forwards the recurrence summary on the FIRST render (no viewer needed)", async () => {
    // The cadence line is event-intrinsic, so it must be on the cached render
    // rather than waiting for the viewer round-trip the way dateRsvps does.
    fetchMock.mockReturnValue(new Promise(() => {}));
    const recurrence = {
      freq: "WEEKLY" as const,
      interval: 1,
      byday: ["WE"],
      until: null,
    };

    render(
      <EventPageBody
        data={pageData({
          communityDates: [
            {
              eventDateId: "d1",
              startsAt: "x",
              endsAt: null,
              status: "SCHEDULED",
            },
          ],
          communityRecurrence: recurrence,
        })}
      />,
    );

    expect(capturedDetailProps.communityRecurrence).toEqual(recurrence);
  });

  it("forwards `communityDatesTruncated` on the FIRST render too", async () => {
    // Same reasoning as the cadence: whether the list stops short of the end of
    // the series describes the EVENT, not the reader, so it must be on the
    // cached render. And it cannot be recomputed downstream — the caps that
    // produced it are server-side.
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(
      <EventPageBody
        data={pageData({
          communityDates: [
            {
              eventDateId: "d1",
              startsAt: "x",
              endsAt: null,
              status: "SCHEDULED",
            },
          ],
          communityDatesTruncated: true,
        })}
      />,
    );

    expect(capturedDetailProps.communityDatesTruncated).toBe(true);
  });

  it("asks the uncacheable endpoint, keyed on the event id", async () => {
    respond(EMPTY_VIEWER_STATE);
    render(<EventPageBody data={pageData()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events/11111111-1111-4111-8111-111111111111/viewer-state",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});

describe("EventPageBody — the reveal", () => {
  it("swaps in the exact location once the endpoint sends one", async () => {
    respond({ ...EMPTY_VIEWER_STATE, location: REVEALED_LOCATION });

    render(<EventPageBody data={pageData()} />);

    await waitFor(() =>
      expect(capturedDetailProps.event.location).toEqual(REVEALED_LOCATION),
    );
  });

  it("restores the edit affordance and the RSVP seed", async () => {
    respond({
      ...EMPTY_VIEWER_STATE,
      editHref: "/admin/demo/events/evt-1",
      viewerRsvped: true,
      dateRsvps: { d1: true },
    });

    render(
      <EventPageBody
        data={pageData({
          communityDates: [
            {
              eventDateId: "d1",
              startsAt: "x",
              endsAt: null,
              status: "SCHEDULED",
            },
          ],
        })}
      />,
    );

    await waitFor(() =>
      expect(capturedDetailProps.editHref).toBe("/admin/demo/events/evt-1"),
    );
    expect(capturedDetailProps.viewerRsvped).toBe(true);
    expect(capturedDetailProps.communityDates[0].viewerRsvped).toBe(true);
  });

  it("keeps JSON-LD on the PUBLIC event even after a reveal", async () => {
    // Structured data rides the shared, indexed document. A revealed address
    // in a schema.org `Place` would be the same leak by another route, and it
    // could never be corrected for the crawler anyway.
    respond({ ...EMPTY_VIEWER_STATE, location: REVEALED_LOCATION });
    const data = pageData();

    render(<EventPageBody data={data} />);

    await waitFor(() =>
      expect(capturedDetailProps.event.location).toEqual(REVEALED_LOCATION),
    );
    expect(capturedJsonLdEvent).toBe(data.event);
    expect(capturedJsonLdEvent.location).toBe(OBSCURED_LOCATION);
  });

  it("hands JSON-LD the payload's enrichment, beside (not merged into) the public event", () => {
    // The stub image and organizer are structured-data only: the poster is
    // `event.images`, which must stay empty for a posterless event.
    fetchMock.mockReturnValue(new Promise(() => {}));
    const jsonLdEnrichment = {
      organizer: { name: "Org", url: "https://tickets.local/orgs/org" },
      fallbackImageUrl: "https://tickets.local/og/event/great-show?v=1",
    };
    const data = pageData({ jsonLdEnrichment });

    render(<EventPageBody data={data} />);

    expect(capturedJsonLdEnrichment).toBe(jsonLdEnrichment);
    expect(capturedJsonLdEvent).toBe(data.event);
    expect(capturedDetailProps.event.images).toEqual([]);
  });
});

describe("EventPageBody — fail closed", () => {
  it("leaves the page redacted when the endpoint answers with the empty state", async () => {
    respond(EMPTY_VIEWER_STATE);
    render(<EventPageBody data={pageData()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
    expect(capturedDetailProps.editHref).toBeUndefined();
  });

  it("leaves the page redacted on a 5xx, and reports it", async () => {
    respond({}, false, 500);
    render(<EventPageBody data={pageData()} />);

    await waitFor(() =>
      expect(traceIgnoredError).toHaveBeenCalledWith(
        "event.page.viewerStateProbe",
      ),
    );
    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
  });

  it("leaves the page redacted when the fetch throws, and reports it", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<EventPageBody data={pageData()} />);

    await waitFor(() =>
      expect(traceIgnoredError).toHaveBeenCalledWith(
        "event.page.viewerStateProbe",
      ),
    );
    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
  });
});

describe("EventPageBody — StrictMode", () => {
  it("still applies the reveal when effects are double-invoked", async () => {
    // Caught by driving the real page, not by a test: the obvious probe effect
    // (a `cancelled` flag flipped in cleanup) is DEAD under StrictMode. The
    // first invocation starts the fetch, the immediate cleanup cancels it, and
    // the second invocation short-circuits on the "already probed" ref — so
    // the response is discarded and no ticket holder ever gets their address.
    // This is the regression test for that, and it fails against that version.
    respond({ ...EMPTY_VIEWER_STATE, location: REVEALED_LOCATION });

    render(
      <StrictMode>
        <EventPageBody data={pageData()} />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(capturedDetailProps.event.location).toEqual(REVEALED_LOCATION),
    );
  });

  it("probes ONCE per event even though the effect runs twice", async () => {
    respond(EMPTY_VIEWER_STATE);

    render(
      <StrictMode>
        <EventPageBody data={pageData()} />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("EventPageBody — soft navigation between events", () => {
  it("does not carry one event's revealed address onto another event", async () => {
    // App Router does not key a segment by its dynamic params, so this tree is
    // RECONCILED in place on a soft nav. The state is tagged with the event it
    // was fetched for and the tag is checked during render, so there is not
    // even a single frame in which the wrong address is on screen.
    respond({ ...EMPTY_VIEWER_STATE, location: REVEALED_LOCATION });
    const first = pageData();
    const { rerender } = render(<EventPageBody data={first} />);

    await waitFor(() =>
      expect(capturedDetailProps.event.location).toEqual(REVEALED_LOCATION),
    );

    fetchMock.mockReturnValue(new Promise(() => {}));
    const second = pageData({
      eventId: "22222222-2222-4222-8222-222222222222",
      event: { ...first.event, id: "22222222-2222-4222-8222-222222222222" },
    });
    rerender(<EventPageBody data={second} />);

    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
  });
});

/**
 * `nextScheduledEventDateId` and `hasRecurrenceRule` describe the SCHEDULE, not
 * the reader, so they belong on the cached render beside the dates. The lead
 * date in particular cannot be recomputed downstream: cancelled nights are in
 * `communityDates` now, and they sort first like any other.
 */
describe("EventPageBody — the schedule's event-intrinsic half", () => {
  it("forwards the lead date and the rule flag on the FIRST render", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(
      <EventPageBody
        data={pageData({
          communityDates: [
            {
              eventDateId: "d1",
              startsAt: "x",
              endsAt: null,
              status: "CANCELLED",
            },
            {
              eventDateId: "d2",
              startsAt: "y",
              endsAt: null,
              status: "SCHEDULED",
            },
          ],
          communityNextScheduledDateId: "d2",
          communityHasRecurrenceRule: true,
        })}
      />,
    );

    expect(capturedDetailProps.communityNextScheduledDateId).toBe("d2");
    expect(capturedDetailProps.communityHasRecurrenceRule).toBe(true);
    // The status rides the cached document too — that is what lets an anonymous
    // reader see the strike-through at all.
    expect(capturedDetailProps.communityDates[0].status).toBe("CANCELLED");
  });
});

/**
 * The page column is three widths, and which one it is decides whether the
 * hero can split at all.
 *
 * MEASURED at 1440x900 on the 48rem column: a 2:3 gig flyer rendered 768x1152,
 * so the title, date, venue, price and CTA were all a full viewport below the
 * fold. 68rem seats the split — a 24px inset, a 440px rail, a 56px gutter and
 * 544px of decision column. What it must NOT do is widen the prose: 48rem is a
 * one-column measure, and splitting one 7fr/5fr is what left the community
 * layout's prose at ~45 characters a line.
 */
describe("EventPageBody — the page column's width", () => {
  const column = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="event-page-column"]')!;

  beforeEach(() => {
    fetchMock.mockReturnValue(new Promise(() => {}));
  });

  it("opens to 68rem for a poster event so the hero can split", () => {
    const { container } = render(
      <EventPageBody
        data={pageData({
          event: { ...pageData().event, images: ["https://cdn.test/p.jpg"] },
        })}
      />,
    );
    expect(column(container).style.maxWidth).toBe("68rem");
  });

  it("keeps 48rem for a posterless event — a 16:9 plate is not a wall", () => {
    const { container } = render(<EventPageBody data={pageData()} />);
    expect(column(container).style.maxWidth).toBe("48rem");
  });

  it("leaves the COMMUNITY listing's own 62rem two-track body alone", () => {
    const { container } = render(
      <EventPageBody
        data={pageData({
          event: {
            ...pageData().event,
            stewardship: "COMMUNITY",
            attendanceMode: "RSVP",
            images: ["https://cdn.test/p.jpg"],
          },
        })}
      />,
    );
    expect(column(container).style.maxWidth).toBe("62rem");
  });

  it("hands the volunteer / resale sections to the event page as belowContent", () => {
    // They used to be siblings of the event body, capped to 48rem and centred
    // under the whole grid — a third left edge on the poster-first page. Now
    // the page renders them itself, in the decision column.
    const withPoster = pageData({
      event: { ...pageData().event, images: ["https://cdn.test/p.jpg"] },
      resaleEnabled: true,
    });
    const { container, unmount } = render(<EventPageBody data={withPoster} />);

    expect(container.querySelector('[data-testid="resale"]')).toBeNull();
    const below = render(<>{capturedDetailProps.belowContent}</>);
    expect(below.getByTestId("resale")).toBeInTheDocument();
    below.unmount();
    unmount();

    // An RSVP listing has no tickets, so no resale market rides along.
    render(
      <EventPageBody
        data={pageData({
          event: { ...pageData().event, attendanceMode: "RSVP" },
          resaleEnabled: true,
        })}
      />,
    );
    const rsvpBelow = render(<>{capturedDetailProps.belowContent}</>);
    expect(rsvpBelow.queryByTestId("resale")).toBeNull();
  });
});

describe("EventPageBody — arrival areas (arrival-areas FR-006, NFR-001)", () => {
  const area = (id: string, kind: "PARKING" | "LOAD_IN" = "PARKING") => ({
    id,
    source: "PLACE" as const,
    kind,
    label: `Area ${id}`,
    cost: "FREE" as const,
    priceText: null,
    note: null,
    accessibleSpots: false,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [-86.78, 36.16],
        [-86.779, 36.16],
      ] as [number, number][],
    },
    directions: { lat: 36.16, lng: -86.7795 },
  });

  it("the cached first render carries only the anonymous list", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const publicAreas = [area("a")];
    render(<EventPageBody data={pageData({ arrivalAreas: publicAreas })} />);
    expect(capturedDetailProps.arrivalAreas).toBe(publicAreas);
  });

  it("the viewer's own list (load-in for an act) replaces it once probed", async () => {
    const viewerAreas = [area("a"), area("load", "LOAD_IN")];
    respond({ ...EMPTY_VIEWER_STATE, viewerArrivalAreas: viewerAreas });
    render(<EventPageBody data={pageData({ arrivalAreas: [area("a")] })} />);
    await waitFor(() =>
      expect(capturedDetailProps.arrivalAreas).toEqual(viewerAreas),
    );
  });

  it.each([
    ["the probe says nothing to add", () => respond(EMPTY_VIEWER_STATE)],
    ["the probe errors", () => respond(EMPTY_VIEWER_STATE, false, 500)],
    ["the network fails", () => fetchMock.mockRejectedValue(new Error("x"))],
  ])("keeps the anonymous list when %s", async (_label, arrange) => {
    arrange();
    const publicAreas = [area("a")];
    render(<EventPageBody data={pageData({ arrivalAreas: publicAreas })} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedDetailProps.arrivalAreas).toBe(publicAreas);
  });
});

describe("EventPageBody — the viewer changes without a navigation", () => {
  const loadIn = {
    id: "load",
    source: "PLACE" as const,
    kind: "LOAD_IN" as const,
    label: "Stage door",
    cost: "FREE" as const,
    priceText: null,
    note: null,
    accessibleSpots: false,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [-86.78, 36.16],
        [-86.779, 36.16],
      ] as [number, number][],
    },
    directions: { lat: 36.16, lng: -86.7795 },
  };
  const editorState: EventViewerState = {
    ...EMPTY_VIEWER_STATE,
    editHref: "/admin/events/1/edit",
    location: REVEALED_LOCATION,
    viewerArrivalAreas: [loadIn],
  };

  it("drops the previous viewer's state at once on sign-out, then re-probes as anonymous", async () => {
    session = { isPending: false, data: { user: { id: "user-a" } } };
    respond(editorState);
    const data = pageData({ arrivalAreas: [] });
    const { rerender } = render(<EventPageBody data={data} />);
    await waitFor(() =>
      expect(capturedDetailProps.arrivalAreas).toEqual([loadIn]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Signs out on the page; the anonymous probe never lands.
    fetchMock.mockReturnValue(new Promise(() => {}));
    session = { isPending: false, data: null };
    rerender(<EventPageBody data={data} />);

    // Gone in the same render, not after the next probe.
    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
    expect(capturedDetailProps.editHref ?? null).toBeNull();
    expect(capturedDetailProps.arrivalAreas).toEqual([]);
    // An anonymous viewer can hold a gate cookie, so it is asked again.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows nothing of A to B when B's probe fails", async () => {
    session = { isPending: false, data: { user: { id: "user-a" } } };
    respond(editorState);
    const data = pageData({ arrivalAreas: [] });
    const { rerender } = render(<EventPageBody data={data} />);
    await waitFor(() =>
      expect(capturedDetailProps.arrivalAreas).toEqual([loadIn]),
    );

    respond(EMPTY_VIEWER_STATE, false, 500);
    session = { isPending: false, data: { user: { id: "user-b" } } };
    rerender(<EventPageBody data={data} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));

    expect(capturedDetailProps.arrivalAreas).toEqual([]);
    expect(capturedDetailProps.event.location).toBe(OBSCURED_LOCATION);
  });

  it("does not probe twice when the session read resolves after the first probe", async () => {
    session = { isPending: true, data: null };
    respond(editorState);
    const data = pageData();
    const { rerender } = render(<EventPageBody data={data} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    session = { isPending: false, data: { user: { id: "user-a" } } };
    rerender(<EventPageBody data={data} />);
    await waitFor(() =>
      expect(capturedDetailProps.event.location).toEqual(REVEALED_LOCATION),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
