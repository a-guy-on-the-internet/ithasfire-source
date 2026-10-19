import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { makeEventUnlocksRepo } from "../event-unlocks";
import { makeEventApplicationsRepo } from "../event-applications";

// ---------------------------------------------------------------------------
// Integration coverage for the anonymous application-approval CLAIM feature:
// EventUnlocksRepo.upsert / isUnlocked / revokeBySubmission and
// EventApplicationsRepo.getSubmissionByToken. The load-bearing new SQL is
// `revokeBySubmission` — an updateMany scoped to `applicationSubmissionId`
// with a `revokedAt: null` active-guard. A fully-mocked test can't prove it
// revokes by SUBMISSION (not by human), doesn't over-revoke sibling grants
// from other submissions, and is idempotent. This hits real Postgres.
//
// Standalone DDL: only the two tables + two enums the adapters touch, no FKs
// or unrelated columns, so the schema is self-contained. Column naming mirrors
// Prisma's default mapping (quoted PascalCase table, camelCase columns) exactly
// as the driver-adapter client expects. `@default`/`@updatedAt` values (id,
// createdAt, updatedAt) are supplied by the Prisma client, but DEFAULTs are
// kept so the raw-SQL submission insert works too.
// ---------------------------------------------------------------------------

const TABLE_SQL = `
CREATE TYPE "EventUnlockSource" AS ENUM ('PASSWORD', 'APPLICATION', 'ADMIN', 'INVITE_LIST', 'MAGIC_LINK');
CREATE TYPE "ApplicationSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'WAITLISTED');
CREATE TYPE "ApplicationFormPurpose" AS ENUM ('ATTEND', 'PERFORM');
CREATE TYPE "OpenCallPayKind" AS ENUM ('FIXED', 'DOOR_SPLIT', 'TICKET_SHARE', 'TICKET_QUOTA', 'UNPAID', 'DISCUSSED_AFTER');

-- The form table as of open calls v1 (migration 20261005120000_open_calls):
-- every column Prisma selects, plus the uniques the adapter keys on.
CREATE TABLE "EventApplicationForm" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "seriesId" TEXT,
  "purpose" "ApplicationFormPurpose" NOT NULL DEFAULT 'ATTEND',
  "publicId" TEXT NOT NULL,
  "payKind" "OpenCallPayKind",
  "payDetails" TEXT,
  "closedAt" TIMESTAMP(3),
  "closedByHumanId" TEXT,
  "postedAt" TIMESTAMP(3),
  "postedByHumanId" TEXT,
  "introText" TEXT,
  "defaults" JSONB NOT NULL DEFAULT '{}',
  "opensAt" TIMESTAMP(3),
  "closesAt" TIMESTAMP(3),
  "maxSubmissions" INTEGER,
  "autoApprove" BOOLEAN NOT NULL DEFAULT false,
  "updatedByHumanId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EventApplicationForm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EventApplicationForm_publicId_key" ON "EventApplicationForm"("publicId");
CREATE UNIQUE INDEX "EventApplicationForm_eventId_purpose_key" ON "EventApplicationForm"("eventId", "purpose");
CREATE UNIQUE INDEX "EventApplicationForm_seriesId_purpose_key" ON "EventApplicationForm"("seriesId", "purpose");
CREATE UNIQUE INDEX "EventApplicationForm_id_eventId_key" ON "EventApplicationForm"("id", "eventId");

CREATE TABLE "EventUnlock" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "humanId" TEXT NOT NULL,
  "source" "EventUnlockSource" NOT NULL,
  "applicationSubmissionId" TEXT,
  -- Gated-event invite links (peer schema, event.prisma EventUnlock.inviteId).
  "inviteId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EventUnlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EventUnlock_eventId_humanId_key" ON "EventUnlock" ("eventId", "humanId");
CREATE INDEX "EventUnlock_applicationSubmissionId_idx" ON "EventUnlock" ("applicationSubmissionId");

CREATE TABLE "EventApplicationSubmission" (
  "id" TEXT NOT NULL,
  "formId" TEXT NOT NULL REFERENCES "EventApplicationForm"("id") ON DELETE CASCADE,
  "eventId" TEXT,
  "humanId" TEXT,
  "applyingAsOrgId" TEXT,
  "guestName" TEXT,
  "guestUrl" TEXT,
  "isPrivate" BOOLEAN NOT NULL DEFAULT false,
  "openedAt" TIMESTAMP(3),
  "statusTokenHash" TEXT,
  "droppedOutAt" TIMESTAMP(3),
  "removedFromLineupAt" TIMESTAMP(3),
  "contactLocale" TEXT,
  "inviteId" TEXT,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "status" "ApplicationSubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "answers" JSONB NOT NULL DEFAULT '{}',
  "decisionReason" TEXT,
  "questionsSnapshot" JSONB NOT NULL DEFAULT '{}',
  "reviewerHumanId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "approvalToken" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EventApplicationSubmission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EventApplicationSubmission_approvalToken_key" ON "EventApplicationSubmission" ("approvalToken");
CREATE UNIQUE INDEX "EventApplicationSubmission_statusTokenHash_key" ON "EventApplicationSubmission" ("statusTokenHash");
ALTER TABLE "EventApplicationSubmission" ADD CONSTRAINT "EventApplicationSubmission_formId_eventId_fkey"
  FOREIGN KEY ("formId", "eventId") REFERENCES "EventApplicationForm"("id", "eventId");
-- The per-FORM one-open-application indexes, verbatim from the migration.
CREATE UNIQUE INDEX "EventApplicationSubmission_open_guest_key"
  ON "EventApplicationSubmission" ("formId", lower("contactEmail"))
  WHERE "humanId" IS NULL
    AND "contactEmail" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');
CREATE UNIQUE INDEX "EventApplicationSubmission_open_human_key"
  ON "EventApplicationSubmission" ("formId", "humanId")
  WHERE "humanId" IS NOT NULL
    AND "applyingAsOrgId" IS NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');
CREATE UNIQUE INDEX "EventApplicationSubmission_open_org_key"
  ON "EventApplicationSubmission" ("formId", "applyingAsOrgId")
  WHERE "applyingAsOrgId" IS NOT NULL
    AND "status" IN ('PENDING', 'APPROVED', 'WAITLISTED');

-- EVENT_A holds BOTH an ATTEND and a PERFORM form; EVENT_B an ATTEND one;
-- EVENT_C both, each past its deadline (the expiry sweep's case).
INSERT INTO "EventApplicationForm" ("id", "eventId", "purpose", "publicId", "closesAt") VALUES
  ('form-a-attend', 'evt-aaaaaaaa', 'ATTEND', 'pubaattend', NULL),
  ('form-a-perform', 'evt-aaaaaaaa', 'PERFORM', 'pubaperfor', NULL),
  ('form-b-attend', 'evt-bbbbbbbb', 'ATTEND', 'pubbattend', NULL),
  ('form-c-attend', 'evt-cccccccc', 'ATTEND', 'pubcattend', '2026-01-01T00:00:00Z'),
  ('form-c-perform', 'evt-cccccccc', 'PERFORM', 'pubcperfor', '2026-01-01T00:00:00Z');
`;

