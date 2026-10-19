import { describe, expect, it, vi } from "vitest";

import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import type { Ctx } from "../../context";
import { t } from "../../trpc";
import { bookingRequestsRouter } from "../booking-requests";
import { embedsRouter } from "../embeds";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// STANDARDS_UNMET on the wire (venue-booking-standards spec, FR-006): both
// pitch entrances refuse unmet REQUIRED items as BAD_REQUEST, and the
// `items` list — each field with the VENUE's label — survives `toTrpcError`
// and the router's REAL errorFormatter into `data.meta`, which is where the
// form reads it to put the error under the right field.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "77777777-7777-4777-8777-777777777777";
const PLACE_ID = "00000000-0000-4000-8000-0000000000e1";
const CALENDAR_ID = "ca1e0da1-1111-4111-8111-1111111111e1";
const EMBED_ID = "00000000-0000-4000-8000-0000000000e2";
const EMBED_DOMAIN = "venue.example.com";

const place = {
  id: PLACE_ID,
  name: "Test Venue",
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  acceptsBookingRequests: true,
  humanIdsWithAccess: [OWNER_ID],
  orgIdsWithAccess: [],
};

const calendar = {
  id: CALENDAR_ID,
  placeId: PLACE_ID,
  name: "Main",
  isDefault: true,
  acceptsPerform: true,
  acceptsRent: false,
  acceptsUse: false,
  rentalMode: "REQUEST",
  spaces: [],
};

async function musicRequired() {
  const bookingStandards = createFakeBookingStandards();
  await bookingStandards.replaceItems({
    ownerType: "CALENDAR",
    ownerId: CALENDAR_ID,
    intent: "PERFORM",
    items: [{ field: "LINK_MUSIC", label: "Send us a music link", requirement: "REQUIRED" }],
  });
  return bookingStandards;
}

function buildRepos(bookingStandards: unknown) {
  const mocks = {
    bookingStandards,
    places: { getById: vi.fn(async () => place) },
    calendars: {
      findById: vi.fn(async () => calendar),
      findDefaultForPlace: vi.fn(async () => calendar),
      listByPlace: vi.fn(async () => [calendar]),
      listAvailabilityForPlace: vi.fn(async () => []),
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
    events: {
      listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    bookingRequests: {
      findOpenByPerformerAndPlace: vi.fn(async () => null),
      findOpenByContactEmailAndPlace: vi.fn(async () => null),
      create: vi.fn(),
      addActs: vi.fn(async () => []),
      touchLastMessageAt: vi.fn(async () => {}),
    },
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    performerProfiles: {
      getByOwner: vi.fn(async () => ({
        id: "profile-1",
        ownerType: "human",
        ownerId: ACTOR_ID,
        enabledAt: new Date("2026-01-01T00:00:00.000Z"),
        disabledAt: null,
      })),
    },
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID, genreTags: [] })) },
    humanStats: { findByHumanId: vi.fn(async () => null) },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
    embeds: {
      getById: vi.fn(async () => ({
        id: EMBED_ID,
        subjectType: "place",
        subjectId: PLACE_ID,
        domain: EMBED_DOMAIN,
        status: "ACTIVE",
        requireAuth: false,
        linkOut: false,
        defaultView: "list",
        viewToggle: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    },
  };
  return {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"] & typeof mocks;
}

/** The router's REAL wire formatter (see trpc-error-formatter.test.ts). */
function wireData(error: unknown) {
  const format = t._config.errorFormatter as unknown as (opts: {
    shape: unknown;
    error: unknown;
  }) => { data: Record<string, unknown> };
  return format({
    shape: { message: "x", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } },
    error,
  }).data;
}

const unmet = {
  items: [{ field: "LINK_MUSIC", label: "Send us a music link" }],
};

describe("STANDARDS_UNMET reaches the wire", () => {
  it("bookingRequests.create: BAD_REQUEST, appCode STANDARDS_UNMET, data.meta.items with the venue's label — nothing written", async () => {
    const repos = buildRepos(await musicRequired());
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
      clock: { now: () => new Date("2026-06-10T12:00:00.000Z") } as Ctx["clock"],
    });

    const err = await caller
      .create({
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        placeId: PLACE_ID,
        message: "We'd love to play a Friday night slot.",
        preferredDates: ["2026-07-10"],
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    const data = wireData(err);
    expect(data.appCode).toBe("STANDARDS_UNMET");
    expect(data.meta).toMatchObject(unmet);
    expect(repos.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("embeds.createBookingInquiry: the same refusal, same wire shape", async () => {
    const repos = buildRepos(await musicRequired());
    const { caller } = createCaller(
      { embeds: embedsRouter },
      {
        repos,
        actorHumanId: null,
        publicAppUrl: "http://localhost:3000",
        clock: { now: () => new Date("2026-06-10T12:00:00.000Z") } as Ctx["clock"],
      },
    );

    const err = await caller.embeds
      .createBookingInquiry({
        embedId: EMBED_ID,
        hostOrigin: `https://${EMBED_DOMAIN}`,
        contactName: "Jo Doe",
        contactEmail: "jo@example.com",
        actName: "The Basement Tapes",
        message: "We'd love to play a Friday night slot.",
        preferredDates: ["2026-07-10"],
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    const data = wireData(err);
    expect(data.appCode).toBe("STANDARDS_UNMET");
    expect(data.meta).toMatchObject(unmet);
    expect(repos.bookingRequests.create).not.toHaveBeenCalled();
  });
});
