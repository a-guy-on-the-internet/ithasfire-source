import { describe, expect, it, vi } from "vitest";

import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import {
  listBookingRequestMessages,
  redactForAct,
} from "../messages/list-messages";
import type { ListBookingRequestMessagesDeps } from "../messages/list-messages";
import {
  ACTOR_ID,
  NOW,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// A joined ACT reads the thread (FR-008) but must not learn anything about
// acts that are still only INVITED (FR-013 — the invite page shows joined
// and by-name acts only). The venue may see invited acts by name on a
// `bill_changed` entry; the ACT side reads ONLY that the bill changed, plus
// the joined / by-name names (coordinator ruling 2026-09-30) — no count, no
// reorder or role flag. The sender and the venue read the entry unchanged.
// And an `act_joined_lineup` line goes, like `act_confirmed`, once the act
// is no longer joined.
// ─────────────────────────────────────────────────────────────────────────────

const ARTIST_ID = OTHER_HUMAN_ID;
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const ACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const BILL_CHANGED = {
  added: [
    { actId: ACT_ID, name: "Maren Sky", source: "TAGGED", state: "invited" },
    { actId: ACT_ID, name: "Junco", source: "EXTERNAL", state: "by_name" },
    { actId: ACT_ID, name: "Sam Sender", source: "SELF", state: "joined" },
  ],
  removed: [{ name: "Paper Moth", wasState: "joined" }],
  otherRemovedCount: 1,
  reordered: true,
  roleChanged: false,
};

function buildDeps() {
  const request = buildBookingRequestRecord();
  const messages = createFakeBookingRequestMessagesRepo();
  const place = buildPlaceRecord({ humanIdsWithAccess: [VENUE_OWNER_ID] });
  const repos = withTx({
    bookingRequests: {
      getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
      touchLastMessageAt: vi.fn(async () => {}),
    },
    bookingRequestMessages: messages,
    places: { getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)) },
    authz: {
      getPlaceAccessContext: vi.fn(async () => ({
        owningOrgIds: [],
        verifiedHumanOwnerIds: [VENUE_OWNER_ID],
      })),
      getOrgMembership: vi.fn(async () => null),
      getOrgMemberships: vi.fn(async () => []),
    },
  });
  const deps = {
    repos: repos as unknown as ListBookingRequestMessagesDeps["repos"],
    clock: { now: () => NOW },
  };
  return { deps, repos, messages };
}

async function joinedArtist(repos: ReturnType<typeof buildDeps>["repos"]) {
  const acts = repos.bookingRequests as unknown as ListBookingRequestMessagesDeps["repos"]["bookingRequests"];
  await acts.addActs(REQUEST_ID, [
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST_ID, sortOrder: 0 },
  ]);
  await acts.setActConfirmation({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: ARTIST_ID,
    expectedFrom: "PENDING",
    to: "CONFIRMED",
    respondedAt: NOW,
  });
}

function seed(messages: ReturnType<typeof createFakeBookingRequestMessagesRepo>) {
  messages.seed({
    bookingRequestId: REQUEST_ID,
    authorSide: "SYSTEM",
    body: "",
    systemKind: "booking_request.bill_changed",
    systemData: BILL_CHANGED,
  });
}

describe("bill_changed on the ACT side (FR-013)", () => {
  it("a joined act reads only that the bill changed, plus joined / by-name names — no invited name, count or flag", async () => {
    const { deps, repos, messages } = buildDeps();
    await joinedArtist(repos);
    seed(messages);

    const page = await listBookingRequestMessages(deps, {
      actorHumanId: ARTIST_ID,
      bookingRequestId: REQUEST_ID,
      side: "ACT",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.systemData).toEqual({
      added: [
        { actId: ACT_ID, name: "Junco", source: "EXTERNAL", state: "by_name" },
        { actId: ACT_ID, name: "Sam Sender", source: "SELF", state: "joined" },
      ],
      removed: [{ name: "Paper Moth", wasState: "joined" }],
      changed: true,
    });
    const json = JSON.stringify(page.items);
    expect(json).not.toContain("Maren Sky");
    for (const key of ["otherRemovedCount", "invitedAddedCount", "reordered", "roleChanged"]) {
      expect(json).not.toContain(key);
    }
  });

  it("the venue and the sender read the entry as written", async () => {
    const { deps, messages } = buildDeps();
    seed(messages);
    const venue = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(venue.items[0]!.systemData).toEqual(BILL_CHANGED);
    const sender = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(sender.items[0]!.systemData).toEqual(BILL_CHANGED);
  });

  it("redactForAct fails closed: rows with no readable state are dropped without a trace; other kinds pass untouched", () => {
    const row = {
      id: "m1",
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM" as const,
      authorHumanId: null,
      body: "",
      readAt: null,
      createdAt: NOW,
      systemKind: "booking_request.bill_changed",
      systemData: {
        added: [{ name: "Mystery" }, null],
        removed: [{ name: "Ghost", wasState: "invited" }],
        otherRemovedCount: 3,
      },
    };
    expect(redactForAct(row as never).systemData).toEqual({
      added: [],
      removed: [],
      changed: true,
    });
    const other = { ...row, systemKind: "booking_request.act_confirmed", systemData: { actName: "X" } };
    expect(redactForAct(other as never)).toBe(other);
  });
});

describe("act_joined_lineup follows the act's CURRENT state (v3 FR-010)", () => {
  it("the venue stops reading 'X is on the lineup' once the act passes; the sender keeps the history", async () => {
    const { deps, repos, messages } = buildDeps();
    const acts = repos.bookingRequests as unknown as ListBookingRequestMessagesDeps["repos"]["bookingRequests"];
    await joinedArtist(repos);
    const act = (await acts.listActsForRequests([REQUEST_ID]))[0]!;
    messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      body: "",
      systemKind: "booking_request.act_joined_lineup",
      systemData: { actId: act.id, eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", actName: "Artie" },
    });
    const venueRead = { actorHumanId: VENUE_OWNER_ID, bookingRequestId: REQUEST_ID, side: "VENUE" };
    expect((await listBookingRequestMessages(deps, venueRead)).items).toHaveLength(1);

    // The act leaves (CONFIRMED → DECLINED).
    await acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: ARTIST_ID,
      expectedFrom: "CONFIRMED",
      to: "DECLINED",
      respondedAt: NOW,
    });
    expect((await listBookingRequestMessages(deps, venueRead)).items).toEqual([]);
    const sender = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(sender.items.map((row) => row.systemKind)).toEqual([
      "booking_request.act_joined_lineup",
    ]);
  });
});
