import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { buildPlaceRecord } from "../../booking-requests/__tests__/helpers";
import { saveEventForOrg } from "../save-event-for-org";

// ─────────────────────────────────────────────────────────────────────────────
// An edit that withholds a PUBLISHED event's location must reach the search
// index fail-closed (`search/privacy-scrub.ts`): its document is deleted
// inside the save's transaction, and a failed delete fails the save. Before
// this, event saves did not touch the index at all, so an event switched to
// hidden kept its pin in search until the nightly reindex.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-25T12:00:00.000Z");

function club(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return buildPlaceRecord({
    id: DEFAULT_PLACE_ID,
    name: "The Basement",
    formattedAddress: "1604 8th Ave S, Nashville, TN 37203",
    addressLine1: "1604 8th Ave S",
    city: "Nashville",
    region: "TN",
    postalCode: "37203",
    lat: 36.1395,
    lng: -86.7825,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    ...overrides,
  });
}

function published(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Late Show",
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2026-12-10T01:00:00.000Z"),
    endsAt: new Date("2026-12-10T04:00:00.000Z"),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    spaceId: null,
    calendarId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: "1604 8th Ave S, Nashville, TN 37203",
    countryCode: "US",
    region: "TN",
    locality: "Nashville",
    postalCode: "37203",
    lat: 36.1395,
    lng: -86.7825,
    slug: "late-show",
    shortId: "abc123",
    regionCode: null,
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "CLOSED",
    admissionTaxRateBps: 925,
    ...overrides,
  } as EventRecord;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    eventId: DEFAULT_EVENT_ID,
    title: "Late Show",
    startsAt: "2026-12-10T01:00:00.000Z",
    endsAt: "2026-12-10T04:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    clientKey: `key-${Math.random()}`,
    ...overrides,
  };
}

/** Wire a search port and record the order of delete vs. commit. */
function setup(opts: {
  existing: EventRecord | null;
  scrub?: "ok" | "err" | "throw";
}) {
  const ctx = makeCreateEventTestContext({
    now: NOW,
    place: club(),
    existingEvent: opts.existing,
  });
  const order: string[] = [];
  const deleteDocuments = vi.fn(async (req: { ids?: string[] }) => {
    order.push("search.delete");
    if (opts.scrub === "throw") throw new Error("search db unreachable");
    if (opts.scrub === "err") {
      return { ok: false as const, error: new Error("delete failed") };
    }
    return { ok: true as const, value: { deleted: req.ids?.length ?? 0 } };
  });
  const originalTx = ctx.deps.repos.tx;
  ctx.deps.repos.tx = (async (fn: never, o: never) => {
    const out = await originalTx(fn, o);
    order.push("commit");
    return out;
  }) as typeof originalTx;
  const deps = {
    ...ctx.deps,
    // Only the delete is exercised synchronously; the post-commit reindex is
    // fire-and-forget and its failure is reported, not thrown.
    search: { deleteDocuments } as unknown as MultiSearchPort,
  };
  return { ctx, deps, deleteDocuments, order };
}

beforeEach(() => {
  configureLocationObfuscation({ secret: "save-event-scrub-secret" });
});
afterEach(() => {
  resetLocationObfuscationForTests();
});

describe("saveEvent: withholding a published event's location scrubs its search document", () => {
  it("EXACT → hidden: deletes event_<id> inside the transaction, before commit", async () => {
    const h = setup({ existing: published() });

    await saveEventForOrg(
      h.deps,
      input({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        addressRevealPreset: "IMMEDIATELY",
      }),
    );

    expect(h.deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${DEFAULT_EVENT_ID}`],
    });
    expect(h.order).toEqual(["search.delete", "commit"]);
  });

  it.each(["err", "throw"] as const)(
    "a failed delete (%s) FAILS the save (rolled back, retryable, reported)",
    async (mode) => {
    const h = setup({ existing: published(), scrub: mode });

    await expect(
      saveEventForOrg(
        h.deps,
        input({
          locationMode: "OBSCURED",
          locationRadiusMeters: null,
          addressRevealPreset: "IMMEDIATELY",
        }),
      ),
    ).rejects.toMatchObject({
      code: "SEARCH_UPDATE_RETRY",
    });
    expect(h.order).not.toContain("commit");
    expect(h.ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: { useCase: "saveEvent", op: "searchPrivacyScrub" },
      }),
    );
    },
  );

  it("compares against the row LOCKED just before the write, not the stale pre-tx read", async () => {
    // The pre-tx read (before the idempotency claim and a possible tax
    // lookup) already says hidden, so on its own the save would look like a
    // no-op and skip the scrub. Under the lock the row is still EXACT (a
    // concurrent save loosened it after that read), so the scrub must run.
    const hidden = published({ locationMode: "OBSCURED", locationRadiusMeters: null });
    const h = setup({ existing: hidden });
    const events = h.ctx.mocks.events as unknown as {
      getById: ReturnType<typeof vi.fn>;
      lockRows: ReturnType<typeof vi.fn>;
      upsertDraft: ReturnType<typeof vi.fn>;
    };
    const exactNow = published();
    let locked = false;
    const realGetById = events.getById.getMockImplementation()!;
    events.lockRows.mockImplementation(async (i: { mode: string }) => {
      h.order.push(`lock:${i.mode}`);
      locked = true;
    });
    events.getById.mockImplementation(async (id: string) =>
      locked && id === DEFAULT_EVENT_ID && !events.upsertDraft.mock.calls.length
        ? exactNow
        : realGetById(id),
    );

    await saveEventForOrg(
      h.deps,
      input({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        addressRevealPreset: "IMMEDIATELY",
      }),
    );

    expect(events.lockRows).toHaveBeenCalledWith({
      ids: [DEFAULT_EVENT_ID],
      mode: "update",
    });
    expect(h.deleteDocuments).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["lock:update", "search.delete", "commit"]);
  });

  it("does NOT scrub an edit that keeps the exact pin", async () => {
    const h = setup({ existing: published() });

    await saveEventForOrg(h.deps, input({ title: "Later Show" }));

    expect(h.deleteDocuments).not.toHaveBeenCalled();
    expect(h.order).toEqual(["commit"]);
  });

  it("does NOT scrub on create (no document exists yet)", async () => {
    const h = setup({ existing: null });

    await saveEventForOrg(
      h.deps,
      input({
        eventId: undefined,
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
        addressRevealPreset: "IMMEDIATELY",
      }),
    );

    expect(h.deleteDocuments).not.toHaveBeenCalled();
  });
});