const FORM_A_ATTEND = "form-a-attend";
const FORM_A_PERFORM = "form-a-perform";
const FORM_C_ATTEND = "form-c-attend";
const FORM_C_PERFORM = "form-c-perform";
const EVENT_C = "evt-cccccccc";

// Fixed identifiers — deterministic, no Math.random / Date.now.
const EVENT_A = "evt-aaaaaaaa";
const EVENT_B = "evt-bbbbbbbb";
const HUMAN_1 = "hum-11111111";
const HUMAN_2 = "hum-22222222";
const HUMAN_3 = "hum-33333333";
const SUBMISSION_X = "sub-xxxxxxxx";
const SUBMISSION_Y = "sub-yyyyyyyy";

describe("event-unlocks redemption + application token (integration)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    pgContainer = await startPostgresContainer();
    pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
    await pool.query(TABLE_SQL);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 300_000);

  beforeEach(async () => {
    await pool?.query(`TRUNCATE "EventUnlock", "EventApplicationSubmission"`);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await pgContainer?.stop();
  });

  test("upsert persists an APPLICATION unlock w/ applicationSubmissionId; isUnlocked returns true", async () => {
    const unlocks = makeEventUnlocksRepo(prisma!);

    const rec = await unlocks.upsert({
      eventId: EVENT_A,
      humanId: HUMAN_1,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_X,
    });

    expect(rec.eventId).toBe(EVENT_A);
    expect(rec.humanId).toBe(HUMAN_1);
    expect(rec.source).toBe("APPLICATION");
    expect(rec.applicationSubmissionId).toBe(SUBMISSION_X);
    expect(rec.revokedAt).toBeNull();

    // The row is really in Postgres with the submission linkage.
    const raw = await pool!.query(
      `SELECT "source", "applicationSubmissionId", "revokedAt" FROM "EventUnlock" WHERE "eventId" = $1 AND "humanId" = $2`,
      [EVENT_A, HUMAN_1],
    );
    expect(raw.rows[0]).toMatchObject({
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_X,
      revokedAt: null,
    });

    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_1)).resolves.toBe(true);
  });

  test("revokeBySubmission revokes ALL grants from a submission, across humans, and only that submission", async () => {
    const unlocks = makeEventUnlocksRepo(prisma!);

    // Two grants sharing SUBMISSION_X but for DIFFERENT humans (anon approval
    // can fan out to multiple humans that later claimed the same submission).
    await unlocks.upsert({
      eventId: EVENT_A,
      humanId: HUMAN_1,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_X,
    });
    await unlocks.upsert({
      eventId: EVENT_A,
      humanId: HUMAN_2,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_X,
    });
    // A THIRD grant from a DIFFERENT submission — must be UNTOUCHED.
    await unlocks.upsert({
      eventId: EVENT_A,
      humanId: HUMAN_3,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_Y,
    });

    // Sanity: all three start unlocked.
    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_1)).resolves.toBe(true);
    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_2)).resolves.toBe(true);
    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_3)).resolves.toBe(true);

    const revoked = await unlocks.revokeBySubmission(SUBMISSION_X);
    expect(revoked).toBe(2);

    // Both SUBMISSION_X grants are now revoked (revokedAt set, isUnlocked false).
    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_1)).resolves.toBe(false);
    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_2)).resolves.toBe(false);
    expect((await unlocks.get(EVENT_A, HUMAN_1))?.revokedAt).toBeInstanceOf(Date);
    expect((await unlocks.get(EVENT_A, HUMAN_2))?.revokedAt).toBeInstanceOf(Date);

    // The SUBMISSION_Y grant is NOT over-revoked.
    await expect(unlocks.isUnlocked(EVENT_A, HUMAN_3)).resolves.toBe(true);
    expect((await unlocks.get(EVENT_A, HUMAN_3))?.revokedAt).toBeNull();
  });

  test("revokeBySubmission is idempotent — a second call revokes 0 active rows", async () => {
    const unlocks = makeEventUnlocksRepo(prisma!);

    await unlocks.upsert({
      eventId: EVENT_A,
      humanId: HUMAN_1,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_X,
    });
    await unlocks.upsert({
      eventId: EVENT_B,
      humanId: HUMAN_1,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_X,
    });

    expect(await unlocks.revokeBySubmission(SUBMISSION_X)).toBe(2);
    // Already-revoked rows are excluded by the `revokedAt: null` guard.
    expect(await unlocks.revokeBySubmission(SUBMISSION_X)).toBe(0);
  });

  test("getSubmissionByToken returns the APPROVED submission for a known token, null for unknown", async () => {
    const applications = makeEventApplicationsRepo(prisma!);

    const KNOWN_TOKEN = "approval-token-abc123";
    const NOW = new Date("2026-07-20T12:00:00.000Z");
    const EXPIRES = new Date("2026-07-27T12:00:00.000Z");

    await pool!.query(
      `INSERT INTO "EventApplicationSubmission"
        ("id", "formId", "eventId", "humanId", "contactEmail", "status", "answers", "approvalToken", "tokenExpiresAt", "metadata", "createdAt", "updatedAt")
       VALUES ($1, $11, $2, $3, $4, $5::"ApplicationSubmissionStatus", $6::jsonb, $7, $8, $9::jsonb, $10, $10)`,
      [
        SUBMISSION_X,
        EVENT_A,
        null,
        "applicant@example.com",
        "APPROVED",
        JSON.stringify({ band: "The Testers" }),
        KNOWN_TOKEN,
        EXPIRES,
        JSON.stringify({}),
        NOW,
        FORM_A_ATTEND,
      ],
    );

    const found = await applications.getSubmissionByToken(KNOWN_TOKEN);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(SUBMISSION_X);
    expect(found!.eventId).toBe(EVENT_A);
    expect(found!.status).toBe("APPROVED");
    expect(found!.approvalToken).toBe(KNOWN_TOKEN);
    expect(found!.contactEmail).toBe("applicant@example.com");

    const missing = await applications.getSubmissionByToken("no-such-token");
    expect(missing).toBeNull();
  });

  test("Phase-2 lifecycle statuses round-trip through the client against real Postgres", async () => {
    const applications = makeEventApplicationsRepo(prisma!);

    const created = await applications.createSubmission({
      formId: FORM_A_ATTEND,
      eventId: EVENT_A,
      humanId: HUMAN_1,
      contactEmail: "applicant@example.com",
      answers: {},
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    for (const status of ["WITHDRAWN", "EXPIRED", "WAITLISTED"] as const) {
      const updated = await applications.updateSubmissionStatus({
        submissionId: created.id,
        status,
      });
      expect(updated.status).toBe(status);

      // Really persisted as the enum value, not just echoed by the client.
      const raw = await pool!.query(
        `SELECT "status"::text AS status FROM "EventApplicationSubmission" WHERE "id" = $1`,
        [created.id],
      );
      expect(raw.rows[0]).toEqual({ status });
    }
  });

  // ── lockApprovedSubmission: the check-then-write race ────────────────────
  // The subject's durable unlock is written as `lockApprovedSubmission` →
  // `eventUnlocks.upsert` in ONE transaction (core
  // `persistSubjectApplicationUnlock`). These pin, against real Postgres row
  // locks, that a concurrent rescind can never leave a live unlock behind.

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settlesWithin = async (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => "settled"), sleep(ms).then(() => "blocked")]);

  /** An APPROVED submission written the way production writes it. */
  const approvedSubmission = async () => {
    const applications = makeEventApplicationsRepo(prisma!);
    const created = await applications.createSubmission({
      formId: FORM_A_ATTEND,
      eventId: EVENT_A,
      humanId: HUMAN_1,
      contactEmail: "applicant@example.com",
      answers: {},
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await applications.updateSubmissionStatus({
      submissionId: created.id,
      status: "APPROVED",
      reviewedAt: new Date("2026-08-02T10:00:00.123Z"),
      approvalToken: "approval-token-lock",
      tokenExpiresAt: new Date("2026-08-09T10:00:00.000Z"),
    });
    // Read back, exactly as the use cases do before locking.
    return (await applications.getSubmissionById(created.id))!;
  };

  /** What `rescindEventApplicationDecision` writes. */
  const rescindWrite = {
    status: "PENDING" as const,
    reviewerHumanId: null,
    reviewedAt: null,
    approvalToken: null,
    tokenExpiresAt: null,
    decisionReason: null,
  };

  test("lockApprovedSubmission matches only APPROVED + same event + same reviewedAt", async () => {
    const applications = makeEventApplicationsRepo(prisma!);
    const sub = await approvedSubmission();
    const reviewedAt = sub.reviewedAt!;

    await expect(
      applications.lockApprovedSubmission({
        submissionId: sub.id,
        eventId: EVENT_A,
        purpose: "ATTEND",
        reviewedAt,
      }),
    ).resolves.toBe(true);
    // A different approval instance (rescind → re-approve stamps a new one).
    await expect(
      applications.lockApprovedSubmission({
        submissionId: sub.id,
        eventId: EVENT_A,
        purpose: "ATTEND",
        reviewedAt: new Date(reviewedAt.getTime() + 1),
      }),
    ).resolves.toBe(false);
    await expect(
      applications.lockApprovedSubmission({
        submissionId: sub.id,
        eventId: EVENT_B,
        purpose: "ATTEND",
        reviewedAt,
      }),
    ).resolves.toBe(false);

    await applications.updateSubmissionStatus({
      submissionId: sub.id,
      ...rescindWrite,
    });
    await expect(
      applications.lockApprovedSubmission({
        submissionId: sub.id,
        eventId: EVENT_A,
        purpose: "ATTEND",
        reviewedAt,
      }),
    ).resolves.toBe(false);
  });

  test("rescind first: the unlock write waits on the row lock, then misses and writes nothing", async () => {
    const sub = await approvedSubmission();
    let rescindWrote!: () => void;
    const wrote = new Promise<void>((r) => (rescindWrote = r));
    let releaseRescind!: () => void;
    const held = new Promise<void>((r) => (releaseRescind = r));

    const rescind = prisma!.$transaction(
      async (tx) => {
        await makeEventApplicationsRepo(tx).updateSubmissionStatus({
          submissionId: sub.id,
          ...rescindWrite,
        });
        rescindWrote();
        await held; // keep the row lock (uncommitted PENDING) open
        return makeEventUnlocksRepo(tx).revokeBySubmission(sub.id);
      },
      { timeout: 20_000 },
    );
    await wrote;

    const write = prisma!.$transaction(
      async (tx) => {
        const ok = await makeEventApplicationsRepo(tx).lockApprovedSubmission({
          submissionId: sub.id,
          eventId: EVENT_A,
          purpose: "ATTEND",
          reviewedAt: sub.reviewedAt!,
        });
        if (ok) {
          await makeEventUnlocksRepo(tx).upsert({
            eventId: EVENT_A,
            humanId: HUMAN_1,
            source: "APPLICATION",
            applicationSubmissionId: sub.id,
          });
        }
        return ok;
      },
      { timeout: 20_000 },
    );

    expect(await settlesWithin(write, 400)).toBe("blocked");
    releaseRescind();
    await rescind;

    await expect(write).resolves.toBe(false);
    await expect(
      makeEventUnlocksRepo(prisma!).isUnlocked(EVENT_A, HUMAN_1),
    ).resolves.toBe(false);
  });

  test("unlock write first: the rescind waits for it, then revokes the row it wrote", async () => {
    const sub = await approvedSubmission();
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    let releaseWrite!: () => void;
    const held = new Promise<void>((r) => (releaseWrite = r));

    const write = prisma!.$transaction(
      async (tx) => {
        const ok = await makeEventApplicationsRepo(tx).lockApprovedSubmission({
          submissionId: sub.id,
          eventId: EVENT_A,
          purpose: "ATTEND",
          reviewedAt: sub.reviewedAt!,
        });
        locked();
        await held;
        if (ok) {
          await makeEventUnlocksRepo(tx).upsert({
            eventId: EVENT_A,
            humanId: HUMAN_1,
            source: "APPLICATION",
            applicationSubmissionId: sub.id,
          });
        }
        return ok;
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    const rescind = prisma!.$transaction(
      async (tx) => {
        await makeEventApplicationsRepo(tx).updateSubmissionStatus({
          submissionId: sub.id,
          ...rescindWrite,
        });
        return makeEventUnlocksRepo(tx).revokeBySubmission(sub.id);
      },
      { timeout: 20_000 },
    );

    expect(await settlesWithin(rescind, 400)).toBe("blocked");
    releaseWrite();
    await expect(write).resolves.toBe(true);

    // The rescind ran after the unlock committed, so its revoke caught it.
    await expect(rescind).resolves.toBe(1);
    await expect(
      makeEventUnlocksRepo(prisma!).isUnlocked(EVENT_A, HUMAN_1),
    ).resolves.toBe(false);
  });

  // ── Open calls v1: an event holding BOTH an ATTEND and a PERFORM form ────
  // Against real Postgres, so the partial unique indexes, the composite FK
  // and the driver-adapter P2002 shape are the real ones.

  const submit = (
    formId: string,
    eventId: string,
    identity: { humanId: string } | { contactEmail: string },
  ) =>
    makeEventApplicationsRepo(prisma!).createSubmission({
      formId,
      eventId,
      ...identity,
      answers: {},
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

  test("getForm returns the form of the purpose asked for", async () => {
    const applications = makeEventApplicationsRepo(prisma!);

    const attend = await applications.getForm(EVENT_A, "ATTEND");
    const perform = await applications.getForm(EVENT_A, "PERFORM");

    expect(attend).toMatchObject({ id: FORM_A_ATTEND, purpose: "ATTEND" });
    expect(perform).toMatchObject({ id: FORM_A_PERFORM, purpose: "PERFORM" });
    await expect(applications.getForm(EVENT_B, "PERFORM")).resolves.toBeNull();
  });

  test("one human holds an open application on EACH form; a second on the same form is a duplicate", async () => {
    await expect(
      submit(FORM_A_PERFORM, EVENT_A, { humanId: HUMAN_1 }),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(
      submit(FORM_A_ATTEND, EVENT_A, { humanId: HUMAN_1 }),
    ).resolves.toMatchObject({ status: "PENDING" });

    // The per-form partial index fires, and the REAL driver-adapter P2002
    // is recognised by index name.
    await expect(
      submit(FORM_A_ATTEND, EVENT_A, { humanId: HUMAN_1 }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });
    await expect(
      submit(FORM_A_ATTEND, EVENT_A, { contactEmail: "g@example.com" }),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(
      submit(FORM_A_ATTEND, EVENT_A, { contactEmail: "g@example.com" }),
    ).rejects.toMatchObject({ code: "duplicate_open_application" });

    const applications = makeEventApplicationsRepo(prisma!);
    await expect(
      applications.findOpenSubmission({
        formId: FORM_A_PERFORM,
        contactEmail: "g@example.com",
      }),
    ).resolves.toBeNull();
    // Reads by (event, purpose) see only their own form's rows.
    expect(
      await applications.countSubmissions({
        eventId: EVENT_A,
        purpose: "ATTEND",
      }),
    ).toBe(2);
    expect(
      await applications.countSubmissions({
        eventId: EVENT_A,
        purpose: "PERFORM",
      }),
    ).toBe(1);
    const viewer = await applications.getSubmissionByEventAndHuman(
      EVENT_A,
      "PERFORM",
      HUMAN_1,
    );
    expect(viewer).not.toBeNull();
    const listed = await applications.listSubmissions({
      eventId: EVENT_A,
      purpose: "ATTEND",
    });
    expect(listed.items.map((r) => r.contactEmail ?? r.humanId).sort()).toEqual(
      ["g@example.com", HUMAN_1].sort(),
    );
  });

  test("a statusTokenHash collision is NOT reported as a duplicate application", async () => {
    const first = await submit(FORM_A_ATTEND, EVENT_A, { humanId: HUMAN_1 });
    const second = await submit(FORM_A_PERFORM, EVENT_A, { humanId: HUMAN_2 });
    await pool!.query(
      `UPDATE "EventApplicationSubmission" SET "statusTokenHash" = 'h1' WHERE "id" = $1`,
      [first.id],
    );
    // Capture the REAL driver-adapter P2002 for the statusTokenHash unique
    // (no adapter path writes the hash yet, so provoke it directly)...
    const collision = await prisma!.eventApplicationSubmission
      .update({ where: { id: second.id }, data: { statusTokenHash: "h1" } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(collision).toMatchObject({ code: "P2002" });

    // ...then replay it through the adapter's create path: it must surface
    // as itself, never as "you already applied".
    const replaying = {
      eventApplicationSubmission: {
        create: () => Promise.reject(collision),
      },
    } as unknown as Parameters<typeof makeEventApplicationsRepo>[0];
    await expect(
      makeEventApplicationsRepo(replaying).createSubmission({
        formId: FORM_A_ATTEND,
        eventId: EVENT_A,
        humanId: HUMAN_3,
        answers: {},
        submittedAt: new Date(),
      }),
    ).rejects.toBe(collision);
  });

  test("the expiry sweep closes ATTEND forms only; a PERFORM form past closesAt keeps its PENDING applications", async () => {
    const attend = await submit(FORM_C_ATTEND, EVENT_C, { humanId: HUMAN_1 });
    const perform = await submit(FORM_C_PERFORM, EVENT_C, { humanId: HUMAN_1 });

    const result = await makeEventApplicationsRepo(
      prisma!,
    ).expireSubmissionsForClosedForms({
      cutoff: new Date("2026-06-01T00:00:00Z"),
      purpose: "ATTEND",
    });

    expect(result).toEqual({ count: 1, ids: [attend.id] });
    const raw = await pool!.query(
      `SELECT "id", "status"::text AS status FROM "EventApplicationSubmission" WHERE "eventId" = $1 ORDER BY "id"`,
      [EVENT_C],
    );
    const byId = Object.fromEntries(raw.rows.map((r) => [r.id, r.status]));
    expect(byId[attend.id]).toBe("EXPIRED");
    expect(byId[perform.id]).toBe("PENDING");
  });

  test("lockApprovedSubmission does not match an ATTEND approval when asked for PERFORM", async () => {
    const sub = await approvedSubmission();
    const applications = makeEventApplicationsRepo(prisma!);

    await expect(
      applications.lockApprovedSubmission({
        submissionId: sub.id,
        eventId: EVENT_A,
        purpose: "PERFORM",
        reviewedAt: sub.reviewedAt!,
      }),
    ).resolves.toBe(false);
    await expect(
      applications.lockApprovedSubmission({
        submissionId: sub.id,
        eventId: EVENT_A,
        purpose: "ATTEND",
        reviewedAt: sub.reviewedAt!,
      }),
    ).resolves.toBe(true);
  });

  test("ensureForm creates the default form inside a transaction, with a publicId, idempotently", async () => {
    const EVENT_D = "evt-dddddddd";
    const [first, second] = await prisma!.$transaction(async (tx) => {
      const repo = makeEventApplicationsRepo(tx);
      const a = await repo.ensureForm({ eventId: EVENT_D, purpose: "ATTEND" });
      const b = await repo.ensureForm({ eventId: EVENT_D, purpose: "ATTEND" });
      return [a, b];
    });

    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({
      eventId: EVENT_D,
      purpose: "ATTEND",
      introText: null,
      autoApprove: false,
    });
    expect(first.publicId).toMatch(/^[0-9a-z]{10}$/);
    await pool!.query(`DELETE FROM "EventApplicationForm" WHERE "eventId" = $1`, [
      EVENT_D,
    ]);
  });

  test("ensureForm race: two transactions, one form — the loser skips its insert and re-reads the winner's row", async () => {
    const EVENT_E = "evt-eeeeeeee";
    let created!: () => void;
    const winnerInserted = new Promise<void>((r) => (created = r));
    let releaseWinner!: () => void;
    const held = new Promise<void>((r) => (releaseWinner = r));

    // Winner: creates the form, then keeps its transaction OPEN.
    const winner = prisma!.$transaction(
      async (tx) => {
        const form = await makeEventApplicationsRepo(tx).ensureForm({
          eventId: EVENT_E,
          purpose: "ATTEND",
        });
        created();
        await held;
        return form;
      },
      { timeout: 20_000 },
    );
    await winnerInserted;

    // Loser: its read cannot see the uncommitted row, so it reaches
    // createMany(skipDuplicates) — ON CONFLICT DO NOTHING, which WAITS on
    // the winner's uncommitted unique key instead of failing.
    const loser = prisma!.$transaction(
      (tx) =>
        makeEventApplicationsRepo(tx).ensureForm({
          eventId: EVENT_E,
          purpose: "ATTEND",
        }),
      { timeout: 20_000 },
    );
    expect(await settlesWithin(loser, 400)).toBe("blocked");

    releaseWinner();
    const [a, b] = await Promise.all([winner, loser]);

    // The loser's insert was skipped (no P2002, its transaction committed)
    // and its re-read returned the winner's row.
    expect(b.id).toBe(a.id);
    const rows = await pool!.query(
      `SELECT count(*)::int AS n FROM "EventApplicationForm" WHERE "eventId" = $1 AND "purpose" = 'ATTEND'`,
      [EVENT_E],
    );
    expect(rows.rows[0]).toEqual({ n: 1 });
    await pool!.query(`DELETE FROM "EventApplicationForm" WHERE "eventId" = $1`, [
      EVENT_E,
    ]);
  });
});
