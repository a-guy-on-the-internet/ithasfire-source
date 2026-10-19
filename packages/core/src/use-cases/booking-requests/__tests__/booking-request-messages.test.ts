import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { postBookingRequestMessage } from "../messages/post-message";
import type { PostBookingRequestMessageDeps } from "../messages/post-message";
import { listBookingRequestMessages } from "../messages/list-messages";
import { markBookingRequestMessagesRead } from "../messages/mark-read";
import {
  LEGACY_OWNER_SIDE,
  LEGACY_REQUEST_DIRECTION,
  LEGACY_SYSTEM_ENTRY_KINDS,
  LEGACY_THREAD_SIDE,
} from "../../../lib/legacy-place-values";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  NOW,
  ORG_ID,
  OTHER_HUMAN_ID,
  ORGANIZER_ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "./helpers";

// The venue-side owner is a DIFFERENT human than the performer sender
// (helpers' default performer owner is ACTOR_ID).
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const OUTSIDER_ID = "14141414-1414-4141-8141-141414141414";
const VIEWER_MEMBER_ID = "15151515-1515-4151-8151-151515151515";

type BuildOptions = {
  request?: BookingRequestRecord | null;
  /** Human ids with venue access via getPlaceAccessContext / the place row. */
  venueOwnerIds?: string[];
  /** Org ids owning the place (reader-gate membership-any path). */
  placeOrgIds?: string[];
  /** `${orgId}:${humanId}` → role for the org-membership fakes. */
  memberships?: Record<string, string>;
  notify?: ReturnType<typeof vi.fn>;
};

function buildDeps(options: BuildOptions = {}) {
  const request =
    options.request === undefined
      ? buildBookingRequestRecord()
      : options.request;
  const messages = createFakeBookingRequestMessagesRepo();

  const touched: Array<{ id: string; at: Date }> = [];
  const bookingRequests = {
    getById: vi.fn(async (id: string) =>
      request && id === request.id ? request : null,
    ),
    touchLastMessageAt: vi.fn(async (input: { id: string; at: Date }) => {
      touched.push(input);
    }),
  };

  const memberships = options.memberships ?? {};
  const placeOrgIds = options.placeOrgIds ?? [];
  const venueOwnerIds = options.venueOwnerIds ?? [VENUE_OWNER_ID];
  const place = buildPlaceRecord({
    humanIdsWithAccess: venueOwnerIds,
    orgIdsWithAccess: placeOrgIds,
  });
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
  };
  const authz = {
    getPlaceAccessContext: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? {
            owningOrgIds: placeOrgIds,
            verifiedHumanOwnerIds: venueOwnerIds,
          }
        : null,
    ),
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        const role = memberships[`${orgId}:${humanId}`];
        return role ? { orgId, humanId, role } : null;
      },
    ),
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        orgIds
          .map((orgId) => ({
            orgId,
            humanId,
            role: memberships[`${orgId}:${humanId}`],
          }))
          .filter((m) => m.role),
    ),
  };

  const audit = { log: vi.fn(async () => {}) };
  const notify = options.notify;
  const reportError = vi.fn();

  const mocks = {
    bookingRequests,
    bookingRequestMessages: messages,
    places,
    authz,
    audit,
  };

  const deps = {
    repos: withTx(mocks) as unknown as PostBookingRequestMessageDeps["repos"],
    clock: { now: () => NOW },
    ...(notify ? { notifyBookingRequestMessagePosted: notify } : {}),
    reportError,
  } satisfies Partial<PostBookingRequestMessageDeps> as PostBookingRequestMessageDeps;

  return { deps, mocks, messages, touched, reportError };
}

