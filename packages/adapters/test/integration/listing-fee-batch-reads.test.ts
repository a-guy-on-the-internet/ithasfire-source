/**
 * The batched reads behind all-in listing prices, against REAL Postgres:
 * every batch read must return, per id, exactly what its point read returns.
 * The listing loader (`loadListingBuyerTotalsByEventId`) swaps N point reads
 * for these, so a divergence here prices a card differently from the event
 * page.
 *
 *  - `feePolicies.resolveEffectiveForScopes` vs `resolveEffective` per scope:
 *    ARCHIVED rows, a future `effectiveFrom`, an elapsed `effectiveTo`, and a
 *    superseded version. (Two ACTIVE rows on one scope cannot be written: the
 *    `FeePolicy_one_active_per_scope_key` partial unique index rejects them,
 *    asserted below, so the adapter's tie-break never sees one.)
 *  - `feePolicies.getByIds` vs `getById`.
 *  - `payoutTerms.listByEventIds` vs `listForEvent`-style pointers.
 *  - `payoutTerms.listLinesByTermsIds` vs `listLines`, including the FR-005
 *    fence: a FIXED or NET_POOL line is excluded from both.
 *  - `places.getByIds` / `savedLocations.getByIds` vs their `getById`,
 *    including verified/unverified/revoked ownerships.
 *
 * Runs only with Docker (testcontainers). The canary test FAILS — it does not
 * skip — when the environment is down, so a green run that executed nothing
 * is visible.
 */
