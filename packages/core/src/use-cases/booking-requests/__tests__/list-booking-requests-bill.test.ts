import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EntityPageRecord } from "@th/types/repos/entity-pages";
import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";

import { listBookingRequests } from "../list-booking-requests";
import type { ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  NOW,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildPlaceRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// `bill` on list summaries (lineup-booking-requests v2, FR-004 / NFR-003).
// ACTOR_ID owns the venue; SENDER_ID sent the request; the acts are ARTIST_*
// (tagged humans) plus free text.
// ─────────────────────────────────────────────────────────────────────────────

const SENDER_ID = "20202020-2020-4202-8202-202020202020";
const SENDER_ORG_ID = "21212121-2121-4212-8212-212121212121";
const ARTIST_PENDING = "22222222-2222-4222-8222-222222222222";
const ARTIST_CONFIRMED = "23232323-2323-4232-8232-232323232323";
const ARTIST_DECLINED = "24242424-2424-4242-8242-242424242424";
const LEGACY_REQUEST_ID = "45454545-4545-4545-8545-454545454545";
const ORG_REQUEST_ID = "46464646-4646-4646-8646-464646464646";

const NAMES: Record<string, string> = {
  [SENDER_ID]: "Sam Sender",
  [ARTIST_PENDING]: "Pending Pat",
  [ARTIST_CONFIRMED]: "Confirmed Cleo",
  [ARTIST_DECLINED]: "Declined Dee",
};

function page(
  ownerType: EntityPageRecord["ownerType"],
  ownerId: string,
  slug: string,
  visibility: EntityPageRecord["visibility"] = "PUBLIC",
): EntityPageRecord {
  return {
    id: crypto.randomUUID(),
    ownerType,
    ownerId,
    slug,
    displayName: null,
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility,
    allowFollows: true,
    showFollowerCount: true,
    category: null,
    templateAppliedCategories: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function buildDeps(options: {
  records: BookingRequestRecord[];
  actsError?: Error;
  reportError?: ListBookingRequestsDeps["reportError"];
}) {
  const recordsById = new Map(options.records.map((r) => [r.id, r]));
  const acts = createFakeBookingRequestActs({
    senderOf: (id) => {
      const record = recordsById.get(id);
      if (!record) return undefined;
      return record.performerOwnerType && record.performerOwnerId
        ? { ownerType: record.performerOwnerType, ownerId: record.performerOwnerId }
        : null;
    },
  });
  const listActsForRequests = vi.fn(async (ids: readonly string[]) => {
    if (options.actsError) throw options.actsError;
    return acts.listActsForRequests(ids);
  });

  const toVenue = options.records.filter((r) => r.direction === "TO_VENUE");
  const toPerformer = options.records.filter((r) => r.direction === "TO_PERFORMER");
  const bookingRequests = {
    listForPlace: vi.fn(async () => toVenue),
    listForPlaces: vi.fn(async () => toVenue),
    listForPerformer: vi.fn(async () => toVenue),
    listForOrganizer: vi.fn(async () => toPerformer),
    listForPerformerInbox: vi.fn(async () => toPerformer),
    listActsForRequests,
  };

  const place = buildPlaceRecord({ humanIdsWithAccess: [ACTOR_ID] });
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
    listOwnedBySubject: vi.fn(
      async ({ ownerType, ownerId }: { ownerType: string; ownerId: string }) =>
        ownerType === "HUMAN" && ownerId === ACTOR_ID ? [place] : [],
    ),
  };
  const authz = {
    getOrgMemberships: vi.fn(async () => []),
    getOrgMembership: vi.fn(async ({ orgId }: { orgId: string }) =>
      orgId === SENDER_ORG_ID ? { orgId, humanId: SENDER_ID, role: "ADMIN" } : null,
    ),
    listOrgMembershipsByHumanId: vi.fn(async () => []),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: NAMES[id] ?? "Someone", status: "ACTIVE" })),
    ),
  };
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: id === SENDER_ORG_ID ? "Night Owls Collective" : "Org" })),
    ),
  };
  const entityPages = {
    getByOwners: vi.fn(async (ownerType: string, ownerIds: string[]) => {
      const all = [
        page("HUMAN", ARTIST_CONFIRMED, "confirmed-cleo"),
        // A PRIVATE page must never become a link.
        page("HUMAN", ARTIST_PENDING, "pending-pat", "PRIVATE"),
        page("ORGANIZATION", SENDER_ORG_ID, "night-owls"),
      ];
      return all.filter((p) => p.ownerType === ownerType && ownerIds.includes(p.ownerId));
    }),
  };
  const stage = buildStageRepos();

  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests,
      places,
      authz,
      humans,
      organizations,
      entityPages,
      bookingRequestMessages: buildUnreadCountingRepo(),
      agreements: stage.agreements,
      events: stage.events,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
    } as unknown as ListBookingRequestsDeps["repos"],
    ...(options.reportError ? { reportError: options.reportError } : {}),
  };
  return { deps, acts, listActsForRequests, humans, entityPages };
}

