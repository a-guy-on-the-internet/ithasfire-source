import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import {
  ApiKeyRepoError,
  type ApiKeyRepoRefusalReason,
  type ApiKeysRepo,
} from "@th/ports/repos/api-keys";
import type {
  ApiKeyAccess,
  ApiKeyRequestRecord,
  ApiKeySubject,
} from "@th/types";

import { createBetterAuthAuthNAdapterWithDeps } from "../../../authn/better-auth-authn-adapter";
import { makeApiKeysRepo } from "../api-keys";
import { toApiKeyRepoError } from "../api-keys-errors";
import { createPrismaRepos } from "../index";

// ---------------------------------------------------------------------------
// Scoped API keys on REAL Postgres (scoped-api-keys spec, db_guards; step 2).
//
// Every CHECK, both guard triggers (api_keys_guard / api_key_requests_guard,
// latest version in migration 20261012120400_scoped_api_keys_guards_v4), the
// one-collect unique index and the composite scope FK are fired at least
// once, and each refusal is asserted as a TYPED ApiKeyRepoError (reason +
// constraint). Mostly through the adapter; where the adapter's CAS WHERE
// pre-empts a guard (so the adapter can never reach it), the guard is fired
// by a raw statement and mapped by the same mapper.
//
// The schema comes from `prisma migrate deploy` of the real migrations
// folder, so the guards under test are the shipped bytes.
//
// It must RUN, not skip: a failed container boot or migrate throws in
// beforeAll (every test then fails), and afterAll asserts that every test
// body executed. Adapter integration suites have skipped silently before.
//
// Clock: the guards stamp LOCALTIMESTAMP, so a 14-day lapse or a 7-day
// collect window cannot be waited out. `backdate()` disables the guard
// trigger for ONE setup UPDATE inside a transaction (the test DB user owns
// the tables) and re-enables it before commit. Test setup only: nothing in
// the adapter does this.
// ---------------------------------------------------------------------------

const REQUESTER = "a0000000-0000-4000-8000-000000000001";
const APPROVER = "a0000000-0000-4000-8000-000000000002";
const OTHER = "a0000000-0000-4000-8000-000000000003";
const SOLE_OWNER = "a0000000-0000-4000-8000-000000000004";
const CAP_HOLDER = "a0000000-0000-4000-8000-000000000005";
const CAP_OTHER = "a0000000-0000-4000-8000-000000000006";
const SWEEP_HOLDER = "a0000000-0000-4000-8000-000000000007";
const SUSPENDED_HOLDER = "a0000000-0000-4000-8000-000000000008";
const ORG_SHARED = "b0000000-0000-4000-8000-000000000001";
const ORG_SOLE = "b0000000-0000-4000-8000-000000000002";
const ORG_CAP = "b0000000-0000-4000-8000-000000000003";

const DAY_MS = 24 * 3600 * 1000;
const EXPECTED_TESTS = 43;

