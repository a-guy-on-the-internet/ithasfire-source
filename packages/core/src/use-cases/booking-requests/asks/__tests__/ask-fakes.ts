import { vi } from "vitest";

import type {
  AnswerBookingRequestAskInput,
  BookingRequestAskRecord,
  BookingRequestAttachmentRecord,
  BookingRequestRecord,
  CreateBookingRequestAskInput,
  StampBookingRequestAskEventImageInput,
  WithdrawBookingRequestAskInput,
} from "@th/ports/repos/booking-requests";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";
import type { BookingStandardItemRecord } from "@th/ports/repos/booking-standards";
import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";

import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  holdsOf,
  ledgerOf,
  withTx,
} from "../../__tests__/helpers";
import { cleanJpeg } from "../../../../lib/images/__tests__/image-fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fakes for the ask suites. The ask store mirrors the ADAPTER's CAS
// contract (booking-request-asks.ts): answer matches OPEN | ANSWERED at the
// expected revision; withdraw matches OPEN; the image stamp matches ANSWERED
// with the same attachment and not already stamped for that event.
// ─────────────────────────────────────────────────────────────────────────────

export const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
export const OUTSIDER_ID = "14141414-1414-4141-8141-141414141414";
export const VENUE_EDITOR_ID = "16161616-1616-4161-8161-161616161616";
export const VENUE_VIEWER_ID = "15151515-1515-4151-8151-151515151515";
export const ASK_ID = "a5a5a5a5-0000-4000-8000-000000000001";
export const ATTACHMENT_ID = "a11a11a1-1111-4111-8111-111111111111";
export const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";

export function buildAsk(
  overrides: Partial<BookingRequestAskRecord> = {},
): BookingRequestAskRecord {
  return {
    id: ASK_ID,
    bookingRequestId: REQUEST_ID,
    kind: "LINK",
    label: "Live video",
    note: null,
    standardField: null,
    useAsEventImage: false,
    status: "OPEN",
    askedByHumanId: VENUE_OWNER_ID,
    askedAt: new Date("2026-06-09T12:00:00.000Z"),
    answerAttachmentId: null,
    answerUrl: null,
    answerText: null,
    answerMinutes: null,
    answeredByHumanId: null,
    answeredAt: null,
    answerRevision: 0,
    withdrawnByHumanId: null,
    withdrawnAt: null,
    eventImageEventId: null,
    eventImageId: null,
    createdAt: new Date("2026-06-09T12:00:00.000Z"),
    updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    ...overrides,
  };
}

export function buildFile(
  overrides: Partial<BookingRequestAttachmentRecord> = {},
): BookingRequestAttachmentRecord {
  return {
    id: ATTACHMENT_ID,
    bookingRequestId: REQUEST_ID,
    storageKey: `booking-requests/${REQUEST_ID}/poster.jpg`,
    fileName: "poster.jpg",
    contentType: "image/jpeg",
    sizeBytes: 4096,
    uploadedBySide: "PERFORMER",
    uploadedByHumanId: ACTOR_ID,
    askId: ASK_ID,
    deletedAt: null,
    createdAt: new Date("2026-06-09T13:00:00.000Z"),
    ...overrides,
  };
}

export type AskFakeOptions = {
  request?: BookingRequestRecord;
  asks?: BookingRequestAskRecord[];
  files?: BookingRequestAttachmentRecord[];
  agreement?: AgreementRecord | null;
  event?: Partial<EventRecord> | null;
  /** `${orgId}:${humanId}` → role; the place is owned by ORG_ID + VENUE_OWNER_ID. */
  memberships?: Record<string, string>;
  heads?: Record<
    string,
    { exists: boolean; size?: number; contentType?: string; metadata?: Record<string, string> }
  >;
  standards?: Array<Partial<BookingStandardItemRecord>>;
};