const postInput = (overrides: Record<string, unknown> = {}) => ({
  actorHumanId: VENUE_OWNER_ID,
  bookingRequestId: REQUEST_ID,
  side: "VENUE",
  body: "Does the 10th work for you?",
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// post-message
// ─────────────────────────────────────────────────────────────────────────────

describe("postBookingRequestMessage", () => {
  it("venue side: appends the message AND bumps lastMessageAt in the SAME tx", async () => {
    const { deps, mocks, messages, touched } = buildDeps();

    const result = await postBookingRequestMessage(deps, postInput());

    expect(result.authorSide).toBe("VENUE");
    expect(result.authorHumanId).toBe(VENUE_OWNER_ID);
    expect(result.body).toBe("Does the 10th work for you?");
    expect(messages.rows.size).toBe(1);

    // touchLastMessageAt rode the same tx bag with the message create and
    // used the created message's timestamp.
    expect(touched).toEqual([{ id: REQUEST_ID, at: result.createdAt }]);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_request",
        action: "booking_request.message_posted",
        data: expect.objectContaining({
          authorSide: "VENUE",
          messageId: result.id,
        }),
      }),
    );
    // Audit is metadata-only: never the body content.
    const auditData = (
      mocks.audit.log.mock.calls[0]![0] as { data: Record<string, unknown> }
    ).data;
    expect(JSON.stringify(auditData)).not.toContain("Does the 10th");
  });

  it("performer side (owned human) posts with PERFORMER authorSide", async () => {
    const { deps } = buildDeps();
    const result = await postBookingRequestMessage(
      deps,
      postInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
    );
    expect(result.authorSide).toBe("PERFORMER");
  });

  it("sanitizes the body via the house helper before persisting", async () => {
    const { deps } = buildDeps();
    const result = await postBookingRequestMessage(
      deps,
      postInput({ body: "  <b>hello</b>\n\nsee you " }),
    );
    expect(result.body).not.toContain("<b>");
    expect(result.body).toContain("hello");
  });

  it("SYSTEM is never client-postable (schema rejects the side)", async () => {
    const { deps, messages } = buildDeps();
    await expect(
      postBookingRequestMessage(deps, postInput({ side: "SYSTEM" })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(messages.rows.size).toBe(0);
  });

  it("rejects a body over 4000 chars", async () => {
    const { deps } = buildDeps();
    await expect(
      postBookingRequestMessage(deps, postInput({ body: "x".repeat(4001) })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── The thread NEVER closes ──────────────────────────────────────────────
  // The request's conversation is the booking's history, so a terminal status
  // does not lock it. This used to be the exact opposite behaviour
  // (`assertThreadWritable` threw `booking_thread_closed` on DECLINED /
  // WITHDRAWN / EXPIRED); these cases pin the guarantee rather than leaving
  // "still writable" merely untested, which is how a status gate would sneak
  // back in.

  it.each([
    "PENDING",
    "VIEWED",
    "ACCEPTED",
    "DECLINED",
    "WITHDRAWN",
    "EXPIRED",
  ] as const)(
    "a %s request still accepts a post and bumps lastMessageAt",
    async (status) => {
      const { deps, messages, touched } = buildDeps({
        request: buildBookingRequestRecord({ status }),
      });

      const result = await postBookingRequestMessage(deps, postInput());

      expect(result.authorSide).toBe("VENUE");
      expect(messages.rows.size).toBe(1);
      expect(touched).toEqual([{ id: REQUEST_ID, at: result.createdAt }]);
    },
  );

  it("both sides can still converse on a DECLINED request (history, not a lock)", async () => {
    const { deps, messages } = buildDeps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
    });

    await postBookingRequestMessage(
      deps,
      postInput({ body: "Sorry we couldn't make it work this time." }),
    );
    const reply = await postBookingRequestMessage(
      deps,
      postInput({
        actorHumanId: ACTOR_ID,
        side: "PERFORMER",
        body: "No worries — keep us in mind for the spring.",
      }),
    );

    expect(reply.authorSide).toBe("PERFORMER");
    expect(messages.rows.size).toBe(2);
  });

  it("authz still applies on a closed thread — an outsider cannot post to it", async () => {
    // Only the STATUS gate went; the participant bar is untouched.
    const { deps, messages } = buildDeps({
      request: buildBookingRequestRecord({ status: "EXPIRED" }),
    });
    await expect(
      postBookingRequestMessage(deps, postInput({ actorHumanId: OUTSIDER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(messages.rows.size).toBe(0);
  });

  it("an OUTSIDER is rejected on both declared sides with no mutation", async () => {
    const { deps, messages } = buildDeps();

    await expect(
      postBookingRequestMessage(deps, postInput({ actorHumanId: OUTSIDER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      postBookingRequestMessage(
        deps,
        postInput({ actorHumanId: OUTSIDER_ID, side: "PERFORMER" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(messages.rows.size).toBe(0);
  });

  it("a VENUE claim by the PERFORMER (and vice versa) is rejected — declared side is verified", async () => {
    const { deps } = buildDeps();
    // The performer (ACTOR_ID) claims the venue side.
    await expect(
      postBookingRequestMessage(deps, postInput({ actorHumanId: ACTOR_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    // The venue owner claims the performer side.
    await expect(
      postBookingRequestMessage(
        deps,
        postInput({ actorHumanId: VENUE_OWNER_ID, side: "PERFORMER" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("anonymous request: performer side has no signed-in participant", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Jane",
        contactEmail: "jane@example.com",
        source: "EMBED",
      }),
    });
    await expect(
      postBookingRequestMessage(
        deps,
        postInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // ── Shadow-owner outreach (booking-inquirer-outreach, 2026-09-05) ────────
  //
  // `notifyBookingInquirer` attaches a SHADOW performer owner pair to an
  // UNCLAIMED embed inquiry so the venue's reply has somewhere to be mailed.
  // That makes `getBookingRequestSender` report the row as `owned`, which on
  // its own would collapse the PERFORMER gate to
  // `actorHumanId === shadowHumanId` — and that shadow IS reachable, because
  // `apps/api/src/auth/shadow-upgrade.ts` attaches a credential account from a
  // sign-up body and `requireEmailVerification` is false, so signing up proves
  // nothing about mailbox control. Both gates must therefore refuse on
  // `isUnclaimedBookingInquiry`, NOT on the sender narrowing.
  const SHADOW_HUMAN_ID = "16161616-1616-4161-8161-161616161616";

  const shadowOwnedUnclaimedInquiry = (
    overrides: Partial<BookingRequestRecord> = {},
  ) =>
    buildBookingRequestRecord({
      performerOwnerType: "human",
      performerOwnerId: SHADOW_HUMAN_ID,
      contactName: "Jane",
      contactEmail: "jane@example.com",
      source: "EMBED",
      claimedAt: null,
      ...overrides,
    });

  it("SHADOW-owned but UNCLAIMED inquiry: the write gate still refuses the shadow", async () => {
    const { deps } = buildDeps({ request: shadowOwnedUnclaimedInquiry() });
    await expect(
      postBookingRequestMessage(
        deps,
        postInput({ actorHumanId: SHADOW_HUMAN_ID, side: "PERFORMER" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("SHADOW-owned but UNCLAIMED inquiry: the VENUE can still POST (outreach's own precondition)", async () => {
    // THE FEATURE'S PRECONDITION, PINNED. Every other test around the shadow
    // owner asserts a REFUSAL, so hoisting the `isUnclaimedBookingInquiry`
    // guard above the `side === "VENUE"` branch would kill the entire
    // venue→inquirer outreach path — there would be no venue reply to mail —
    // and leave the suite green.
    const { deps, messages, touched } = buildDeps({
      request: shadowOwnedUnclaimedInquiry(),
    });

    const posted = await postBookingRequestMessage(deps, postInput());

    expect(posted.authorSide).toBe("VENUE");
    expect(posted.authorHumanId).toBe(VENUE_OWNER_ID);
    expect(messages.rows.size).toBe(1);
    // The post-commit hook that mails the inquirer hangs off this bump.
    expect(touched).toEqual([{ id: REQUEST_ID, at: posted.createdAt }]);
  });

  it("CLAIMING the inquiry is what opens the write gate", async () => {
    // Redeeming the invite-to-claim token (FR-007) is the one mechanism that
    // proves mailbox control, and it stamps `claimedAt`.
    const { deps } = buildDeps({
      request: shadowOwnedUnclaimedInquiry({
        claimedAt: new Date("2026-06-09T00:00:00.000Z"),
      }),
    });
    const posted = await postBookingRequestMessage(
      deps,
      postInput({ actorHumanId: SHADOW_HUMAN_ID, side: "PERFORMER" }),
    );
    expect(posted.authorSide).toBe("PERFORMER");
  });

  it("TO_PERFORMER direction: organizer org edit member posts as VENUE; the act as PERFORMER", async () => {
    const request = buildOrganizerBookingRequestRecord();
    const { deps } = buildDeps({
      request,
      memberships: { [`${ORGANIZER_ORG_ID}:${OTHER_HUMAN_ID}`]: "ADMIN" },
    });

    // Organizer side (the thread's VENUE slot).
    const fromOrg = await postBookingRequestMessage(
      deps,
      postInput({ actorHumanId: OTHER_HUMAN_ID }),
    );
    expect(fromOrg.authorSide).toBe("VENUE");

    // The act (helpers' default: human ACTOR_ID).
    const fromAct = await postBookingRequestMessage(
      deps,
      postInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
    );
    expect(fromAct.authorSide).toBe("PERFORMER");
  });

  it("TO_PERFORMER: a VIEWER-role organizer member cannot post", async () => {
    const request = buildOrganizerBookingRequestRecord();
    const { deps } = buildDeps({
      request,
      memberships: { [`${ORGANIZER_ORG_ID}:${OTHER_HUMAN_ID}`]: "VIEWER" },
    });
    await expect(
      postBookingRequestMessage(
        deps,
        postInput({ actorHumanId: OTHER_HUMAN_ID }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("TO_VENUE: a VIEWER member of the owning org cannot post (write gate stays edit-role)", async () => {
    const { deps, messages } = buildDeps({
      placeOrgIds: [ORG_ID],
      memberships: { [`${ORG_ID}:${VIEWER_MEMBER_ID}`]: "VIEWER" },
    });
    await expect(
      postBookingRequestMessage(
        deps,
        postInput({ actorHumanId: VIEWER_MEMBER_ID }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(messages.rows.size).toBe(0);
  });

  it("unknown request id → BOOKING_REQUEST_NOT_FOUND", async () => {
    const { deps } = buildDeps({ request: null });
    await expect(
      postBookingRequestMessage(deps, postInput()),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
  });

  it("a request that VANISHES between the read and the tx → BOOKING_REQUEST_NOT_FOUND", async () => {
    // The in-tx re-read survives the status-gate removal because the row can
    // still disappear underneath us: Place/Organization cascade-delete their
    // booking requests. Without it, the message insert would fail as a raw
    // Prisma FK error instead of the typed domain error.
    const { deps, mocks, messages } = buildDeps();
    mocks.bookingRequests.getById
      .mockResolvedValueOnce(buildBookingRequestRecord())
      .mockResolvedValueOnce(null);

    await expect(
      postBookingRequestMessage(deps, postInput()),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    expect(messages.rows.size).toBe(0);
  });

  it("notifies the OTHER side post-commit with the message payload", async () => {
    const notify = vi.fn(async () => {});
    const { deps } = buildDeps({ notify });

    const result = await postBookingRequestMessage(deps, postInput());

    expect(notify).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_ID }),
      message: expect.objectContaining({ id: result.id }),
      recipientSide: "PERFORMER",
    });
  });

  it("a THROWING notifier never fails the committed message AND is reported (regression)", async () => {
    const notify = vi.fn(async () => {
      throw new Error("notify pipeline down");
    });
    const { deps, messages, reportError } = buildDeps({ notify });

    const result = await postBookingRequestMessage(deps, postInput());

    expect(result.id).toBeDefined();
    expect(messages.rows.size).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "postBookingRequestMessage" },
        extra: expect.objectContaining({ bookingRequestId: REQUEST_ID }),
      }),
    );
  });

  it("a THROWING reporter in the notify swallow still returns the message", async () => {
    const notify = vi.fn(async () => {
      throw new Error("notify down");
    });
    const { deps, reportError } = buildDeps({ notify });
    reportError.mockImplementation(() => {
      throw new Error("reporter down too");
    });

    await expect(
      postBookingRequestMessage(deps, postInput()),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// list-messages
// ─────────────────────────────────────────────────────────────────────────────

describe("listBookingRequestMessages", () => {
  it("returns the thread oldest-first with a working cursor", async () => {
    const { deps, messages } = buildDeps();
    const m1 = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      body: "first",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    const m2 = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "VENUE",
      body: "second",
      createdAt: new Date("2026-06-10T11:00:00Z"),
    });
    const m3 = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      body: "third",
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const page1 = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      limit: 2,
    });
    expect(page1.items.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(page1.nextCursor).toBe(m2.id);

    const page2 = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items.map((m) => m.id)).toEqual([m3.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("closed threads still list (calm read-only state)", async () => {
    const { deps, messages } = buildDeps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
    });
    messages.seed({ bookingRequestId: REQUEST_ID, body: "history" });

    const page = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(page.items).toHaveLength(1);
  });

  it("a VIEWER member of the owning org CAN list (read gate mirrors the inbox: membership-any)", async () => {
    const { deps, messages } = buildDeps({
      placeOrgIds: [ORG_ID],
      memberships: { [`${ORG_ID}:${VIEWER_MEMBER_ID}`]: "VIEWER" },
    });
    messages.seed({ bookingRequestId: REQUEST_ID, body: "hello" });

    const page = await listBookingRequestMessages(deps, {
      actorHumanId: VIEWER_MEMBER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(page.items).toHaveLength(1);
  });

  it("SHADOW-owned but UNCLAIMED inquiry: the READ gate refuses the shadow too", async () => {
    // The venue's replies are private until the inquirer proves the mailbox.
    const shadowId = "16161616-1616-4161-8161-161616161616";
    const { deps, messages } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: "human",
        performerOwnerId: shadowId,
        contactName: "Jane",
        contactEmail: "jane@example.com",
        source: "EMBED",
        claimedAt: null,
      }),
    });
    messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "VENUE",
      body: "our private counter-offer",
    });

    await expect(
      listBookingRequestMessages(deps, {
        actorHumanId: shadowId,
        bookingRequestId: REQUEST_ID,
        side: "PERFORMER",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    // mark-read rides the same reader gate.
    await expect(
      markBookingRequestMessagesRead(deps, {
        actorHumanId: shadowId,
        bookingRequestId: REQUEST_ID,
        side: "PERFORMER",
        upToCreatedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("SHADOW-owned but UNCLAIMED inquiry: the VENUE side still LISTS", async () => {
    // Same precondition as the post gate: the venue reads its own thread with
    // an unclaimed inquirer, otherwise the admin inbox goes dark on exactly
    // the conversations outreach exists to carry.
    const shadowId = "16161616-1616-4161-8161-161616161616";
    const { deps, messages } = buildDeps({
      request: buildBookingRequestRecord({
        performerOwnerType: "human",
        performerOwnerId: shadowId,
        contactName: "Jane",
        contactEmail: "jane@example.com",
        source: "EMBED",
        claimedAt: null,
      }),
    });
    messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "VENUE",
      body: "our counter-offer",
    });

    const page = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });

    expect(page.items).toHaveLength(1);
  });

  it("outsiders cannot list", async () => {
    const { deps } = buildDeps();
    await expect(
      listBookingRequestMessages(deps, {
        actorHumanId: OUTSIDER_ID,
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("venue-internal ledger kinds (booking_request.assigned) are dropped for the PERFORMER side and kept for VENUE", async () => {
    const { deps, messages } = buildDeps();
    const hello = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "VENUE",
      body: "hello",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    const assigned = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      authorHumanId: VENUE_OWNER_ID,
      body: "",
      systemKind: "booking_request.assigned",
      systemData: { assigneeHumanId: VENUE_OWNER_ID, previousAssigneeHumanId: null },
      createdAt: new Date("2026-06-10T11:00:00Z"),
    });
    const placed = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      body: "",
      systemKind: "booking_hold.placed",
      systemData: { holdId: "11111111-1111-4111-8111-111111111111", date: "2026-07-10", position: 1 },
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const performer = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(performer.items.map((m) => m.id)).toEqual([hello.id, placed.id]);
    expect(JSON.stringify(performer)).not.toContain("booking_request.assigned");

    const venue = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(venue.items.map((m) => m.id)).toEqual([hello.id, assigned.id, placed.id]);
  });

  it("ledger rows stored before 2026-10-18 read in the current place spelling; the stored rows are untouched", async () => {
    // `lib/legacy-place-values` holds every old spelling; the read boundary
    // normalises kind and params, so no reader past it sees two spellings.
    const { deps, messages } = buildDeps();
    const EVENT = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3";
    const at = (h: number) => new Date(`2026-06-10T${String(h).padStart(2, "0")}:00:00Z`);
    const system = (systemKind: string, systemData: Record<string, unknown>, h: number) =>
      messages.seed({
        bookingRequestId: REQUEST_ID,
        authorSide: "SYSTEM",
        body: "",
        systemKind,
        systemData,
        createdAt: at(h),
      });
    const opened = system("booking_request.opened", { direction: LEGACY_REQUEST_DIRECTION, source: "PLATFORM" }, 9);
    const countered = system("booking_agreement.countered", { agreementId: AGREEMENT_ID, actorSide: LEGACY_THREAD_SIDE }, 10);
    const confirmed = system(
      LEGACY_SYSTEM_ENTRY_KINDS["booking_event.place_confirmed"],
      { eventId: EVENT, ownerSide: LEGACY_OWNER_SIDE },
      11,
    );
    const withdrawn = system(
      LEGACY_SYSTEM_ENTRY_KINDS["booking_event.place_confirmation_withdrawn"],
      { eventId: EVENT, reason: "Double booked." },
      12,
    );
    const cancelled = system("booking_request.booking_cancelled", { by: LEGACY_OWNER_SIDE, reason: "Storm." }, 13);
    const closed = system(LEGACY_SYSTEM_ENTRY_KINDS["booking_request.closed_by_place"], { reason: "Went another way." }, 14);
    // A row written by this build reads the same.
    const fresh = system("booking_event.place_confirmed", { eventId: EVENT, ownerSide: "requester" }, 15);

    const page = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    const read = (id: string) => page.items.find((m) => m.id === id);
    expect(read(opened.id)).toMatchObject({
      systemKind: "booking_request.opened",
      systemData: { direction: "TO_PLACE", source: "PLATFORM" },
    });
    expect(read(countered.id)?.systemData).toEqual({ agreementId: AGREEMENT_ID, actorSide: "PLACE" });
    expect(read(confirmed.id)).toMatchObject({
      systemKind: "booking_event.place_confirmed",
      systemData: { eventId: EVENT, ownerSide: "place" },
    });
    expect(read(withdrawn.id)).toMatchObject({
      systemKind: "booking_event.place_confirmation_withdrawn",
      systemData: { eventId: EVENT, reason: "Double booked." },
    });
    expect(read(cancelled.id)?.systemData).toEqual({ by: "place", reason: "Storm." });
    expect(read(closed.id)).toMatchObject({
      systemKind: "booking_request.closed_by_place",
      systemData: { reason: "Went another way." },
    });
    expect(read(fresh.id)).toMatchObject({
      systemKind: "booking_event.place_confirmed",
      systemData: { eventId: EVENT, ownerSide: "requester" },
    });
    expect(page.items.map((m) => m.id)).toEqual([
      opened.id,
      countered.id,
      confirmed.id,
      withdrawn.id,
      cancelled.id,
      closed.id,
      fresh.id,
    ]);
    // Append-only: the stored rows keep what was written.
    expect(confirmed.systemKind).toBe(LEGACY_SYSTEM_ENTRY_KINDS["booking_event.place_confirmed"]);
    expect(confirmed.systemData).toEqual({ eventId: EVENT, ownerSide: LEGACY_OWNER_SIDE });
  });

  it("sender-only ledger kinds (booking_request.act_declined) are dropped for the VENUE side and kept for the sender", async () => {
    // lineup v2 FR-004: a declined act is hidden from every venue-facing
    // render — the data never reaches the venue client at all.
    const { deps, messages } = buildDeps();
    // Two DIFFERENT tagged acts: one confirmed (still on the bill), one
    // declined. (The same act confirmed-then-declined is a WITHDRAWAL, whose
    // confirmation the venue must not see either — covered in
    // answer-booking-request-act.test.ts.)
    const acts = deps.repos.bookingRequests;
    const [weeds, nope] = await acts.addActs(REQUEST_ID, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: OTHER_HUMAN_ID, sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: OUTSIDER_ID, sortOrder: 1 },
    ]);
    for (const [actOwnerId, to] of [
      [OTHER_HUMAN_ID, "CONFIRMED"],
      [OUTSIDER_ID, "DECLINED"],
    ] as const) {
      await acts.setActConfirmation({
        bookingRequestId: REQUEST_ID,
        actOwnerType: "human",
        actOwnerId,
        expectedFrom: "PENDING",
        to,
        respondedAt: NOW,
      });
    }
    const hello = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      body: "hello",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    const confirmed = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      body: "",
      systemKind: "booking_request.act_confirmed",
      systemData: { actId: weeds!.id, actName: "The Weeds" },
      createdAt: new Date("2026-06-10T11:00:00Z"),
    });
    const declined = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      body: "",
      systemKind: "booking_request.act_declined",
      systemData: { actId: nope!.id, actName: "Nope Band" },
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const venue = await listBookingRequestMessages(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(venue.items.map((m) => m.id)).toEqual([hello.id, confirmed.id]);
    expect(JSON.stringify(venue)).not.toContain("booking_request.act_declined");
    expect(JSON.stringify(venue)).not.toContain("Nope Band");

    const sender = await listBookingRequestMessages(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(sender.items.map((m) => m.id)).toEqual([
      hello.id,
      confirmed.id,
      declined.id,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mark-read
// ─────────────────────────────────────────────────────────────────────────────

describe("markBookingRequestMessagesRead", () => {
  // INVERTED with the system-entry migration: this used to assert SYSTEM rows
  // were stamped alongside the counterparty's. They are not, and must not be —
  // an entry can never be unread, so a read receipt on one is a receipt for a
  // state that does not exist, and it would break markRead's exact-complement
  // relationship with countUnreadByRequest.
  it("stamps ONLY the opposite side's messages up to the cutoff, never SYSTEM entries — idempotent", async () => {
    const { deps, messages } = buildDeps();
    const theirs = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });
    const system = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "SYSTEM",
      systemKind: "booking_request.viewed",
      systemData: {},
      body: "",
      createdAt: new Date("2026-06-10T10:30:00Z"),
    });
    const mine = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "VENUE",
      createdAt: new Date("2026-06-10T11:00:00Z"),
    });
    const later = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const result = await markBookingRequestMessagesRead(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      upToCreatedAt: new Date("2026-06-10T11:30:00Z"),
    });

    expect(result.updated).toBe(1); // theirs only; never mine, SYSTEM or later
    expect(messages.rows.get(theirs.id)!.readAt).not.toBeNull();
    // The load-bearing inversion.
    expect(messages.rows.get(system.id)!.readAt).toBeNull();
    expect(messages.rows.get(mine.id)!.readAt).toBeNull();
    expect(messages.rows.get(later.id)!.readAt).toBeNull();

    // Idempotent repeat.
    const again = await markBookingRequestMessagesRead(deps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      upToCreatedAt: new Date("2026-06-10T11:30:00Z"),
    });
    expect(again.updated).toBe(0);
  });

  it("a VIEWER member of the owning org CAN mark read (reading, not conversing)", async () => {
    const { deps, messages } = buildDeps({
      placeOrgIds: [ORG_ID],
      memberships: { [`${ORG_ID}:${VIEWER_MEMBER_ID}`]: "VIEWER" },
    });
    const theirs = messages.seed({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      createdAt: new Date("2026-06-10T10:00:00Z"),
    });

    const result = await markBookingRequestMessagesRead(deps, {
      actorHumanId: VIEWER_MEMBER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      upToCreatedAt: NOW,
    });
    expect(result.updated).toBe(1);
    expect(messages.rows.get(theirs.id)!.readAt).not.toBeNull();
  });

  it("outsiders cannot mark read", async () => {
    const { deps } = buildDeps();
    await expect(
      markBookingRequestMessagesRead(deps, {
        actorHumanId: OUTSIDER_ID,
        bookingRequestId: REQUEST_ID,
        side: "PERFORMER",
        upToCreatedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});
