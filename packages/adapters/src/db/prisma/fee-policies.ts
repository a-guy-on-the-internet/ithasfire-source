import type { FeePolicy } from "@prisma/client";
import type {
  FeePoliciesRepo,
  FeePolicyRecord,
  UpsertFeePolicyInput,
} from "@th/ports/repos/fee-policies";

import type { PrismaClientOrTx } from "./types";

export function makeFeePoliciesRepo(p: PrismaClientOrTx): FeePoliciesRepo {
  return {
    async getById(id) {
      const policy = await p.feePolicy.findUnique({ where: { id } });
      return policy ? toFeePolicyRecord(policy) : null;
    },
    async resolveEffective({ scopeType, scopeId, at }) {
      const policy = await p.feePolicy.findFirst({
        where: {
          scopeType,
          scopeId: scopeType === "GLOBAL" ? null : scopeId,
          status: "ACTIVE",
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      });

      return policy ? toFeePolicyRecord(policy) : null;
    },
    async getByIds(ids) {
      const unique = [...new Set(ids)];
      const result = new Map<string, FeePolicyRecord>();
      if (unique.length === 0) return result;
      const policies = await p.feePolicy.findMany({
        where: { id: { in: unique } },
      });
      for (const policy of policies) {
        result.set(policy.id, toFeePolicyRecord(policy));
      }
      return result;
    },
    async resolveEffectiveForScopes({ scopeType, scopeIds, at }) {
      const unique = [...new Set(scopeIds)];
      const result = new Map<string, FeePolicyRecord>();
      if (unique.length === 0) return result;
      // The `resolveEffective` filter and ordering, widened to `scopeId IN`.
      // Rows arrive best-first per scope, so the FIRST row seen for a scope id
      // is the one `resolveEffective` would have returned for it.
      const policies = await p.feePolicy.findMany({
        where: {
          scopeType,
          scopeId: { in: unique },
          status: "ACTIVE",
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      });
      for (const policy of policies) {
        if (policy.scopeId == null || result.has(policy.scopeId)) continue;
        result.set(policy.scopeId, toFeePolicyRecord(policy));
      }
      return result;
    },
    async getActiveForScope({ scopeType, scopeId }) {
      // Deliberately the SAME query `upsert` runs to pick the row it archives
      // (status ACTIVE, highest version, no `effectiveFrom` filter), so the
      // reconciler compares against exactly what the write will replace. See
      // the port doc comment for the concurrency bug the time-filtered
      // `resolveEffective` caused here.
      const policy = await p.feePolicy.findFirst({
        where: {
          scopeType,
          scopeId: scopeType === "GLOBAL" ? null : scopeId,
          status: "ACTIVE",
        },
        orderBy: { version: "desc" },
      });
      return policy ? toFeePolicyRecord(policy) : null;
    },
    async lockScopeGuard({ scopeType, scopeId }): Promise<void> {
      // Transaction-scoped advisory lock — see the port doc comment
      // (`packages/ports/src/repos/fee-policies.ts`) for why the
      // `@@unique([scopeType, scopeId, status, version])` index cannot
      // serialize the GLOBAL version bump (`scopeId IS NULL`, and Postgres
      // treats NULLs as distinct). The partial index added in
      // 20260812130000_fee_policy_one_active_per_scope CAN reject the duplicate
      // (it keys on `COALESCE("scopeId", '')`), but as an unmapped P2002 — this
      // lock is still what makes the loser wait and no-op instead of crashing.
      //
      // `hashtext` deterministically maps the key string to a bigint-compatible
      // lock id; every caller for the SAME scope contends on that same id. The
      // key is a bound parameter, not interpolated — `scopeId` is a UUID from
      // our own tables, but nothing here builds SQL by concatenation.
      //
      // Deliberately `$executeRaw`, not `$queryRaw`: under the driver-adapter
      // engine (`@prisma/adapter-pg`) used throughout this repo,
      // `pg_advisory_xact_lock` returns Postgres `void`, which `$queryRaw`'s
      // result decoder cannot deserialize (`UnsupportedNativeDataType`).
      // `$executeRaw` only reports a row count, so it works. Same reasoning as
      // `authz.lockAdminRoleGuard`.
      const key = `fee_policy:${scopeType}:${scopeType === "GLOBAL" ? "" : (scopeId ?? "")}`;
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    },
    async upsert(input: UpsertFeePolicyInput): Promise<FeePolicyRecord> {
      // Find current active policy for this scope to determine next version
      const existing = await p.feePolicy.findFirst({
        where: {
          scopeType: input.scopeType,
          scopeId: input.scopeType === "GLOBAL" ? null : input.scopeId,
          status: "ACTIVE",
        },
        orderBy: { version: "desc" },
      });

      const nextVersion = existing ? existing.version + 1 : 1;
      const now = new Date();

      // Archive the old active policy (set effectiveTo)
      if (existing) {
        await p.feePolicy.update({
          where: { id: existing.id },
          data: { status: "ARCHIVED", effectiveTo: now },
        });
      }

      // Create the new active policy
      const created = await p.feePolicy.create({
        data: {
          scopeType: input.scopeType,
          scopeId: input.scopeType === "GLOBAL" ? null : input.scopeId,
          status: "ACTIVE",
          version: nextVersion,
          effectiveFrom: now,
          effectiveTo: null,
          buyerFeePct: input.buyerFeePct,
          // PASS `null` THROUGH. The column is `Int?` and `null` means "no
          // per-ticket cap" everywhere that reads it
          // (`compute-ticket-price-for-agreement.ts` does
          // `policy.maxFeeCents ?? POSITIVE_INFINITY`). This used to be
          // `?? 0`, which inverted the meaning at the only place it could not
          // be noticed: 0 makes `Math.min(0, pctFee)` ZERO THE PLATFORM FEE on
          // every sale. Now that `PLATFORM_FEE_POLICY` is the sole editing
          // surface, a one-token edit to `maxFeeCents: null` reading as
          // "remove the cap" would have silently zeroed all platform revenue
          // AND made the reconciler diff `0 !== null` forever, minting a
          // policy version on every deploy.
          maxFeeCents: input.maxFeeCents,
          minFeeCents: input.minFeeCents,
          maxPlatformFeeCents: input.maxPlatformFeeCents ?? null,
          platformFixedCents: input.platformFixedCents,
          feeMode: input.feeMode,
          processsorFeePct: input.processsorFeePct,
          processorFixedCents: input.processorFixedCents,
          payoutPct: input.payoutPct,
          payoutFixedCents: input.payoutFixedCents,
          monthlyPayoutCents: input.monthlyPayoutCents,
          payoutMinimumCents: input.payoutMinimumCents,
          // CARRY FORWARD when the caller omits it. `upsert` mints a new
          // version row, so defaulting to 0 here would silently switch OFF the
          // Connect active-account fee recovery every time a platform admin
          // edited an unrelated pricing knob.
          connectAccountFeeCents:
            input.connectAccountFeeCents ??
            existing?.connectAccountFeeCents ??
            0,
          notes: input.notes ?? null,
          createdBy: input.actorHumanId,
        },
      });

      return toFeePolicyRecord(created);
    },
  };
}

function toFeePolicyRecord(policy: FeePolicy): FeePolicyRecord {
  return {
    id: policy.id,
    scopeType: policy.scopeType,
    scopeId: policy.scopeId,
    status: policy.status,
    version: policy.version,
    effectiveFrom: policy.effectiveFrom,
    effectiveTo: policy.effectiveTo ?? null,
    buyerFeePct: decimalToNumber(policy.buyerFeePct),
    maxFeeCents: policy.maxFeeCents ?? null,
    minFeeCents: policy.minFeeCents,
    platformFixedCents: policy.platformFixedCents,
    feeMode: policy.feeMode,
    maxPlatformFeeCents: policy.maxPlatformFeeCents ?? null,
    processsorFeePct: decimalToNumber(policy.processsorFeePct),
    processorFixedCents: policy.processorFixedCents,
    payoutPct: decimalToNumber(policy.payoutPct),
    payoutFixedCents: policy.payoutFixedCents,
    monthlyPayoutCents: policy.monthlyPayoutCents,
    payoutMinimumCents: policy.payoutMinimumCents,
    connectAccountFeeCents: policy.connectAccountFeeCents,
  };
}

function decimalToNumber(value: FeePolicy["buyerFeePct"]): number {
  return Number(value);
}
