/**
 * Community-managed event listings — Step 7 blast-radius integration test
 * (docs/specs/2026-07-01/completed/community-managed-event-listings.spec.yaml).
 *
 * Runs the REAL core use-cases against the REAL Prisma adapters on a real
 * Postgres (testcontainer + `prisma migrate deploy`), proving the acceptance
 * criteria that span layers:
 *
 *  A. MODEL-A ISOLATION — an ownerless COMMUNITY/RSVP row lives in the same
 *     Event table as owned/ticketed events: it is first-class in public
 *     discovery (listPublished) but invisible to owner-scoped reads
 *     (listByOwner); the DB CHECK constraint
 *     `event_community_ownerless_rsvp_check` enforces the COMMUNITY =>
 *     (ownerless AND RSVP) direction ONLY; EventRsvp is idempotent per
 *     (eventId, humanId) and reversibly deletable.
 *  B. CLAIM-GUARD ATOMICITY — two concurrent claimPendingForReview calls on
 *     the same PENDING suggestion / moderator application have exactly one
 *     winner (the atomic updateMany guard, FR-008/FR-010).
 *  C. AUTHZ MATRIX — through the core use-cases with the real db-authz
 *     adapter: anonymous submit works ONLY on COMMUNITY listings (product
 *     decision 2026-07-20 reversed FR-006's universal scope — OWNED events
 *     collapse to EVENT_NOT_FOUND); pre-cutover OWNED-event suggestions stay
 *     reviewable; review routes to
 *     the event's approver side and nobody else; APPROVE applies the diff in
 *     one tx and writes the before/after "event_edit.applied" AuditLog row;
 *     stale suggestions conflict-skip per field (FR-009); FR-010 grants
 *     COMMUNITY_MODERATOR via platform-ADMIN review only.
 *  D. TICKETED GUARDS — creating a ticket type against the RSVP listing
 *     fails EVENT_NOT_TICKETED (FR-003) through the real upsertTicketType
 *     use case.
 *  E. ROLES-COLUMN REGRESSION — grantHumanRole used to no-op when Human.roles
 *     was SQL NULL (the state of every production-created human before the
 *     20260702120000 migration). Fixed on both layers: NOT NULL DEFAULT '{}'
 *     at the schema, NULL-safe COALESCE guard in the adapter. The E tests pin
 *     both fixes.
 *
 * Complements community-blast-radius.test.ts (discovery/search/orders/
 *  analytics/settlement exclusion) — this file owns the use-case-driven
 * authz + review pipeline against real SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { Repos } from "@th/ports/repos";

import { createCommunityListing } from "@th/core/use-cases/community/create-community-listing";
import { submitEventEditSuggestion } from "@th/core/use-cases/community/submit-event-edit-suggestion";
import { reviewEventEditSuggestion } from "@th/core/use-cases/community/review-event-edit-suggestion";
import { applyToBeModerator } from "@th/core/use-cases/community/apply-to-be-moderator";
import { reviewModeratorApplication } from "@th/core/use-cases/community/review-moderator-application";
import { rsvpToEvent } from "@th/core/use-cases/community/rsvp-to-event";
import { cancelRsvp } from "@th/core/use-cases/community/cancel-rsvp";
import { upsertTicketType } from "@th/core/use-cases/ticket-types/upsert-ticket-type";
import { snapshotSuggestionBase } from "@th/core/use-cases/events/_shared/suggestion-fields";

import { createPrismaRepos } from "../../src/db/prisma";
import { createDbAuthZAdapter } from "../../src/authz/db-authz-adapter";
import { createProfanityContentFilterAdapter } from "../../src/content-filter";
import { PrismaIdempotencyAdapter } from "../../src/idempotency/prisma-adapter";

const STARTS_AFTER = new Date("2027-01-01T00:00:00.000Z");
const EVENT_STARTS_AT = new Date("2027-06-01T20:00:00.000Z");
const EVENT_ENDS_AT = new Date("2027-06-01T23:00:00.000Z");
const COMMUNITY_TITLE = "Community Listings Itest Open Mic";

describe("Prisma adapters integration – community listings (use-case blast radius)", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let runtimeError: Error | null = null;

  // Shared wiring (real adapters, real DB).
  let repos: Repos;
  let authz: AuthZPort;
  let contentFilter: ContentFilterPort;
  const clock: ClockPort = { now: () => new Date() };
  const TEST_SECRET = "k".repeat(48);

  // Actors.
  let adminId: string; // platform ADMIN (Human.roles)
  let moderatorId: string; // granted COMMUNITY_MODERATOR via FR-010 flow
  let orgEditorId: string; // EDITOR of orgA
  let personalOwnerId: string; // owns the personal event
  let attendeeId: string; // plain signed-in user (RSVPs)
  let outsiderId: string; // plain signed-in user (negative cases)

  // Scaffolding.
  let orgId: string;
  let moderatorApplicationId: string;

  // One PUBLISHED PUBLIC event per ownership shape.
  let communityEventId: string;
  let orgEventId: string;
  let personalEventId: string;

  // Suggestions created in C1 (community via the real submit use case;
  // org/personal seeded at the repo layer as pre-cutover legacy rows) and
  // consumed by C2–C5.
  let communitySuggestionId: string;
  let orgSuggestionId: string;
  let personalSuggestionId: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      // The repo's Prisma client runs in driver-adapter ("client" engine)
      // mode, so a bare `new PrismaClient()` throws — construct it the way
      // packages/db/src/index.ts does, with a pg Pool adapter.
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      repos = createPrismaRepos(prisma);
      authz = createDbAuthZAdapter({ repos });
      contentFilter = createProfanityContentFilterAdapter();

      // ── Actors ────────────────────────────────────────────────────────────
      const [admin, moderator, orgEditor, personalOwner, attendee, outsider] =
        await Promise.all([
          prisma.human.create({
            data: { name: "Platform Admin", status: "ACTIVE", roles: ["ADMIN"] },
          }),
          prisma.human.create({
            // Deliberately created WITHOUT `roles` — exactly like every
            // production create path — so the FR-010 grant in setup proves
            // grantHumanRole works on a default-roles human (see section E).
            data: { name: "Future Moderator", status: "ACTIVE" },
          }),
          prisma.human.create({
            data: { name: "Org A Editor", status: "ACTIVE" },
          }),
          prisma.human.create({
            data: { name: "Personal Event Owner", status: "ACTIVE" },
          }),
          prisma.human.create({ data: { name: "Attendee", status: "ACTIVE" } }),
          prisma.human.create({ data: { name: "Outsider", status: "ACTIVE" } }),
        ]);
      adminId = admin.id;
      moderatorId = moderator.id;
      orgEditorId = orgEditor.id;
      personalOwnerId = personalOwner.id;
      attendeeId = attendee.id;
      outsiderId = outsider.id;

      const org = await prisma.organization.create({
        data: { name: "Community Itest Collective", slug: "community-itest-co" },
      });
      orgId = org.id;
      await prisma.orgMember.create({
        data: { orgId, humanId: orgEditorId, role: "EDITOR" },
      });

      // The authz port counts a staff role only with a second factor
      // enrolled (TOTP here; `repos.humans.hasSecondFactorEnrolled` reads
      // `AuthUser.twoFactorEnabled`). Both staff actors are enrolled.
      await prisma.authUser.create({
        data: {
          name: "Platform Admin",
          email: "community-itest-admin@example.test",
          humanId: adminId,
          twoFactorEnabled: true,
        },
      });
      await prisma.authUser.create({
        data: {
          name: "Future Moderator",
          email: "community-itest-moderator@example.test",
          humanId: moderatorId,
          twoFactorEnabled: true,
        },
      });

      // ── FR-010: moderator grant goes through the REAL RfA flow ───────────
      const { application } = await applyToBeModerator(
        { repos, authz, clock, contentFilter },
        {
          actorHumanId: moderatorId,
          statement: "I keep the weekly open-mic listings accurate.",
        },
      );
      moderatorApplicationId = application.id;
      await reviewModeratorApplication(
        { repos, authz, clock },
        {
          actorHumanId: adminId,
          applicationId: moderatorApplicationId,
          decision: "APPROVE",
        },
      );

      // ── One PUBLISHED PUBLIC event per ownership shape ────────────────────
      const orgEvent = await prisma.event.create({
        data: {
          title: "Community Itest Org Gala",
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          orgId,
          countryCode: "US",
          slug: "event/us/testville/community-itest-org-gala-2027-06-01-2000--cio001",
          shortId: "cio001",
          publishedAt: new Date(),
        },
      });
      orgEventId = orgEvent.id;

      const personalEvent = await prisma.event.create({
        data: {
          title: "Community Itest House Show",
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          humanId: personalOwnerId,
          countryCode: "US",
          slug: "event/us/testville/community-itest-house-show-2027-06-01-2000--cip001",
          shortId: "cip001",
          publishedAt: new Date(),
        },
      });
      personalEventId = personalEvent.id;

      // The COMMUNITY listing is created through the REAL FR-005 use case
      // (moderator gate + inline slug/geohash + PUBLISHED write + audit).
      const { event: communityEvent } = await createCommunityListing(
        { repos, authz, clock, contentFilter },
        {
          actorHumanId: moderatorId,
          title: COMMUNITY_TITLE,
          startsAt: EVENT_STARTS_AT,
          endsAt: EVENT_ENDS_AT,
          timezone: "America/Chicago",
          addressText: "123 Main St, Austin, TX",
          countryCode: "US",
          region: "TX",
          locality: "Austin",
          postalCode: "78701",
          lat: 30.27,
          lng: -97.74,
        },
      );
      communityEventId = communityEvent.id;
    } catch (err) {
      runtimeError = err as Error;
      // eslint-disable-next-line no-console
      console.error("[community-listings.test] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  // Deliberately NOT wrapped in the skip() guard: this file is THE Step-7
  // risk checkpoint, and if the container/migrate/setup fails, sixteen
  // skipped tests read as green in CI. The canary makes that failure loud.
  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
  });

  // ═════════════════════════ A. MODEL-A ISOLATION ════════════════════════════

  test("A1: moderator-created COMMUNITY listing is ownerless RSVP+PUBLISHED; creator attribution lives ONLY in the AuditLog", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const event = await repos.events.getById(communityEventId);
    expect(event).not.toBeNull();
    expect(event!.stewardship).toBe("COMMUNITY");
    expect(event!.attendanceMode).toBe("RSVP");
    expect(event!.status).toBe("PUBLISHED");
    expect(event!.visibility).toBe("PUBLIC");
    expect(event!.orgId).toBeNull();
    expect(event!.humanId).toBeNull();
    expect(event!.slug).toContain("event/us/");
    // Money fields never stamped — the row skipped the publish pipeline.
    expect(event!.payoutTermsId).toBeNull();
    expect(event!.currency).toBeNull();

    const created = await prisma.auditLog.findFirst({
      where: {
        entity: "event",
        entityId: communityEventId,
        action: "community_listing.created",
      },
    });
    expect(created).not.toBeNull();
    expect((created!.data as { actorHumanId?: string }).actorHumanId).toBe(
      moderatorId,
    );
  }, 60_000);

  test("A2: COMMUNITY event appears in listPublished but is ABSENT from listByOwner for both org and human", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const page = await repos.events.listPublished({
      limit: 100,
      offset: 0,
      startsAfter: STARTS_AFTER,
    });
    expect(page.items.map((e) => e.id)).toEqual(
      expect.arrayContaining([communityEventId, orgEventId, personalEventId]),
    );

    const orgPage = await repos.events.listByOwner({
      ownerType: "ORGANIZATION",
      ownerId: orgId,
    });
    expect(orgPage.items.map((e) => e.id)).toEqual([orgEventId]);
    expect(orgPage.items.map((e) => e.id)).not.toContain(communityEventId);

    const humanPage = await repos.events.listByOwner({
      ownerType: "HUMAN",
      ownerId: personalOwnerId,
    });
    expect(humanPage.items.map((e) => e.id)).toEqual([personalEventId]);
    expect(humanPage.items.map((e) => e.id)).not.toContain(communityEventId);
  }, 60_000);

  test("A3: DB CHECK constraint — COMMUNITY must be ownerless AND RSVP; ownerless OWNED stays legal (SetNull orphans)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const base = {
      title: "Constraint Probe",
      startsAt: EVENT_STARTS_AT,
      endsAt: EVENT_ENDS_AT,
      status: "DRAFT" as const,
    };

    // COMMUNITY with a HUMAN owner → rejected by
    // event_community_ownerless_rsvp_check (the orgId direction is covered in
    // community-blast-radius.test.ts).
    await expect(
      prisma.event.create({
        data: {
          ...base,
          stewardship: "COMMUNITY",
          attendanceMode: "RSVP",
          humanId: personalOwnerId,
        },
      }),
    ).rejects.toThrow(/event_community_ownerless_rsvp_check|constraint/i);

    // COMMUNITY but TICKETED → rejected even when ownerless.
    await expect(
      prisma.event.create({
        data: {
          ...base,
          stewardship: "COMMUNITY",
          attendanceMode: "TICKETED",
        },
      }),
    ).rejects.toThrow(/event_community_ownerless_rsvp_check|constraint/i);

    // OWNED with BOTH owners null is DELIBERATELY allowed — Event.humanId is
    // onDelete SetNull, so admin-delete-human orphans personal OWNED events;
    // the OWNED => has-owner direction is use-case-enforced, not DB-enforced.
    const orphan = await prisma.event.create({
      data: { ...base, stewardship: "OWNED", attendanceMode: "TICKETED" },
    });
    expect(orphan.humanId).toBeNull();
    expect(orphan.orgId).toBeNull();
    await prisma.event.delete({ where: { id: orphan.id } });
  }, 60_000);

  test("A4: RSVP is idempotent per (eventId, humanId), reversible, DB-unique, and rejected on TICKETED events", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // Upsert twice through the use case → same row, count 1.
    const first = await rsvpToEvent(
      { repos, clock },
      { actorHumanId: attendeeId, eventId: communityEventId },
    );
    const second = await rsvpToEvent(
      { repos, clock },
      { actorHumanId: attendeeId, eventId: communityEventId },
    );
    expect(second.rsvp.id).toBe(first.rsvp.id);
    expect(
      await prisma.eventRsvp.count({
        where: { eventId: communityEventId, humanId: attendeeId },
      }),
    ).toBe(1);

    // The @@unique([eventId, humanId]) really exists at the DB layer.
    await expect(
      prisma.eventRsvp.create({
        data: { eventId: communityEventId, humanId: attendeeId },
      }),
    ).rejects.toThrow();

    // Delete is idempotent: second cancel is a no-op, not an error.
    await cancelRsvp(
      { repos },
      { actorHumanId: attendeeId, eventId: communityEventId },
    );
    await cancelRsvp(
      { repos },
      { actorHumanId: attendeeId, eventId: communityEventId },
    );
    expect(
      await prisma.eventRsvp.count({
        where: { eventId: communityEventId, humanId: attendeeId },
      }),
    ).toBe(0);

    // RSVP against a TICKETED event is rejected (FR-004 gating).
    await expect(
      rsvpToEvent({ repos, clock }, { actorHumanId: attendeeId, eventId: orgEventId }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMMUNITY" });
  }, 60_000);

  // ═══════════════════════ B. CLAIM-GUARD ATOMICITY ══════════════════════════

  test("B1: two concurrent claimPendingForReview calls on one PENDING suggestion — exactly one wins", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const suggestion = await repos.eventEditSuggestions.create({
      eventId: communityEventId,
      submitterHumanId: null,
      submitterIpHash: "a".repeat(64),
      fields: { title: "Claim Race Probe" },
      baseVersion: { title: COMMUNITY_TITLE },
      note: null,
    });

    const reviewedAt = new Date();
    const [a, b] = await Promise.all([
      repos.eventEditSuggestions.claimPendingForReview({
        id: suggestion.id,
        reviewedByHumanId: moderatorId,
        reviewedAt,
      }),
      repos.eventEditSuggestions.claimPendingForReview({
        id: suggestion.id,
        reviewedByHumanId: adminId,
        reviewedAt,
      }),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    // The claim only stamps reviewer/at — status stays PENDING until
    // markReviewed, and the stored reviewer is the single winner's.
    const row = await prisma.eventEditSuggestion.findUnique({
      where: { id: suggestion.id },
    });
    expect(row!.status).toBe("PENDING");
    expect(row!.reviewedByHumanId).toBe(winners[0]!.reviewedByHumanId);
  }, 60_000);

  test("B2: two concurrent claimPendingForReview calls on one PENDING moderator application — exactly one wins", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const applicant = await prisma.human.create({
      data: { name: "Claim Race Applicant", status: "ACTIVE" },
    });
    const application = await repos.communityModeratorApplications.create({
      applicantHumanId: applicant.id,
      statement: null,
    });

    const reviewedAt = new Date();
    const [a, b] = await Promise.all([
      repos.communityModeratorApplications.claimPendingForReview({
        id: application.id,
        reviewedByHumanId: adminId,
        reviewedAt,
      }),
      repos.communityModeratorApplications.claimPendingForReview({
        id: application.id,
        reviewedByHumanId: moderatorId,
        reviewedAt,
      }),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    const row = await prisma.communityModeratorApplication.findUnique({
      where: { id: application.id },
    });
    expect(row!.status).toBe("PENDING");
    expect(row!.reviewedByHumanId).toBe(winners[0]!.reviewedByHumanId);
  }, 60_000);

  // ══════════════════ C. AUTHZ MATRIX (through core use-cases) ═══════════════

  test("C1: anonymous submit works against the COMMUNITY listing only; OWNED events reject EVENT_NOT_FOUND; non-whitelisted fields reject", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    // The per-IP cap counts a keyed hash of the IP; the use case needs the
    // root secret to derive it (ban-that-sticks round 3).
    const deps = { repos, clock, contentFilter, identitySecret: TEST_SECRET };

    const { suggestion } = await submitEventEditSuggestion(deps, {
      eventId: communityEventId,
      submitterHumanId: null, // anonymous
      submitterIp: "198.51.100.10",
      fields: { title: `${COMMUNITY_TITLE} (Every Tuesday)`, ageLimit: 18 },
      note: "Saw the sign at the venue door",
    });
    expect(suggestion.status).toBe("PENDING");
    expect(suggestion.submitterHumanId).toBeNull();
    expect(suggestion.eventId).toBe(communityEventId);
    communitySuggestionId = suggestion.id;

    // The suggestion NEVER mutates the event (FR-006) — witnessed through
    // the repo read surface, which now exposes ageLimit (EVENT_SELECT +
    // mapEvent), keeping FR-009 conflict detection and audit before-values
    // honest for this field.
    const record = await repos.events.getById(communityEventId);
    expect(record!.ageLimit).toBeNull();

    // COMMUNITY-only (product decision 2026-07-20 reversing FR-006's
    // universal scope): OWNED events — org and personal, even PUBLISHED
    // PUBLIC — collapse to EVENT_NOT_FOUND through the real adapter stack,
    // and no suggestion row is written.
    for (const [index, ownedEventId] of [
      orgEventId,
      personalEventId,
    ].entries()) {
      await expect(
        submitEventEditSuggestion(deps, {
          eventId: ownedEventId,
          submitterHumanId: null,
          submitterIp: `198.51.100.${11 + index}`,
          fields: { ageLimit: 21 },
        }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      const rows = await prisma.eventEditSuggestion.count({
        where: { eventId: ownedEventId },
      });
      expect(rows).toBe(0);
    }

    // C3/C4 still pin the review-side authz for OWNED-event suggestions:
    // PENDING rows submitted BEFORE the COMMUNITY-only cutover exist in prod
    // and must stay reviewable by their owner side. Seed them at the repo
    // layer (the submit gate now rejects OWNED targets).
    const [orgEvent, personalEvent] = await Promise.all([
      repos.events.getById(orgEventId),
      repos.events.getById(personalEventId),
    ]);
    const [orgLegacy, personalLegacy] = await Promise.all([
      repos.eventEditSuggestions.create({
        eventId: orgEventId,
        submitterHumanId: null,
        submitterIpHash: "b".repeat(64),
        fields: { ageLimit: 21 },
        baseVersion: snapshotSuggestionBase({
          event: orgEvent!,
          content: null,
          heroImageId: null,
        }),
        note: "Saw the sign at the venue door",
      }),
      repos.eventEditSuggestions.create({
        eventId: personalEventId,
        submitterHumanId: null,
        submitterIpHash: "c".repeat(64),
        fields: { ageLimit: 16 },
        baseVersion: snapshotSuggestionBase({
          event: personalEvent!,
          content: null,
          heroImageId: null,
        }),
        note: "Saw the sign at the venue door",
      }),
    ]);
    orgSuggestionId = orgLegacy.id;
    personalSuggestionId = personalLegacy.id;

    // A non-whitelisted field rejects the WHOLE payload (FR-007) — money/
    // ownership/status fields can never ride a suggestion.
    for (const forbidden of [
      { admissionTaxRateBps: 250 },
      { orgId: orgId },
      { status: "CANCELLED" },
    ]) {
      await expect(
        submitEventEditSuggestion(deps, {
          eventId: communityEventId,
          submitterHumanId: null,
          submitterIp: "198.51.100.20",
          fields: { title: "smuggle attempt", ...forbidden },
        }),
      ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    }
  }, 60_000);

  test("C2: org EDITOR of org A cannot review a COMMUNITY suggestion (STAFF_ONLY) and does not burn the claim", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    await expect(
      reviewEventEditSuggestion(
        { repos, authz, clock, contentFilter },
        {
          actorHumanId: orgEditorId,
          suggestionId: communitySuggestionId,
          decision: "APPROVE",
        },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    // Authz runs BEFORE the claim: the forbidden actor must not have stamped
    // reviewedBy/At (which would fake ALREADY_REVIEWED for the real reviewer).
    const row = await prisma.eventEditSuggestion.findUnique({
      where: { id: communitySuggestionId },
    });
    expect(row!.status).toBe("PENDING");
    expect(row!.reviewedByHumanId).toBeNull();
    expect(row!.reviewedAt).toBeNull();
  }, 60_000);

  test("C3: COMMUNITY_MODERATOR cannot review an ORG-event suggestion unless org member; the org EDITOR can", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const deps = { repos, authz, clock, contentFilter };

    // The moderator is NOT a member of org A → INSUFFICIENT_ROLE.
    await expect(
      reviewEventEditSuggestion(deps, {
        actorHumanId: moderatorId,
        suggestionId: orgSuggestionId,
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // The org EDITOR reviews it via the owner-side inbox (FR-008/FR-016).
    const result = await reviewEventEditSuggestion(deps, {
      actorHumanId: orgEditorId,
      suggestionId: orgSuggestionId,
      decision: "APPROVE",
    });
    expect(result.suggestion.status).toBe("APPROVED");
    expect(result.appliedFields).toEqual(["ageLimit"]);
    expect(result.conflictedFields).toEqual([]);

    const row = await prisma.event.findUnique({
      where: { id: orgEventId },
      select: { ageLimit: true },
    });
    expect(row!.ageLimit).toBe(21);
  }, 60_000);

  test("C4: personal-event suggestion is reviewable ONLY by its humanId owner", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const deps = { repos, authz, clock, contentFilter };

    for (const actorHumanId of [moderatorId, orgEditorId, outsiderId]) {
      await expect(
        reviewEventEditSuggestion(deps, {
          actorHumanId,
          suggestionId: personalSuggestionId,
          decision: "APPROVE",
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }

    const result = await reviewEventEditSuggestion(deps, {
      actorHumanId: personalOwnerId,
      suggestionId: personalSuggestionId,
      decision: "APPROVE",
    });
    expect(result.suggestion.status).toBe("APPROVED");
    expect(result.appliedFields).toEqual(["ageLimit"]);

    const row = await prisma.event.findUnique({
      where: { id: personalEventId },
      select: { ageLimit: true },
    });
    expect(row!.ageLimit).toBe(16);
  }, 60_000);

  test("C5: moderator APPROVE applies the diff atomically + writes the before/after event_edit.applied AuditLog; re-review is a no-op", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const deps = { repos, authz, clock, contentFilter };

    const result = await reviewEventEditSuggestion(deps, {
      actorHumanId: moderatorId,
      suggestionId: communitySuggestionId,
      decision: "APPROVE",
      reviewNote: "Confirmed with the venue",
    });
    expect(result.suggestion.status).toBe("APPROVED");
    expect(result.appliedFields.sort()).toEqual(["ageLimit", "title"]);
    expect(result.conflictedFields).toEqual([]);

    const applied2 = await prisma.event.findUnique({
      where: { id: communityEventId },
      select: { title: true, ageLimit: true },
    });
    expect(applied2!.title).toBe(`${COMMUNITY_TITLE} (Every Tuesday)`);
    expect(applied2!.ageLimit).toBe(18);

    // FR-008/FR-013: the applied AuditLog row IS the version history —
    // before/after per changed field + the material marker.
    const applied = await prisma.auditLog.findMany({
      where: {
        entity: "event",
        entityId: communityEventId,
        action: "event_edit.applied",
      },
    });
    expect(applied).toHaveLength(1);
    const data = applied[0]!.data as {
      suggestionId: string;
      actorHumanId: string;
      material: boolean;
      changes: Record<string, { before: unknown; after: unknown }>;
    };
    expect(data.suggestionId).toBe(communitySuggestionId);
    expect(data.actorHumanId).toBe(moderatorId);
    expect(data.changes.title).toEqual({
      before: COMMUNITY_TITLE,
      after: `${COMMUNITY_TITLE} (Every Tuesday)`,
    });
    expect(data.changes.ageLimit).toEqual({ before: null, after: 18 });
    // title/ageLimit are non-material (FR-013: material = schedule/venue).
    expect(data.material).toBe(false);

    // Re-reviewing the same suggestion is a no-op (claim guard).
    await expect(
      reviewEventEditSuggestion(deps, {
        actorHumanId: moderatorId,
        suggestionId: communitySuggestionId,
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "EDIT_SUGGESTION_ALREADY_REVIEWED" });
  }, 60_000);

  test("C6 (FR-009): a suggestion drafted against stale data has conflicting fields skipped+flagged, non-conflicting applied", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }
    const deps = { repos, authz, clock, contentFilter };

    // Draft a suggestion, then someone else edits the same field directly.
    const { suggestion } = await submitEventEditSuggestion(
      { repos, clock, contentFilter, identitySecret: TEST_SECRET },
      {
        eventId: communityEventId,
        submitterHumanId: attendeeId,
        submitterIp: "198.51.100.30",
        fields: { title: "Stale Title Proposal", ageLimit: 25 },
      },
    );
    await prisma.event.update({
      where: { id: communityEventId },
      data: { title: "Direct Rename By Someone Else" },
    });

    const result = await reviewEventEditSuggestion(deps, {
      actorHumanId: moderatorId,
      suggestionId: suggestion.id,
      decision: "APPROVE",
    });
    expect(result.suggestion.status).toBe("APPROVED");
    expect(result.conflictedFields).toEqual(["title"]);
    expect(result.appliedFields).toEqual(["ageLimit"]);

    // The drifted field was NOT stomped; the clean field applied.
    const row = await prisma.event.findUnique({
      where: { id: communityEventId },
      select: { title: true, ageLimit: true },
    });
    expect(row!.title).toBe("Direct Rename By Someone Else");
    expect(row!.ageLimit).toBe(25);

    // The event_edit.applied audit row records the REAL before value — 18,
    // stamped by C5 — not a blind null. This is only possible because the
    // events repo read surface (EVENT_SELECT/mapEvent) exposes ageLimit to
    // snapshotSuggestionBase.
    const appliedRows = await prisma.auditLog.findMany({
      where: {
        entity: "event",
        entityId: communityEventId,
        action: "event_edit.applied",
      },
    });
    const thisApply = appliedRows.find(
      (r) =>
        (r.data as { suggestionId?: string }).suggestionId === suggestion.id,
    );
    expect(thisApply).toBeDefined();
    const auditData = thisApply!.data as {
      changes: Record<string, { before: unknown; after: unknown }>;
    };
    expect(auditData.changes.ageLimit).toEqual({ before: 18, after: 25 });
  }, 60_000);

  test("C7 (FR-010): ADMIN approval granted COMMUNITY_MODERATOR + audited; a moderator cannot review applications", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    // The setup flow (apply → ADMIN approve) really granted the role…
    const roles = await repos.authz.getStaffRolesForHumanId(moderatorId);
    expect(roles).toContain("COMMUNITY_MODERATOR");

    const application = await repos.communityModeratorApplications.getById(
      moderatorApplicationId,
    );
    expect(application!.status).toBe("APPROVED");
    expect(application!.reviewedByHumanId).toBe(adminId);

    // …and audited it (grant + decision in one row).
    const audit = await prisma.auditLog.findFirst({
      where: {
        entity: "community_moderator_application",
        entityId: moderatorApplicationId,
        action: "moderator_application.reviewed",
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.data).toMatchObject({
      actorHumanId: adminId,
      applicantHumanId: moderatorId,
      decision: "APPROVE",
      granted: true,
    });

    // Application review is platform-ADMIN-only: a COMMUNITY_MODERATOR is not
    // enough (single-tier moderation, spec decision).
    const { application: outsiderApplication } = await applyToBeModerator(
      { repos, authz, clock, contentFilter },
      { actorHumanId: outsiderId },
    );
    await expect(
      reviewModeratorApplication(
        { repos, authz, clock },
        {
          actorHumanId: moderatorId,
          applicationId: outsiderApplication.id,
          decision: "APPROVE",
        },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    // REJECT by the ADMIN grants nothing.
    await reviewModeratorApplication(
      { repos, authz, clock },
      {
        actorHumanId: adminId,
        applicationId: outsiderApplication.id,
        decision: "REJECT",
        reviewNote: "Not enough listing history yet",
      },
    );
    const outsiderRoles = await repos.authz.getStaffRolesForHumanId(outsiderId);
    expect(outsiderRoles).not.toContain("COMMUNITY_MODERATOR");
  }, 60_000);

  // ════════════════════════ D. TICKETED GUARDS (FR-003) ══════════════════════

  // Load-bearing on guard ORDER inside upsertTicketType: the attendanceMode
  // guard fires BEFORE the edit-rights authz check (fine — attendance mode is
  // public info), which is the only reason the moderator actor here reaches
  // EVENT_NOT_TICKETED instead of an ownership error on this ownerless row.
  test("D1: creating a ticket type against the RSVP listing fails EVENT_NOT_TICKETED and writes nothing", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const idempotency = new PrismaIdempotencyAdapter(prisma, "itest");
    await expect(
      upsertTicketType(
        { repos, idempotency, clock },
        {
          actorHumanId: moderatorId,
          eventId: communityEventId,
          name: "General Admission",
          priceCents: 1000,
          capacity: 50,
          clientKey: "itest-tt-community-1",
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_TICKETED" });

    expect(
      await prisma.ticketType.count({ where: { eventId: communityEventId } }),
    ).toBe(0);
  }, 60_000);

  // ═══════════ E. ROLES-COLUMN REGRESSION (grantHumanRole vs SQL NULL) ═══════
  //
  // HISTORY: Human.roles was created with no DEFAULT and no NOT NULL, and no
  // production create path (humans.create, ensureGuestHuman, the Better-Auth
  // link path) sets it — so every real human stored SQL NULL, and the old
  // Prisma guard in grantHumanRole (`NOT: { roles: { has: role } }`, i.e.
  // `NOT ("roles" @> ARRAY[role])`) evaluated to NULL against a NULL array →
  // zero rows → { granted: false } → reviewModeratorApplication treated it as
  // benign "already held" and FR-010 APPROVE silently never granted the role.
  //
  // FIXED on both layers:
  //  - schema: 20260702120000_human_roles_not_null_default backfills NULL →
  //    '{}' and pins NOT NULL DEFAULT '{}' (E1);
  //  - adapter: grantHumanRole now uses a NULL-safe COALESCE raw-SQL guard.
  //
  // SCOPE NOTE: this DB runs the full migration set, so a SQL NULL roles
  // column cannot exist here — E2 therefore pins the user-visible regression
  // path (granting on a default-empty-array human created without an explicit
  // roles value), not the literal NULL column. The COALESCE guard's NULL
  // handling is belt-and-braces for environments where the backfill migration
  // hasn't run and is not directly exercisable in this suite.

  test("E1: a human created without roles stores a NOT NULL empty array (schema default)", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const plain = await prisma.human.create({
      data: { name: "Roles Default Probe", status: "ACTIVE" },
    });
    const [row] = await prisma.$queryRaw<Array<{ isNull: boolean }>>`
      SELECT ("roles" IS NULL) AS "isNull" FROM "Human" WHERE "id" = ${plain.id}
    `;
    expect(row!.isNull).toBe(false);
    expect(plain.roles).toEqual([]);
  }, 60_000);

  test("E2: grantHumanRole grants (idempotently) on a human created without an explicit roles value", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const human = await prisma.human.create({
      data: { name: "Grant Default Probe", status: "ACTIVE" },
    });

    const result = await repos.authz.grantHumanRole({
      humanId: human.id,
      role: "COMMUNITY_MODERATOR",
    });
    expect(result.granted).toBe(true);
    expect(await repos.authz.getStaffRolesForHumanId(human.id)).toContain(
      "COMMUNITY_MODERATOR",
    );

    // Idempotency contract preserved: a re-grant is a zero-row match.
    const again = await repos.authz.grantHumanRole({
      humanId: human.id,
      role: "COMMUNITY_MODERATOR",
    });
    expect(again.granted).toBe(false);
    expect(
      (await repos.authz.getStaffRolesForHumanId(human.id)).filter(
        (r) => r === "COMMUNITY_MODERATOR",
      ),
    ).toHaveLength(1);
  }, 60_000);

  // ── F. A staff role counts only with a second factor (real adapter) ───────
  //
  // `createDbAuthZAdapter` over the real repos: the role comes from
  // `Human.roles`, the enrolment from `AuthUser.twoFactorEnabled` or a
  // `Passkey` row (`repos.humans.hasSecondFactorEnrolled`).

  test("F1: a COMMUNITY_MODERATOR with no AuthUser is refused, and told a second factor is why", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const human = await prisma.human.create({
      data: { name: "Unenrolled Moderator", status: "ACTIVE" },
    });
    await repos.authz.grantHumanRole({
      humanId: human.id,
      role: "COMMUNITY_MODERATOR",
    });

    expect(
      await authz.hasStaffRole({
        actorHumanId: human.id,
        requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
      }),
    ).toEqual({ allowed: false, secondFactorRequired: true });

    // The status-probe opt-out answers on the role alone.
    expect(
      await authz.hasStaffRole({
        actorHumanId: human.id,
        requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
        allowWithoutSecondFactor: true,
      }),
    ).toEqual({ allowed: true });
  }, 60_000);

  test("F2: a passkey alone is a second factor; an AuthUser with nothing enrolled is not", async ({
    skip,
  }) => {
    if (runtimeError || !prisma) {
      skip();
      return;
    }

    const human = await prisma.human.create({
      data: { name: "Passkey Moderator", status: "ACTIVE" },
    });
    await repos.authz.grantHumanRole({
      humanId: human.id,
      role: "COMMUNITY_MODERATOR",
    });
    // `twoFactorEnabled` keeps its default (false): no TOTP.
    const authUser = await prisma.authUser.create({
      data: {
        name: "Passkey Moderator",
        email: "community-itest-passkey-moderator@example.test",
        humanId: human.id,
      },
    });
    const probe = {
      actorHumanId: human.id,
      requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
    } satisfies Parameters<typeof authz.hasStaffRole>[0];

    expect(await authz.hasStaffRole(probe)).toEqual({
      allowed: false,
      secondFactorRequired: true,
    });

    await prisma.passkey.create({
      data: {
        userId: authUser.id,
        publicKey: "public-key-bytes",
        credentialID: `cred-${authUser.id}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      },
    });

    expect(await authz.hasStaffRole(probe)).toEqual({ allowed: true });
  }, 60_000);
});
