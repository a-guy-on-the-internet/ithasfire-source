/**
 * Shared helpers used across all E2E route modules.
 *
 * Centralises repeated patterns: auth gating, human resolution,
 * fee-policy / payout-terms scaffolding, error formatting, etc.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@th/db";
import type { HumanRole } from "@th/ports/authz";
import type { OrgRole } from "@th/ports/repos/authz";
import { clonePayoutTermsRow } from "@th/adapters/db/prisma/payout-terms";
import { PLATFORM_FEE_POLICY } from "@th/core/lib/pricing/platform-fee-policy";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * E2E seeds bypass the events adapter (they call `prisma.event.create`
 * directly), so they skip the snapshot-at-creation that production event
 * creation does. This helper clones a shared `PayoutTerms` row into an
 * event-owned snapshot so each seeded event still gets its own payout terms
 * — matching the production guarantee that schedule/line edits on the
 * shared agreement don't retroactively affect seeded events.
 *
 * Call this once per event, immediately before `prisma.event.create`.
 */
export async function snapshotPayoutTermsForE2eEvent(
  p: PrismaClient,
  sharedPayoutTermsId: string,
): Promise<string> {
  const cloned = await clonePayoutTermsRow(p, {
    sourcePayoutTermsId: sharedPayoutTermsId,
    isDefault: false,
  });
  if (!cloned) {
    throw new Error(
      `e2e snapshot failed: payout terms ${sharedPayoutTermsId} not found`,
    );
  }
  return cloned.id;
}

// ── Auth guard ───────────────────────────────────────────────────────────

export function assertE2eAuthorized(request: any, reply: any): boolean {
  if (process.env.NODE_ENV === "production") {
    reply.status(404).send({ ok: false });
    return false;
  }

  const expected = process.env.E2E_RESET_SECRET;
  const provided = request.headers["x-e2e-reset-secret"];
  if (!expected || typeof provided !== "string" || provided !== expected) {
    reply.status(401).send({ ok: false, error: "unauthorized" });
    return false;
  }

  return true;
}

// ── Error formatting ─────────────────────────────────────────────────────

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

/**
 * Extract a typed error code from an unknown Error-like object.
 */
export function extractErrorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && (err as any).code
    ? (err as any).code
    : undefined;
}

/**
 * Map a use-case error code to an HTTP status.
 */
export function httpStatusForCode(code: string | undefined): number {
  switch (code) {
    case "invalid_input":
      return 422;
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "dependency_failed":
      return 424;
    case "transient":
      return 503;
    case "unauthorized":
      return 401;
    default:
      return 500;
  }
}

// ── Human resolution ─────────────────────────────────────────────────────

export async function resolveHumanId(input: {
  humanId?: string;
  email?: string;
}): Promise<string | null> {
  if (input.humanId && typeof input.humanId === "string") return input.humanId;
  if (!input.email || typeof input.email !== "string") return null;

  const authUser = await prisma.authUser.findUnique({
    where: { email: input.email },
  });
  if (authUser?.humanId) return authUser.humanId;
  if (authUser) {
    const created = await prisma.human.create({
      data: { id: randomUUID(), status: "ACTIVE", roles: ["USER"] },
    });
    await prisma.authUser.update({
      where: { id: authUser.id },
      data: { humanId: created.id },
    });
    return created.id;
  }

  return null;
}

// ── Reusable fixture builders ────────────────────────────────────────────

/**
 * Create a Human + AuthUser pair.  Returns `{ humanId }`.
 */