import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeFeePoliciesRepo } from "../../src/db/prisma/fee-policies";
import { makePayoutTermsRepo } from "../../src/db/prisma/payout-terms";
import { makePlacesRepo } from "../../src/db/prisma/places";
import { makeSavedLocationsRepo } from "../../src/db/prisma/saved-locations";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("Prisma adapters integration – listing fee batch reads", { timeout: 60_000 }, () => {
  let pg: PostgresTestContainer | undefined;
  let prisma: PrismaClient | undefined;
  let pool: Pool | undefined;
  let runtimeError: Error | null = null;

  let humanId: string;
  let orgId: string;

  beforeAll(async () => {
    try {
      pg = await startPostgresContainer();
      await runPrismaMigrateDeploy(pg.databaseUrl);

      process.env.DATABASE_URL = pg.databaseUrl;
      // Driver-adapter ("client" engine) mode — a bare `new PrismaClient()`
      // throws PrismaClientInitializationError. Constructed the way
      // packages/db/src/index.ts and the sibling integration suites do.
      pool = new Pool({ connectionString: pg.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      humanId = (
        await prisma.human.create({
          data: { name: "Batch Reader", status: "ACTIVE" },
        })
      ).id;
      orgId = (
        await prisma.organization.create({
          data: {
            name: "Batch Hall",
            slug: `batch-${randomUUID().slice(0, 8)}`,
          },
        })
      ).id;
    } catch (error) {
      runtimeError = error as Error;
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pg) await pg.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  const policy = (data: {
    scopeType: "GLOBAL" | "ORG" | "EVENT";
    scopeId: string | null;
    status: "ACTIVE" | "ARCHIVED" | "DRAFT";
    version: number;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    buyerFeePct?: number;
  }) =>
    prisma!.feePolicy.create({
      data: {
        scopeType: data.scopeType,
        scopeId: data.scopeId,
        status: data.status,
        version: data.version,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
        buyerFeePct: data.buyerFeePct ?? 0.05,
        minFeeCents: 50,
        platformFixedCents: 100,
        feeMode: "PASS_THROUGH",
        processsorFeePct: 0.029,
        processorFixedCents: 30,
        payoutPct: 0.0025,
        payoutFixedCents: 25,
        monthlyPayoutCents: 200,
        createdBy: humanId,
      },
    });

  test("resolveEffectiveForScopes agrees with resolveEffective for every scope", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeFeePoliciesRepo(prisma);

    // ORG A: an ARCHIVED v2 that is NEWER (effective yesterday, higher
    // version) than the ACTIVE v1 (effective last month). It would win the
    // ordering, so only the status filter keeps it out.
    const orgA = randomUUID();
    await policy({ scopeType: "ORG", scopeId: orgA, status: "ARCHIVED", version: 2, effectiveFrom: daysFromNow(-1), buyerFeePct: 0.09 });
    const orgAActive = await policy({ scopeType: "ORG", scopeId: orgA, status: "ACTIVE", version: 1, effectiveFrom: daysFromNow(-30), buyerFeePct: 0.04 });
    // ORG B: the ONLY ACTIVE row starts next week → nothing effective now.
    const orgB = randomUUID();
    await policy({ scopeType: "ORG", scopeId: orgB, status: "ACTIVE", version: 1, effectiveFrom: daysFromNow(7) });
    // ORG C: ACTIVE but its window closed yesterday → nothing effective now.
    const orgC = randomUUID();
    await policy({ scopeType: "ORG", scopeId: orgC, status: "ACTIVE", version: 1, effectiveFrom: daysFromNow(-30), effectiveTo: daysFromNow(-1) });
    // ORG D: ACTIVE, window still open (effectiveTo tomorrow) → effective.
    const orgD = randomUUID();
    const orgDActive = await policy({ scopeType: "ORG", scopeId: orgD, status: "ACTIVE", version: 3, effectiveFrom: daysFromNow(-2), effectiveTo: daysFromNow(1) });
    // ORG E: DRAFT only → nothing effective.
    const orgE = randomUUID();
    await policy({ scopeType: "ORG", scopeId: orgE, status: "DRAFT", version: 1, effectiveFrom: daysFromNow(-5) });
    // An EVENT-scoped ACTIVE row whose scopeId equals ORG A's id must NOT
    // leak into an ORG-scoped batch.
    await policy({ scopeType: "EVENT", scopeId: orgA, status: "ACTIVE", version: 1, effectiveFrom: daysFromNow(-1), buyerFeePct: 0.08 });
    // A scope id with no rows at all.
    const orgNone = randomUUID();

    const scopeIds = [orgA, orgB, orgC, orgD, orgE, orgNone, orgA];
    const batch = await repo.resolveEffectiveForScopes({ scopeType: "ORG", scopeIds, at: NOW });

    for (const scopeId of new Set(scopeIds)) {
      const point = await repo.resolveEffective({ scopeType: "ORG", scopeId, at: NOW });
      expect(batch.get(scopeId) ?? null, `scope ${scopeId}`).toEqual(point);
    }
    expect(batch.get(orgA)?.id).toBe(orgAActive.id);
    expect(batch.get(orgD)?.id).toBe(orgDActive.id);
    expect([...batch.keys()].sort()).toEqual([orgA, orgD].sort());
  });

  test("the partial unique index refuses a second ACTIVE row on one scope", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const scopeId = randomUUID();
    await policy({ scopeType: "ORG", scopeId, status: "ACTIVE", version: 1, effectiveFrom: daysFromNow(-10) });
    await expect(
      policy({ scopeType: "ORG", scopeId, status: "ACTIVE", version: 2, effectiveFrom: daysFromNow(-1) }),
    ).rejects.toThrow(/FeePolicy_one_active_per_scope_key|Unique constraint/);
  });

  test("feePolicies.getByIds returns exactly what getById returns, unknown ids absent", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeFeePoliciesRepo(prisma);
    const a = await policy({ scopeType: "EVENT", scopeId: randomUUID(), status: "ACTIVE", version: 1, effectiveFrom: daysFromNow(-1) });
    const b = await policy({ scopeType: "EVENT", scopeId: randomUUID(), status: "ARCHIVED", version: 1, effectiveFrom: daysFromNow(-9) });
    const missing = randomUUID();

    const batch = await repo.getByIds([a.id, b.id, missing, a.id]);

    expect(batch.get(a.id)).toEqual(await repo.getById(a.id));
    expect(batch.get(b.id)).toEqual(await repo.getById(b.id));
    expect(batch.has(missing)).toBe(false);
    expect(batch.size).toBe(2);
    expect(await repo.getByIds([])).toEqual(new Map());
  });

  const event = (data: { payoutTermsId?: string | null; resalePayoutTermsId?: string | null }) =>
    prisma!.event.create({
      data: {
        title: `Batch ${randomUUID().slice(0, 6)}`,
        startsAt: daysFromNow(10),
        endsAt: daysFromNow(10.1),
        status: "PUBLISHED",
        orgId,
        payoutTermsId: data.payoutTermsId ?? null,
        resalePayoutTermsId: data.resalePayoutTermsId ?? null,
      },
    });

  test("payoutTerms.listByEventIds: primary then resale per event, [] for none or unknown", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makePayoutTermsRepo(prisma);
    const primary = await prisma.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const resale = await prisma.payoutTerms.create({ data: { kind: "RESALE", status: "ACTIVE" } });
    const shared = await prisma.payoutTerms.create({ data: { kind: "PRIMARY", status: "ARCHIVED" } });

    const both = await event({ payoutTermsId: primary.id, resalePayoutTermsId: resale.id });
    const sharedA = await event({ payoutTermsId: shared.id });
    const sharedB = await event({ payoutTermsId: shared.id });
    const none = await event({});
    const unknown = randomUUID();

    const batch = await repo.listByEventIds([both.id, sharedA.id, sharedB.id, none.id, unknown, both.id]);

    expect(batch.get(both.id)?.map((t) => t.id)).toEqual([primary.id, resale.id]);
    expect(batch.get(sharedA.id)?.map((t) => t.id)).toEqual([shared.id]);
    expect(batch.get(sharedB.id)?.map((t) => t.id)).toEqual([shared.id]);
    expect(batch.get(none.id)).toEqual([]);
    expect(batch.get(unknown)).toEqual([]);
    // Each record is the point read's record.
    expect(batch.get(both.id)?.[0]).toEqual(await repo.getById(primary.id));
    expect(batch.get(sharedA.id)?.[0]?.status).toBe("ARCHIVED");
  });

  test("payoutTerms.listLinesByTermsIds equals listLines per id, FR-005 fence included", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makePayoutTermsRepo(prisma);
    const payee = (subjectId: string) =>
      prisma!.payee.create({ data: { subjectType: "ORGANIZATION", subjectId } }).then((p) => p.id);
    const venuePayee = await payee(orgId);
    const actPayee = await payee(randomUUID());

    const withFixed = await prisma.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const percentOnly = await prisma.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });
    const empty = await prisma.payoutTerms.create({ data: { kind: "PRIMARY", status: "ACTIVE" } });

    const venueLine = await prisma.payoutTermsLine.create({
      data: { payoutTermsId: withFixed.id, payeeId: venuePayee, percent: 80, priority: 1 },
    });
    // Outside the per-order fence: a FIXED guarantee and a NET_POOL split.
    await prisma.payoutTermsLine.create({
      data: { payoutTermsId: withFixed.id, payeeId: actPayee, amountType: "FIXED", amountCents: 80_000, percent: null } as never,
    });
    await prisma.payoutTermsLine.create({
      data: { payoutTermsId: withFixed.id, payeeId: actPayee, amountType: "PERCENT", percent: 10, basis: "NET_POOL" } as never,
    });
    const first = await prisma.payoutTermsLine.create({
      data: { payoutTermsId: percentOnly.id, payeeId: venuePayee, percent: 60, priority: 0 },
    });
    const second = await prisma.payoutTermsLine.create({
      data: { payoutTermsId: percentOnly.id, payeeId: actPayee, percent: 40, priority: 2 },
    });

    const ids = [withFixed.id, percentOnly.id, empty.id, randomUUID()];
    const batch = await repo.listLinesByTermsIds(ids);

    for (const id of ids) {
      expect(batch.get(id) ?? [], `terms ${id}`).toEqual(await repo.listLines(id));
    }
    expect(batch.get(withFixed.id)?.map((l) => l.id)).toEqual([venueLine.id]);
    expect(batch.get(percentOnly.id)?.map((l) => l.id)).toEqual([first.id, second.id]);
    for (const lines of batch.values()) {
      for (const line of lines) {
        expect(line).toMatchObject({ amountType: "PERCENT", basis: "GROSS" });
      }
    }
  });

  test("places.getByIds returns exactly what getById returns, access from verified unrevoked ownerships only", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makePlacesRepo(prisma);
    const place = (name: string) =>
      prisma!.place.create({
        data: { name, address: `1 ${name} Way`, capacity: 100, status: "ACTIVE", verification: "VERIFIED" },
      });
    const owned = await place("Owned");
    const mixed = await place("Mixed");
    const bare = await place("Bare");

    await prisma.placeOwnership.create({
      data: { placeId: owned.id, ownerType: "ORGANIZATION", ownerId: orgId, verified: true },
    });
    await prisma.placeOwnership.create({
      data: { placeId: owned.id, ownerType: "HUMAN", ownerId: humanId, verified: true },
    });
    // Mixed: one verified org, one UNVERIFIED human, one REVOKED org.
    await prisma.placeOwnership.create({
      data: { placeId: mixed.id, ownerType: "ORGANIZATION", ownerId: orgId, verified: true },
    });
    await prisma.placeOwnership.create({
      data: { placeId: mixed.id, ownerType: "HUMAN", ownerId: humanId, verified: false },
    });
    await prisma.placeOwnership.create({
      data: { placeId: mixed.id, ownerType: "ORGANIZATION", ownerId: randomUUID(), verified: true, revokedAt: daysFromNow(-1) },
    });
    const missing = randomUUID();

    const batch = await repo.getByIds([owned.id, mixed.id, bare.id, missing, owned.id]);

    for (const id of [owned.id, mixed.id, bare.id]) {
      expect(batch.get(id), `place ${id}`).toEqual(await repo.getById(id));
    }
    expect(batch.has(missing)).toBe(false);
    expect(batch.get(mixed.id)?.orgIdsWithAccess).toEqual([orgId]);
    expect(batch.get(mixed.id)?.humanIdsWithAccess).toEqual([]);
    expect(batch.get(bare.id)?.orgIdsWithAccess).toEqual([]);
    expect(await repo.getByIds([])).toEqual(new Map());
  });

  test("savedLocations.getByIds returns exactly what getById returns, unknown ids absent", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) return skip();
    const repo = makeSavedLocationsRepo(prisma);
    const create = (name: string, postalCode: string) =>
      repo.create({
        name,
        address: `${postalCode} Main St`,
        countryCode: "US",
        region: "TN",
        locality: "Nashville",
        postalCode,
        lat: 36.16,
        lng: -86.78,
        ownerType: "ORGANIZATION",
        ownerId: orgId,
      });
    const a = await create("A", "37203");
    const b = await create("B", "37204");
    await repo.updateTaxRate({
      id: b.id,
      admissionTaxRateBps: 925,
      taxRateSource: "ZIPTAX",
      taxRateFetchedAt: NOW,
    });
    const missing = randomUUID();

    const batch = await repo.getByIds([a.id, b.id, missing]);

    expect(batch.get(a.id)).toEqual(await repo.getById(a.id));
    expect(batch.get(b.id)).toEqual(await repo.getById(b.id));
    expect(batch.get(b.id)?.admissionTaxRateBps).toBe(925);
    expect(batch.has(missing)).toBe(false);
  });
});
