import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadEventSeo = vi.fn();
const mockResolveEditUrl = vi.fn();
const mockLoadViewerDateRsvps = vi.fn();
const mockTrace = vi.fn();
const mockLoadViewerEventArrivalAreas = vi.fn();

vi.mock("@/server/events", () => ({
  loadEventSeo: (...args: unknown[]) => mockLoadEventSeo(...args),
  resolveEditUrl: (...args: unknown[]) => mockResolveEditUrl(...args),
  loadViewerDateRsvps: (...args: unknown[]) =>
    mockLoadViewerDateRsvps(...args),
}));

vi.mock("@/server/arrival-areas", () => ({
  loadViewerEventArrivalAreas: (...args: unknown[]) =>
    mockLoadViewerEventArrivalAreas(...args),
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => (err: unknown) => mockTrace(label, err),
}));

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

beforeEach(() => {
  mockLoadEventSeo.mockReset();
  mockResolveEditUrl.mockReset();
  mockLoadViewerDateRsvps.mockReset();
  mockTrace.mockReset();
  mockLoadEventSeo.mockResolvedValue(null);
  mockResolveEditUrl.mockResolvedValue(null);
  mockLoadViewerDateRsvps.mockResolvedValue({});
  mockLoadViewerEventArrivalAreas.mockReset();
  mockLoadViewerEventArrivalAreas.mockResolvedValue(null);
});

