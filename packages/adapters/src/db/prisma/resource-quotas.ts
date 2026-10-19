import { Prisma } from "@prisma/client";
import type { ResourceQuotasRepo } from "@th/ports/repos/resource-quotas";
import {
  DEFAULT_RESOURCE_LIMITS,
  isTrustScaledKind,
  orgTrustLevelFromPayoutCount,
  TRUST_LEVEL_LIMITS,
  type CreateExpansionRequestInput,
  type DefaultResourceLimitRecord,
  type EffectiveQuota,
  type ExpansionRequestRecord,
  type ExpansionRequestStatus,
  type GetResourceUsageInput,
  type IncrementResourceUsageInput,
  type ListExpansionRequestsInput,
  type ListExpansionRequestsResult,
  type QuotaSubjectType,
  type ResourceLimitKind,
  type ResourceQuotaOverrideRecord,
  type ResourceUsageRecord,
  type ReviewExpansionRequestInput,
  type UpsertDefaultResourceLimitInput,
  type UpsertResourceQuotaOverrideInput,
} from "@th/types/repos/resource-quotas";

import type { PrismaClientOrTx } from "./types";

/**
 * Re-export for backward compat. The canonical source is
 * `DEFAULT_RESOURCE_LIMITS` in `@th/types`.
 */