describe("scoped API keys: adapter + DB guards on real Postgres", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  let repo: ApiKeysRepo;
  let executed = 0;
  const queryLog: string[] = [];

  afterEach(async () => {
    executed += 1;
    // A test that disables a guard for setup must leave it enabled; a
    // disabled guard would let every later test pass vacuously.
    await expectGuardsEnabled();
  });

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    await runPrismaMigrateDeploy(pgContainer.databaseUrl);
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    prisma = new PrismaClient({
      adapter: new PrismaPg(pool),
      log: [{ emit: "event", level: "query" }],
    });
    (
      prisma as unknown as {
        $on(e: "query", cb: (ev: Prisma.QueryEvent) => void): void;
      }
    ).$on("query", (ev) => queryLog.push(ev.query));
    repo = makeApiKeysRepo(prisma);

    // Fails loudly if the guards are missing (e.g. a migration folder
    // without them): this suite is worthless without them.
    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgname IN ('api_keys_guard', 'api_key_requests_guard')
      ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "api_key_requests_guard",
      "api_keys_guard",
    ]);

    await prisma.human.createMany({
      data: [
        REQUESTER,
        APPROVER,
        OTHER,
        SOLE_OWNER,
        CAP_HOLDER,
        CAP_OTHER,
        SWEEP_HOLDER,
        SUSPENDED_HOLDER,
      ].map((id, i) => ({ id, name: `H${i}`, status: "ACTIVE" as const })),
    });
    await prisma.organization.createMany({
      data: [
        { id: ORG_SHARED, name: "Shared", slug: "ak-shared" },
        { id: ORG_SOLE, name: "Sole", slug: "ak-sole" },
        { id: ORG_CAP, name: "Cap", slug: "ak-cap" },
      ],
    });
    await prisma.orgMember.createMany({
      data: [
        { orgId: ORG_SHARED, humanId: REQUESTER, role: "OWNER" },
        { orgId: ORG_SHARED, humanId: APPROVER, role: "ADMIN" },
        { orgId: ORG_SOLE, humanId: SOLE_OWNER, role: "OWNER" },
        { orgId: ORG_CAP, humanId: CAP_HOLDER, role: "OWNER" },
        { orgId: ORG_CAP, humanId: CAP_OTHER, role: "ADMIN" },
      ],
    });
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
    // Every test body above ran (a skip or a setup failure leaves this short).
    expect(executed).toBe(EXPECTED_TESTS);
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function request(
    overrides: Partial<{
      requesterHumanId: string;
      subject: ApiKeySubject;
      orgId: string | null;
      access: ApiKeyAccess;
      expiryDays: number | null;
      autoRenew: boolean;
      label: string;
    }> = {},
  ): Promise<ApiKeyRequestRecord> {
    return repo.createRequest({
      requesterHumanId: REQUESTER,
      subject: "PERSONAL",
      orgId: null,
      access: "READ",
      label: "ci bot",
      purpose: "integration test purpose",
      expiryDays: 30,
      autoRenew: false,
      ...overrides,
    });
  }

  async function approved(
    overrides: Parameters<typeof request>[0] = {},
  ): Promise<ApiKeyRequestRecord> {
    const r = await request(overrides);
    const out = await repo.decide({
      requestId: r.id,
      decision: "APPROVED",
      decidedByHumanId: APPROVER,
      denialReason: null,
      selfApproved: false,
    });
    expect(out.status).toBe("decided");
    return r;
  }

  async function collected(overrides: Parameters<typeof request>[0] = {}) {
    const r = await approved(overrides);
    const out = await repo.collect({
      requestId: r.id,
      holderHumanId: r.requesterHumanId,
    });
    if (out.status !== "collected") throw new Error(out.status);
    return { request: r, key: out.key, record: out.record };
  }

  /** Assert a promise rejects with a typed ApiKeyRepoError. */
  async function expectRefused(
    p: Promise<unknown>,
    reason: ApiKeyRepoRefusalReason,
    constraint: string,
  ) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `expected refusal ${reason}`).toBeInstanceOf(ApiKeyRepoError);
    expect(err).toMatchObject({ code: "guard_refused", reason, constraint });
  }

  /** Fire a raw statement at a guard the adapter never reaches; map its error. */
  async function expectRawRefused(
    run: () => Promise<unknown>,
    reason: ApiKeyRepoRefusalReason,
    constraint: string,
  ) {
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `expected raw refusal ${reason}`).not.toBeNull();
    expect(toApiKeyRepoError(err)).toMatchObject({
      code: "guard_refused",
      reason,
      constraint,
    });
  }

  /**
   * TEST SETUP ONLY: move a guarded timestamp into the past with the guard
   * trigger disabled for this one UPDATE (same transaction; re-enabled
   * before commit).
   */
  async function backdate(
    table: "api_key_requests" | "api_keys",
    column: "created_at" | "decided_at",
    id: string,
    daysAgo: number,
    extraMinutes = 0,
  ) {
    const trigger =
      table === "api_keys" ? "api_keys_guard" : "api_key_requests_guard";
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE ${table} SET ${column} = ${column} - make_interval(days => $1, mins => $3) WHERE id = $2`,
        daysAgo,
        id,
        extraMinutes,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`,
      );
    });
  }

  /** Both guard triggers are enabled ('O' = fires in origin mode). */
  async function expectGuardsEnabled() {
    const rows = await prisma.$queryRaw<
      { tgname: string; tgenabled: string }[]
    >`
      SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger
      WHERE tgname IN ('api_keys_guard', 'api_key_requests_guard')`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.tgenabled, r.tgname).toBe("O");
  }

  const authn = () =>
    createBetterAuthAuthNAdapterWithDeps({
      repos: createPrismaRepos(prisma),
      verifyJwt: async () => ({ sub: null }),
    });

  // ── key requests: CHECKs and the insert guard ────────────────────────────

  it("creates a pending request; the DB stamps created_at", async () => {
    const before = Date.now();
    const r = await request();
    expect(r).toMatchObject({
      requesterHumanId: REQUESTER,
      subject: "PERSONAL",
      access: "READ",
      expiryDays: 30,
      decision: null,
      decidedAt: null,
      withdrawnAt: null,
      collectedAt: null,
      selfApproved: false,
    });
    expect(Math.abs(r.createdAt.getTime() - before)).toBeLessThan(60_000);
    expect(await repo.getRequest({ requestId: r.id })).toEqual(r);
  });

  it("refuses expiry beyond the subject's cap (api_key_requests_expiry_days_cap, R6)", async () => {
    await expectRefused(
      request({ subject: "STAFF", expiryDays: 31 }),
      "check_violation",
      "api_key_requests_expiry_days_cap",
    );
    await expectRefused(
      request({ subject: "PLATFORM_WIDE", expiryDays: null }),
      "check_violation",
      "api_key_requests_expiry_days_cap",
    );
    await expectRefused(
      request({ subject: "PERSONAL", expiryDays: 91 }),
      "check_violation",
      "api_key_requests_expiry_days_cap",
    );
  });

  it("refuses PLATFORM_WIDE + READ_WRITE (api_key_requests_platform_wide_read_only, R19)", async () => {
    await expectRefused(
      request({
        subject: "PLATFORM_WIDE",
        access: "READ_WRITE",
        expiryDays: 10,
      }),
      "check_violation",
      "api_key_requests_platform_wide_read_only",
    );
  });

  it("refuses auto-renew on a term under 2 days or never-expiring (api_key_requests_auto_renew_min_term, R30)", async () => {
    await expectRefused(
      request({ expiryDays: 1, autoRenew: true }),
      "check_violation",
      "api_key_requests_auto_renew_min_term",
    );
    await expectRefused(
      request({ expiryDays: null, autoRenew: true }),
      "check_violation",
      "api_key_requests_auto_renew_min_term",
    );
    // 2 days is the floor and is allowed.
    await expect(
      request({ expiryDays: 2, autoRenew: true }),
    ).resolves.toBeTruthy();
  });

  it("refuses an ORG request without its org (api_key_requests_org_shape)", async () => {
    await expectRefused(
      request({ subject: "ORG", orgId: null }),
      "check_violation",
      "api_key_requests_org_shape",
    );
  });

  it("refuses a request inserted already decided (api_key_requests_guard)", async () => {
    await expectRawRefused(
      () => prisma.$executeRaw`
        INSERT INTO api_key_requests (id, requester_human_id, subject, access,
          label, purpose, expiry_days, decision, decided_at, decided_by_human_id)
        VALUES (gen_random_uuid()::text, ${REQUESTER}, 'PERSONAL', 'READ', 'x',
          'integration test purpose', 5, 'APPROVED', now(), ${APPROVER})`,
      "request_not_inserted_pending",
      "api_key_requests_guard",
    );
  });

  // ── decide / withdraw ────────────────────────────────────────────────────

  it("refuses a self-approval shape the decider does not match (FR-003 CHECKs)", async () => {
    const r = await request({ subject: "STAFF", expiryDays: 10 });
    // Decider is the requester but not flagged selfApproved.
    await expectRefused(
      repo.decide({
        requestId: r.id,
        decision: "APPROVED",
        decidedByHumanId: REQUESTER,
        denialReason: null,
        selfApproved: false,
      }),
      "check_violation",
      "api_key_requests_self_approved_is_self",
    );
    // Flagged selfApproved but decided by someone else.
    await expectRefused(
      repo.decide({
        requestId: r.id,
        decision: "APPROVED",
        decidedByHumanId: APPROVER,
        denialReason: null,
        selfApproved: true,
      }),
      "check_violation",
      "api_key_requests_self_approved_is_self",
    );
    // Self-approval is STAFF-only.
    const personal = await request();
    await expectRefused(
      repo.decide({
        requestId: personal.id,
        decision: "APPROVED",
        decidedByHumanId: REQUESTER,
        denialReason: null,
        selfApproved: true,
      }),
      "check_violation",
      "api_key_requests_self_approved_shape",
    );
    // A denial needs its reason.
    await expectRefused(
      repo.decide({
        requestId: personal.id,
        decision: "DENIED",
        decidedByHumanId: APPROVER,
        denialReason: null,
        selfApproved: false,
      }),
      "check_violation",
      "api_key_requests_denial_reason_shape",
    );
    // The platform owner's break-glass shape is accepted.
    const ok = await repo.decide({
      requestId: r.id,
      decision: "APPROVED",
      decidedByHumanId: REQUESTER,
      denialReason: null,
      selfApproved: true,
    });
    expect(ok).toMatchObject({
      status: "decided",
      request: { selfApproved: true, decision: "APPROVED" },
    });
  });

  it("a decision is final: re-deciding is an outcome, and the guard refuses a raw rewrite", async () => {
    const r = await request();
    const first = await repo.decide({
      requestId: r.id,
      decision: "APPROVED",
      decidedByHumanId: APPROVER,
      denialReason: null,
      selfApproved: false,
    });
    expect(first.status).toBe("decided");
    if (first.status !== "decided") return;
    expect(first.request.decidedAt).not.toBeNull();
    expect(first.request.decidedByHumanId).toBe(APPROVER);

    const again = await repo.decide({
      requestId: r.id,
      decision: "DENIED",
      decidedByHumanId: OTHER,
      denialReason: "changed my mind about it",
      selfApproved: false,
    });
    expect(again).toMatchObject({
      status: "already_decided",
      request: { decision: "APPROVED", decidedByHumanId: APPROVER },
    });
    expect(
      await repo.decide({
        requestId: "00000000-0000-4000-8000-00000000ffff",
        decision: "APPROVED",
        decidedByHumanId: APPROVER,
        denialReason: null,
        selfApproved: false,
      }),
    ).toEqual({ status: "not_found" });

    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET decision = 'DENIED', denial_reason = 'nope nope nope'
        WHERE id = ${r.id}`,
      "decision_final",
      "api_key_requests_guard",
    );
    // Decision without a decider / decider without a decision.
    const pending = await request();
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET decision = 'DENIED', denial_reason = 'no decider here'
        WHERE id = ${pending.id}`,
      "decision_without_decider",
      "api_key_requests_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET decided_by_human_id = ${APPROVER}
        WHERE id = ${pending.id}`,
      "undecided_with_decider",
      "api_key_requests_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET label = 'edited after sending' WHERE id = ${pending.id}`,
      "request_content_immutable",
      "api_key_requests_guard",
    );
  });

  it("refuses approval after the 14-day lapse; denial still allowed (FR-004)", async () => {
    const r = await request();
    await backdate("api_key_requests", "created_at", r.id, 15);

    const out = await repo.decide({
      requestId: r.id,
      decision: "APPROVED",
      decidedByHumanId: APPROVER,
      denialReason: null,
      selfApproved: false,
    });
    expect(out).toMatchObject({
      status: "lapsed",
      request: { decision: null },
    });

    // The guard itself, past the adapter's CAS.
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests
        SET decision = 'APPROVED', decided_by_human_id = ${APPROVER}
        WHERE id = ${r.id}`,
      "request_lapsed",
      "api_key_requests_guard",
    );

    const denied = await repo.decide({
      requestId: r.id,
      decision: "DENIED",
      decidedByHumanId: APPROVER,
      denialReason: "lapsed, please ask again",
      selfApproved: false,
    });
    expect(denied).toMatchObject({
      status: "decided",
      request: { decision: "DENIED" },
    });
  });

  it("withdraw is a CAS by the requester and final; a withdrawn request cannot be decided or collected", async () => {
    const r = await request();
    expect(
      await repo.withdraw({ requestId: r.id, requesterHumanId: OTHER }),
    ).toEqual({ status: "not_found" });
    const out = await repo.withdraw({
      requestId: r.id,
      requesterHumanId: REQUESTER,
    });
    expect(out.status).toBe("withdrawn");
    if (out.status === "withdrawn") {
      expect(out.request.withdrawnAt).not.toBeNull();
      expect(out.request.withdrawalReason).toBe("REQUESTER");
    }
    expect(
      await repo.withdraw({ requestId: r.id, requesterHumanId: REQUESTER }),
    ).toMatchObject({ status: "already_withdrawn" });
    expect(
      await repo.decide({
        requestId: r.id,
        decision: "APPROVED",
        decidedByHumanId: APPROVER,
        denialReason: null,
        selfApproved: false,
      }),
    ).toMatchObject({ status: "withdrawn" });
    await expectRefused(
      repo.collect({ requestId: r.id, holderHumanId: REQUESTER }),
      "request_withdrawn",
      "api_keys_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET withdrawn_at = now() - interval '1 day' WHERE id = ${r.id}`,
      "withdrawal_final",
      "api_key_requests_guard",
    );
    // R31: the reason is final once recorded.
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET withdrawal_reason = 'ACCOUNT_SECURITY' WHERE id = ${r.id}`,
      "withdrawal_final",
      "api_key_requests_guard",
    );
    // The guard itself refuses deciding a withdrawn request (past the CAS).
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests
        SET decision = 'APPROVED', decided_by_human_id = ${APPROVER}
        WHERE id = ${r.id}`,
      "request_withdrawn",
      "api_key_requests_guard",
    );
  });

  it("R31 CHECKs: a reason exactly when withdrawn; REQUESTER only on an undecided request", async () => {
    const pending = await request();
    await expectRefused(
      (async () => {
        try {
          await prisma.$executeRaw`
            UPDATE api_key_requests SET withdrawn_at = now() WHERE id = ${pending.id}`;
        } catch (e) {
          throw toApiKeyRepoError(e) ?? e;
        }
      })(),
      "check_violation",
      "api_key_requests_withdrawal_reason_shape",
    );
    const ok = await approved();
    await expectRefused(
      (async () => {
        try {
          await prisma.$executeRaw`
            UPDATE api_key_requests
            SET withdrawn_at = now(), withdrawal_reason = 'REQUESTER'
            WHERE id = ${ok.id}`;
        } catch (e) {
          throw toApiKeyRepoError(e) ?? e;
        }
      })(),
      "check_violation",
      "api_key_requests_withdrawn_shape",
    );
    // ACCOUNT_SECURITY on a COLLECTED request is refused too.
    const { request: collectedReq } = await collected();
    await expectRefused(
      (async () => {
        try {
          await prisma.$executeRaw`
            UPDATE api_key_requests
            SET withdrawn_at = now(), withdrawal_reason = 'ACCOUNT_SECURITY'
            WHERE id = ${collectedReq.id}`;
        } catch (e) {
          throw toApiKeyRepoError(e) ?? e;
        }
      })(),
      "check_violation",
      "api_key_requests_withdrawn_shape",
    );
    // A request is inserted with no reason.
    await expectRawRefused(
      () => prisma.$executeRaw`
        INSERT INTO api_key_requests (id, requester_human_id, subject, access,
          label, purpose, expiry_days, withdrawal_reason)
        VALUES (gen_random_uuid()::text, ${REQUESTER}, 'PERSONAL', 'READ', 'x',
          'integration test purpose', 5, 'REQUESTER')`,
      "request_not_inserted_pending",
      "api_key_requests_guard",
    );
  });

  it("a renewal under a closed request is refused (api_keys_guard, R31)", async () => {
    const { request: r, record: parent } = await collected({
      expiryDays: 5,
      autoRenew: true,
    });
    // Unreachable through valid states (a collected request cannot be
    // closed: CHECK api_key_requests_withdrawn_shape), so the CHECK is
    // dropped inside a transaction that ALWAYS rolls back, and the guard is
    // shown to refuse on its own.
    await expectRawRefused(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE api_key_requests DROP CONSTRAINT "api_key_requests_withdrawn_shape"',
          );
          await tx.$executeRaw`
            UPDATE api_key_requests
            SET withdrawn_at = now(), withdrawal_reason = 'ACCOUNT_SECURITY'
            WHERE id = ${r.id}`;
          await makeApiKeysRepo(tx).renew({
            parentKeyId: parent.id,
            holderHumanId: REQUESTER,
          });
          throw new Error("renewal under a closed request was not refused");
        }),
      "request_withdrawn",
      "api_keys_guard",
    );
    const shape = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_constraint
      WHERE conname = 'api_key_requests_withdrawn_shape'`;
    expect(shape[0]!.n).toBe(1);
  });

  // ── collect ──────────────────────────────────────────────────────────────

  it("collects once: the DB stamps created_at and collected_at; a second collect is refused", async () => {
    const r = await approved({ expiryDays: 10 });
    expect(
      await repo.collect({ requestId: r.id, holderHumanId: OTHER }),
    ).toEqual({ status: "not_found" });

    const out = await repo.collect({
      requestId: r.id,
      holderHumanId: REQUESTER,
    });
    if (out.status !== "collected") throw new Error(out.status);
    expect(out.key).toMatch(/^thk_[A-Za-z0-9_-]{43}$/);
    expect(out.record.keyLast4).toBe(out.key.slice(-4));
    expect(out.record).toMatchObject({
      humanId: REQUESTER,
      requestId: r.id,
      subject: "PERSONAL",
      access: "READ",
      orgId: null,
      label: "ci bot",
      revokedAt: null,
      renewedFromKeyId: null,
    });
    expect(
      out.record.expiresAt!.getTime() - out.record.createdAt.getTime(),
    ).toBe(10 * DAY_MS);
    const after = await repo.getRequest({ requestId: r.id });
    expect(after?.collectedAt?.getTime()).toBe(out.record.createdAt.getTime());
    // The hash is stored, never the plaintext.
    const stored = await prisma.$queryRaw<{ key_hash: string }[]>`
      SELECT key_hash FROM api_keys WHERE id = ${out.record.id}`;
    expect(stored[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.key_hash).not.toContain(out.key);

    await expectRefused(
      repo.collect({ requestId: r.id, holderHumanId: REQUESTER }),
      "already_collected_or_collect_lapsed",
      "api_keys_guard",
    );
  });

  it("the one-collect unique index backs the guard (api_keys_one_collect_per_request)", async () => {
    const { request: r } = await collected();
    // With the guard off, only the partial unique index stands in the way.
    // The transaction ALWAYS rolls back: if the index failed to fire, the
    // sentinel throw below undoes the insert AND the DISABLE TRIGGER, so a
    // broken index fails this test only, never the guard in later tests.
    await expectRawRefused(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "ALTER TABLE api_keys DISABLE TRIGGER api_keys_guard",
          );
          await tx.$executeRaw`
            INSERT INTO api_keys (id, human_id, key_hash, label, request_id,
              subject, access, expires_at, key_last4)
            VALUES (gen_random_uuid()::text, ${REQUESTER}, ${"x".repeat(64)}, 'ci bot',
              ${r.id}, 'PERSONAL', 'READ', now() AT TIME ZONE 'UTC' + interval '1 day', 'abcd')`;
          throw new Error("api_keys_one_collect_per_request did not fire");
        }),
      "unique_violation",
      "api_keys_one_collect_per_request",
    );
  });

  it("refuses collect after a denial (api_keys_guard)", async () => {
    const r = await request();
    await repo.decide({
      requestId: r.id,
      decision: "DENIED",
      decidedByHumanId: APPROVER,
      denialReason: "not for this purpose",
      selfApproved: false,
    });
    await expectRefused(
      repo.collect({ requestId: r.id, holderHumanId: REQUESTER }),
      "request_not_approved",
      "api_keys_guard",
    );
  });

  it("refuses collect after the 7-day collection window (FR-005)", async () => {
    const r = await approved();
    await backdate("api_key_requests", "decided_at", r.id, 8);
    await expectRefused(
      repo.collect({ requestId: r.id, holderHumanId: REQUESTER }),
      "already_collected_or_collect_lapsed",
      "api_keys_guard",
    );
  });

  it("the composite scope FK refuses a key whose holder is not the requester", async () => {
    const r = await approved();
    await expectRawRefused(
      () => prisma.$executeRaw`
        INSERT INTO api_keys (id, human_id, key_hash, label, request_id,
          subject, access, expires_at, key_last4)
        VALUES (gen_random_uuid()::text, ${OTHER}, ${"y".repeat(64)}, 'ci bot',
          ${r.id}, 'PERSONAL', 'READ', (now() AT TIME ZONE 'UTC')::timestamp(3) + interval '1 day', 'abcd')`,
      "foreign_key_violation",
      "api_keys_request_scope_fkey",
    );
  });

  it("api_keys_guard refuses a key born revoked or outside its request's term", async () => {
    const r = await approved({ expiryDays: 5 });
    await expectRawRefused(
      () => prisma.$executeRaw`
        INSERT INTO api_keys (id, human_id, key_hash, label, request_id,
          subject, access, expires_at, key_last4, revoked_at)
        VALUES (gen_random_uuid()::text, ${REQUESTER}, ${"z".repeat(64)}, 'ci bot',
          ${r.id}, 'PERSONAL', 'READ', now() AT TIME ZONE 'UTC' + interval '1 day', 'abcd', now())`,
      "key_born_dirty",
      "api_keys_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        INSERT INTO api_keys (id, human_id, key_hash, label, request_id,
          subject, access, expires_at, key_last4)
        VALUES (gen_random_uuid()::text, ${REQUESTER}, ${"w".repeat(64)}, 'ci bot',
          ${r.id}, 'PERSONAL', 'READ', now() AT TIME ZONE 'UTC' + interval '6 days', 'abcd')`,
      "expiry_outside_term",
      "api_keys_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET collected_at = now() WHERE id = ${r.id}`,
      "collected_at_writer",
      "api_key_requests_guard",
    );
  });

  // ── renew / revoke ───────────────────────────────────────────────────────

  it("renews once in the last 7 days; a second live key on the request is refused", async () => {
    const { request: r, record: parent } = await collected({
      expiryDays: 5,
      autoRenew: true,
    });
    expect(parent.autoRenew).toBe(true);

    const out = await repo.renew({
      parentKeyId: parent.id,
      holderHumanId: REQUESTER,
    });
    if (out.status !== "renewed") throw new Error(out.status);
    expect(out.record).toMatchObject({
      requestId: r.id,
      renewedFromKeyId: parent.id,
      subject: "PERSONAL",
      access: "READ",
      label: "ci bot",
      autoRenew: true,
    });
    expect(
      out.record.expiresAt!.getTime() - out.record.createdAt.getTime(),
    ).toBe(5 * DAY_MS);
    // The trigger cut the parent to now + 24h.
    const cut = await repo.getKey({ keyId: parent.id });
    expect(cut!.expiresAt!.getTime() - out.record.createdAt.getTime()).toBe(
      DAY_MS,
    );

    // Renewing again, from either key, would make a third live key.
    await expectRefused(
      repo.renew({ parentKeyId: out.record.id, holderHumanId: REQUESTER }),
      "renewal_overlap",
      "api_keys_guard",
    );
    await expectRefused(
      repo.renew({ parentKeyId: parent.id, holderHumanId: REQUESTER }),
      "renewal_overlap",
      "api_keys_guard",
    );
    expect(
      await repo.renew({ parentKeyId: parent.id, holderHumanId: OTHER }),
    ).toEqual({ status: "not_found" });
  });

  it("refuses renewal outside the last 7 days or without auto-renew", async () => {
    const { record: far } = await collected({
      expiryDays: 20,
      autoRenew: true,
    });
    await expectRefused(
      repo.renew({ parentKeyId: far.id, holderHumanId: REQUESTER }),
      "renewal_not_allowed",
      "api_keys_guard",
    );
    const { record: noAuto } = await collected({ expiryDays: 5 });
    await expectRefused(
      repo.renew({ parentKeyId: noAuto.id, holderHumanId: REQUESTER }),
      "auto_renew_not_allowed",
      "api_keys_guard",
    );
  });

  it("revoke kills BOTH live keys of an approval; revoke is final; revoked keys stop resolving", async () => {
    const { key: parentKey, record: parent } = await collected({
      expiryDays: 5,
      autoRenew: true,
    });
    const renewed = await repo.renew({
      parentKeyId: parent.id,
      holderHumanId: REQUESTER,
    });
    if (renewed.status !== "renewed") throw new Error(renewed.status);

    const a = authn();
    await expect(
      a.ensureAuthedHumanFromApiKey({ apiKey: parentKey }),
    ).resolves.toMatchObject({ humanId: REQUESTER });
    await expect(
      a.ensureAuthedHumanFromApiKey({ apiKey: renewed.key }),
    ).resolves.toMatchObject({ humanId: REQUESTER });

    const out = await repo.revokeKey({
      keyId: renewed.record.id,
      revokedByHumanId: APPROVER,
      reason: "leaked in a log",
    });
    expect(out).toEqual({
      status: "revoked",
      revokedKeyIds: [parent.id, renewed.record.id].sort(),
      alsoClosedExpiredKeyIds: [],
    });
    const both = await prisma.$queryRaw<
      { revoked_by_human_id: string; revoke_reason: string; revoked_at: Date }[]
    >`SELECT revoked_by_human_id, revoke_reason, revoked_at FROM api_keys
      WHERE id IN (${parent.id}, ${renewed.record.id})`;
    expect(both).toHaveLength(2);
    for (const k of both) {
      expect(k.revoked_by_human_id).toBe(APPROVER);
      expect(k.revoke_reason).toBe("leaked in a log");
      expect(k.revoked_at).toBeInstanceOf(Date);
    }

    await expect(
      a.ensureAuthedHumanFromApiKey({ apiKey: parentKey }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      a.ensureAuthedHumanFromApiKey({ apiKey: renewed.key }),
    ).rejects.toMatchObject({ code: "unauthorized" });

    expect(
      await repo.revokeKey({
        keyId: parent.id,
        revokedByHumanId: APPROVER,
        reason: null,
      }),
    ).toEqual({ status: "already_revoked" });
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_keys SET revoke_reason = 'rewritten' WHERE id = ${parent.id}`,
      "revocation_final",
      "api_keys_guard",
    );
  });

  // ── authn resolution ─────────────────────────────────────────────────────

  it("resolves a scoped key with its scope in ONE statement (NFR-003)", async () => {
    const {
      key,
      record,
      request: r,
    } = await collected({
      subject: "ORG",
      orgId: ORG_SHARED,
      access: "READ_WRITE",
    });
    const a = authn();
    queryLog.length = 0;
    const out = await a.ensureAuthedHumanFromApiKey({ apiKey: key });
    const statements = [...queryLog];
    expect(out).toEqual({
      humanId: REQUESTER,
      keyScope: {
        kind: "scoped",
        keyId: record.id,
        requestId: r.id,
        subject: "ORG",
        access: "READ_WRITE",
        orgId: ORG_SHARED,
      },
    });
    // Exactly one statement, and no transaction around it (a tx logs COMMIT).
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/UPDATE api_keys AS k/);

    // Control: the counter does see a transaction's COMMIT, so "1" above is
    // a real measurement, not a counter that only ever sees one event.
    queryLog.length = 0;
    await createPrismaRepos(prisma).tx((tx) =>
      tx.apiKeys.getHumanIdForKey({ apiKey: key }),
    );
    expect(queryLog.length).toBeGreaterThan(1);
  });

  it("does not resolve an expired key; expiry only moves earlier", async () => {
    const { key, record } = await collected({ expiryDays: 5 });
    const a = authn();
    await expect(
      a.ensureAuthedHumanFromApiKey({ apiKey: key }),
    ).resolves.toBeTruthy();

    // Earlier is allowed by the guard (no trigger bypass needed).
    await prisma.$executeRaw`
      UPDATE api_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE id = ${record.id}`;
    await expect(
      a.ensureAuthedHumanFromApiKey({ apiKey: key }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await repo.getHumanIdForKey({ apiKey: key })).toBeNull();

    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_keys SET expires_at = expires_at + interval '1 day' WHERE id = ${record.id}`,
      "expiry_only_earlier",
      "api_keys_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_keys SET label = 'renamed' WHERE id = ${record.id}`,
      "key_identity_immutable",
      "api_keys_guard",
    );
  });

  it("resolves a legacy key as legacy, never with a scope", async () => {
    const legacy = await repo.create({ humanId: OTHER, label: "old" });
    const out = await authn().ensureAuthedHumanFromApiKey({
      apiKey: legacy.key,
    });
    expect(out).toEqual({
      humanId: OTHER,
      keyScope: { kind: "legacy", keyId: legacy.id },
    });
    const legacyRevoke = await repo.revokeKey({
      keyId: legacy.id,
      revokedByHumanId: OTHER,
      reason: null,
    });
    expect(legacyRevoke).toEqual({
      status: "revoked",
      revokedKeyIds: [legacy.id],
      alsoClosedExpiredKeyIds: [],
    });
  });

  it("refuses a key with a partial scope, never resolving it as legacy", async () => {
    const r = await approved();
    const shapes = [
      { subject: "PERSONAL", access: null, requestId: null },
      { subject: "PERSONAL", access: "READ", requestId: null },
      { subject: null, access: null, requestId: r.id },
    ] as const;
    const legacy = await repo.create({ humanId: REQUESTER, label: "partial" });
    for (const shape of shapes) {
      // Such a row needs api_keys_scope_shape and the guard out of the way.
      // The transaction ALWAYS rolls back (sentinel), restoring both, so
      // later tests still run against every guard.
      const SENTINEL = "partial-scope-rollback";
      let resolved: unknown = "not-run";
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "ALTER TABLE api_keys DROP CONSTRAINT api_keys_scope_shape",
          );
          await tx.$executeRawUnsafe(
            "ALTER TABLE api_keys DISABLE TRIGGER api_keys_guard",
          );
          await tx.$executeRaw`
            UPDATE api_keys
            SET subject = ${shape.subject}::"ApiKeySubject",
                access = ${shape.access}::"ApiKeyAccess",
                request_id = ${shape.requestId},
                key_last4 = 'abcd'
            WHERE id = ${legacy.id}`;
          resolved = await makeApiKeysRepo(tx).getHumanIdForKey({
            apiKey: legacy.key,
          });
          throw new Error(SENTINEL);
        }),
      ).rejects.toThrow(SENTINEL);
      expect(resolved).toBeNull();
      // Control: rolled back to an all-null legacy row, it resolves again.
      expect(await repo.getHumanIdForKey({ apiKey: legacy.key })).toMatchObject({
        keyScope: { kind: "legacy", keyId: legacy.id },
      });
    }
    const constraint = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'api_keys_scope_shape'`;
    expect(Number(constraint[0]!.n)).toBe(1);
  });

  // ── auto-renew switches ──────────────────────────────────────────────────

  it("auto-renew: the holder's switch needs the request on; the approver's switch-off is on the request and final", async () => {
    const { request: r, record } = await collected({
      expiryDays: 10,
      autoRenew: true,
    });
    expect(
      await repo.setKeyAutoRenew({ keyId: record.id, autoRenew: false }),
    ).toMatchObject({ status: "updated", record: { autoRenew: false } });
    expect(
      await repo.setKeyAutoRenew({ keyId: record.id, autoRenew: true }),
    ).toMatchObject({ status: "updated", record: { autoRenew: true } });

    const off = await repo.switchOffRequestAutoRenew({ requestId: r.id });
    expect(off).toMatchObject({
      status: "switched_off",
      request: { autoRenew: false },
      keyIds: [record.id],
    });
    expect(
      await repo.setKeyAutoRenew({ keyId: record.id, autoRenew: true }),
    ).toMatchObject({ status: "request_disallows" });
    expect(
      await repo.switchOffRequestAutoRenew({ requestId: r.id }),
    ).toMatchObject({ status: "unchanged" });

    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_key_requests SET auto_renew = true WHERE id = ${r.id}`,
      "request_auto_renew_switch_on",
      "api_key_requests_guard",
    );
    await expectRawRefused(
      () => prisma.$executeRaw`
        UPDATE api_keys SET auto_renew = true WHERE id = ${record.id}`,
      "auto_renew_not_allowed",
      "api_keys_guard",
    );
  });

  // ── bulk revoke, caps, queues, notices ───────────────────────────────────

  it("revokeAllForHuman revokes scoped and legacy keys, request rows locked first", async () => {
    const one = await collected({ requesterHumanId: SWEEP_HOLDER });
    const two = await collected({
      requesterHumanId: SWEEP_HOLDER,
      expiryDays: 5,
      autoRenew: true,
    });
    const renewed = await repo.renew({
      parentKeyId: two.record.id,
      holderHumanId: SWEEP_HOLDER,
    });
    expect(renewed.status).toBe("renewed");
    const legacy = await repo.create({ humanId: SWEEP_HOLDER });
    const pending = await request({ requesterHumanId: SWEEP_HOLDER });
    const uncollected = await approved({ requesterHumanId: SWEEP_HOLDER });

    // Root client: the method opens its own transaction.
    // An expired, unrevoked key is closed too but not counted as cut off.
    const expired = await collected({ requesterHumanId: SWEEP_HOLDER });
    await prisma.$executeRaw`
      UPDATE api_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE id = ${expired.record.id}`;
    expect(await repo.revokeAllForHuman({ humanId: SWEEP_HOLDER })).toEqual({
      count: 4,
      closedRequestCount: 2,
    });
    expect(await repo.revokeAllForHuman({ humanId: SWEEP_HOLDER })).toEqual({
      count: 0,
      closedRequestCount: 0,
    });
    const expiredRow = await repo.getKey({ keyId: expired.record.id });
    expect(expiredRow?.revokedAt).toBeInstanceOf(Date);
    for (const key of [one.key, two.key, legacy.key]) {
      expect(await repo.getHumanIdForKey({ apiKey: key })).toBeNull();
    }

    // The pending request is closed for account security: no approval can
    // land on it, and it never reads as "you withdrew".
    const after = await repo.getRequest({ requestId: pending.id });
    expect(after?.withdrawnAt).toBeInstanceOf(Date);
    expect(after?.withdrawalReason).toBe("ACCOUNT_SECURITY");
    expect(
      await repo.decide({
        requestId: pending.id,
        decision: "APPROVED",
        decidedByHumanId: APPROVER,
        denialReason: null,
        selfApproved: false,
      }),
    ).toMatchObject({ status: "withdrawn" });

    // R31 (owner 2026-10-13): the approved-but-uncollected request is
    // closed too; the holder (still ACTIVE after a password reset) cannot
    // collect it and is told why.
    const closed = await repo.getRequest({ requestId: uncollected.id });
    expect(closed).toMatchObject({
      decision: "APPROVED",
      withdrawalReason: "ACCOUNT_SECURITY",
      collectedAt: null,
    });
    await expectRefused(
      repo.collect({ requestId: uncollected.id, holderHumanId: SWEEP_HOLDER }),
      "request_withdrawn",
      "api_keys_guard",
    );
  });

  it("a ban closes the holder's approved-but-uncollected request (R31)", async () => {
    const BANNED = "a0000000-0000-4000-8000-000000000009";
    await prisma.human.create({
      data: { id: BANNED, name: "Banned", status: "ACTIVE" },
    });
    const r = await approved({ requesterHumanId: BANNED });
    // As adminSetHumanStatus does: status change and sweep in one tx.
    const swept = await prisma.$transaction(async (tx) => {
      await tx.human.update({
        where: { id: BANNED },
        data: { status: "BANNED" },
      });
      return makeApiKeysRepo(tx).revokeAllForHuman({ humanId: BANNED });
    });
    expect(swept).toEqual({ count: 0, closedRequestCount: 1 });
    expect(await repo.getRequest({ requestId: r.id })).toMatchObject({
      withdrawalReason: "ACCOUNT_SECURITY",
      collectedAt: null,
    });
    expect(
      await repo.collect({ requestId: r.id, holderHumanId: BANNED }),
    ).toEqual({ status: "holder_inactive" });
  });

  it("the sweep's lapse edges: 1-hour margin, earlier withdrawals and denials untouched (R31)", async () => {
    const EDGE = "a0000000-0000-4000-8000-00000000000c";
    await prisma.human.create({
      data: { id: EDGE, name: "Edge", status: "ACTIVE" },
    });
    // Lapsed well past the margin (14 d + 2 h, 7 d + 2 h): left lapsed.
    const pendingOld = await request({ requesterHumanId: EDGE });
    await backdate("api_key_requests", "created_at", pendingOld.id, 14, 120);
    const approvedOld = await approved({ requesterHumanId: EDGE });
    await backdate("api_key_requests", "decided_at", approvedOld.id, 7, 120);
    // Lapsed under an hour ago (14 d + 30 min, 7 d + 30 min): inside the
    // margin, so closed rather than left for an in-flight call to race.
    const pendingEdge = await request({ requesterHumanId: EDGE });
    await backdate("api_key_requests", "created_at", pendingEdge.id, 14, 30);
    const approvedEdge = await approved({ requesterHumanId: EDGE });
    await backdate("api_key_requests", "decided_at", approvedEdge.id, 7, 30);
    // Withdrawn by the requester earlier: keeps REQUESTER and its stamp.
    const mine = await request({ requesterHumanId: EDGE });
    const w = await repo.withdraw({
      requestId: mine.id,
      requesterHumanId: EDGE,
    });
    if (w.status !== "withdrawn") throw new Error(w.status);
    // Denied: terminal, untouched.
    const denied = await request({ requesterHumanId: EDGE });
    expect(
      await repo.decide({
        requestId: denied.id,
        decision: "DENIED",
        decidedByHumanId: APPROVER,
        denialReason: "not needed for this test",
        selfApproved: false,
      }),
    ).toMatchObject({ status: "decided" });
    const deniedBefore = await repo.getRequest({ requestId: denied.id });

    expect(await repo.revokeAllForHuman({ humanId: EDGE })).toEqual({
      count: 0,
      closedRequestCount: 2,
    });

    for (const id of [pendingOld.id, approvedOld.id]) {
      expect(await repo.getRequest({ requestId: id }), id).toMatchObject({
        withdrawnAt: null,
        withdrawalReason: null,
      });
    }
    for (const id of [pendingEdge.id, approvedEdge.id]) {
      const r = await repo.getRequest({ requestId: id });
      expect(r?.withdrawnAt, id).toBeInstanceOf(Date);
      expect(r?.withdrawalReason, id).toBe("ACCOUNT_SECURITY");
    }
    expect(await repo.getRequest({ requestId: mine.id })).toMatchObject({
      withdrawalReason: "REQUESTER",
      withdrawnAt: w.request.withdrawnAt,
    });
    expect(await repo.getRequest({ requestId: denied.id })).toEqual(
      deniedBefore,
    );
    expect(deniedBefore).toMatchObject({
      decision: "DENIED",
      withdrawnAt: null,
      withdrawalReason: null,
    });
  });

  it("collect mints nothing for a holder who is not ACTIVE", async () => {
    const r = await approved({ requesterHumanId: SUSPENDED_HOLDER });
    await prisma.human.update({
      where: { id: SUSPENDED_HOLDER },
      data: { status: "SUSPENDED" },
    });
    expect(
      await repo.collect({ requestId: r.id, holderHumanId: SUSPENDED_HOLDER }),
    ).toEqual({ status: "holder_inactive" });
    const req = await repo.getRequest({ requestId: r.id });
    expect(req?.collectedAt).toBeNull();
    const keys = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM api_keys WHERE request_id = ${r.id}`;
    expect(keys[0]!.n).toBe(0);
  });

  it("the advisory-lock methods refuse to run outside a transaction", async () => {
    await expect(
      repo.lockAndCountForCap({
        holderHumanId: REQUESTER,
        subject: "PERSONAL",
        orgId: null,
      }),
    ).rejects.toThrow(/must run inside repos\.tx\(\)/);
    await expect(
      repo.lockAndCountActiveByHuman({ humanId: REQUESTER }),
    ).rejects.toThrow(/must run inside repos\.tx\(\)/);
    // Inside a transaction they run.
    await expect(
      prisma.$transaction((tx) =>
        makeApiKeysRepo(tx).lockAndCountActiveByHuman({ humanId: REQUESTER }),
      ),
    ).resolves.toBeTypeOf("number");
  });

  it("renew returns not_found, never renewed, for a missing or legacy parent", async () => {
    expect(
      await repo.renew({
        parentKeyId: "00000000-0000-4000-8000-00000000eeee",
        holderHumanId: REQUESTER,
      }),
    ).toEqual({ status: "not_found" });
    const legacy = await repo.create({ humanId: REQUESTER, label: "legacy" });
    expect(
      await repo.renew({ parentKeyId: legacy.id, holderHumanId: REQUESTER }),
    ).toEqual({ status: "not_found" });
  });

  it("revoke reports an already-expired sibling separately from the key it cut off", async () => {
    const { record: parent } = await collected({
      expiryDays: 5,
      autoRenew: true,
    });
    const renewed = await repo.renew({
      parentKeyId: parent.id,
      holderHumanId: REQUESTER,
    });
    if (renewed.status !== "renewed") throw new Error(renewed.status);
    // The parent's overlap has ended (expiry only moves earlier: allowed).
    await prisma.$executeRaw`
      UPDATE api_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE id = ${parent.id}`;
    expect(
      await repo.revokeKey({
        keyId: renewed.record.id,
        revokedByHumanId: REQUESTER,
        reason: null,
      }),
    ).toEqual({
      status: "revoked",
      revokedKeyIds: [renewed.record.id],
      alsoClosedExpiredKeyIds: [parent.id],
    });
  });

  it("the composite org FK refuses a key on another org (api_keys_request_org_fkey)", async () => {
    const r = await approved({ subject: "ORG", orgId: ORG_SHARED });
    await expectRawRefused(
      () => prisma.$executeRaw`
        INSERT INTO api_keys (id, human_id, key_hash, label, request_id,
          subject, org_id, access, expires_at, key_last4)
        VALUES (gen_random_uuid()::text, ${REQUESTER}, ${"v".repeat(64)}, 'ci bot',
          ${r.id}, 'ORG', ${ORG_SOLE}, 'READ',
          (now() AT TIME ZONE 'UTC')::timestamp(3) + interval '1 day', 'abcd')`,
      "foreign_key_violation",
      "api_keys_request_org_fkey",
    );
  });

  it("orgHasOtherLiveApprover: an ACTIVE OWNER/ADMIN other than the excluded human", async () => {
    expect(
      await repo.orgHasOtherLiveApprover({
        orgId: ORG_SHARED,
        excludeHumanId: REQUESTER,
      }),
    ).toBe(true);
    expect(
      await repo.orgHasOtherLiveApprover({
        orgId: ORG_SOLE,
        excludeHumanId: SOLE_OWNER,
      }),
    ).toBe(false);

    // A SUSPENDED admin is not a live approver.
    const SUSP_ADMIN = "a0000000-0000-4000-8000-00000000000a";
    const MEMBER_ONLY = "a0000000-0000-4000-8000-00000000000b";
    const ORG_SUSP = "b0000000-0000-4000-8000-000000000004";
    const ORG_VIEWER = "b0000000-0000-4000-8000-000000000005";
    await prisma.human.createMany({
      data: [
        { id: SUSP_ADMIN, name: "Suspended admin", status: "SUSPENDED" },
        { id: MEMBER_ONLY, name: "Viewer", status: "ACTIVE" },
      ],
    });
    await prisma.organization.createMany({
      data: [
        { id: ORG_SUSP, name: "Susp", slug: "ak-susp" },
        { id: ORG_VIEWER, name: "Viewer", slug: "ak-viewer" },
      ],
    });
    await prisma.orgMember.createMany({
      data: [
        { orgId: ORG_SUSP, humanId: CAP_HOLDER, role: "OWNER" },
        { orgId: ORG_SUSP, humanId: SUSP_ADMIN, role: "ADMIN" },
        { orgId: ORG_VIEWER, humanId: CAP_HOLDER, role: "OWNER" },
        { orgId: ORG_VIEWER, humanId: MEMBER_ONLY, role: "VIEWER" },
      ],
    });
    expect(
      await repo.orgHasOtherLiveApprover({
        orgId: ORG_SUSP,
        excludeHumanId: CAP_HOLDER,
      }),
    ).toBe(false);
    // Only a non-approver member besides the requester.
    expect(
      await repo.orgHasOtherLiveApprover({
        orgId: ORG_VIEWER,
        excludeHumanId: CAP_HOLDER,
      }),
    ).toBe(false);
  });

  /**
   * Two transactions on separate pool connections. The first takes the cap
   * lock, counts, signals, then holds the lock 400 ms before inserting and
   * committing; the second starts during that hold, so its count must wait
   * for the first commit and see the first insert.
   */
  async function raceCap(input: {
    first: string;
    second: string;
    subject: ApiKeySubject;
    orgId: string | null;
  }) {
    const events: string[] = [];
    let signal!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const run = (holder: string, name: string, hold: boolean) =>
      prisma.$transaction(
        async (tx) => {
          const txRepo = makeApiKeysRepo(tx);
          const counts = await txRepo.lockAndCountForCap({
            holderHumanId: holder,
            subject: input.subject,
            orgId: input.orgId,
          });
          events.push(`${name}:counted`);
          if (hold) {
            signal();
            await new Promise((r) => setTimeout(r, 400));
          }
          await txRepo.createRequest({
            requesterHumanId: holder,
            subject: input.subject,
            orgId: input.orgId,
            access: "READ",
            label: "race",
            purpose: "concurrency test purpose",
            expiryDays: 30,
            autoRenew: false,
          });
          events.push(`${name}:inserted`);
          return counts;
        },
        { maxWait: 20_000, timeout: 20_000 },
      );
    const first = run(input.first, "first", true);
    await firstHoldsLock;
    const second = run(input.second, "second", false);
    const [a, b] = await Promise.all([first, second]);
    return { first: a, second: b, events };
  }

  it("cap lock: two concurrent requests by one holder at 4 slots, the second reads 5 (FR-011)", async () => {
    const HOLDER = "a0000000-0000-4000-8000-00000000000f";
    await prisma.human.create({
      data: { id: HOLDER, name: "Race", status: "ACTIVE" },
    });
    for (let i = 0; i < 4; i++) await request({ requesterHumanId: HOLDER });

    const out = await raceCap({
      first: HOLDER,
      second: HOLDER,
      subject: "PERSONAL",
      orgId: null,
    });
    expect(out.first.holderCount).toBe(4);
    expect(out.second.holderCount).toBe(5);
    // The second counted only after the first inserted (it waited on the lock).
    expect(out.events).toEqual([
      "first:counted",
      "first:inserted",
      "second:counted",
      "second:inserted",
    ]);
  });

  it("cap lock: two holders on one org at 19 slots, the second reads 20 (FR-011)", async () => {
    const H1 = "a0000000-0000-4000-8000-000000000010";
    const H2 = "a0000000-0000-4000-8000-000000000011";
    const ORG_RACE = "b0000000-0000-4000-8000-000000000006";
    await prisma.human.createMany({
      data: [H1, H2].map((id, i) => ({
        id,
        name: `Race${i}`,
        status: "ACTIVE" as const,
      })),
    });
    await prisma.organization.create({
      data: { id: ORG_RACE, name: "Race", slug: "ak-race" },
    });
    await prisma.orgMember.createMany({
      data: [
        { orgId: ORG_RACE, humanId: H1, role: "OWNER" },
        { orgId: ORG_RACE, humanId: H2, role: "ADMIN" },
      ],
    });
    for (let i = 0; i < 19; i++) {
      await request({
        requesterHumanId: i < 10 ? H1 : H2,
        subject: "ORG",
        orgId: ORG_RACE,
      });
    }

    const out = await raceCap({
      first: H1,
      second: H2,
      subject: "ORG",
      orgId: ORG_RACE,
    });
    expect(out.first.orgCount).toBe(19);
    expect(out.second.orgCount).toBe(20);
    expect(out.events).toEqual([
      "first:counted",
      "first:inserted",
      "second:counted",
      "second:inserted",
    ]);
  });

  it("caps count slots: pending, uncollected-in-window, collected with a live key (FR-011)", async () => {
    const base = {
      requesterHumanId: CAP_HOLDER,
      subject: "ORG" as const,
      orgId: ORG_CAP,
    };
    const count = () =>
      prisma.$transaction((tx) =>
        makeApiKeysRepo(tx).lockAndCountForCap({
          holderHumanId: CAP_HOLDER,
          subject: "ORG",
          orgId: ORG_CAP,
        }),
      );
    expect(await count()).toEqual({
      holderCount: 0,
      orgCount: 0,
      holderRequestsLast24h: 0,
    });

    await request(base); // pending: counts
    const withdrawn = await request(base);
    await repo.withdraw({
      requestId: withdrawn.id,
      requesterHumanId: CAP_HOLDER,
    });
    const denied = await request(base);
    await repo.decide({
      requestId: denied.id,
      decision: "DENIED",
      decidedByHumanId: CAP_OTHER,
      denialReason: "not needed right now",
      selfApproved: false,
    });
    const lapsed = await request(base);
    await backdate("api_key_requests", "created_at", lapsed.id, 15);
    await approved(base); // approved, uncollected, in window: counts
    const live = await collected({ ...base, expiryDays: 5, autoRenew: true });
    // A renewal pair is one slot.
    expect(
      (
        await repo.renew({
          parentKeyId: live.record.id,
          holderHumanId: CAP_HOLDER,
        })
      ).status,
    ).toBe("renewed");
    const expired = await collected(base);
    await prisma.$executeRaw`
      UPDATE api_keys SET expires_at = (now() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE id = ${expired.record.id}`;
    // Another holder on the same org counts for the org only.
    await request({ ...base, requesterHumanId: CAP_OTHER });

    // 7 sent by CAP_HOLDER; the one backdated 15 days is outside the 24h
    // rate window, the withdrawn and denied ones are inside it.
    expect(await count()).toEqual({
      holderCount: 3,
      orgCount: 4,
      holderRequestsLast24h: 6,
    });

    // Non-ORG subjects: per holder + subject, no org count.
    const personal = await prisma.$transaction((tx) =>
      makeApiKeysRepo(tx).lockAndCountForCap({
        holderHumanId: CAP_HOLDER,
        subject: "PERSONAL",
        orgId: null,
      }),
    );
    // The 24-hour request count is per holder, across subjects.
    expect(personal).toEqual({
      holderCount: 0,
      orgCount: null,
      holderRequestsLast24h: 6,
    });
  });

  it("counts the holder's requests of the last 24 hours on the DB clock, withdrawn included (rate limit)", async () => {
    const RATE = "a0000000-0000-4000-8000-00000000000d";
    await prisma.human.create({
      data: { id: RATE, name: "Rate", status: "ACTIVE" },
    });
    const count = () =>
      prisma.$transaction((tx) =>
        makeApiKeysRepo(tx).lockAndCountForCap({
          holderHumanId: RATE,
          subject: "STAFF",
          orgId: null,
        }),
      );
    const a = await request({ requesterHumanId: RATE });
    const b = await request({
      requesterHumanId: RATE,
      subject: "PLATFORM_WIDE",
    });
    const w = await repo.withdraw({ requestId: b.id, requesterHumanId: RATE });
    expect(w.status).toBe("withdrawn");
    const old = await request({ requesterHumanId: RATE });
    // 1 day + 1 minute ago: just outside the window.
    await backdate("api_key_requests", "created_at", old.id, 1, 1);
    const edge = await request({ requesterHumanId: RATE });
    // 23 h 59 min ago: inside the window.
    await backdate("api_key_requests", "created_at", edge.id, 0, 23 * 60 + 59);
    // Another holder's request does not count.
    await request({ requesterHumanId: OTHER });

    expect(await count()).toEqual({
      holderCount: 0,
      orgCount: null,
      holderRequestsLast24h: 3,
    });
    expect(a.requesterHumanId).toBe(RATE);
  });

  it("the lapse mark skips a request withdrawn or closed for account security after the list", async () => {
    const MARK = "a0000000-0000-4000-8000-00000000000e";
    await prisma.human.create({
      data: { id: MARK, name: "Mark", status: "ACTIVE" },
    });
    // Pending lapsed 30 min ago (inside the sweep's 1-hour margin) and
    // approved-uncollected lapsed 30 min ago: both due a lapse notice.
    const pending = await request({ requesterHumanId: MARK });
    await backdate("api_key_requests", "created_at", pending.id, 14, 30);
    const uncollected = await approved({ requesterHumanId: MARK });
    await backdate("api_key_requests", "decided_at", uncollected.id, 7, 30);
    // A lapsed request the requester withdraws after the list.
    const selfWithdrawn = await request({ requesterHumanId: MARK });
    await backdate("api_key_requests", "created_at", selfWithdrawn.id, 15);

    const due = (await repo.listRequestsDueLapseNotice({ limit: 500 })).map(
      (d) => d.request.id,
    );
    expect(due).toEqual(
      expect.arrayContaining([pending.id, uncollected.id, selfWithdrawn.id]),
    );

    // Between the list and the mark: a ban closes the two inside the
    // margin (R31), and the requester withdraws the third.
    expect(await repo.revokeAllForHuman({ humanId: MARK })).toMatchObject({
      closedRequestCount: 2,
    });
    expect(
      (
        await repo.withdraw({
          requestId: selfWithdrawn.id,
          requesterHumanId: MARK,
        })
      ).status,
    ).toBe("withdrawn");

    for (const id of [pending.id, uncollected.id, selfWithdrawn.id]) {
      expect(await repo.markRequestLapseNotified({ requestId: id }), id).toBe(
        false,
      );
      expect(
        (await repo.getRequest({ requestId: id }))?.lapseNotifiedAt,
        id,
      ).toBeNull();
    }
  });

  it("queues: org queue lists live pending ORG requests; platform queue adds sole-owner org fallbacks", async () => {
    const shared = await request({ subject: "ORG", orgId: ORG_SHARED });
    const sole = await request({
      requesterHumanId: SOLE_OWNER,
      subject: "ORG",
      orgId: ORG_SOLE,
    });
    const staff = await request({ subject: "STAFF", expiryDays: 10 });
    const lapsedStaff = await request({ subject: "STAFF", expiryDays: 10 });
    await backdate("api_key_requests", "created_at", lapsedStaff.id, 15);

    const orgQueue = await repo.listOrgQueue({ orgId: ORG_SHARED, limit: 50 });
    expect(orgQueue.map((r) => r.id)).toContain(shared.id);
    expect(orgQueue.every((r) => r.orgId === ORG_SHARED)).toBe(true);

    const platform = await repo.listPlatformQueue({
      subjects: ["STAFF", "PERSONAL", "PLATFORM_WIDE"],
      includeOrgFallbacks: true,
      limit: 500,
    });
    const ids = platform.map((r) => r.id);
    expect(ids).toContain(staff.id);
    expect(ids).toContain(sole.id); // no other OWNER/ADMIN on ORG_SOLE
    expect(ids).not.toContain(shared.id); // APPROVER is ADMIN on ORG_SHARED
    expect(ids).not.toContain(lapsedStaff.id);

    const noFallback = await repo.listPlatformQueue({
      subjects: ["STAFF"],
      includeOrgFallbacks: false,
      limit: 500,
    });
    expect(noFallback.map((r) => r.id)).not.toContain(sole.id);

    const mine = await repo.listRequestsByRequester({
      requesterHumanId: SOLE_OWNER,
      limit: 10,
    });
    expect(mine.map((r) => r.id)).toEqual([sole.id]);
  });

  it("notice markers: lapse and expiry lists, CAS-marked once", async () => {
    const pending = await request({ requesterHumanId: OTHER });
    await backdate("api_key_requests", "created_at", pending.id, 15);
    const uncollected = await approved({ requesterHumanId: OTHER });
    await backdate("api_key_requests", "decided_at", uncollected.id, 8);

    const due = await repo.listRequestsDueLapseNotice({ limit: 500 });
    expect(due.find((d) => d.request.id === pending.id)?.kind).toBe(
      "pending_lapsed",
    );
    expect(due.find((d) => d.request.id === uncollected.id)?.kind).toBe(
      "collect_lapsed",
    );
    expect(await repo.markRequestLapseNotified({ requestId: pending.id })).toBe(
      true,
    );
    expect(await repo.markRequestLapseNotified({ requestId: pending.id })).toBe(
      false,
    );
    const dueAfter = await repo.listRequestsDueLapseNotice({ limit: 500 });
    expect(dueAfter.map((d) => d.request.id)).not.toContain(pending.id);

    const soon = await collected({ requesterHumanId: OTHER, expiryDays: 5 });
    const autoSoon = await collected({
      requesterHumanId: OTHER,
      expiryDays: 5,
      autoRenew: true,
    });
    const later = await collected({ requesterHumanId: OTHER, expiryDays: 30 });
    const expiring = (await repo.listKeysDueExpiryNotice({ limit: 500 })).map(
      (k) => k.id,
    );
    expect(expiring).toContain(soon.record.id);
    expect(expiring).not.toContain(autoSoon.record.id); // auto-renew on
    expect(expiring).not.toContain(later.record.id); // not within 7 days
    expect(await repo.markKeyExpiryNotified({ keyId: soon.record.id })).toBe(
      true,
    );
    expect(await repo.markKeyExpiryNotified({ keyId: soon.record.id })).toBe(
      false,
    );
    expect(
      (await repo.listKeysDueExpiryNotice({ limit: 500 })).map((k) => k.id),
    ).not.toContain(soon.record.id);
  });

  it("screen reads list keys with their request fields and never the hash", async () => {
    const { record } = await collected({ subject: "ORG", orgId: ORG_SHARED });
    const byOrg = await repo.listKeysByOrg({ orgId: ORG_SHARED, limit: 100 });
    const row = byOrg.find((k) => k.id === record.id);
    expect(row).toMatchObject({
      purpose: "integration test purpose",
      selfApproved: false,
      decidedByHumanId: APPROVER,
      requestAutoRenew: false,
    });
    expect(row).not.toHaveProperty("keyHash");
    expect(Object.keys(row!).some((k) => /hash/i.test(k))).toBe(false);

    const mine = await repo.listKeysByHolder({
      humanId: REQUESTER,
      limit: 500,
    });
    expect(mine.map((k) => k.id)).toContain(record.id);
    const all = await repo.listAllKeys({ limit: 5, offset: 0, subject: "ORG" });
    expect(all.total).toBeGreaterThanOrEqual(1);
    expect(all.items.every((k) => k.subject === "ORG")).toBe(true);
  });
});