describe("loadEventViewerState", () => {
  it("hands back the exact location once the API has revealed it", async () => {
    mockLoadEventSeo.mockResolvedValue({
      viewerHasTicket: true,
      location: REVEALED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.viewerHasTicket).toBe(true);
    expect(state.location).toEqual(REVEALED_LOCATION);
  });

  it("withholds the location while the reveal date has NOT passed", async () => {
    // `redactLocation` applies the time gate server-side and answers with the
    // obscured shape (`isExact: false`) until `now >= addressRevealAt`. Keying
    // on that verdict rather than re-deriving the rule is what keeps the two
    // in step; this test is the proof that a ticket alone is not enough.
    mockLoadEventSeo.mockResolvedValue({
      viewerHasTicket: true,
      location: OBSCURED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.viewerHasTicket).toBe(true);
    expect(state.location).toBeNull();
  });

  it("withholds the location for a viewer with no ticket", async () => {
    mockLoadEventSeo.mockResolvedValue({
      viewerHasTicket: false,
      location: REVEALED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.location).toBeNull();
  });

  it("hands back the exact location to an act on the bill the API released it to (arrival-areas FR-009)", async () => {
    // No ticket: the API's per-viewer flag is what released it.
    mockLoadEventSeo.mockResolvedValue({
      viewerHasTicket: false,
      viewerAddressReleased: true,
      location: REVEALED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.viewerHasTicket).toBe(false);
    expect(state.location).toEqual(REVEALED_LOCATION);
  });

  it("hands back the exact location to an RSVP-er the API released it to (arrival-areas Q16)", async () => {
    // An RSVP-er has no ticket; the API's release flag is the whole answer,
    // and `viewerRsvped` alone never reveals anything.
    mockLoadEventSeo.mockResolvedValue({
      viewerHasTicket: false,
      viewerAddressReleased: true,
      viewerRsvped: true,
      location: REVEALED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.viewerHasTicket).toBe(false);
    expect(state.viewerRsvped).toBe(true);
    expect(state.location).toEqual(REVEALED_LOCATION);
  });

  it("withholds the location from an RSVP-er the API did not release it to (before the reveal)", async () => {
    mockLoadEventSeo.mockResolvedValue({
      viewerHasTicket: false,
      viewerRsvped: true,
      location: OBSCURED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.location).toBeNull();
  });

  it("withholds the location when the release flag rides an obscured shape", async () => {
    mockLoadEventSeo.mockResolvedValue({
      viewerAddressReleased: true,
      location: OBSCURED_LOCATION,
    });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.location).toBeNull();
  });

  it("withholds the location for an EXACT-mode event (nothing to reveal)", async () => {
    // `get-event-seo` never runs the ticket lookup for EXACT events, so
    // `viewerHasTicket` is false and no override is sent — the server-rendered
    // address, which is public by definition, stands.
    mockLoadEventSeo.mockResolvedValue({ location: REVEALED_LOCATION });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.location).toBeNull();
  });

  it("carries the edit href and the per-date RSVP map", async () => {
    mockResolveEditUrl.mockResolvedValue("/admin/demo/events/evt-1");
    // The loader hands back the flag map and nothing else: the cadence and the
    // truncation flag are event-intrinsic, already rode the cached document,
    // and this path asks the API to skip the Event row read behind them.
    mockLoadViewerDateRsvps.mockResolvedValue({ d1: true, d2: false });
    mockLoadEventSeo.mockResolvedValue({ viewerRsvped: true });

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.editHref).toBe("/admin/demo/events/evt-1");
    expect(state.viewerRsvped).toBe(true);
    expect(state.dateRsvps).toEqual({ d1: true, d2: false });
    expect(mockLoadViewerDateRsvps).toHaveBeenCalledWith("evt-1");
    // The viewer payload carries the viewer's half ONLY — the cadence is not
    // viewer-scoped and has no business in this uncacheable response.
    expect(state).not.toHaveProperty("recurrence");
    expect(state).not.toHaveProperty("truncated");
  });

  it("reports viewerRsvped as null (not false) when the API did not answer", async () => {
    // `undefined` means "anonymous / not an RSVP listing", which the toggle
    // must treat as NO SEED. Coercing it to false would render "not going" as
    // a fact.
    mockLoadEventSeo.mockResolvedValue({});

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.viewerRsvped).toBeNull();
  });

  it("fails CLOSED when the SEO read throws (gated event, API outage)", async () => {
    mockLoadEventSeo.mockRejectedValue(new Error("403"));
    mockResolveEditUrl.mockResolvedValue("/admin/demo/events/evt-1");

    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state.location).toBeNull();
    expect(state.viewerHasTicket).toBe(false);
    expect(state.viewerRsvped).toBeNull();
    // The other reads still resolve — a partial answer beats none, and it
    // cannot over-reveal.
    expect(state.editHref).toBe("/admin/demo/events/evt-1");
    expect(mockTrace).toHaveBeenCalledWith(
      "event.viewerState.seoFailed",
      expect.any(Error),
    );
  });

  it("fails CLOSED when every read throws", async () => {
    mockLoadEventSeo.mockRejectedValue(new Error("down"));
    mockResolveEditUrl.mockRejectedValue(new Error("down"));
    mockLoadViewerDateRsvps.mockRejectedValue(new Error("down"));

    const { EMPTY_EVENT_VIEWER_STATE, loadEventViewerState } = await import(
      "../event-viewer-state"
    );
    const state = await loadEventViewerState("evt-1", "great-show");

    expect(state).toEqual(EMPTY_EVENT_VIEWER_STATE);
  });

  it("EMPTY_EVENT_VIEWER_STATE is the redacted, no-affordance value", async () => {
    const { EMPTY_EVENT_VIEWER_STATE } = await import("../event-viewer-state");
    expect(EMPTY_EVENT_VIEWER_STATE).toEqual({
      editHref: null,
      viewerHasTicket: false,
      location: null,
      viewerRsvped: null,
      dateRsvps: {},
      viewerArrivalAreas: null,
    });
  });
});

describe("loadEventViewerState: arrival areas (arrival-areas NFR-001)", () => {
  const AREAS = [{ id: "load-in", kind: "LOAD_IN" }];

  it("hands back the viewer's own areas for this event", async () => {
    mockLoadViewerEventArrivalAreas.mockResolvedValue(AREAS);
    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");
    expect(mockLoadViewerEventArrivalAreas).toHaveBeenCalledWith("evt-1");
    expect(state.viewerArrivalAreas).toBe(AREAS);
  });

  it("keeps the cached list (null) when the loader has nothing to add", async () => {
    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");
    expect(state.viewerArrivalAreas).toBeNull();
  });

  it("fails closed to null when the loader throws, leaving the rest intact", async () => {
    mockLoadViewerEventArrivalAreas.mockRejectedValue(new Error("down"));
    mockResolveEditUrl.mockResolvedValue("/admin/demo/events/evt-1");
    const { loadEventViewerState } = await import("../event-viewer-state");
    const state = await loadEventViewerState("evt-1", "great-show");
    expect(state.viewerArrivalAreas).toBeNull();
    expect(state.editHref).toBe("/admin/demo/events/evt-1");
  });

  it("the empty (fail-closed) state carries no areas", async () => {
    const { EMPTY_EVENT_VIEWER_STATE } = await import("../event-viewer-state");
    expect(EMPTY_EVENT_VIEWER_STATE.viewerArrivalAreas).toBeNull();
  });
});