export const FALLBACK_LIMITS = DEFAULT_RESOURCE_LIMITS;

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapDefaultLimit(row: any): DefaultResourceLimitRecord {
  return {
    kind: row.kind as ResourceLimitKind,
    limitValue: BigInt(row.limitValue),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function mapOverride(row: any): ResourceQuotaOverrideRecord {
  return {
    id: row.id,
    subjectType: row.subjectType as QuotaSubjectType,
    subjectId: row.subjectId,
    kind: row.kind as ResourceLimitKind,
    limitValue: BigInt(row.limitValue),
    note: row.note ?? null,
    grantedByHumanId: row.grantedByHumanId ?? null,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function mapUsage(row: any): ResourceUsageRecord {
  return {
    id: row.id,
    subjectType: row.subjectType as QuotaSubjectType,
    subjectId: row.subjectId,
    kind: row.kind as ResourceLimitKind,
    currentUsage: BigInt(row.currentUsage),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function mapExpansionRequest(row: any): ExpansionRequestRecord {
  return {
    id: row.id,
    subjectType: row.subjectType as QuotaSubjectType,
    subjectId: row.subjectId,
    kind: row.kind as ResourceLimitKind,
    currentLimitValue: BigInt(row.currentLimitValue),
    requestedLimitValue: BigInt(row.requestedLimitValue),
    reason: row.reason,
    status: row.status as ExpansionRequestStatus,
    requestedByHumanId: row.requestedByHumanId,
    reviewedByHumanId: row.reviewedByHumanId ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewNote: row.reviewNote ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeResourceQuotasRepo(
  p: PrismaClientOrTx,
): ResourceQuotasRepo {
  return {
    // ── Default limits ────────────────────────────────────────────────────
    async getDefaultLimit(
      kind: ResourceLimitKind,
    ): Promise<DefaultResourceLimitRecord | null> {
      const row = await (p as any).defaultResourceLimit.findUnique({
        where: { kind },
      });
      return row ? mapDefaultLimit(row) : null;
    },

    async listDefaultLimits(): Promise<DefaultResourceLimitRecord[]> {
      const rows = await (p as any).defaultResourceLimit.findMany({
        orderBy: { kind: "asc" },
      });
      return rows.map(mapDefaultLimit);
    },

    async upsertDefaultLimit(
      input: UpsertDefaultResourceLimitInput,
    ): Promise<DefaultResourceLimitRecord> {
      const row = await (p as any).defaultResourceLimit.upsert({
        where: { kind: input.kind },
        create: { kind: input.kind, limitValue: input.limitValue },
        update: { limitValue: input.limitValue },
      });
      return mapDefaultLimit(row);
    },

    // ── Overrides ───────────────────────────────────────────────────────
    async getOverride(
      input: GetResourceUsageInput,
    ): Promise<ResourceQuotaOverrideRecord | null> {
      const row = await (p as any).resourceQuotaOverride.findUnique({
        where: {
          subjectType_subjectId_kind: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            kind: input.kind,
          },
        },
      });
      return row ? mapOverride(row) : null;
    },

    async upsertOverride(
      input: UpsertResourceQuotaOverrideInput,
    ): Promise<ResourceQuotaOverrideRecord> {
      const row = await (p as any).resourceQuotaOverride.upsert({
        where: {
          subjectType_subjectId_kind: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            kind: input.kind,
          },
        },
        create: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
          limitValue: input.limitValue,
          note: input.note ?? null,
          grantedByHumanId: input.grantedByHumanId ?? null,
        },
        update: {
          limitValue: input.limitValue,
          note: input.note ?? null,
          grantedByHumanId: input.grantedByHumanId ?? null,
        },
      });
      return mapOverride(row);
    },

    // ── Usage ───────────────────────────────────────────────────────────
    async getUsage(
      input: GetResourceUsageInput,
    ): Promise<ResourceUsageRecord | null> {
      const row = await (p as any).resourceUsage.findUnique({
        where: {
          subjectType_subjectId_kind: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            kind: input.kind,
          },
        },
      });
      return row ? mapUsage(row) : null;
    },

    async incrementUsage(
      input: IncrementResourceUsageInput,
    ): Promise<ResourceUsageRecord> {
      // Atomic, race-free upsert with a zero-floor on BOTH branches. A negative
      // delta (a storage-quota credit) must never drive currentUsage below 0,
      // or enforceQuota would grant more headroom than the subject actually has.
      // GREATEST(0, ...) is a no-op for the normal positive-increment path.
      //
      // Parameterized via Prisma.sql (${} placeholders are bound, not
      // interpolated) — injection-safe. `delta` binds as a bigint; the enum
      // params are cast to their Postgres enum types. `id` is app-generated
      // (the model has @default(uuid()) but no DB default) and `updatedAt` is
      // set explicitly (the model uses @updatedAt, which Prisma manages
      // client-side and is absent in raw SQL). Single statement → no
      // read-modify-write race; RETURNING gives us the post-update row.
      const rows = await (p as PrismaClientOrTx).$queryRaw<
        Array<{
          id: string;
          subjectType: string;
          subjectId: string;
          kind: string;
          currentUsage: bigint;
          updatedAt: Date;
          createdAt: Date;
        }>
      >(Prisma.sql`
        INSERT INTO "ResourceUsage" (
          "id", "subjectType", "subjectId", "kind", "currentUsage", "updatedAt", "createdAt"
        )
        VALUES (
          ${crypto.randomUUID()},
          ${input.subjectType}::"QuotaSubjectType",
          ${input.subjectId},
          ${input.kind}::"ResourceLimitKind",
          GREATEST(0, ${input.delta}::bigint),
          NOW(),
          NOW()
        )
        ON CONFLICT ("subjectType", "subjectId", "kind") DO UPDATE
        SET "currentUsage" = GREATEST(0, "ResourceUsage"."currentUsage" + ${input.delta}::bigint),
            "updatedAt" = NOW()
        RETURNING "id", "subjectType", "subjectId", "kind", "currentUsage", "updatedAt", "createdAt"
      `);
      return mapUsage(rows[0]);
    },

    async deleteUsage(input: GetResourceUsageInput): Promise<void> {
      // deleteMany so a missing row is an idempotent no-op (delete() throws
      // P2025 when the unique target doesn't exist).
      await (p as any).resourceUsage.deleteMany({
        where: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
        },
      });
    },

    // ── Effective quota ─────────────────────────────────────────────────
    async getEffectiveQuota(
      input: GetResourceUsageInput,
    ): Promise<EffectiveQuota> {
      // Fetch override, default, and usage in parallel
      const [override, defaultLimit, usage] = await Promise.all([
        (p as any).resourceQuotaOverride.findUnique({
          where: {
            subjectType_subjectId_kind: {
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              kind: input.kind,
            },
          },
        }),
        (p as any).defaultResourceLimit.findUnique({
          where: { kind: input.kind },
        }),
        (p as any).resourceUsage.findUnique({
          where: {
            subjectType_subjectId_kind: {
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              kind: input.kind,
            },
          },
        }),
      ]);

      // 1. Manual override always wins
      if (override !== null) {
        return {
          kind: input.kind,
          limitValue: BigInt(override.limitValue),
          currentUsage: usage ? BigInt(usage.currentUsage) : 0n,
          isOverride: true,
        };
      }

      // 2. For ORG subjects with trust-scaled kinds, compute trust-level limit
      if (input.subjectType === "ORG" && isTrustScaledKind(input.kind)) {
        const payoutCount = await this.getCompletedPayoutCountForOrg(
          input.subjectId,
        );
        const trustLevel = orgTrustLevelFromPayoutCount(payoutCount);
        const trustLimit = TRUST_LEVEL_LIMITS[trustLevel][input.kind];

        // Use the higher of trust-level limit and platform default (admin may
        // have lowered the default for new orgs but trust should never shrink).
        const platformDefault = defaultLimit
          ? BigInt(defaultLimit.limitValue)
          : FALLBACK_LIMITS[input.kind];
        const limitValue =
          trustLimit > platformDefault ? trustLimit : platformDefault;

        return {
          kind: input.kind,
          limitValue,
          currentUsage: usage ? BigInt(usage.currentUsage) : 0n,
          isOverride: false,
          trustLevel,
        };
      }

      // 3. Platform default → hardcoded fallback
      const limitValue = defaultLimit
        ? BigInt(defaultLimit.limitValue)
        : FALLBACK_LIMITS[input.kind];

      return {
        kind: input.kind,
        limitValue,
        currentUsage: usage ? BigInt(usage.currentUsage) : 0n,
        isOverride: false,
      };
    },

    // ── Expansion requests ──────────────────────────────────────────────
    async getExpansionRequestById(
      id: string,
    ): Promise<ExpansionRequestRecord | null> {
      const row = await (p as any).expansionRequest.findUnique({
        where: { id },
      });
      return row ? mapExpansionRequest(row) : null;
    },

    async createExpansionRequest(
      input: CreateExpansionRequestInput,
    ): Promise<ExpansionRequestRecord> {
      const row = await (p as any).expansionRequest.create({
        data: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
          currentLimitValue: input.currentLimitValue,
          requestedLimitValue: input.requestedLimitValue,
          reason: input.reason,
          requestedByHumanId: input.requestedByHumanId,
          status: "PENDING",
        },
      });
      return mapExpansionRequest(row);
    },

    async reviewExpansionRequest(
      input: ReviewExpansionRequestInput,
    ): Promise<ExpansionRequestRecord> {
      const row = await (p as any).expansionRequest.update({
        where: { id: input.id },
        data: {
          status: input.status,
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: new Date(),
          reviewNote: input.reviewNote ?? null,
        },
      });
      return mapExpansionRequest(row);
    },

    async listExpansionRequests(
      input: ListExpansionRequestsInput,
    ): Promise<ListExpansionRequestsResult> {
      const where = input.status ? { status: input.status } : {};

      const [items, total] = await Promise.all([
        (p as any).expansionRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: input.limit,
          skip: input.offset,
        }),
        (p as any).expansionRequest.count({ where }),
      ]);

      return {
        items: items.map(mapExpansionRequest),
        total,
      };
    },

    async hasPendingExpansionRequest(
      input: GetResourceUsageInput,
    ): Promise<boolean> {
      const count = await (p as any).expansionRequest.count({
        where: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          kind: input.kind,
          status: "PENDING",
        },
      });
      return count > 0;
    },

    // ── Trust-level helpers ─────────────────────────────────────────────
    async getCompletedPayoutCountForOrg(orgId: string): Promise<number> {
      // Count distinct PayoutItem rows with status "transferred" where the
      // Payee is linked to this org (subjectType=ORGANIZATION, subjectId=orgId).
      const count = await (p as any).payoutItem.count({
        where: {
          status: "transferred",
          payee: {
            subjectType: "ORGANIZATION",
            subjectId: orgId,
          },
        },
      });
      return count;
    },
  };
}