export function buildAskDeps(options: AskFakeOptions = {}) {
  let request = options.request ?? buildBookingRequestRecord();
  const asks = new Map<string, BookingRequestAskRecord>(
    (options.asks ?? []).map((a) => [a.id, a]),
  );
  const files = new Map<string, BookingRequestAttachmentRecord>(
    (options.files ?? []).map((f) => [f.id, f]),
  );
  let agreement = options.agreement ?? null;
  const event = options.event === undefined ? null : options.event;
  const memberships: Record<string, string> = {
    [`${ORG_ID}:${VENUE_EDITOR_ID}`]: "ADMIN",
    [`${ORG_ID}:${VENUE_VIEWER_ID}`]: "VIEWER",
    ...(options.memberships ?? {}),
  };

  const bookingRequests = {
    getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    getAsk: vi.fn(async ({ id, bookingRequestId }: { id: string; bookingRequestId: string }) => {
      const ask = asks.get(id);
      return ask && ask.bookingRequestId === bookingRequestId ? { ...ask } : null;
    }),
    listAsks: vi.fn(async (bookingRequestId: string) =>
      [...asks.values()]
        .filter((a) => a.bookingRequestId === bookingRequestId)
        .map((a) => ({ ...a })),
    ),
    createAsk: vi.fn(async (input: CreateBookingRequestAskInput) => {
      const ask = buildAsk({
        id: crypto.randomUUID(),
        ...input,
        status: "OPEN",
      });
      asks.set(ask.id, ask);
      return { ...ask };
    }),
    answerAsk: vi.fn(async (input: AnswerBookingRequestAskInput) => {
      const ask = asks.get(input.id);
      if (
        !ask ||
        ask.bookingRequestId !== input.bookingRequestId ||
        (ask.status !== "OPEN" && ask.status !== "ANSWERED") ||
        ask.answerRevision !== input.expectedRevision
      ) {
        return null;
      }
      const a = input.answer;
      const next: BookingRequestAskRecord = {
        ...ask,
        status: "ANSWERED",
        answerAttachmentId: a.kind === "attachment" ? a.attachmentId : null,
        answerUrl: a.kind === "url" ? a.url : null,
        answerText: a.kind === "text" ? a.text : null,
        answerMinutes: a.kind === "minutes" ? a.minutes : null,
        answeredByHumanId: input.answeredByHumanId,
        answeredAt: input.answeredAt,
        answerRevision: ask.answerRevision + 1,
      };
      asks.set(ask.id, next);
      return { ...next };
    }),
    withdrawAsk: vi.fn(async (input: WithdrawBookingRequestAskInput) => {
      const ask = asks.get(input.id);
      if (!ask || ask.bookingRequestId !== input.bookingRequestId || ask.status !== "OPEN") {
        return null;
      }
      const next: BookingRequestAskRecord = {
        ...ask,
        status: "WITHDRAWN",
        withdrawnByHumanId: input.withdrawnByHumanId,
        withdrawnAt: input.withdrawnAt,
      };
      asks.set(ask.id, next);
      return { ...next };
    }),
    stampAskEventImage: vi.fn(async (input: StampBookingRequestAskEventImageInput) => {
      const ask = asks.get(input.id);
      if (
        !ask ||
        ask.bookingRequestId !== input.bookingRequestId ||
        ask.status !== "ANSWERED" ||
        ask.answerAttachmentId !== input.attachmentId ||
        ask.eventImageEventId === input.eventId
      ) {
        return false;
      }
      asks.set(ask.id, {
        ...ask,
        eventImageEventId: input.eventId,
        eventImageId: input.imageId,
      });
      return true;
    }),
    getAttachment: vi.fn(async ({ id, bookingRequestId }: { id: string; bookingRequestId: string }) => {
      const file = files.get(id);
      return file && file.bookingRequestId === bookingRequestId ? { ...file } : null;
    }),
    addAttachment: vi.fn(async (input: Record<string, unknown>) => {
      if ([...files.values()].some((f) => f.storageKey === input.storageKey)) {
        throw { code: "conflict", message: "attachment_key_taken" } as const;
      }
      const record = buildFile({
        id: crypto.randomUUID(),
        askId: null,
        ...(input as Partial<BookingRequestAttachmentRecord>),
      });
      files.set(record.id, record);
      return { ...record };
    }),
    listAttachments: vi.fn(async (bookingRequestId: string) =>
      [...files.values()].filter(
        (f) => f.bookingRequestId === bookingRequestId && f.deletedAt === null,
      ),
    ),
    softDeleteAttachment: vi.fn(
      async ({ id, bookingRequestId }: { id: string; bookingRequestId: string }) => {
        const row = files.get(id);
        if (!row || row.bookingRequestId !== bookingRequestId) return null;
        if (row.deletedAt !== null) return { record: row, didStamp: false };
        const stamped = { ...row, deletedAt: NOW };
        files.set(id, stamped);
        return { record: stamped, didStamp: true };
      },
    ),
  };

  const place = buildPlaceRecord({
    humanIdsWithAccess: [VENUE_OWNER_ID],
    orgIdsWithAccess: [ORG_ID],
  });
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
  };
  const authz = {
    getPlaceAccessContext: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? { owningOrgIds: [ORG_ID], verifiedHumanOwnerIds: [VENUE_OWNER_ID] }
        : null,
    ),
    getOrgMembership: vi.fn(async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
      const role = memberships[`${orgId}:${humanId}`];
      return role ? { orgId, humanId, role } : null;
    }),
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        orgIds
          .map((orgId) => ({ orgId, humanId, role: memberships[`${orgId}:${humanId}`] }))
          .filter((m) => m.role),
    ),
  };

  // The venue-side recipient resolver (notices) reads these.
  const humans = {
    getById: vi.fn(async (id: string) => ({ id, name: "Someone" })),
    getByIdWithIdentity: vi.fn(async () => ({ identity: { username: "venue-owner" } })),
  };
  const organizations = {
    getById: vi.fn(async (id: string) => ({ id, name: "Venue Org", slug: "venue-org" })),
    getByIds: vi.fn(async () => []),
    listMembers: vi.fn(async ({ offset }: { offset: number }) => ({
      items:
        offset === 0
          ? Object.entries(memberships)
              .filter(([key]) => key.startsWith(`${ORG_ID}:`))
              .map(([key, role]) => ({
                humanId: key.split(":")[1]!,
                name: null,
                email: null,
                role,
                joinedAt: NOW,
              }))
          : [],
      total: 2,
    })),
  };
  const entityPages = { getByOwner: vi.fn(async () => null) };
  const performerBookingDefaults = {
    getByOwner: vi.fn(async () => ({ actName: "The Midnight Ramblers" })),
  };

  const agreements = {
    getById: vi.fn(async (id: string) => (agreement && agreement.id === id ? agreement : null)),
    updateHeader: vi.fn(
      async (input: { id: string; expectedFrom: readonly string[]; proposedEndDate?: Date | null }) => {
        if (!agreement || !input.expectedFrom.includes(agreement.status)) {
          throw { code: "conflict", message: "agreement_status_changed" } as const;
        }
        agreement = { ...agreement, proposedEndDate: input.proposedEndDate ?? null };
        return agreement;
      },
    ),
  };

  let heroImageId: string | null =
    event && (event.heroImageKey || event.heroImageUrl) ? "existing-hero" : null;
  const events = {
    getById: vi.fn(async (id: string) =>
      event && (event.id ?? EVENT_ID) === id
        ? ({ id: EVENT_ID, status: "DRAFT", orgId: ORG_ID, humanId: null, ...event } as EventRecord)
        : null,
    ),
    setHeroImageIfEmpty: vi.fn(async ({ imageId }: { eventId: string; imageId: string }) => {
      if (heroImageId !== null) return false;
      heroImageId = imageId;
      return true;
    }),
  };
  const imageRows: Array<Record<string, unknown>> = [];
  const images = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      imageRows.push({ ...input, deletedAt: null });
      return { ...input };
    }),
    markUploaded: vi.fn(async () => ({})),
    attach: vi.fn(async () => {}),
    listByEventId: vi.fn(async (eventId: string) =>
      imageRows.filter((row) => row.eventId === eventId),
    ),
  };
  const imageModerationRecords = { create: vi.fn(async () => ({})) };
  const resourceQuotas = {
    getEffectiveQuota: vi.fn(async () => ({
      limitValue: 1_000_000_000n,
      currentUsage: 0n,
    })),
    hasPendingExpansionRequest: vi.fn(async () => false),
    incrementUsage: vi.fn(async () => {}),
  };
  const pendingObjectDeletions = { enqueueMany: vi.fn(async () => {}) };
  const audit = { log: vi.fn(async () => {}) };
  const bookingStandards = createFakeBookingStandards();
  for (const [index, item] of (options.standards ?? []).entries()) {
    const id = crypto.randomUUID();
    bookingStandards.items.set(id, {
      id,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      intent: "PERFORM",
      field: "CUSTOM",
      label: "Custom",
      hint: null,
      requirement: "SUGGESTED",
      sortOrder: index,
      createdAt: NOW,
      updatedAt: NOW,
      ...item,
    } as BookingStandardItemRecord);
  }

  const repos = withTx({
    bookingRequests,
    places,
    authz,
    humans,
    organizations,
    entityPages,
    performerBookingDefaults,
    agreements,
    events,
    images,
    imageModerationRecords,
    resourceQuotas,
    pendingObjectDeletions,
    audit,
    bookingStandards,
  }) as unknown as Repos;

  const objects = new Map<string, Buffer>();
  const storage = {
    headObject: vi.fn(async ({ key }: { key: string }) => {
      const seeded = options.heads?.[key];
      if (seeded) return seeded;
      const file = [...files.values()].find((f) => f.storageKey === key);
      return file
        ? { exists: true, size: file.sizeBytes, contentType: file.contentType }
        : { exists: false };
    }),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
    // A tiny object store: a source file's bytes are a plain 640x480 JPEG
    // unless seeded (the copy strips metadata, so they must parse);
    // `putObject` records what landed where (the W1 race test reads it).
    getObject: vi.fn(async ({ key }: { key: string }) => {
      const content = objects.get(key) ?? cleanJpeg();
      return { content, contentType: "image/jpeg", size: content.length };
    }),
    putObject: vi.fn(async ({ key, content }: { key: string; content: Buffer | unknown }) => {
      if (Buffer.isBuffer(content)) objects.set(key, content);
      return { url: `https://cdn.test/${key}` };
    }),
    getObjectUrl: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn.test/${key}` })),
  };

  const notifyBookingRequestAsk = vi.fn(async () => {});
  const reportError = vi.fn();

  return {
    repos,
    storage,
    notifyBookingRequestAsk,
    reportError,
    clock: { now: () => NOW },
    asks,
    files,
    mocks: {
      bookingRequests,
      resourceQuotas,
      agreements,
      events,
      images,
      imageModerationRecords,
      pendingObjectDeletions,
      audit,
    },
    ledger: () => ledgerOf(repos),
    holds: () => holdsOf(repos),
    setRequest(next: BookingRequestRecord) {
      request = next;
    },
    agreementNow: () => agreement,
    objects,
    imageRows,
    heroImageId: () => heroImageId,
  };
}