/** SELF, then pending / confirmed / declined tagged artists, then free text. */
async function seedMixedBill(acts: ReturnType<typeof createFakeBookingRequestActs>) {
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST_PENDING, sortOrder: 1 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST_CONFIRMED, sortOrder: 2 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST_DECLINED, sortOrder: 3 },
    {
      source: "EXTERNAL",
      externalName: "The Weeds",
      // A typed URL — must NOT become a link.
      externalUrl: "https://theweeds.example",
      sortOrder: 4,
    },
  ]);
  const answer = (actOwnerId: string, to: "CONFIRMED" | "DECLINED") =>
    acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId,
      expectedFrom: "PENDING",
      to,
      respondedAt: NOW,
    });
  await answer(ARTIST_CONFIRMED, "CONFIRMED");
  await answer(ARTIST_DECLINED, "DECLINED");
}

const request = () =>
  buildBookingRequestRecord({ performerOwnerId: SENDER_ID });
const legacy = () =>
  buildBookingRequestRecord({ id: LEGACY_REQUEST_ID, performerOwnerId: SENDER_ID });

const summaryOf = (
  result: Awaited<ReturnType<typeof listBookingRequests>>,
  id: string,
) => result.requests.find((r) => r.id === id)!;

describe("listBookingRequests — the bill", () => {
  it("venue inbox: ordered bill with consent state, DECLINED hidden, free text never linked", async () => {
    const { deps, acts } = buildDeps({ records: [request(), legacy()] });
    await seedMixedBill(acts);

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    const bill = summaryOf(result, REQUEST_ID).bill;
    expect(bill.map((item) => [item.source, item.displayName, item.confirmation])).toEqual([
      ["SELF", "Sam Sender", "CONFIRMED"],
      ["TAGGED", "Pending Pat", "PENDING"],
      ["TAGGED", "Confirmed Cleo", "CONFIRMED"],
      // ARTIST_DECLINED is gone — not struck, absent.
      ["EXTERNAL", "The Weeds", "CONFIRMED"],
    ]);
    // v3 FR-004 / NFR-002: positions are renumbered AFTER the hide. The
    // stored order is 0,1,2,(3 hidden),4 — a raw "4" after "2" would tell the
    // venue somebody between them was taken off.
    expect(bill.map((item) => item.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(bill.map((item) => item.isSender)).toEqual([true, false, false, false]);
    // v3 FR-011: only JOINED platform acts carry their identity (the payee
    // picker's suggestions) — never the invited act, never free text.
    expect(bill.map((item) => item.joinedAs)).toEqual([
      { ownerType: "human", ownerId: SENDER_ID },
      null,
      { ownerType: "human", ownerId: ARTIST_CONFIRMED },
      null,
    ]);
    expect(bill.every((item) => item.customRoleLabel === null)).toBe(true);
    // Links: PUBLIC page only; PRIVATE page → none; free text → NEVER.
    expect(bill.map((item) => item.href)).toEqual([
      null,
      null,
      "/humans/confirmed-cleo",
      null,
    ]);

    // Legacy request (sent before the bill): no rows → [] — and that is a
    // FACT, not a failed read.
    expect(summaryOf(result, LEGACY_REQUEST_ID).bill).toEqual([]);
    expect(summaryOf(result, LEGACY_REQUEST_ID).billUnavailable).toBe(false);
    expect(summaryOf(result, REQUEST_ID).billUnavailable).toBe(false);
  });

  it("ONE batched act read and ONE identity pass for the whole page", async () => {
    const { deps, acts, listActsForRequests, humans, entityPages } = buildDeps({
      records: [request(), legacy()],
    });
    await seedMixedBill(acts);

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(listActsForRequests).toHaveBeenCalledTimes(1);
    expect(listActsForRequests).toHaveBeenCalledWith([REQUEST_ID, LEGACY_REQUEST_ID]);
    // Sender-name batch (existing) + ONE bill identity batch.
    expect(humans.getByIds).toHaveBeenCalledTimes(2);
    expect(entityPages.getByOwners).toHaveBeenCalledTimes(1);
  });

  it("the cross-venue inbox (human-venues) hides DECLINED acts too", async () => {
    const { deps, acts } = buildDeps({ records: [request()] });
    await seedMixedBill(acts);

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    const confirmations = summaryOf(result, REQUEST_ID).bill.map((i) => i.confirmation);
    expect(confirmations).not.toContain("DECLINED");
    expect(confirmations).toHaveLength(4);
  });

  it("the sender's sent list KEEPS the declined act (rendered struck)", async () => {
    const { deps, acts } = buildDeps({ records: [request()] });
    await seedMixedBill(acts);

    const result = await listBookingRequests(deps, {
      actorHumanId: SENDER_ID,
      scope: "performer",
    });

    const bill = summaryOf(result, REQUEST_ID).bill;
    expect(bill).toHaveLength(5);
    expect(bill[3]).toMatchObject({
      source: "TAGGED",
      displayName: "Declined Dee",
      confirmation: "DECLINED",
      // A passed act's id never leaves the server, even to the sender.
      joinedAs: null,
    });
    expect(bill.map((item) => item.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it("an ORG sender's SELF row names the org and links its public page", async () => {
    const orgRequest = buildBookingRequestRecord({
      id: ORG_REQUEST_ID,
      performerOwnerType: "organization",
      performerOwnerId: SENDER_ORG_ID,
    });
    const { deps, acts } = buildDeps({ records: [orgRequest] });
    await acts.addActs(ORG_REQUEST_ID, [{ source: "SELF", sortOrder: 0 }]);

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(summaryOf(result, ORG_REQUEST_ID).bill).toEqual([
      expect.objectContaining({
        source: "SELF",
        displayName: "Night Owls Collective",
        href: "/orgs/night-owls",
        isSender: true,
      }),
    ]);
  });

  it("TO_PERFORMER scopes carry no bill and never read one", async () => {
    const organizerRow = buildOrganizerBookingRequestRecord();
    const { deps, listActsForRequests } = buildDeps({ records: [organizerRow] });

    const inbox = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer-inbox",
    });
    expect(inbox.requests[0]?.bill).toEqual([]);
    expect(inbox.requests[0]?.billUnavailable).toBe(false);
    expect(listActsForRequests).not.toHaveBeenCalled();
  });

  it("DEGRADES every bill to [] and REPORTS when the act read fails", async () => {
    const actsError = new Error("acts table on fire");
    const reportError = vi.fn();
    const { deps, acts } = buildDeps({
      records: [request()],
      actsError,
      reportError,
    });
    await seedMixedBill(acts);

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    // The inbox still renders, and says the bill is UNKNOWN — it must not
    // read as a pre-bill request ("the sender is the act").
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.bill).toEqual([]);
    expect(result.requests[0]?.billUnavailable).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(actsError, {
      tags: { useCase: "listBookingRequests", step: "bookingBills" },
      extra: { scope: "venue", audience: "venue", requestCount: 1 },
    });
  });

  it("a throwing reporter never breaks the degrade-to-empty fallback", async () => {
    const { deps } = buildDeps({
      records: [request()],
      actsError: new Error("down"),
      reportError: vi.fn(() => {
        throw new Error("reporter down too");
      }),
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });
    expect(result.requests[0]?.bill).toEqual([]);
  });
});
