/**
 * Shared fakes for the getPageDraft / savePageDraft / discardPageDraft /
 * publishPageDraft tests.
 *
 * The four draft primitives run against ONE in-memory row with the Prisma
 * adapter's contract: lock creates an empty revision-0 row; write and clear
 * refuse a revision that does not increase and the inputs the table CHECKs
 * would reject (assertWritableDraft / assertClearableDraft); clear keeps
 * appliedBatchIds and never deletes the row; lock / write / clear on the
 * ROOT repo throw INTERNAL `page_draft_<op>_outside_tx`. `repos.tx` hands
 * the callback a SEPARATE tx repo, serialises transactions (the row lock)
 * and restores the row and the outbox when the callback throws (rollback).
 * The repo shape comes from test-utils' entityPagesRepoPrototype, with a
 * fresh vi.fn per method.
 *
 * Publish also writes the live rows, so the page, theme, blocks, Place,
 * slug history, audit rows and search marks are in-memory state too, and a
 * rollback restores ALL of it. The live-row fakes follow the Prisma
 * adapters' contracts that publish relies on: page upsert refuses a slug
 * another page holds (as the unique index would), a second main-section
 * copy of a pinned kind is refused BLOCK_PINNED (the adapter's P2002 map),
 * and update / delete / reorder of a missing block throw (P2025).
 */

import { createHash } from "node:crypto";

import { vi } from "vitest";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import { entityPagesRepoPrototype } from "@th/test-utils/fakes/prototypes/repos";
import {
  PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
  type ClearPageDraftInput,
  type EntityPageRecord,
  type PageBlockRecord,
  type PageDraftRecord,
  type PageOwnerType,
  type PageThemeRecord,
  type WritePageDraftInput,
} from "@th/types/repos/entity-pages";
import type { EnqueuePendingObjectDeletionItem } from "@th/types/repos/pending-object-deletions";

import { isPinnedBlockKind } from "../block-config";

export const PLACE_ID = "place-1";
export const ORG_ID = "org-1";
export const OTHER_ORG_ID = "org-2";
export const PAGE_ID = "page-1";
export const HUMAN_A = "human-a";
export const HUMAN_B = "human-b";
export const HUMAN_GONE = "human-deleted";
export const OUTSIDER = "human-outsider";
export const NOW = new Date("2026-10-08T15:00:00.000Z");
export const CDN = "https://cdn.test";

export function ownedImage(
  name: string,
  ownerType: PageOwnerType = "PLACE",
  ownerId = PLACE_ID,
): string {
  return `${CDN}/entity-pages/${ownerType.toLowerCase()}/${ownerId}/2026-10-08/${strippedName(name)}.jpg`;
}

export function ownedKey(name: string): string {
  return `entity-pages/place/${PLACE_ID}/2026-10-08/${strippedName(name)}.jpg`;
}

/**
 * A readable test name as a METADATA-STRIPPED copy's file name (32 hex
 * chars, the shape `strippedImageKey` mints): only stripped copies are
 * accepted as new page images, and only minted shapes are scanned.
 */
export function strippedName(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 32);
}

/** A RAW upload's URL (`<day>/<uuid>.<ext>`): original bytes, GPS included. */
export function rawUploadImage(
  uuid = "0b9a2c3e-4d5f-4a6b-8c7d-9e0f1a2b3c4d",
): string {
  return `${CDN}/entity-pages/place/${PLACE_ID}/2026-10-08/${uuid}.jpg`;
}

export function block(
  id: string,
  kind: string,
  orderIndex: number,
  extra: Partial<PageBlockRecord> = {},
): PageBlockRecord {
  return {
    id,
    pageId: PAGE_ID,
    kind,
    orderIndex,
    data: {},
    visible: true,
    section: "main",
    ...extra,
  };
}

