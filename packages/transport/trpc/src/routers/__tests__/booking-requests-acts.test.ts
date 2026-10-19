import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import type { Ctx } from "../../context";
import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The bill over the wire (lineup-booking-requests v2): a tagged artist's
// confirmAct / declineAct / getActInvite, the `bill` on list summaries, and
// the read-only ACT side on the thread procedures.
// ─────────────────────────────────────────────────────────────────────────────

const SENDER_ID = "11111111-1111-4111-8111-111111111111";
const ARTIST_ID = "12121212-1212-4121-8121-121212121212";
const STRANGER_ID = "18181818-1818-4181-8181-181818181818";
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function buildRequest(): BookingRequestRecord {
  return {
    id: REQUEST_ID,
    direction: "TO_VENUE",
    intent: "PERFORM",
    spaceId: null,
    requestedStartsAt: null,
    requestedEndsAt: null,
    expectedAttendance: null,
    purpose: null,
    originEventId: null,
    parkedUnclaimedAt: null,
    billRecorded: true,
    placeId: PLACE_ID,
    placeName: "Test Venue",
    calendarId: null,
    calendarName: null,
    organizerOrgId: null,
    organizerOrgName: null,
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    performerOwnerType: "human",
    performerOwnerId: SENDER_ID,
    contactName: null,
    contactEmail: null,
    source: "PLATFORM",
    embedId: null,
    claimTokenHash: null,
    claimTokenExpiresAt: null,
    claimedAt: null,
    inquirerEmailMessageId: null,
    inquirerEmailUndeliverableAt: null,
    inquirerEmailUndeliverableStatus: null,
    message: "A three-band night.",
    preferredDates: ["2026-07-10"],
    expectedDraw: 80,
    genre: "punk",
    links: [],
    actName: null,
    lineupSize: null,
    setLengthMinutes: null,
    contactPhone: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    linkMusic: null,
    linkVideo: null,
    linkSocial: null,
    linkEpk: null,
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    verifiedStatsSnapshot: null,
    assigneeHumanId: null,
    tags: [],
    taxFormStatus: "NONE",
    lastMessageAt: null,
    expiresAt: new Date("2026-06-24T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  } as BookingRequestRecord;
}

async function buildRepos() {
  const request = buildRequest();
  const acts = createFakeBookingRequestActs({
    senderOf: (id) =>
      id === REQUEST_ID ? { ownerType: "human", ownerId: SENDER_ID } : undefined,
  });
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST_ID, sortOrder: 1 },
    { source: "EXTERNAL", externalName: "The Weeds", externalUrl: "https://weeds.example", sortOrder: 2 },
  ]);
  const messages = createFakeBookingRequestMessagesRepo();
  const place = {
    id: PLACE_ID,
    name: "Test Venue",
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    acceptsBookingRequests: true,
    humanIdsWithAccess: [VENUE_OWNER_ID],
    orgIdsWithAccess: [],
  };
  const mocks = {
    bookingRequests: {
      getById: vi.fn(async (id: string) => (id === REQUEST_ID ? request : null)),
      listForPlace: vi.fn(async () => [request]),
      touchLastMessageAt: vi.fn(async () => {}),
      addActs: acts.addActs,
      listActsForRequests: acts.listActsForRequests,
      getActForOwner: acts.getActForOwner,
      setActConfirmation: acts.setActConfirmation,
      lockBill: vi.fn(acts.lockBill),
      promoteActToSelf: acts.promoteActToSelf,
    },
    bookingRequestMessages: messages,
    agreements: {
      getById: vi.fn(async () => null),
      findManyByIds: vi.fn(async () => []),
    },
    events: {
      getById: vi.fn(async () => null),
      findManyByIds: vi.fn(async () => []),
    },
    bookingHolds: {
      listLiveForRequests: vi.fn(async () => []),
      listRequestIdsWithConfirmedHold: vi.fn(async () => []),
    },
    bookingTags: { listForRequests: vi.fn(async () => []) },
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: id === ARTIST_ID ? "Artie Artist" : "Sam Sender",
          status: "ACTIVE",
        })),
      ),
    },
    organizations: { getByIds: vi.fn(async () => []) },
    entityPages: {
      getByOwners: vi.fn(async () => []),
      getByOwner: vi.fn(async () => null),
    },
    places: { getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)) },
    authz: {
      getPlaceAccessContext: vi.fn(async () => ({
        owningOrgIds: [],
        verifiedHumanOwnerIds: [VENUE_OWNER_ID],
      })),
      getOrgMembership: vi.fn(async () => null),
      getOrgMemberships: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}) },
  };
  const repos = {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"];
  return { repos, mocks, acts, messages };
}

