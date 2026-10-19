import type { PlaceVerificationRequestsRepo } from "@th/ports/repos/place-verification-requests";
import type {
  AcknowledgeVerificationInput,
  ClaimantPlaceClaimItem,
  CreatePlaceVerificationRequestInput,
  ListClaimsByClaimantInput,
  ListVerificationQueueInput,
  PlaceVerificationRequestRecord,
  UpdateVerificationDecisionInput,
  VerificationQueueItem,
  WithdrawVerificationInput,
} from "@th/types/repos/place-verification";

import type { PrismaClientOrTx } from "./types";

type RequestRow = {
  id: string;
  placeId: string;
  orgId: string | null;
  submittedById: string | null;
  status: string;
  source: string;
  claimantHumanId: string | null;
  claimOwnerType: "HUMAN" | "ORGANIZATION" | null;
  claimOwnerId: string | null;
  ownershipId: string | null;
  reviewerNotes: string | null;
  reviewerHumanId: string | null;
  reviewedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapRow(row: RequestRow): PlaceVerificationRequestRecord {
  return {
    id: row.id,
    placeId: row.placeId,
    orgId: row.orgId,
    submittedById: row.submittedById,
    status: row.status as PlaceVerificationRequestRecord["status"],
    source: row.source as PlaceVerificationRequestRecord["source"],
    claimantHumanId: row.claimantHumanId,
    claimOwnerType: row.claimOwnerType,
    claimOwnerId: row.claimOwnerId,
    ownershipId: row.ownershipId,
    reviewerNotes: row.reviewerNotes,
    reviewerHumanId: row.reviewerHumanId,
    reviewedAt: row.reviewedAt,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ACTIVE_STATUSES = ["PENDING", "IN_REVIEW"] as const;

const CLAIM_SOURCES = ["OWNERSHIP_CLAIM", "OWNERSHIP_DISPUTE"] as const;

// Matches the use case's Zod `.default(20)`; only reached if a caller
// bypasses the use case and omits `limit`.
const CLAIMANT_LIST_DEFAULT_LIMIT = 20;
const CLAIMANT_LIST_MAX_LIMIT = 100;

function getSafeClaimantListLimit(limit?: number) {
  return Math.min(
    Math.max(limit ?? CLAIMANT_LIST_DEFAULT_LIMIT, 1),
    CLAIMANT_LIST_MAX_LIMIT,
  );
}

export function makePlaceVerificationRequestsRepo(
  p: PrismaClientOrTx,
): PlaceVerificationRequestsRepo {
  return {
    create: async (input: CreatePlaceVerificationRequestInput) => {
      const row = await p.placeVerificationRequest.create({
        data: {
          placeId: input.placeId,
          orgId: input.orgId ?? null,
          submittedById: input.submittedById,
          status: "PENDING",
          source: input.source ?? "ORG_SUBMISSION",
          claimantHumanId: input.claimantHumanId ?? null,
          claimOwnerType: input.claimOwnerType ?? null,
          claimOwnerId: input.claimOwnerId ?? null,
          ownershipId: input.ownershipId ?? null,
        },
      });
      return mapRow(row);
    },

    getById: async (requestId: string) => {
      const row = await p.placeVerificationRequest.findUnique({
        where: { id: requestId },
      });
      return row ? mapRow(row) : null;
    },

    getLatestForPlace: async (placeId: string) => {
      const row = await p.placeVerificationRequest.findFirst({
        where: { placeId },
        orderBy: { createdAt: "desc" },
      });
      return row ? mapRow(row) : null;
    },

    listForPlace: async (placeId: string) => {
      const rows = await p.placeVerificationRequest.findMany({
        where: { placeId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(mapRow);
    },

    getActiveForPlace: async (placeId: string) => {
      // Legacy org-verification idempotency: ORG_SUBMISSION only. An
      // OWNERSHIP_CLAIM/DISPUTE must NOT be returned here, else an org
      // resubmitting verification would get a claim/dispute's requestId back as
      // a "reused" active request (use getActiveClaimForPlace for claims).
      const row = await p.placeVerificationRequest.findFirst({
        where: {
          placeId,
          source: "ORG_SUBMISSION",
          status: { in: [...ACTIVE_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      });
      return row ? mapRow(row) : null;
    },

    getActiveClaimForPlace: async (placeId: string) => {
      const row = await p.placeVerificationRequest.findFirst({
        where: {
          placeId,
          source: "OWNERSHIP_CLAIM",
          status: { in: [...ACTIVE_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      });
      return row ? mapRow(row) : null;
    },

    getActiveStatusByPlaceIds: async (placeIds: string[]) => {
      const result = new Map<string, "PENDING" | "IN_REVIEW">();
      if (placeIds.length === 0) return result;
      // Org-verification listing badges: ORG_SUBMISSION only. A claim's PENDING
      // state is already reflected by Place.verification=PENDING on the row
      // itself, and the claim CTA state has its own read
      // (getPlaceClaimEligibility), so mixing OWNERSHIP_CLAIM IN_REVIEW into the
      // org badge would mislabel these tiles. Kept ORG_SUBMISSION-only.
      const rows = await p.placeVerificationRequest.findMany({
        where: {
          placeId: { in: placeIds },
          source: "ORG_SUBMISSION",
          status: { in: [...ACTIVE_STATUSES] },
        },
        select: { placeId: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      // Newest-first ordering means the first row we see for any given
      // place wins, which is the most recent active request — exactly what
      // the listing UI wants to surface.
      for (const r of rows) {
        if (!result.has(r.placeId)) {
          result.set(r.placeId, r.status as "PENDING" | "IN_REVIEW");
        }
      }
      return result;
    },

    hasPendingForPlace: async (placeId: string) => {
      // ORG_SUBMISSION only (mirrors getActiveForPlace) — claims/disputes have
      // their own read paths and must not register as a legacy pending
      // verification.
      const count = await p.placeVerificationRequest.count({
        where: {
          placeId,
          source: "ORG_SUBMISSION",
          status: { in: [...ACTIVE_STATUSES] },
        },
      });
      return count > 0;
    },

    // Claimant-facing "my venue claims" list (all statuses). Querying by a
    // concrete claimantHumanId + claim sources inherently excludes legacy
    // ORG_SUBMISSION rows (claimantHumanId = null there anyway). Newest first,
    // same keyset cursor scheme as eventEditSuggestions.listBySubmitter
    // (cursor = request id, orderBy createdAt desc, id desc). The Place
    // relation is joined to hydrate the target's name + current slug. Reviewer
    // identity (reviewerHumanId / acknowledgedBy) is deliberately NOT selected.
    listByClaimant: async (input: ListClaimsByClaimantInput) => {
      const safeLimit = getSafeClaimantListLimit(input.limit);
      const rows = await p.placeVerificationRequest.findMany({
        where: {
          claimantHumanId: input.claimantHumanId,
          source: { in: [...CLAIM_SOURCES] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(input.cursor
          ? {
              cursor: { id: input.cursor },
              skip: 1,
            }
          : {}),
        take: safeLimit + 1,
        select: {
          id: true,
          placeId: true,
          source: true,
          status: true,
          claimOwnerType: true,
          claimOwnerId: true,
          claimantHumanId: true,
          reviewerNotes: true,
          reviewedAt: true,
          createdAt: true,
          place: { select: { name: true } },
        },
      });

      const hasMore = rows.length > safeLimit;
      const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;

      // The claimant's list links to each venue's PUBLIC page, which resolves
      // on `EntityPage.slug` — never on `Place.slug` (a multi-segment
      // directory key no route resolves). EntityPage is polymorphic, so there
      // is no relation to `include`; one extra index-backed read over the
      // page's ids covers the whole page (`safeLimit` <= 100).
      const pagePlaceIds = [...new Set(pageRows.map((row) => row.placeId))];
      const pages = pagePlaceIds.length
        ? await p.entityPage.findMany({
            where: { ownerType: "PLACE", ownerId: { in: pagePlaceIds } },
            select: { ownerId: true, slug: true, visibility: true },
          })
        : [];
      const pageByPlaceId = new Map(pages.map((page) => [page.ownerId, page]));

      const items: ClaimantPlaceClaimItem[] = pageRows.map((row) => ({
        requestId: row.id,
        placeId: row.placeId,
        placeName: row.place.name,
        placePageSlug: pageByPlaceId.get(row.placeId)?.slug ?? null,
        placePageVisibility:
          pageByPlaceId.get(row.placeId)?.visibility ?? null,
        source: row.source as ClaimantPlaceClaimItem["source"],
        status: row.status as ClaimantPlaceClaimItem["status"],
        // Claim/dispute rows always carry the claimed-as identity; the
        // fallback (the claimant themselves) only covers degenerate legacy
        // rows and never leaks another party's identifier.
        ownerType: row.claimOwnerType ?? "HUMAN",
        ownerId: row.claimOwnerId ?? row.claimantHumanId ?? input.claimantHumanId,
        createdAt: row.createdAt,
        reviewedAt: row.reviewedAt,
        reviewerNotes: row.reviewerNotes,
      }));

      const last = items.length > 0 ? items[items.length - 1] : undefined;
      return {
        items,
        nextCursor: hasMore && last ? last.requestId : null,
      };
    },

    // Counting twin of listByClaimant — the SAME where clause (claimant +
    // CLAIM_SOURCES), so a non-zero count always means that list has rows.
    countByClaimant: async (claimantHumanId: string) =>
      p.placeVerificationRequest.count({
        where: {
          claimantHumanId,
          source: { in: [...CLAIM_SOURCES] },
        },
      }),

    // The anti-squatting cap's count: open OWNERSHIP_CLAIM rows filed by
    // this person, for themselves or for an org. "Open" is ACTIVE_STATUSES,
    // the set the one-active-claim-per-place partial-unique index uses.
    countOpenClaimsByClaimant: async (claimantHumanId: string) =>
      p.placeVerificationRequest.count({
        where: {
          claimantHumanId,
          source: "OWNERSHIP_CLAIM",
          status: { in: [...ACTIVE_STATUSES] },
        },
      }),

    updateDecision: async (input: UpdateVerificationDecisionInput) => {
      const row = await p.placeVerificationRequest.update({
        where: { id: input.requestId },
        data: {
          status: input.status,
          reviewerHumanId: input.reviewerHumanId,
          reviewerNotes: input.reviewerNotes,
          reviewedAt: input.reviewedAt,
        },
      });
      return mapRow(row);
    },

    acknowledge: async (input: AcknowledgeVerificationInput) => {
      // Atomic: only PENDING → IN_REVIEW transitions succeed. updateMany returns
      // count=0 when the row is no longer PENDING (someone else claimed it).
      const result = await p.placeVerificationRequest.updateMany({
        where: { id: input.requestId, status: "PENDING" },
        data: {
          status: "IN_REVIEW",
          acknowledgedAt: input.acknowledgedAt,
          acknowledgedBy: input.acknowledgedBy,
        },
      });
      if (result.count === 0) return null;
      const row = await p.placeVerificationRequest.findUnique({
        where: { id: input.requestId },
      });
      return row ? mapRow(row) : null;
    },

    withdraw: async (input: WithdrawVerificationInput) => {
      const result = await p.placeVerificationRequest.updateMany({
        where: { id: input.requestId, status: "PENDING" },
        data: { status: "WITHDRAWN" },
      });
      if (result.count === 0) return null;
      const row = await p.placeVerificationRequest.findUnique({
        where: { id: input.requestId },
      });
      return row ? mapRow(row) : null;
    },

    release: async (input: { requestId: string }) => {
      const result = await p.placeVerificationRequest.updateMany({
        where: { id: input.requestId, status: "IN_REVIEW" },
        data: { status: "PENDING", acknowledgedAt: null, acknowledgedBy: null },
      });
      if (result.count === 0) return null;
      const row = await p.placeVerificationRequest.findUnique({
        where: { id: input.requestId },
      });
      return row ? mapRow(row) : null;
    },

    listQueue: async (input: ListVerificationQueueInput) => {
      const statuses = input.statuses ?? [...ACTIVE_STATUSES];
      const where = { status: { in: statuses } };

      const [total, rows] = await Promise.all([
        p.placeVerificationRequest.count({ where }),
        p.placeVerificationRequest.findMany({
          where,
          orderBy: [
            // PENDING (oldest) first, then IN_REVIEW (oldest acknowledged).
            // Rely on enum lexicographic order: IN_REVIEW < PENDING is false,
            // so we explicitly group by status via a CASE-like sort.
            { status: "asc" },
            { createdAt: "asc" },
          ],
          skip: input.offset,
          take: input.limit,
          include: {
            place: {
              select: {
                id: true,
                name: true,
                slug: true,
                address: true,
                city: true,
                region: true,
                country: true,
                capacity: true,
                website: true,
                phone: true,
                // Verified ownership claims on this place. Filtered relation
                // count keeps this a single query (no N+1) and mirrors the
                // ownerCount surfaced by listPlatformPlaces for consistency.
                _count: {
                  select: {
                    ownerships: { where: { verified: true, revokedAt: null } },
                  },
                },
              },
            },
            submittedBy: { select: { id: true, name: true } },
            reviewer: { select: { id: true, name: true } },
            acknowledger: { select: { id: true, name: true } },
            _count: { select: { documents: { where: { deletedAt: null } } } },
          },
        }),
      ]);

      // Stable secondary sort: PENDING first, then IN_REVIEW. Prisma's enum
      // ordering is alphabetic which would put IN_REVIEW before PENDING, so
      // re-sort in JS.
      const ordered = [...rows].sort((a, b) => {
        const rank = (s: string) =>
          s === "PENDING" ? 0 : s === "IN_REVIEW" ? 1 : 2;
        const r = rank(a.status) - rank(b.status);
        if (r !== 0) return r;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      const items: VerificationQueueItem[] = ordered.map((r) => ({
        request: mapRow(r),
        place: {
          id: r.place.id,
          name: r.place.name,
          formattedAddress: r.place.address,
          city: r.place.city,
          region: r.place.region,
          countryCode: r.place.country,
          capacity: r.place.capacity,
          website: r.place.website,
          phone: r.place.phone,
        },
        // Null when the submitting account has been deleted (SetNull FK).
        submitter: r.submittedBy
          ? {
              humanId: r.submittedBy.id,
              displayName: r.submittedBy.name,
            }
          : null,
        reviewer: r.reviewer
          ? { humanId: r.reviewer.id, displayName: r.reviewer.name }
          : null,
        acknowledger: r.acknowledger
          ? { humanId: r.acknowledger.id, displayName: r.acknowledger.name }
          : null,
        documentCount: r._count.documents,
        ownerCount: r.place._count.ownerships,
      }));

      return { items, total };
    },

    getQueueStats: async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [pending, inReview, reviewedThisMonth, oldestPending] =
        await Promise.all([
          p.placeVerificationRequest.count({ where: { status: "PENDING" } }),
          p.placeVerificationRequest.count({ where: { status: "IN_REVIEW" } }),
          p.placeVerificationRequest.count({
            where: {
              status: { in: ["APPROVED", "REJECTED"] },
              reviewedAt: { gte: monthStart },
            },
          }),
          p.placeVerificationRequest.findFirst({
            where: { status: "PENDING" },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        ]);

      return {
        pending,
        inReview,
        reviewedThisMonth,
        oldestPendingAgeMs: oldestPending
          ? now.getTime() - oldestPending.createdAt.getTime()
          : null,
      };
    },
  };
}