export function liveBlocks(): PageBlockRecord[] {
  return [
    block("blk-about", "about", 0, {
      data: { heading: "About", content: "We host shows." },
    }),
    block("blk-photos", "photos", 1, {
      data: { photos: [{ url: ownedImage("live-photo") }] },
    }),
    block("blk-amenities", "amenities", 2, { data: { amenities: ["Bar"] } }),
    block("blk-track", "track_record", 3),
    block("blk-tech", "tech_specs", 4),
    block("blk-booking", "booking_info", 5),
  ];
}

export function pageRecord(
  overrides: Partial<EntityPageRecord> = {},
): EntityPageRecord {
  return {
    id: PAGE_ID,
    ownerType: "PLACE",
    ownerId: PLACE_ID,
    slug: "the-room",
    displayName: null,
    bio: "Live bio",
    avatarUrl: null,
    bannerUrl: ownedImage("live-banner"),
    visibility: "PUBLIC",
    allowFollows: true,
    showFollowerCount: false,
    category: "venue",
    templateAppliedCategories: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** The Place row the harness keeps (nullable columns typed as such). */
export type HarnessPlace = {
  id: string;
  name: string;
  capacity: number | null;
  phone: string | null;
  website: string | null;
  formattedAddress: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
  addressHash: string | null;
  locationMode: string;
  locationRadiusMeters: number | null;
  locationLabel: string | null;
  status: string;
  verificationStatus: string;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  timezone: string | null;
  orgIdsWithAccess: string[];
  humanIdsWithAccess: string[];
  [key: string]: unknown;
};

export function placeRecord(
  overrides: Record<string, unknown> = {},
): HarnessPlace {
  return {
    id: PLACE_ID,
    name: "The Room",
    capacity: 200,
    phone: null,
    website: null,
    formattedAddress: "1 Main St, Minneapolis, MN",
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    countryCode: "US",
    lat: null,
    lng: null,
    addressHash: "1 main st, minneapolis, mn",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    admissionTaxRateBps: null,
    taxRateSource: null,
    timezone: null,
    // The verified owners upsertPlace's write check reads.
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    ...overrides,
  } as HarnessPlace;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** A logger whose `child` is itself, so `error` calls can be asserted. */
export type SpyLogger = LoggerPort & {
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

export function spyLogger(): SpyLogger {
  const logger: SpyLogger = {
    child: vi.fn((): LoggerPort => logger),
    withTime: vi.fn(
      async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    ) as LoggerPort["withTime"],
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

export type HarnessOptions = {
  ownerType?: PageOwnerType;
  ownerId?: string;
  page?: EntityPageRecord | null;
  theme?: PageThemeRecord | null;
  blocks?: PageBlockRecord[];
  /** Org memberships with an edit role: actor → org ids. */
  orgEditors?: Record<string, string[]>;
  /** What canManagePlace allows: actor → place ids. */
  placeManagers?: Record<string, string[]>;
  /** Humans that still resolve (humans.getByIds). */
  humans?: { id: string; name: string | null }[];
  /**
   * Org roles for repos.authz.getOrgMembership (upsertPlace's write check):
   * actor → org id → role. Default: every orgEditors entry as EDITOR.
   */
  orgRoles?: Record<string, Record<string, string>>;
  /** Slugs other pages hold (isSlugAvailable / the page upsert). */
  takenSlugs?: string[];
  /**
   * Actors that hold a COMMUNITY_MODERATION_ROLES role (authz.hasStaffRole;
   * the moderator place page spec). Default: none.
   */
  moderators?: string[];
};

/** A place ownership row, as `listActiveOwnershipsForPlace` returns it. */
export type HarnessOwnership = { id: string; humanId: string; verified: boolean };

/** One in-memory audit row (`audit.log` writes these; `seedAudit` too). */
export type FakeAuditRow = {
  entity: string;
  entityId?: string | null;
  action: string;
  data?: unknown;
  at?: Date;
};

/** One row of the in-memory pending-object-deletions outbox. */
export type FakePendingDeletion = {
  targetKey: string;
  targetKind: string;
  source: string | null;
  sourceId: string | null;
  notBefore: Date | null;
  status: "PENDING" | "DEAD";
};

function isJsonObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function internal(message: string): never {
  fail("INTERNAL", { message });
}

function assertRevision(name: string, value: number, min: number, max?: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    internal(`page_draft_${name}_out_of_range`);
  }
}

export function makeHarness(options: HarnessOptions = {}) {
  const ownerType = options.ownerType ?? "PLACE";
  const ownerId = options.ownerId ?? PLACE_ID;
  let page: EntityPageRecord | null =
    options.page === undefined
      ? pageRecord({ ownerType, ownerId })
      : options.page;
  let theme: PageThemeRecord | null = options.theme ?? null;
  let blocks = options.blocks ?? liveBlocks();
  let place = placeRecord();
  let slugHistory: { pageId: string; slug: string }[] = [];
  let audits: FakeAuditRow[] = [];
  let marks: { entityType: string; entityId: string }[] = [];
  let blockSeq = 0;
  const takenSlugs = new Set(options.takenSlugs ?? []);
  let row: PageDraftRecord | null = null;
  let pending: FakePendingDeletion[] = [];
  // Committed by OTHER transactions (a claim): never rolled back here.
  let ownerships: HarnessOwnership[] = [];
  let ownedLiveEventsAtPlace = false;
  let onClaimLock: (() => void) | null = null;
  const claimLockOrder: string[] = [];
  const moderators = new Set(options.moderators ?? []);
  const placeManagers = options.placeManagers ?? {
    [HUMAN_A]: [PLACE_ID],
    [HUMAN_B]: [PLACE_ID],
  };
  const orgEditors = options.orgEditors ?? {
    [HUMAN_A]: [ORG_ID],
    [HUMAN_B]: [ORG_ID],
  };
  const knownHumans = options.humans ?? [
    { id: HUMAN_A, name: "Ana" },
    { id: HUMAN_B, name: "Ben" },
  ];
  const orgRoles: Record<string, Record<string, string>> =
    options.orgRoles ??
    Object.fromEntries(
      Object.entries(orgEditors).map(([actor, orgIds]) => [
        actor,
        Object.fromEntries(orgIds.map((orgId) => [orgId, "EDITOR"])),
      ]),
    );

  // The repo the use cases see INSIDE `repos.tx`. Every method is a fresh
  // vi.fn (shape from test-utils' prototype); the root repo below shares the
  // read methods and refuses the three tx-only draft primitives.
  const entityPages = Object.fromEntries(
    Object.keys(entityPagesRepoPrototype).map((key) => [key, vi.fn()]),
  ) as Record<keyof typeof entityPagesRepoPrototype, ReturnType<typeof vi.fn>>;

  entityPages.getByOwner.mockImplementation(
    async (type: PageOwnerType, id: string) =>
      page && page.ownerType === type && page.ownerId === id
        ? clone(page)
        : null,
  );
  entityPages.getById.mockImplementation(async (id: string) =>
    page && page.id === id ? clone(page) : null,
  );
  entityPages.getTheme.mockImplementation(async () =>
    theme ? clone(theme) : null,
  );
  entityPages.listBlocks.mockImplementation(async () => clone(blocks));
  entityPages.getDraft.mockImplementation(async () =>
    row ? clone(row) : null,
  );
  entityPages.lockDraftForUpdate.mockImplementation(async (pageId: string) => {
    if (!page || page.id !== pageId) fail("PAGE_NOT_FOUND");
    if (!row) {
      row = {
        id: "draft-1",
        pageId,
        data: {},
        placePatch: {},
        placeBase: {},
        fieldEditors: {},
        appliedBatchIds: [],
        revision: 0,
        lastPublishedRevision: null,
        updatedByHumanId: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
    return clone(row);
  });
  // Mirrors assertWritableDraft in the Prisma adapter.
  entityPages.writeDraft.mockImplementation(
    async (_pageId: string, next: WritePageDraftInput) => {
      assertRevision("revision", next.revision, 0);
      if (next.appliedBatchIds.length > PAGE_DRAFT_APPLIED_BATCH_IDS_MAX) {
        internal("page_draft_applied_batch_ids_over_cap");
      }
      for (const column of [
        "data",
        "placePatch",
        "placeBase",
        "fieldEditors",
      ] as const) {
        if (!isJsonObject(next[column])) {
          internal("page_draft_overlay_not_object");
        }
      }
      if (!row || next.revision <= row.revision) {
        internal("page_draft_row_missing_or_revision_not_increasing");
      }
      row = { ...row, ...clone(next), updatedAt: NOW };
      return clone(row);
    },
  );
  // Mirrors assertClearableDraft in the Prisma adapter.
  entityPages.clearDraft.mockImplementation(
    async (_pageId: string, input: ClearPageDraftInput) => {
      assertRevision("revision", input.revision, 0);
      if (input.lastPublishedRevision !== undefined) {
        assertRevision(
          "lastPublishedRevision",
          input.lastPublishedRevision,
          1,
          input.revision,
        );
      }
      if (!row || input.revision <= row.revision) {
        internal("page_draft_row_missing_or_revision_not_increasing");
      }
      row = {
        ...row,
        data: {},
        placePatch: {},
        placeBase: {},
        fieldEditors: {},
        revision: input.revision,
        ...(input.lastPublishedRevision !== undefined && {
          lastPublishedRevision: input.lastPublishedRevision,
        }),
        updatedByHumanId: input.updatedByHumanId,
        updatedAt: NOW,
      };
      return clone(row);
    },
  );

  // ── Live rows (publish) ────────────────────────────────────────────────
  entityPages.isSlugAvailable.mockImplementation(
    async (slug: string, excludePageId?: string) =>
      !takenSlugs.has(slug) &&
      !(page && page.slug === slug && page.id !== excludePageId),
  );
  entityPages.recordSlugHistory.mockImplementation(
    async (pageId: string, slug: string) => {
      slugHistory.push({ pageId, slug });
    },
  );
  entityPages.upsert.mockImplementation(
    async (input: Partial<EntityPageRecord> & { slug: string }) => {
      if (!page) fail("PAGE_NOT_FOUND");
      // The unique index on slug.
      if (takenSlugs.has(input.slug)) {
        throw Object.assign(new Error("Unique constraint failed on slug"), {
          code: "P2002",
        });
      }
      const defined = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      page = { ...page, ...defined, updatedAt: NOW } as EntityPageRecord;
      return clone(page);
    },
  );
  entityPages.upsertTheme.mockImplementation(
    async (input: { pageId: string } & Partial<PageThemeRecord>) => {
      theme = {
        id: theme?.id ?? "theme-1",
        colorPrimary: null,
        colorBg: null,
        colorText: null,
        fontKey: null,
        layoutKey: null,
        ...(theme ?? {}),
        ...input,
      };
      return clone(theme);
    },
  );
  entityPages.createBlock.mockImplementation(
    async (input: {
      pageId: string;
      kind: string;
      orderIndex?: number;
      data?: unknown;
      visible?: boolean;
      section?: string;
    }) => {
      // The pinned-kind partial unique index, mapped as the adapter maps it.
      if (
        isPinnedBlockKind(input.kind) &&
        blocks.some((existing) => existing.kind === input.kind)
      ) {
        fail("BLOCK_PINNED", {
          meta: { kind: input.kind, attempted: "add_duplicate" },
        });
      }
      const created = block(
        `blk-created-${++blockSeq}`,
        input.kind,
        input.orderIndex ??
          Math.max(-1, ...blocks.map((existing) => existing.orderIndex)) + 1,
        {
          data: input.data ?? {},
          visible: input.visible ?? true,
          section: input.section ?? "main",
        },
      );
      blocks = [...blocks, created];
      return clone(created);
    },
  );
  entityPages.updateBlock.mockImplementation(
    async (input: {
      id: string;
      orderIndex?: number;
      data?: unknown;
      visible?: boolean;
    }) => {
      const existing = blocks.find((candidate) => candidate.id === input.id);
      if (!existing) throw new Error("P2025: block not found");
      const next = {
        ...existing,
        ...(input.orderIndex !== undefined && { orderIndex: input.orderIndex }),
        ...(input.data !== undefined && { data: input.data }),
        ...(input.visible !== undefined && { visible: input.visible }),
      };
      blocks = blocks.map((candidate) =>
        candidate.id === input.id ? next : candidate,
      );
      return clone(next);
    },
  );
  entityPages.deleteBlock.mockImplementation(async (blockId: string) => {
    if (!blocks.some((candidate) => candidate.id === blockId)) {
      throw new Error("P2025: block not found");
    }
    blocks = blocks.filter((candidate) => candidate.id !== blockId);
  });
  entityPages.reorderBlocks.mockImplementation(
    async (_pageId: string, orderedIds: string[]) => {
      for (const id of orderedIds) {
        if (!blocks.some((candidate) => candidate.id === id)) {
          throw new Error("P2025: block not found");
        }
      }
      blocks = blocks.map((candidate) => {
        const index = orderedIds.indexOf(candidate.id);
        return index === -1 ? candidate : { ...candidate, orderIndex: index };
      });
    },
  );

  // Outside a transaction the adapter refuses the lock / write / clear.
  const rootEntityPages = {
    ...entityPages,
    lockDraftForUpdate: vi.fn(async (..._args: unknown[]) =>
      internal("page_draft_lock_outside_tx"),
    ),
    writeDraft: vi.fn(async (..._args: unknown[]) =>
      internal("page_draft_write_outside_tx"),
    ),
    clearDraft: vi.fn(async (..._args: unknown[]) =>
      internal("page_draft_clear_outside_tx"),
    ),
  };

  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? clone(place) : null)),
    // The claim lock (moderator place page spec, D4). `onClaimLock` stands
    // in for a claim that committed while this transaction waited on it.
    lockPlaceForClaim: vi.fn(async (placeId: string) => {
      // A transaction-scoped advisory lock: outside a tx it would lock
      // nothing (the re-check must run inside the writing transaction).
      if (txDepth === 0) internal("place_claim_lock_outside_tx");
      claimLockOrder.push(`claim:${placeId}`);
      onClaimLock?.();
    }),
    listActiveOwnershipsForPlace: vi.fn(async () => clone(ownerships)),
    // The Prisma places adapter's write, as far as publish uses it.
    upsert: vi.fn(
      async (input: {
        placeId: string | null;
        owner?: unknown;
        name: string;
        address: {
          formatted: string;
          /** Omitted = leave the stored line alone (the adapter's contract). */
          line1?: string;
          line2: string | null;
          city: string | null;
          region: string | null;
          postalCode: string | null;
          countryCode: string;
        };
        geo?: { lat: number; lng: number };
        capacity: number | null;
        phone: string | null;
        website: string | null;
        locationMode?: string;
        locationRadiusMeters?: number | null;
        locationLabel?: string | null;
      }) => {
        if (input.placeId !== PLACE_ID) throw new Error("P2025: place");
        const formatted = input.address.formatted.trim();
        place = {
          ...place,
          name: input.name,
          formattedAddress: input.address.formatted,
          addressLine1:
            input.address.line1 !== undefined
              ? input.address.line1
              : place.addressLine1,
          addressLine2: input.address.line2,
          city: input.address.city,
          region: input.address.region,
          postalCode: input.address.postalCode,
          countryCode: input.address.countryCode,
          lat: input.geo?.lat ?? null,
          lng: input.geo?.lng ?? null,
          addressHash: formatted ? formatted.toLowerCase() : null,
          capacity: input.capacity,
          phone: input.phone,
          website: input.website,
          ...(input.locationMode !== undefined && {
            locationMode: input.locationMode,
          }),
          ...(input.locationRadiusMeters !== undefined && {
            locationRadiusMeters: input.locationRadiusMeters,
          }),
          ...(input.locationLabel !== undefined && {
            locationLabel: input.locationLabel,
          }),
        };
        return clone(place);
      },
    ),
    updateTaxRate: vi.fn(
      async (input: {
        admissionTaxRateBps: number | null;
        taxRateSource: string | null;
      }) => {
        place = {
          ...place,
          admissionTaxRateBps: input.admissionTaxRateBps,
          taxRateSource: input.taxRateSource,
        };
      },
    ),
    updateTimezone: vi.fn(async (input: { timezone: string }) => {
      place = { ...place, timezone: input.timezone };
    }),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      knownHumans.filter((human) => ids.includes(human.id)),
    ),
    getById: vi.fn(
      async (id: string) =>
        knownHumans.find((human) => human.id === id) ?? null,
    ),
  };
  const events = {
    hasOwnedLiveEventsAtPlace: vi.fn(async () => ownedLiveEventsAtPlace),
    lockLocationsAtPlace: vi.fn(async () => undefined),
    reprojectLocationForPlace: vi.fn(async (): Promise<string[]> => []),
    followPlaceAddress: vi.fn(async () => ({
      followedIds: [] as string[],
      skippedIds: [] as string[],
    })),
  };
  const audit = {
    log: vi.fn(async (entry: FakeAuditRow) => {
      audits.push(clone(entry));
    }),
    // The Prisma adapter's exact-match read: newest first (at, then id).
    listForEntity: vi.fn(
      async (input: {
        entity: string;
        entityId: string;
        actions: readonly string[];
        after?: Date | null;
        limit: number;
      }) =>
        audits
          .map((row, index) => ({ row, id: `audit-${index + 1}` }))
          .filter(
            ({ row }) =>
              row.entity === input.entity &&
              row.entityId === input.entityId &&
              input.actions.includes(row.action) &&
              row.at !== undefined &&
              (!input.after || row.at.getTime() > input.after.getTime()),
          )
          .sort(
            (a, b) =>
              (b.row.at?.getTime() ?? 0) - (a.row.at?.getTime() ?? 0) ||
              b.id.localeCompare(a.id, "en", { numeric: true }),
          )
          .slice(0, input.limit)
          .map(({ row, id }) => ({
            id,
            entity: row.entity,
            entityId: row.entityId ?? null,
            action: row.action,
            data: clone(row.data ?? {}),
            actorHumanId:
              row.data !== null &&
              typeof row.data === "object" &&
              typeof (row.data as { actorHumanId?: unknown }).actorHumanId ===
                "string"
                ? (row.data as { actorHumanId: string }).actorHumanId
                : null,
            at: new Date(row.at?.getTime() ?? 0),
          })),
    ),
  };
  const searchReindexPending = {
    mark: vi.fn(async (targets: { entityType: string; entityId: string }[]) => {
      marks.push(...clone(targets));
    }),
  };
  const repoAuthz = {
    getOrgMembership: vi.fn(
      async (args: { orgId: string; humanId: string }) => {
        const role = orgRoles[args.humanId]?.[args.orgId];
        return role
          ? { orgId: args.orgId, humanId: args.humanId, role }
          : null;
      },
    ),
  };
  let txDepth = 0;
  const pendingObjectDeletions = {
    enqueueMany: vi.fn(async (items: EnqueuePendingObjectDeletionItem[]) => {
      for (const item of items) {
        pending.push({
          targetKey: item.targetKey,
          targetKind: item.targetKind,
          source: item.source ?? null,
          sourceId: item.sourceId ?? null,
          notBefore: item.notBefore ?? null,
          status: "PENDING",
        });
      }
    }),
    cancelPending: vi.fn(
      async (input: { source: string; targetKeys: readonly string[] }) => {
        const before = pending.length;
        pending = pending.filter(
          (entry) =>
            !(
              entry.status === "PENDING" &&
              entry.source === input.source &&
              input.targetKeys.includes(entry.targetKey)
            ),
        );
        return before - pending.length;
      },
    ),
  };

  const txRepos = {
    entityPages,
    places,
    humans,
    pendingObjectDeletions,
    events,
    audit,
    searchReindexPending,
    authz: repoAuthz,
  };
  const repos: Record<string, unknown> = {
    entityPages: rootEntityPages,
    places,
    humans,
    pendingObjectDeletions,
    events,
    audit,
    searchReindexPending,
    authz: repoAuthz,
  };
  // A SEPARATE tx object, serialised like the row lock; the draft row and
  // the outbox are restored when the callback throws, as a rollback would.
  let chain: Promise<unknown> = Promise.resolve();
  repos.tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const run = chain.then(async () => {
      const snapshot = clone({
        row,
        pending,
        page,
        theme,
        blocks,
        place,
        slugHistory,
        audits,
        marks,
      });
      txDepth++;
      try {
        return await fn(txRepos);
      } catch (error) {
        ({
          row,
          pending,
          page,
          theme,
          blocks,
          place,
          slugHistory,
          audits,
          marks,
        } = snapshot);
        throw error;
      } finally {
        txDepth--;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  });

  const authz = {
    requireOrgRole: vi.fn(
      async (args: { actorHumanId: string; orgId: string }) => {
        if (!(orgEditors[args.actorHumanId] ?? []).includes(args.orgId)) {
          fail("INSUFFICIENT_ROLE");
        }
      },
    ),
    canManagePlace: vi.fn(
      async (args: { actorHumanId: string; placeId: string }) => ({
        allowed: (placeManagers[args.actorHumanId] ?? []).includes(
          args.placeId,
        ),
      }),
    ),
    hasStaffRole: vi.fn(async (args: { actorHumanId: string }) => ({
      allowed: moderators.has(args.actorHumanId),
    })),
  };

  return {
    repos: repos as never,
    /** The repo inside `repos.tx` (draft primitives work here only). */
    entityPages,
    /** The root repo (draft lock / write / clear throw here). */
    rootEntityPages,
    places,
    humans,
    pendingObjectDeletions,
    events,
    audit,
    searchReindexPending,
    repoAuthz,
    authz,
    clock: { now: () => NOW },
    logger: spyLogger(),
    row: () => (row ? clone(row) : null),
    /** The outbox rows (pending-object-deletions). */
    pending: () => clone(pending),
    /** True while a `repos.tx` callback is running. */
    inTx: () => txDepth > 0,
    /** The live rows (publish writes these). */
    page: () => (page ? clone(page) : null),
    theme: () => (theme ? clone(theme) : null),
    blocks: () =>
      clone(blocks).sort((a, b) => a.orderIndex - b.orderIndex),
    place: () => clone(place),
    slugHistory: () => clone(slugHistory),
    audits: () => clone(audits),
    marks: () => clone(marks),
    /** An audit row committed earlier (a moderator write, a handover). */
    seedAudit: (row: FakeAuditRow) => {
      audits.push(clone(row));
    },
    setTheme: (next: PageThemeRecord | null) => {
      theme = next;
    },
    setRow: (next: PageDraftRecord | null) => {
      row = next ? clone(next) : null;
    },
    setPlace: (overrides: Record<string, unknown>) => {
      place = { ...place, ...overrides };
    },
    setPage: (next: EntityPageRecord | null) => {
      page = next;
    },
    setBlocks: (next: PageBlockRecord[]) => {
      blocks = next;
    },
    /** Place ownership rows (committed elsewhere; not rolled back). */
    setOwnerships: (next: HarnessOwnership[]) => {
      ownerships = clone(next);
    },
    setOwnedLiveEventsAtPlace: (next: boolean) => {
      ownedLiveEventsAtPlace = next;
    },
    /** Runs when a transaction takes the claim lock (a claim landing). */
    onClaimLock: (fn: (() => void) | null) => {
      onClaimLock = fn;
    },
    /** Which claim locks were taken, in order. */
    claimLocks: () => [...claimLockOrder],
  };
}

export type Harness = ReturnType<typeof makeHarness>;

/** Owner input for the harness page. */
export function ownerInput(
  actorHumanId: string,
  ownerType: PageOwnerType = "PLACE",
  ownerId = PLACE_ID,
) {
  return { actorHumanId, ownerType, ownerId };
}