const allowAll = () =>
  vi.fn(async () => ({
    allowed: true,
    remaining: Number.POSITIVE_INFINITY,
    retryAfterSeconds: 0,
  }));

describe("bookingRequestsRouter.confirmAct / declineAct (lineup v2, FR-003)", () => {
  it("confirmAct: injects ctx.actorHumanId, CAS + ledger, output parses", async () => {
    const { repos, mocks, messages } = await buildRepos();
    const consume = allowAll();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    const result = await caller.confirmAct({ bookingRequestId: REQUEST_ID });

    expect(result).toMatchObject({
      bookingRequestId: REQUEST_ID,
      confirmation: "CONFIRMED",
      changed: true,
    });
    expect(mocks.bookingRequests.lockBill).toHaveBeenCalledWith(REQUEST_ID);
    expect(
      [...messages.rows.values()].map((row) => row.systemKind),
    ).toEqual(["booking_request.act_confirmed"]);
    // 30/hour per actor, one bucket shared by both answers.
    expect(consume).toHaveBeenCalledWith(
      `bookingRequests:answerAct:${ARTIST_ID}`,
      30,
      3600,
    );
  });

  it("declineAct: takes an optional reason; the same bucket as confirmAct", async () => {
    const { repos, acts } = await buildRepos();
    const consume = allowAll();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.declineAct({ bookingRequestId: REQUEST_ID, declineReason: "Booked that night" }),
    ).resolves.toMatchObject({ confirmation: "DECLINED", changed: true });
    await expect(
      acts.getActForOwner({
        bookingRequestId: REQUEST_ID,
        actOwnerType: "human",
        actOwnerId: ARTIST_ID,
      }),
    ).resolves.toMatchObject({ declineReason: "Booked that night" });
    expect(consume).toHaveBeenCalledWith(
      `bookingRequests:answerAct:${ARTIST_ID}`,
      30,
      3600,
    );
  });

  it("maps DECLINED → confirm to CONFLICT with the app code", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
    });
    await caller.declineAct({ bookingRequestId: REQUEST_ID });

    await expect(
      caller.confirmAct({ bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { appCode: "ACT_ALREADY_DECLINED" },
    });
  });

  it("a human who is not tagged gets NOT_FOUND — nothing written", async () => {
    const { repos, messages } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: STRANGER_ID,
    });

    await expect(
      caller.confirmAct({ bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      meta: { appCode: "BOOKING_REQUEST_NOT_FOUND" },
    });
    expect(messages.rows.size).toBe(0);
  });

  it("strict inputs: a smuggled actorHumanId (or unknown key) is BAD_REQUEST", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: STRANGER_ID,
    });

    await expect(
      caller.confirmAct({ bookingRequestId: REQUEST_ID, actorHumanId: ARTIST_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.declineAct({ bookingRequestId: REQUEST_ID, actId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an exhausted budget is TOO_MANY_REQUESTS before any read", async () => {
    const { repos, mocks } = await buildRepos();
    const deniedKey = `bookingRequests:answerAct:${ARTIST_ID}`;
    const consume = vi.fn(async (key: string) =>
      key === deniedKey
        ? { allowed: false, remaining: 0, retryAfterSeconds: 600 }
        : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.declineAct({ bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(deniedKey, 30, 3600);
    expect(mocks.bookingRequests.getById).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: null,
    });
    await expect(
      caller.confirmAct({ bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("bookingRequestsRouter.joinAct / passAct (lineup v3, FR-003)", () => {
  const GROUP_ID = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
  const GROUP_EDITOR_ID = "6e6e6e6e-6e6e-46e6-86e6-6e6e6e6e6e6e";

  it("joinAct and passAct answer like their v2 aliases, on the SAME 30/hour bucket", async () => {
    const { repos, messages } = await buildRepos();
    const consume = allowAll();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.joinAct({ bookingRequestId: REQUEST_ID }),
    ).resolves.toMatchObject({ confirmation: "CONFIRMED", changed: true });
    // Leaving after joining (L14), with a reason.
    await expect(
      caller.passAct({ bookingRequestId: REQUEST_ID, declineReason: "Van broke down" }),
    ).resolves.toMatchObject({ confirmation: "DECLINED", changed: true });
    // Final: the v2 alias of joinAct is refused the same way.
    await expect(caller.confirmAct({ bookingRequestId: REQUEST_ID })).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { appCode: "ACT_ALREADY_DECLINED" },
    });

    const bucketCalls = (consume.mock.calls as unknown as unknown[][]).filter(
      (call) => call[0] === `bookingRequests:answerAct:${ARTIST_ID}`,
    );
    expect(bucketCalls).toHaveLength(3);
    expect(bucketCalls[0]).toEqual([`bookingRequests:answerAct:${ARTIST_ID}`, 30, 3600]);
    expect(
      [...messages.rows.values()].map((row) => [row.systemKind, row.systemData]),
    ).toEqual([
      ["booking_request.act_confirmed", expect.objectContaining({ actName: "Artie Artist" })],
      [
        "booking_request.act_declined",
        expect.objectContaining({ reason: "Van broke down", left: true }),
      ],
    ]);
  });

  it("asOrgId: an editor of a tagged GROUP answers for it; a non-member naming the group gets NOT_FOUND", async () => {
    const { repos, mocks, acts } = await buildRepos();
    await acts.addActs(REQUEST_ID, [
      { source: "TAGGED", actOwnerType: "organization", actOwnerId: GROUP_ID, sortOrder: 3 },
    ]);
    mocks.authz.getOrgMemberships = vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        humanId === GROUP_EDITOR_ID && orgIds.includes(GROUP_ID)
          ? [{ orgId: GROUP_ID, humanId, role: "ADMIN" }]
          : [],
    ) as never;

    const stranger = createCaller(bookingRequestsRouter, { repos, actorHumanId: STRANGER_ID });
    await expect(
      stranger.caller.joinAct({ bookingRequestId: REQUEST_ID, asOrgId: GROUP_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", meta: { appCode: "BOOKING_REQUEST_NOT_FOUND" } });

    const editor = createCaller(bookingRequestsRouter, { repos, actorHumanId: GROUP_EDITOR_ID });
    await expect(
      editor.caller.joinAct({ bookingRequestId: REQUEST_ID, asOrgId: GROUP_ID }),
    ).resolves.toMatchObject({ confirmation: "CONFIRMED" });
    await expect(
      acts.getActForOwner({
        bookingRequestId: REQUEST_ID,
        actOwnerType: "organization",
        actOwnerId: GROUP_ID,
      }),
    ).resolves.toMatchObject({ confirmation: "CONFIRMED" });

    // The editor's invite read answers "as" the group.
    await expect(
      editor.caller.getActInvite({ bookingRequestId: REQUEST_ID }),
    ).resolves.toMatchObject({
      answeringAs: { ownerType: "organization", ownerId: GROUP_ID },
      myAct: { confirmation: "CONFIRMED" },
    });
  });

  it("strict inputs: a smuggled owner type or act id is BAD_REQUEST on the v3 names too", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, { repos, actorHumanId: ARTIST_ID });

    await expect(
      caller.joinAct({ bookingRequestId: REQUEST_ID, actOwnerType: "organization" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.passAct({ bookingRequestId: REQUEST_ID, actId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.joinAct({ bookingRequestId: REQUEST_ID, asOrgId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("bookingRequestsRouter.getActInvite (lineup v2, FR-003)", () => {
  it("the tagged artist reads their invite; the output schema survives", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
    });

    const invite = await caller.getActInvite({ bookingRequestId: REQUEST_ID });

    expect(invite).toMatchObject({
      bookingRequestId: REQUEST_ID,
      sender: { displayName: "Sam Sender", href: null },
      venue: { placeId: PLACE_ID, name: "Test Venue", pageSlug: null },
      myAct: { confirmation: "PENDING", sortOrder: 1 },
      eventMinted: false,
      canConfirm: true,
      canDecline: true,
      confirmBlockedReason: null,
      declineBlockedReason: null,
    });
    expect(invite.otherActs).toEqual([
      { source: "SELF", displayName: "Sam Sender", href: null, role: "PERFORMER", customRoleLabel: null, sortOrder: 0 },
      { source: "EXTERNAL", displayName: "The Weeds", href: null, role: "PERFORMER", customRoleLabel: null, sortOrder: 2 },
    ]);
    // v3: which identity the spot is (here: the viewer themselves), and the
    // full list of spots they answer for.
    expect(invite.answeringAs).toMatchObject({ ownerType: "human", ownerId: ARTIST_ID });
    expect(invite.identities).toHaveLength(1);
  });

  it("carries the blocked reason over the wire once the answer is terminal", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
    });
    await caller.declineAct({ bookingRequestId: REQUEST_ID });

    await expect(
      caller.getActInvite({ bookingRequestId: REQUEST_ID }),
    ).resolves.toMatchObject({
      canConfirm: false,
      confirmBlockedReason: "act_declined",
      canDecline: false,
      declineBlockedReason: null,
    });
  });

  it("is throttled per actor: 60/min, TOO_MANY_REQUESTS when spent", async () => {
    const { repos, mocks } = await buildRepos();
    // Deny ONLY this procedure's bucket (the global default limiter passes).
    const deniedKey = `bookingRequests:getActInvite:${ARTIST_ID}`;
    const consume = vi.fn(async (key: string) =>
      key === deniedKey
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.getActInvite({ bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(deniedKey, 60, 60);
    expect(mocks.bookingRequests.getById).not.toHaveBeenCalled();
  });

  it("anyone else gets NOT_FOUND", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: STRANGER_ID,
    });
    await expect(
      caller.getActInvite({ bookingRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("bookingRequestsRouter.list — the bill survives .output()", () => {
  it("venue inbox rows carry the ordered bill; free text has no link", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: VENUE_OWNER_ID,
    });

    const result = await caller.list({ scope: "venue", placeId: PLACE_ID });

    expect(result.requests[0].billUnavailable).toBe(false);
    expect(result.requests[0].bill).toEqual([
      expect.objectContaining({ source: "SELF", displayName: "Sam Sender", isSender: true, confirmation: "CONFIRMED" }),
      expect.objectContaining({ source: "TAGGED", displayName: "Artie Artist", confirmation: "PENDING" }),
      expect.objectContaining({ source: "EXTERNAL", displayName: "The Weeds", href: null }),
    ]);
  });
});

describe("bookingRequestsRouter.messages — side ACT (lineup v2, FR-008)", () => {
  it("a confirmed artist lists the thread and markRead is a no-op; a pending one is FORBIDDEN", async () => {
    const { repos, messages } = await buildRepos();
    messages.seed({ bookingRequestId: REQUEST_ID, authorSide: "VENUE", body: "Welcome!" });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
    });

    // Still PENDING: refused.
    await expect(
      caller.messages.list({ bookingRequestId: REQUEST_ID, side: "ACT" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await caller.confirmAct({ bookingRequestId: REQUEST_ID });
    const page = await caller.messages.list({ bookingRequestId: REQUEST_ID, side: "ACT" });
    expect(page.items.map((row: { body: string; systemKind: string | null }) => row.systemKind ?? row.body)).toEqual([
      "Welcome!",
      "booking_request.act_confirmed",
    ]);

    await expect(
      caller.messages.markRead({
        bookingRequestId: REQUEST_ID,
        side: "ACT",
        upToCreatedAt: new Date("2100-01-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ updated: 0 });
    expect([...messages.rows.values()].every((row) => row.readAt === null)).toBe(true);
  });

  it("a WITHDRAWN confirmation is gone from the venue's thread; a failed act read fails closed and reports through ctx.reportError", async () => {
    const { repos, mocks } = await buildRepos();
    const artist = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
    }).caller;
    await artist.confirmAct({ bookingRequestId: REQUEST_ID });
    await artist.declineAct({ bookingRequestId: REQUEST_ID }); // withdraw

    const reportError = vi.fn();
    const venue = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: VENUE_OWNER_ID,
      reportError,
    }).caller;
    const page = await venue.messages.list({ bookingRequestId: REQUEST_ID, side: "VENUE" });
    expect(page.items.map((row: { systemKind: string | null }) => row.systemKind)).toEqual([]);

    // Confirm again is impossible (DECLINED is terminal) — so re-seed a
    // confirmed act entry and break the act read to exercise fail-closed.
    const lookupError = new Error("acts down");
    const confirmedAct = await mocks.bookingRequests.addActs(REQUEST_ID, [
      {
        source: "TAGGED",
        actOwnerType: "human",
        actOwnerId: STRANGER_ID,
        sortOrder: 3,
      },
    ]);
    await mocks.bookingRequests.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: STRANGER_ID,
      expectedFrom: "PENDING",
      to: "CONFIRMED",
      respondedAt: new Date(),
    });
    mocks.bookingRequestMessages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      body: "",
      systemKind: "booking_request.act_confirmed",
      systemData: { actId: confirmedAct[0]!.id, actName: "Stranger" },
    });
    mocks.bookingRequests.listActsForRequests = vi.fn(async () => {
      throw lookupError;
    });

    const degraded = await venue.messages.list({ bookingRequestId: REQUEST_ID, side: "VENUE" });
    expect(degraded.items).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(lookupError, {
      tags: { useCase: "listBookingRequestMessages", step: "actConfirmations" },
      extra: { bookingRequestId: REQUEST_ID, side: "VENUE" },
    });
  });

  it("messages.post refuses side ACT at the schema", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
    });
    await expect(
      caller.messages.post({ bookingRequestId: REQUEST_ID, side: "ACT", body: "hi" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lineup v3: the sender edits the bill (FR-009), and an answer tells the
// sender (FR-012a). Deps assembly only — the rules are pinned in core.
// ─────────────────────────────────────────────────────────────────────────────

async function buildEditRepos() {
  const built = await buildRepos();
  const { acts, mocks } = built;
  Object.assign(mocks.bookingRequests, {
    softRemoveAct: acts.softRemoveAct,
    restoreAct: acts.restoreAct,
    setActSortOrders: acts.setActSortOrders,
    setActRole: acts.setActRole,
    setActName: vi.fn(),
  });
  Object.assign(mocks, {
    performerProfiles: { getByOwner: vi.fn(async () => null) },
  });
  return built;
}

describe("bookingRequestsRouter.editBill (lineup v3, FR-009)", () => {
  it("injects ctx.actorHumanId, writes the edit and one ledger entry; 30/hour per actor", async () => {
    const { repos, messages, acts } = await buildEditRepos();
    const consume = allowAll();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: SENDER_ID,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    const result = await caller.editBill({
      bookingRequestId: REQUEST_ID,
      ops: [{ kind: "add", act: { kind: "external", name: "Paper Kite" } }],
    });

    expect(result).toMatchObject({ bookingRequestId: REQUEST_ID, changed: true, entryWritten: true });
    expect(result.bill.map((item: { displayName: string | null }) => item.displayName)).toEqual([
      "Sam Sender",
      "Artie Artist",
      "The Weeds",
      "Paper Kite",
    ]);
    expect((await acts.listActsForRequests([REQUEST_ID])).length).toBe(4);
    expect([...messages.rows.values()].map((row) => row.systemKind)).toEqual([
      "booking_request.bill_changed",
    ]);
    expect(consume).toHaveBeenCalledWith(`bookingRequests:editBill:${SENDER_ID}`, 30, 3600);
  });

  it("refuses anyone but the sender, mapped with its app code — nothing written", async () => {
    const { repos, messages } = await buildEditRepos();
    const { caller } = createCaller(bookingRequestsRouter, { repos, actorHumanId: STRANGER_ID });
    await expect(
      caller.editBill({
        bookingRequestId: REQUEST_ID,
        ops: [{ kind: "add", act: { kind: "external", name: "Paper Kite" } }],
      }),
    ).rejects.toMatchObject({ meta: { appCode: "NOT_RESOURCE_OWNER" } });
    expect(messages.rows.size).toBe(0);
  });

  it("is strict at the boundary: an unknown op, an actor field, or no ops is BAD_REQUEST", async () => {
    const { repos } = await buildEditRepos();
    const { caller } = createCaller(bookingRequestsRouter, { repos, actorHumanId: SENDER_ID });
    for (const input of [
      { bookingRequestId: REQUEST_ID, ops: [{ kind: "confirm", actId: REQUEST_ID }] },
      { bookingRequestId: REQUEST_ID, ops: [{ kind: "removeSelf" }], actorHumanId: STRANGER_ID },
      { bookingRequestId: REQUEST_ID, ops: [] },
    ]) {
      await expect(caller.editBill(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
});

describe("bookingRequestsRouter.joinAct tells the sender (lineup v3, FR-012a)", () => {
  it("composes the in-app 'joined' notice to the sender, post-commit", async () => {
    const { repos, mocks } = await buildRepos();
    Object.assign(mocks.humans, {
      getByIdWithIdentity: vi.fn(async () => ({ identity: { username: "sam" } })),
    });
    const notify = vi.fn(async () => ({ ok: true }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ARTIST_ID,
      notify: notify as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.test",
    });

    await caller.joinAct({ bookingRequestId: REQUEST_ID });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SENDER_ID,
        variant: "booking.lineup-answered",
        payload: expect.objectContaining({
          answer: "joined",
          actName: "Artie Artist",
          targetUrl: "https://ithasfire.test/admin/@sam/bookings",
        }),
        channels: { email: { enabled: false }, push: { enabled: false }, sms: { enabled: false } },
      }),
    );
  });
});
