import { describe, expect, it, vi } from "vitest";

import type {
  BookingRequestAttachmentRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";

import {
  addBookingRequestAttachment,
  deleteBookingRequestAttachment,
  listBookingRequestAttachments,
} from "../attachments";
import type {
  AddBookingRequestAttachmentDeps,
  BookingRequestAttachmentsDeps,
} from "../attachments";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "./helpers";

const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const OUTSIDER_ID = "14141414-1414-4141-8141-141414141414";
const VIEWER_MEMBER_ID = "15151515-1515-4151-8151-151515151515";
const ATTACHMENT_ID = "a11a11a1-1111-4111-8111-111111111111";
const FOREIGN_ATTACHMENT_ID = "a11a11a1-9999-4999-8999-999999999999";

type BuildOptions = {
  request?: BookingRequestRecord | null;
  /** In-memory attachment table keyed by id, seedable. */
  attachments?: BookingRequestAttachmentRecord[];
  /** Org ids owning the place (reader-gate membership-any path). */
  placeOrgIds?: string[];
  /** `${orgId}:${humanId}` → role for the org-membership fakes. */
  memberships?: Record<string, string>;
  // ── P3b (asks) ──
  /** HEAD results by key; default: present, 2048 bytes, type from the extension. */
  heads?: Record<string, { exists: boolean; size?: number; contentType?: string; metadata?: Record<string, string> }>;
};

// ── P3b (asks) ──
const TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

function buildAttachment(
  overrides: Partial<BookingRequestAttachmentRecord> = {},
): BookingRequestAttachmentRecord {
  return {
    id: ATTACHMENT_ID,
    bookingRequestId: REQUEST_ID,
    storageKey: "booking-requests/req/rider.pdf",
    fileName: "rider.pdf",
    contentType: "application/pdf",
    sizeBytes: 12_345,
    uploadedBySide: "VENUE",
    uploadedByHumanId: VENUE_OWNER_ID,
    // ── P3b (asks) ──
    askId: null,
    deletedAt: null,
    createdAt: new Date("2026-06-05T00:00:00.000Z"),
    ...overrides,
  };
}

function buildDeps(options: BuildOptions = {}) {
  const request =
    options.request === undefined
      ? buildBookingRequestRecord()
      : options.request;
  const table = new Map<string, BookingRequestAttachmentRecord>(
    (options.attachments ?? []).map((a) => [a.id, a]),
  );

  const bookingRequests = {
    getById: vi.fn(async (id: string) =>
      request && id === request.id ? request : null,
    ),
    addAttachment: vi.fn(async (input: Record<string, unknown>) => {
      // Port contract (CLAIM-ONCE, Step-6 review): a storageKey already
      // carried by ANY row — live OR soft-deleted, on ANY request — rejects.
      const taken = [...table.values()].some(
        (a) => a.storageKey === input.storageKey,
      );
      if (taken) {
        throw { code: "conflict", message: "attachment_key_taken" } as const;
      }
      const record = buildAttachment({
        id: crypto.randomUUID(),
        ...(input as Partial<BookingRequestAttachmentRecord>),
      });
      table.set(record.id, record);
      return record;
    }),
    listAttachments: vi.fn(async (bookingRequestId: string) =>
      [...table.values()].filter(
        (a) => a.bookingRequestId === bookingRequestId && a.deletedAt === null,
      ),
    ),
    // Port contract: WHERE (id, bookingRequestId); didStamp only when THIS
    // call transitioned the row.
    softDeleteAttachment: vi.fn(
      async ({ id, bookingRequestId }: { id: string; bookingRequestId: string }) => {
        const row = table.get(id);
        if (!row || row.bookingRequestId !== bookingRequestId) return null;
        if (row.deletedAt !== null) return { record: row, didStamp: false };
        const stamped = { ...row, deletedAt: new Date() };
        table.set(id, stamped);
        return { record: stamped, didStamp: true };
      },
    ),
  };

  const placeOrgIds = options.placeOrgIds ?? [];
  const memberships = options.memberships ?? {};
  const place = buildPlaceRecord({
    humanIdsWithAccess: [VENUE_OWNER_ID],
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
            verifiedHumanOwnerIds: [VENUE_OWNER_ID],
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

  const pendingObjectDeletions = { enqueueMany: vi.fn(async () => {}) };
  const audit = { log: vi.fn(async () => {}) };
  // ── P3b (asks) ── a stamped delete refunds the uploader's quota (W2).
  const resourceQuotas = { incrementUsage: vi.fn(async () => {}) };

  const mocks = {
    bookingRequests,
    places,
    authz,
    pendingObjectDeletions,
    audit,
    resourceQuotas,
  };
  // ── P3b (asks) ── `add` HEADs the stored object; the store is the truth.
  const storage = {
    headObject: vi.fn(async ({ key }: { key: string }) => {
      const seeded = options.heads?.[key];
      if (seeded) return seeded;
      const ext = key.split(".").pop() ?? "";
      return { exists: true, size: 2048, contentType: TYPE_BY_EXTENSION[ext] };
    }),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };
  const deps = {
    repos: withTx(mocks) as unknown as BookingRequestAttachmentsDeps["repos"],
    clock: { now: () => NOW },
    storage,
  } satisfies Partial<AddBookingRequestAttachmentDeps> as AddBookingRequestAttachmentDeps;

  return { deps, mocks, table, storage };
}

const addInput = (overrides: Record<string, unknown> = {}) => ({
  actorHumanId: VENUE_OWNER_ID,
  bookingRequestId: REQUEST_ID,
  side: "VENUE",
  storageKey: `booking-requests/${REQUEST_ID}/stage-plot.png`,
  fileName: "stage-plot.png",
  contentType: "image/png",
  sizeBytes: 2048,
  ...overrides,
});

describe("addBookingRequestAttachment", () => {
  it("venue side attaches and audits", async () => {
    const { deps, mocks } = buildDeps();

    const record = await addBookingRequestAttachment(deps, addInput());

    expect(record.fileName).toBe("stage-plot.png");
    expect(mocks.bookingRequests.addAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingRequestId: REQUEST_ID,
        // Uploader provenance (uploader-or-venue delete posture): the
        // VERIFIED side + the actor — never anything else client-supplied.
        uploadedBySide: "VENUE",
        uploadedByHumanId: VENUE_OWNER_ID,
      }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.attachment_added" }),
    );
  });

  it("performer side may attach too (both sides trade documents)", async () => {
    const { deps } = buildDeps();
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
      ),
    ).resolves.toBeTruthy();
  });

  it("outsiders cannot attach", async () => {
    const { deps, mocks } = buildDeps();
    await expect(
      addBookingRequestAttachment(deps, addInput({ actorHumanId: OUTSIDER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.addAttachment).not.toHaveBeenCalled();
  });

  it.each(["DECLINED", "WITHDRAWN", "EXPIRED"] as const)(
    "a %s request still accepts an attachment (the thread is history, not a lock)",
    async (status) => {
      // Inverted deliberately: `assertThreadWritable` used to reject these with
      // INVALID_STATUS. Filing the rider for a booking that already resolved
      // must stay possible, so the guarantee is pinned here.
      const { deps, mocks } = buildDeps({
        request: buildBookingRequestRecord({ status }),
      });
      await expect(
        addBookingRequestAttachment(deps, addInput()),
      ).resolves.toBeTruthy();
      expect(mocks.bookingRequests.addAttachment).toHaveBeenCalled();
    },
  );

  it("authz still applies on a closed thread — an outsider cannot attach", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
    });
    await expect(
      addBookingRequestAttachment(deps, addInput({ actorHumanId: OUTSIDER_ID })),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.addAttachment).not.toHaveBeenCalled();
  });

  it("rejects a storageKey outside this request's namespace (foreign-key GC guard)", async () => {
    const { deps, mocks } = buildDeps();

    // Another request's namespace — registering it here would let this
    // request's soft-delete GC destroy the foreign object's bytes.
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({
          storageKey:
            "booking-requests/99999999-9999-4999-8999-999999999999/rider.pdf",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Entirely foreign prefix, and a bare prefix with no object segment.
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({ storageKey: "events/hero/some-image.png" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({ storageKey: `booking-requests/${REQUEST_ID}/` }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(mocks.bookingRequests.addAttachment).not.toHaveBeenCalled();
  });

  it("CLAIM-ONCE: re-registering an already-claimed storageKey on the SAME request → conflict (attachment_key_taken)", async () => {
    const key = `booking-requests/${REQUEST_ID}/rider.pdf`;
    const { deps } = buildDeps({
      attachments: [buildAttachment({ storageKey: key })],
    });

    // Either participant re-asserting the other's key must lose — the key's
    // first registration owns it (adapter-enforced, surfaced untouched here).
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({
          actorHumanId: ACTOR_ID,
          side: "PERFORMER",
          storageKey: key,
          // ── P3b (asks) ── the declared type must be the stored one.
          contentType: "application/pdf",
        }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "attachment_key_taken",
    });
  });

  it("CLAIM-ONCE: a SOFT-DELETED row still blocks re-claiming its storageKey", async () => {
    const key = `booking-requests/${REQUEST_ID}/stage-plot.png`;
    const { deps } = buildDeps({
      attachments: [
        buildAttachment({
          storageKey: key,
          deletedAt: new Date("2026-06-06T00:00:00.000Z"),
        }),
      ],
    });

    // The deleted row's GC enqueue may already be racing the bytes —
    // re-registering the key would hand the next soft-delete a double-GC.
    await expect(
      addBookingRequestAttachment(deps, addInput({ storageKey: key })),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "attachment_key_taken",
    });
  });

  it("CLAIM-ONCE: a key claimed on ANOTHER request cannot be registered here (namespace guard fires first)", async () => {
    const foreignRequestId = "99999999-9999-4999-8999-999999999999";
    const foreignKey = `booking-requests/${foreignRequestId}/rider.pdf`;
    const { deps, mocks } = buildDeps({
      attachments: [
        buildAttachment({
          id: FOREIGN_ATTACHMENT_ID,
          bookingRequestId: foreignRequestId,
          storageKey: foreignKey,
        }),
      ],
    });

    // At the use-case boundary the namespace prefix guard rejects the foreign
    // key BEFORE the adapter is reached (invalid_input); the adapter's WHERE
    // storageKey check (no request scoping) is the defense-in-depth layer
    // behind it, pinned by the adapter integration test.
    await expect(
      addBookingRequestAttachment(deps, addInput({ storageKey: foreignKey })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.addAttachment).not.toHaveBeenCalled();
  });

  it("a VIEWER-role member of the owning org cannot add (write gate is edit-role)", async () => {
    const { deps, mocks } = buildDeps({
      placeOrgIds: [ORG_ID],
      memberships: { [`${ORG_ID}:${VIEWER_MEMBER_ID}`]: "VIEWER" },
    });
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({ actorHumanId: VIEWER_MEMBER_ID }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(mocks.bookingRequests.addAttachment).not.toHaveBeenCalled();
  });

  it("sanitizes the file name and bounds the payload", async () => {
    const { deps } = buildDeps();
    const record = await addBookingRequestAttachment(
      deps,
      addInput({ fileName: "  <i>rider</i>.pdf  " }),
    );
    expect(record.fileName).not.toContain("<i>");

    await expect(
      addBookingRequestAttachment(deps, addInput({ contentType: "not a type" })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      addBookingRequestAttachment(
        deps,
        addInput({ sizeBytes: 51 * 1024 * 1024 }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("listBookingRequestAttachments", () => {
  it("lists live attachments for participants (closed threads included)", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
      attachments: [
        buildAttachment(),
        buildAttachment({
          id: "a11a11a1-2222-4222-8222-222222222222",
          deletedAt: new Date(),
        }),
      ],
    });

    const records = await listBookingRequestAttachments(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });

    expect(records.map((r) => r.id)).toEqual([ATTACHMENT_ID]);
  });

  it("a VIEWER-role member of the owning org CAN list (read gate is membership-any)", async () => {
    const { deps } = buildDeps({
      attachments: [buildAttachment()],
      placeOrgIds: [ORG_ID],
      memberships: { [`${ORG_ID}:${VIEWER_MEMBER_ID}`]: "VIEWER" },
    });

    const records = await listBookingRequestAttachments(deps, {
      actorHumanId: VIEWER_MEMBER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(records.map((r) => r.id)).toEqual([ATTACHMENT_ID]);
  });

  it("outsiders cannot list", async () => {
    const { deps } = buildDeps({ attachments: [buildAttachment()] });
    await expect(
      listBookingRequestAttachments(deps, {
        actorHumanId: OUTSIDER_ID,
        bookingRequestId: REQUEST_ID,
        side: "VENUE",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

describe("deleteBookingRequestAttachment", () => {
  const deleteInput = (overrides: Record<string, unknown> = {}) => ({
    actorHumanId: VENUE_OWNER_ID,
    bookingRequestId: REQUEST_ID,
    side: "VENUE",
    attachmentId: ATTACHMENT_ID,
    ...overrides,
  });

  it("soft-deletes AND enqueues the storage GC in the same tx (didStamp=true)", async () => {
    const attachment = buildAttachment();
    const { deps, mocks } = buildDeps({ attachments: [attachment] });

    const result = await deleteBookingRequestAttachment(deps, deleteInput());

    expect(result).toEqual({ deleted: true });
    expect(mocks.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
      {
        targetKey: attachment.storageKey,
        targetKind: "KEY",
        source: "booking_request_attachment",
        sourceId: attachment.id,
      },
    ]);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.attachment_deleted" }),
    );
  });

  it("repeat delete: didStamp=false → NO second enqueue (double-GC protection)", async () => {
    const { deps, mocks } = buildDeps({ attachments: [buildAttachment()] });

    await deleteBookingRequestAttachment(deps, deleteInput());
    const second = await deleteBookingRequestAttachment(deps, deleteInput());

    expect(second).toEqual({ deleted: false });
    expect(mocks.pendingObjectDeletions.enqueueMany).toHaveBeenCalledTimes(1);
    // ── P3b (asks), review W2 ── the refund rides the same stamp: once.
    expect(mocks.resourceQuotas.incrementUsage).toHaveBeenCalledTimes(1);
  });

  it("CROSS-REQUEST forged attachment id: no-op, NO enqueue, NO audit (IDOR backstop)", async () => {
    const foreign = buildAttachment({
      id: FOREIGN_ATTACHMENT_ID,
      bookingRequestId: "44444444-9999-4999-8999-444444444444",
    });
    const { deps, mocks, table } = buildDeps({ attachments: [foreign] });

    const result = await deleteBookingRequestAttachment(
      deps,
      deleteInput({ attachmentId: FOREIGN_ATTACHMENT_ID }),
    );

    expect(result).toEqual({ deleted: false });
    // The foreign row is untouched — no mutation across the request boundary.
    expect(table.get(FOREIGN_ATTACHMENT_ID)!.deletedAt).toBeNull();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("PERFORMER deletes their OWN upload: soft-deleted + GC enqueued (uploader-or-venue)", async () => {
    const own = buildAttachment({
      uploadedBySide: "PERFORMER",
      uploadedByHumanId: ACTOR_ID,
    });
    const { deps, mocks } = buildDeps({ attachments: [own] });

    const result = await deleteBookingRequestAttachment(
      deps,
      deleteInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
    );

    expect(result).toEqual({ deleted: true });
    expect(mocks.pendingObjectDeletions.enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({ targetKey: own.storageKey }),
    ]);
  });

  it("PERFORMER deleting the VENUE's upload: INSUFFICIENT_ROLE (not_uploader) BEFORE any mutation", async () => {
    const { deps, mocks, table } = buildDeps({
      attachments: [buildAttachment()], // uploadedBySide: "VENUE"
    });

    await expect(
      deleteBookingRequestAttachment(
        deps,
        deleteInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
      meta: expect.objectContaining({ reason: "not_uploader" }),
    });

    // READ-then-CHECK-then-MUTATE: the uploader check runs on the row read
    // from the live list, BEFORE softDeleteAttachment — a blocked performer
    // never mutates anything (belt) AND the tx would roll back on the throw
    // anyway (braces). No GC enqueue, no audit row.
    expect(mocks.bookingRequests.softDeleteAttachment).not.toHaveBeenCalled();
    expect(table.get(ATTACHMENT_ID)!.deletedAt).toBeNull();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("PERFORMER probing an ALREADY-DELETED venue attachment: same no-op as a missing id (no existence leak)", async () => {
    const { deps, mocks } = buildDeps({
      attachments: [
        buildAttachment({ deletedAt: new Date("2026-06-06T00:00:00.000Z") }), // VENUE upload, soft-deleted
      ],
    });

    // The row is absent from the LIVE list, so the performer gets the
    // idempotent `{ deleted: false }` — NOT INSUFFICIENT_ROLE, which would
    // confirm a venue attachment existed at that id.
    await expect(
      deleteBookingRequestAttachment(
        deps,
        deleteInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
      ),
    ).resolves.toEqual({ deleted: false });
    expect(mocks.bookingRequests.softDeleteAttachment).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("LEGACY row (null uploader columns) is venue-managed: performer cannot delete it", async () => {
    const legacy = buildAttachment({
      uploadedBySide: null,
      uploadedByHumanId: null,
    });
    const { deps, mocks, table } = buildDeps({ attachments: [legacy] });

    await expect(
      deleteBookingRequestAttachment(
        deps,
        deleteInput({ actorHumanId: ACTOR_ID, side: "PERFORMER" }),
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
      meta: expect.objectContaining({ reason: "not_uploader" }),
    });
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    // Check-before-mutate: the blocked attempt left the row untouched…
    expect(table.get(ATTACHMENT_ID)!.deletedAt).toBeNull();

    // …so the VENUE can clean it up on the very same state.
    await expect(
      deleteBookingRequestAttachment(deps, deleteInput()),
    ).resolves.toEqual({ deleted: true });
  });

  it("VENUE may delete the PERFORMER's upload (venue moderates its inbox)", async () => {
    const performerUpload = buildAttachment({
      uploadedBySide: "PERFORMER",
      uploadedByHumanId: ACTOR_ID,
    });
    const { deps, mocks } = buildDeps({ attachments: [performerUpload] });

    await expect(
      deleteBookingRequestAttachment(deps, deleteInput()),
    ).resolves.toEqual({ deleted: true });
    // ── P3b (asks), review W2 ── the UPLOADER (the performer) is refunded,
    // never the venue person who deleted it.
    expect(mocks.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: ACTOR_ID,
      kind: "STORAGE_BYTES_HUMAN",
      delta: -12_345n,
    });
    expect(mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: VENUE_OWNER_ID }),
    );
  });

  it("a legacy row with no recorded uploader is deleted without a refund (no one to credit)", async () => {
    const { deps, mocks } = buildDeps({
      attachments: [buildAttachment({ uploadedBySide: null, uploadedByHumanId: null })],
    });
    await expect(
      deleteBookingRequestAttachment(deps, deleteInput()),
    ).resolves.toEqual({ deleted: true });
    expect(mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
  });

  it("a VIEWER-role member of the owning org cannot delete; outsiders cannot either", async () => {
    const { deps } = buildDeps({
      attachments: [buildAttachment()],
      placeOrgIds: [ORG_ID],
      memberships: { [`${ORG_ID}:${VIEWER_MEMBER_ID}`]: "VIEWER" },
    });
    await expect(
      deleteBookingRequestAttachment(
        deps,
        deleteInput({ actorHumanId: VIEWER_MEMBER_ID }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      deleteBookingRequestAttachment(
        deps,
        deleteInput({ actorHumanId: OUTSIDER_ID }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("closed threads still allow deletion (cleanup, not conversation)", async () => {
    const { deps } = buildDeps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
      attachments: [buildAttachment()],
    });
    await expect(
      deleteBookingRequestAttachment(deps, deleteInput()),
    ).resolves.toEqual({ deleted: true });
  });
});
