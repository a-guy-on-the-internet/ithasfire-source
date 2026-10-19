import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { BookingRequestMessageRow } from "@th/ports/repos/booking-request-messages";

import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

/**
 * Transport wiring for the booking thread + attachments (booking-conversation
 * 2026-07-14 / venue-hierarchy FR-012, FR-008):
 *
 * - `messages.post` carries the ~30/hour PER-ACTOR abuse throttle the post
 *   use case explicitly delegates to transport (its NOTE(step 6)), and
 *   composes the counterparty notification exactly like `create` composes
 *   notifyBookingRequestReceived (notifyWithEmail-first).
 * - `actorHumanId` always comes from ctx — a client-smuggled one is rejected
 *   by the `.strict()`-derived procedure inputs.
 * - attachments.add/list/delete are thin passes into the use cases.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111"; // test-helpers default
const PERFORMER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const PLACE_ID = "55555555-5555-4555-8555-555555555555";
const ATTACHMENT_ID = "66666666-6666-4666-8666-666666666666";
const SYSTEM_ENTRY_ID = "77777777-7777-4777-8777-777777777777";
const AGREEMENT_ID = "88888888-8888-4888-8888-888888888888";

const NOW = new Date("2026-08-19T12:00:00Z");

function makeRequest(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return {
    id: REQUEST_ID,
    direction: "TO_VENUE",
    placeId: PLACE_ID,
    placeName: "The Basement",
    organizerOrgId: null,
    organizerOrgName: null,
    performerOwnerType: "human",
    performerOwnerId: PERFORMER_ID,
    contactName: null,
    contactEmail: null,
    actName: "Loud Band",
    status: "PENDING",
    lastMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as BookingRequestRecord;
}

function makeMessage(
  overrides: Partial<BookingRequestMessageRow> = {},
): BookingRequestMessageRow {
  return {
    id: MESSAGE_ID,
    bookingRequestId: REQUEST_ID,
    authorSide: "VENUE",
    authorHumanId: ACTOR_ID,
    body: "See you at load-in.",
    // Null on a human message; a SYSTEM ledger entry carries both. The output
    // schema is `.strict()`, so omitting them here would fail the parse — which
    // is the point: the wire shape and the row shape stay in lockstep.
    systemKind: null,
    systemData: null,
    readAt: null,
    createdAt: NOW,
    ...overrides,
  } as BookingRequestMessageRow;
}

function buildRepos(opts: { request?: BookingRequestRecord } = {}) {
  const request = opts.request ?? makeRequest();

  const createMessage = vi.fn(async (input: { body: string }) =>
    makeMessage({ body: input.body }),
  );
  const touchLastMessageAt = vi.fn(async () => undefined);
  const auditLog = vi.fn(async () => undefined);
  const addAttachment = vi.fn(async (input: Record<string, unknown>) => ({
    id: ATTACHMENT_ID,
    bookingRequestId: REQUEST_ID,
    storageKey: input.storageKey,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    uploadedBySide: input.uploadedBySide,
    uploadedByHumanId: input.uploadedByHumanId,
    // ── P3b (asks) ──
    askId: input.askId ?? null,
    createdAt: NOW,
  }));
  const softDeleteAttachment = vi.fn(async () => ({
    didStamp: true,
    record: {
      id: ATTACHMENT_ID,
      bookingRequestId: REQUEST_ID,
      storageKey: `booking-requests/${REQUEST_ID}/rider.pdf`,
      fileName: "rider.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      uploadedBySide: "VENUE",
      uploadedByHumanId: ACTOR_ID,
      askId: null,
      createdAt: NOW,
    },
  }));
  const listAttachments = vi.fn(async () => [
    {
      id: ATTACHMENT_ID,
      bookingRequestId: REQUEST_ID,
      storageKey: `booking-requests/${REQUEST_ID}/rider.pdf`,
      fileName: "rider.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      uploadedBySide: "VENUE",
      uploadedByHumanId: ACTOR_ID,
      askId: null,
      createdAt: NOW,
    },
  ]);
  const listForRequest = vi.fn(async () => ({
    // A human message AND a SYSTEM ledger entry — the thread is one
    // chronological list of both, and the `.strict()` output schema has to
    // admit each.
    items: [
      makeMessage(),
      makeMessage({
        id: SYSTEM_ENTRY_ID,
        authorSide: "SYSTEM",
        authorHumanId: ACTOR_ID,
        body: "",
        systemKind: "booking_agreement.countered",
        systemData: { agreementId: AGREEMENT_ID, actorSide: "PERFORMER" },
      }),
    ],
    nextCursor: null,
  }));
  const markRead = vi.fn(async () => 2);
  const enqueueMany = vi.fn(async () => undefined);
  const incrementUsage = vi.fn(async () => undefined);

  const txRepos = {
    bookingRequests: {
      getById: vi.fn(async () => request),
      touchLastMessageAt,
      addAttachment,
      listAttachments,
      softDeleteAttachment,
    },
    bookingRequestMessages: { create: createMessage, markRead },
    pendingObjectDeletions: { enqueueMany },
    audit: { log: auditLog },
    // ── P3b (asks) ── a stamped delete refunds the uploader's quota (W2).
    resourceQuotas: { incrementUsage },
  } as unknown as TxRepos;

  const repos = {
    bookingRequests: {
      getById: vi.fn(async () => request),
      listAttachments,
    },
    bookingRequestMessages: { listForRequest },
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        name: "The Basement",
        humanIdsWithAccess: [ACTOR_ID],
        orgIdsWithAccess: [],
      })),
    },
    authz: {
      // ensurePlaceOwnerAccess (WRITE gate, TO_VENUE + VENUE side).
      getPlaceAccessContext: vi.fn(async () => ({
        owningOrgIds: [],
        verifiedHumanOwnerIds: [ACTOR_ID],
      })),
      getOrgMembership: vi.fn(async () => null),
      getOrgMemberships: vi.fn(async () => []),
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  return {
    repos,
    createMessage,
    touchLastMessageAt,
    auditLog,
    addAttachment,
    softDeleteAttachment,
    listForRequest,
    markRead,
    enqueueMany,
    incrementUsage,
  };
}

describe("bookingRequests.messages.post", () => {
  it("posts as the actor from ctx, consumes the 30/hour per-actor budget, and notifies the counterparty via notifyWithEmail", async () => {
    const world = buildRepos();
    const consume = vi.fn(async () => ({
      allowed: true,
      remaining: 29,
      retryAfterSeconds: 0,
    }));
    const notifyWithEmail = vi.fn(async () => ({ ok: true }));

    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
      rateLimit: { consume } as never,
      notifyWithEmail: notifyWithEmail as never,
      publicAppUrl: "https://ithasfire.com",
    });

    const result = await caller.messages.post({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      body: "See you at load-in.",
    });

    expect(result).toMatchObject({ id: MESSAGE_ID, authorSide: "VENUE" });
    expect(world.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingRequestId: REQUEST_ID,
        authorSide: "VENUE",
        authorHumanId: ACTOR_ID,
      }),
    );
    // The denormalized recency bump rides the same tx (port mandate).
    expect(world.touchLastMessageAt).toHaveBeenCalledWith({
      id: REQUEST_ID,
      at: NOW,
    });

    // The specific per-actor throttle, alongside the default floor.
    expect(consume).toHaveBeenCalledWith(
      `bookingRequests:postMessage:${ACTOR_ID}`,
      30,
      3600,
    );

    // Counterparty (PERFORMER = owned human) notified post-commit through the
    // email-binding notify, per-message idempotency key.
    expect(notifyWithEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: PERFORMER_ID,
        variant: "booking.message-received",
        idempotencyKey: `booking-message:${MESSAGE_ID}:${PERFORMER_ID}`,
      }),
    );
  });

  it("rejects with TOO_MANY_REQUESTS when the per-actor budget is exhausted (nothing written)", async () => {
    const world = buildRepos();
    const consume = vi.fn(async (key: string) =>
      key.startsWith("bookingRequests:postMessage:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 120 }
        : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
    );

    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
      rateLimit: { consume } as never,
      publicAppUrl: "https://ithasfire.com",
    });

    await expect(
      caller.messages.post({
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
        body: "spam",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(world.createMessage).not.toHaveBeenCalled();
  });

  it("rejects a client-smuggled actorHumanId (strict procedure input)", async () => {
    const world = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
      publicAppUrl: "https://ithasfire.com",
    });

    await expect(
      caller.messages.post({
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
        body: "hello",
        actorHumanId: PERFORMER_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(world.createMessage).not.toHaveBeenCalled();
  });

  it("a failing notifier never fails the committed message (swallow + report)", async () => {
    const world = buildRepos();
    const reportError = vi.fn();
    const notifyWithEmail = vi.fn(async () => {
      throw new Error("smtp down");
    });

    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
      notifyWithEmail: notifyWithEmail as never,
      reportError: reportError as never,
      publicAppUrl: "https://ithasfire.com",
    });

    const result = await caller.messages.post({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      body: "still lands",
    });

    expect(result.id).toBe(MESSAGE_ID);
    expect(reportError).toHaveBeenCalled();
  });
});

describe("bookingRequests.messages.list / markRead", () => {
  it("lists a thread page for a reader (ctx actor injected)", async () => {
    const world = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
    });

    const page = await caller.messages.list({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(world.listForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ bookingRequestId: REQUEST_ID, limit: 50 }),
    );
  });

  it("carries a SYSTEM ledger entry's kind and params out to the wire", async () => {
    // The output schema is `.strict()` — if `systemKind`/`systemData` were not
    // on it, this parse would throw and the timeline would have nothing to
    // render.
    const world = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
    });

    const page = await caller.messages.list({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });

    expect(page.items[0]).toMatchObject({ systemKind: null, systemData: null });
    expect(page.items[1]).toMatchObject({
      id: SYSTEM_ENTRY_ID,
      authorSide: "SYSTEM",
      body: "",
      systemKind: "booking_agreement.countered",
      systemData: { agreementId: AGREEMENT_ID, actorSide: "PERFORMER" },
    });
  });

  it("marks counterparty messages read up to a timestamp", async () => {
    const world = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
    });

    const result = await caller.messages.markRead({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      upToCreatedAt: NOW,
    });

    expect(result).toEqual({ updated: 2 });
    expect(world.markRead).toHaveBeenCalledWith({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      upToCreatedAt: NOW,
    });
  });
});

describe("bookingRequests.attachments", () => {
  it("add → list → delete round-trips through the use cases", async () => {
    const world = buildRepos();
    // ── P3b (asks) ── `add` HEADs the stored object (FR-009a).
    const headObject = vi.fn(async () => ({
      exists: true,
      size: 1234,
      contentType: "application/pdf",
    }));
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
      fileStorage: { headObject, deleteObject: vi.fn() } as never,
    });

    const added = await caller.attachments.add({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      storageKey: `booking-requests/${REQUEST_ID}/rider.pdf`,
      fileName: "rider.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
    });
    expect(added).toMatchObject({ id: ATTACHMENT_ID, fileName: "rider.pdf" });
    expect(world.addAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedBySide: "VENUE",
        uploadedByHumanId: ACTOR_ID,
      }),
    );

    const listed = await caller.attachments.list({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(listed).toHaveLength(1);

    const deleted = await caller.attachments.delete({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      attachmentId: ATTACHMENT_ID,
    });
    expect(deleted).toEqual({ deleted: true });
    // Storage GC enqueued in the same tx as the soft delete.
    expect(world.enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({
        source: "booking_request_attachment",
        targetKind: "KEY",
      }),
    ]);
    // ── P3b (asks) ── the uploader's quota comes back in the same tx.
    expect(world.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: ACTOR_ID, delta: -1234n }),
    );
  });

  it("rejects a storageKey outside the request's own namespace", async () => {
    const world = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos: world.repos,
    });

    await expect(
      caller.attachments.add({
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
        storageKey: "booking-requests/other-request/stolen.pdf",
        fileName: "stolen.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(world.addAttachment).not.toHaveBeenCalled();
  });
});