export async function seedHumanWithAuth(opts: {
  email: string;
  name: string;
  now?: Date;
  roles?: HumanRole[];
}) {
  const now = opts.now ?? new Date();
  const human = await prisma.human.create({
    data: { status: "ACTIVE", roles: opts.roles ?? (["USER"] as HumanRole[]) },
  });
  await prisma.authUser.create({
    data: {
      id: human.id,
      humanId: human.id,
      email: opts.email,
      emailVerified: true,
      name: opts.name,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { humanId: human.id };
}

/**
 * Create the standard E2E fee-policy. Returns the Prisma record.
 *
 * Spreads `PLATFORM_FEE_POLICY` — the SAME code constant the deploy-time
 * reconciler (`scripts/seed-platform-fee-policy.ts`) materializes and
 * `seed/finance.ts` seeds. It used to hand-copy a flat 50¢ table, which made
 * the money suite green against economics production had stopped running: at
 * $50 face the old flat 50¢ and the new capped 3.33% both yield 50¢, so
 * `full-money-flow` could not tell which policy it had exercised.
 *
 * If you need a DIFFERENT policy for a specific journey, pass `overrides` —
 * explicitly, at the call site, where it is visible — rather than editing the
 * baseline here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ARCHIVE-THEN-CREATE, not a blind `create`
 * ─────────────────────────────────────────────────────────────────────────
 * Every seeder that needs money plumbing calls this, and several SPECS seed
 * more than once between resets — two paid-checkout events in one `beforeAll`
 * (`event-detail-currency.spec.ts`), an admin-tables describe followed by a
 * platform-tables describe that does NOT reset (`page-smoke.spec.ts`), a
 * journey that seeds an event-builder fixture and then a paid-checkout one
 * (`lifecycle-journey.spec.ts`), and the two `.trpc.e2e` specs that never
 * reset at all. A blind `create` therefore left two-plus ACTIVE GLOBAL rows
 * lying around, which the DB now forbids:
 * `FeePolicy_one_active_per_scope_key` (migration
 * 20260812130000_fee_policy_one_active_per_scope) is a partial unique index on
 * ("scopeType", COALESCE("scopeId", '')) WHERE status = 'ACTIVE'. The second
 * seed would have failed with P2002 and turned a green suite red.
 *
 * So this mirrors what production actually does (`feePolicies.upsert`): take
 * the same advisory lock the reconciler takes, archive the scope's current
 * ACTIVE row, and insert the next version. Nothing observable changes for the
 * earlier fixture — `PayoutTerms.feePolicyId` PINS the archived row and
 * `loadPayoutTermsContext` reads that pin with `getById`, which does not filter
 * on status, while the buyer-facing preview paths re-resolve the (identical)
 * newest ACTIVE row.
 *
 * The advisory lock is not decoration: Playwright runs specs across parallel
 * workers against one database, so two seeds can genuinely overlap, and the
 * read-modify-write on `version` below is exactly the race
 * `feePolicies.lockScopeGuard` exists to close.
 */
export async function seedFeePolicy(opts: {
  createdBy: string;
  approvedBy?: string;
  now?: Date;
  notes?: string;
  overrides?: Partial<Prisma.FeePolicyCreateInput>;
}) {
  const now = opts.now ?? new Date();
  const data = {
    ...PLATFORM_FEE_POLICY,
    status: "ACTIVE" as const,
    effectiveFrom: new Date(now.getTime() - 60_000),
    notes: opts.notes ?? "e2e",
    createdBy: opts.createdBy,
    approvedBy: opts.approvedBy ?? opts.createdBy,
    ...opts.overrides,
  };

  const scopeType = data.scopeType;
  const scopeId = data.scopeId ?? null;
  // Same key shape as `feePolicies.lockScopeGuard` in
  // `packages/adapters/src/db/prisma/fee-policies.ts`, so an e2e seed and a
  // manually-triggered reconcile contend on the same lock id. Bound parameter,
  // never string-interpolated SQL.
  const lockKey = `fee_policy:${scopeType}:${scopeType === "GLOBAL" ? "" : scopeId}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const existing = await tx.feePolicy.findFirst({
      where: { scopeType, scopeId, status: "ACTIVE" },
      orderBy: { version: "desc" },
      select: { id: true },
    });

    if (existing) {
      await tx.feePolicy.update({
        where: { id: existing.id },
        data: { status: "ARCHIVED", effectiveTo: data.effectiveFrom },
      });
    }

    // Version is per-scope and monotonic across ARCHIVED rows too: reusing
    // version 1 would collide with `@@unique([scopeType, scopeId, status,
    // version])` on the ARCHIVED tuple for any scope with a non-null
    // `scopeId` (GLOBAL escapes it only because NULLs compare distinct).
    const highest = await tx.feePolicy.aggregate({
      where: { scopeType, scopeId },
      _max: { version: true },
    });

    return tx.feePolicy.create({
      data: { ...data, version: data.version ?? (highest._max.version ?? 0) + 1 },
    });
  });
}

/**
 * Create payout terms + a single 100% line, optionally auto-creating a Payee.
 *
 * Returns `{ agreement, payee }`.
 * The PayoutTerms is linked to the event via `Event.payoutTermsId` FK
 * (set when the event is created).
 *
 * Supply **either** `payeeId` (existing) **or** `orgId` (auto-creates a Payee).
 */
export async function seedPayoutTerms(
  opts: {
    feePolicyId: string;
    currency?: string;
  } & (
    | { payeeId: string; orgId?: undefined; stripeAccountId?: string }
    | { orgId: string; payeeId?: undefined; stripeAccountId?: string }
  ),
) {
  // Resolve or create the payee
  let payeeId: string;
  let payee: Awaited<ReturnType<typeof prisma.payee.create>> | null = null;

  if (opts.payeeId) {
    payeeId = opts.payeeId;
  } else {
    payee = await prisma.payee.create({
      data: {
        subjectType: "ORGANIZATION",
        subjectId: opts.orgId!,
        stripeAccountId: opts.stripeAccountId ?? `acct_e2e_${Date.now()}`,
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
        defaultCurrency: opts.currency ?? "usd",
        requirements: {},
      },
    });
    payeeId = payee.id;
  }

  const agreement = await prisma.payoutTerms.create({
    data: {
      kind: "PRIMARY",
      version: 1,
      isDefault: true,
      settlementCurrency: opts.currency ?? "usd",
      status: "ACTIVE",
      feePolicyId: opts.feePolicyId,
    },
  });

  await prisma.payoutTermsLine.create({
    data: {
      payoutTermsId: agreement.id,
      payeeId,
      percent: 100,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
    },
  });

  return { agreement, payee };
}

/**
 * Create an Org + OrgMember link.  Returns the Prisma `Organization` record.
 */
export async function seedOrgWithMember(opts: {
  name: string;
  slugPrefix: string;
  humanId: string;
  role?: OrgRole;
}) {
  const org = await prisma.organization.create({
    data: {
      name: opts.name,
      slug: `${opts.slugPrefix}-${Date.now()}`,
      status: "ACTIVE",
      defaultLocale: null,
    },
  });
  await prisma.orgMember.create({
    data: {
      orgId: org.id,
      humanId: opts.humanId,
      role: opts.role ?? ("OWNER" as OrgRole),
    },
  });
  return org;
}

/**
 * Create a Payee for an org.  Returns the Prisma `Payee` record.
 */
export async function seedPayee(opts: {
  orgId: string;
  stripeAccountId?: string;
  currency?: string;
}) {
  return prisma.payee.upsert({
    where: {
      stripeAccountId: opts.stripeAccountId ?? `acct_e2e_${Date.now()}`,
    },
    update: {
      subjectType: "ORGANIZATION",
      subjectId: opts.orgId,
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      defaultCurrency: opts.currency ?? "usd",
      requirements: {},
    },
    create: {
      subjectType: "ORGANIZATION",
      subjectId: opts.orgId,
      stripeAccountId: opts.stripeAccountId ?? `acct_e2e_${Date.now()}`,
      status: "ACTIVE",
      payoutsEnabled: true,
      chargesEnabled: true,
      defaultCurrency: opts.currency ?? "usd",
      requirements: {},
    },
  });
}
