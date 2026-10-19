import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerOccurrenceClaimRecord,
  VolunteerOccurrenceClaimRosterRow,
  VolunteerShiftOccurrenceRecord,
} from "@th/ports/repos/volunteering";
import { fail, isAppError } from "@th/errors";

import { generateSingleEventIcs, type ICalEvent } from "../../lib/ical";
import { describeError, parseInput } from "../../lib/io";
import {
  ensureCoordinatorEmailVerified,
  OWNERSHIP_DENIAL_CODES,
  requireCoordinatorOrOwner,
} from "./_shared/require-coordinator-or-owner";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { isAskOwnerWithheld } from "./_shared/ask-owner-withheld";
import { VOLUNTEER_ICS_UID_DOMAIN } from "./export-signup-ics";
import {
  claimOccurrenceInputSchema,
  withdrawOccurrenceClaimInputSchema,
  assignOccurrenceClaimInputSchema,
  checkInOccurrenceClaimInputSchema,
  listOccurrenceRosterInputSchema,
  getPublicAskScheduleInputSchema,
} from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type OccurrenceClaimDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * Base URL for deep links in the assignment email/.ics. Nullable — when
   * unset the email still sends, simply omitting the link (mirrors the
   * cancel fan-out's posture; an .ics without a URL is still valid).
   */
  appBaseUrl: string | null;
  /**
   * Assignment confirmation email with an .ics attachment (FR-004).
   * Optional: absent = the assignment still lands, the missed email is
   * logged + reported (mirrors the comp-grant mailer posture — the durable
   * outcome must not depend on email being configured).
   */
  mailer?: Pick<MailerPort, "send"> | null;
  logger?: LoggerPort;
  /**
   * Best-effort swallow reporter (Sentry) for caught-and-continued failures
   * (CLAUDE.md error-reporting convention). A throwing reporter must never
   * change behaviour.
   */
  reportError?: ReporterPort;
};

/** Signup statuses allowed to hold occurrence claims. */
const CLAIMABLE_SIGNUP_STATUSES: ReadonlySet<string> = new Set([
  "APPROVED",
  "CHECKED_IN",
]);

// ── Shared resolution ───────────────────────────────────────────────────────

/**
 * Occurrence + its standing ask. EVENT-subject asks can never own an
 * occurrence (creation rejects them), but the guard keeps a hand-crafted
 * row failing closed. Missing anything collapses to `occurrence_not_found`.
 */
async function resolveOccurrenceContext(
  tx: TxRepos,
  occurrenceId: string,
): Promise<{
  occurrence: VolunteerShiftOccurrenceRecord;
  ask: VolunteerAskRecord;
}> {
  const occurrence = await tx.volunteering.getOccurrence(occurrenceId);
  if (!occurrence) {
    throw fail("OCCURRENCE_NOT_FOUND");
  }
  const ask = await tx.volunteering.getAsk(occurrence.askId);
  if (!ask || ask.subjectType === "EVENT") {
    throw fail("OCCURRENCE_NOT_FOUND");
  }
  return { occurrence, ask };
}

/** Round to 2dp — matches the hours-report convention. */
const round2 = (n: number): number => Number(n.toFixed(2));

/** Trim trailing slashes; empty/unset collapses to null (no valid links). */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Decimal(5,2) column bound on claim.hoursWorked. */
const MAX_CLAIM_HOURS = 999.99;

/** Duration-derived hours for an occurrence window, 2dp. */
function occurrenceDurationHours(
  occurrence: VolunteerShiftOccurrenceRecord,
): number {
  return round2(
    (occurrence.endsAt.getTime() - occurrence.startsAt.getTime()) / 3_600_000,
  );
}

// ── claim-occurrence (self-serve) ───────────────────────────────────────────

/**
 * A signed-in volunteer claims an open occurrence (FR-003).
 *
 * - Their signup on the SAME ask + role must be accepted (APPROVED |
 *   CHECKED_IN — the seat-occupying set; PENDING/REJECTED/WITHDRAWN and
 *   other-role/other-ask signups uniformly fail `signup_not_eligible`).
 *   Shadow signups can't self-claim by construction — the lookup is
 *   keyed on the actor's humanId.
 * - Occurrence must be SCHEDULED and in the future — gated on the row
 *   re-read UNDER a `FOR UPDATE` lock (`getOccurrenceForUpdate`), taken
 *   unconditionally (even uncapped), so a concurrent cancel or capacity
 *   edit can never be missed by a stale pre-lock read.
 * - Capacity gates inside the same tx as the write, against the locked
 *   row's capacity, so two racing claims on the last slot serialize.
 * - Idempotent: an existing CLAIMED row returns as-is; a WITHDRAWN row
 *   flips back to CLAIMED (re-claim) under the same capacity check.
 * - A withheld owner's ask (ban that sticks) refuses every NEW claim with
 *   `SHIFT_SIGNUPS_PAUSED`; an existing CLAIMED row still returns as-is.
 */
export async function claimOccurrence(
  deps: Pick<OccurrenceClaimDeps, "repos" | "clock" | "logger">,
  rawInput: unknown,
): Promise<VolunteerOccurrenceClaimRecord> {
  const input = parseInput(claimOccurrenceInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { occurrence, ask } = await resolveOccurrenceContext(
      tx,
      input.occurrenceId,
    );

    // Eligibility BEFORE any occurrence-state error: an ineligible caller
    // learns nothing about the occurrence beyond its existence (which the
    // public schedule already shows).
    const signups = await tx.volunteering.listSignupsByHuman(
      input.actorHumanId,
    );
    const signup = signups.find(
      (s) =>
        s.askId === ask.id &&
        s.roleId === occurrence.roleId &&
        CLAIMABLE_SIGNUP_STATUSES.has(s.status),
    );
    if (!signup) {
      throw fail("CONFLICT", {
        message: "signup_not_eligible",
        meta: { reason: "signup_not_eligible" },
      });
    }

    // THE gate: lock the occurrence row and re-read it under that lock —
    // ALWAYS, even for uncapped occurrences. Every state check below runs
    // against the LOCKED row, never the plain read above: a cancel or
    // capacity-lowering edit that committed before our lock acquired is
    // visible here, so a claim can never land on a CANCELLED occurrence
    // (missing its cancel fan-out) or against stale capacity.
    const locked = await tx.volunteering.getOccurrenceForUpdate(occurrence.id);
    if (!locked) {
      throw fail("OCCURRENCE_NOT_FOUND");
    }
    if (locked.status !== "SCHEDULED") {
      throw fail("CONFLICT", {
        message: "occurrence_cancelled",
        meta: { reason: "occurrence_cancelled" },
      });
    }
    const now = deps.clock.now();
    if (locked.startsAt <= now) {
      throw fail("CONFLICT", {
        message: "occurrence_in_past",
        meta: { reason: "occurrence_in_past" },
      });
    }

    // Idempotent replay / re-claim pre-read on the (occurrence, signup)
    // unique — under the lock, so it can't race a concurrent claim by the
    // same signup either.
    const existing = await tx.volunteering.getClaimByOccurrenceAndSignup(
      locked.id,
      signup.id,
    );
    if (existing?.status === "CLAIMED") {
      return existing;
    }

    // Ban that sticks (owner ruling 2026-10-07: "Refuse, but tell them
    // why"). A withheld owner's ask takes no NEW claim, re-claims included,
    // but a claim already held stays: the replay above returns it untouched
    // and nothing here releases it. Only a volunteer accepted on this ask
    // gets this far (eligibility gates first), so the distinct code tells
    // nobody else the ask exists. The code says sign-ups are paused, never
    // why: a moderation action stays private to the person it concerns.
    if (await isAskOwnerWithheld(tx, ask)) {
      throw fail("SHIFT_SIGNUPS_PAUSED");
    }

    // Capacity from the LOCKED row. Soft cap semantics: null capacity =
    // unlimited (no count needed — the row lock is already held).
    if (locked.capacity != null) {
      const claimed = await tx.volunteering.countActiveOccurrenceClaims(
        locked.id,
      );
      if (claimed >= locked.capacity) {
        throw fail("CONFLICT", {
          message: "occurrence_full",
          meta: { reason: "occurrence_full" },
        });
      }
    }

    const claim = existing
      ? await tx.volunteering.updateOccurrenceClaim(existing.id, {
          status: "CLAIMED",
          source: "SELF",
        })
      : await tx.volunteering.createOccurrenceClaim({
          occurrenceId: occurrence.id,
          signupId: signup.id,
          source: "SELF",
        });

    await tx.audit.log({
      entity: "volunteer_occurrence_claim",
      entityId: claim.id,
      action: existing ? "reclaimed" : "claimed",
      data: {
        occurrenceId: occurrence.id,
        askId: ask.id,
        roleId: occurrence.roleId,
        signupId: signup.id,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    return claim;
  });
}

// ── withdraw-occurrence-claim (self-serve) ──────────────────────────────────

/**
 * A volunteer withdraws their own claim (FR-003). Frictionless — no T-24h
 * cutoff (per the spec's open-question lean). Idempotent: withdrawing an
 * already WITHDRAWN claim returns it unchanged.
 */
export async function withdrawOccurrenceClaim(
  deps: Pick<OccurrenceClaimDeps, "repos" | "clock" | "logger">,
  rawInput: unknown,
): Promise<VolunteerOccurrenceClaimRecord> {
  const input = parseInput(withdrawOccurrenceClaimInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const claim = await tx.volunteering.getOccurrenceClaim(input.claimId);
    if (!claim) {
      throw fail("NOT_FOUND", {
        message: "claim_not_found",
        meta: { entity: "volunteer_occurrence_claim" },
      });
    }
    const signup = await tx.volunteering.getSignup(claim.signupId);
    if (!signup || signup.humanId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "claim" } });
    }

    if (claim.status === "WITHDRAWN") {
      return claim;
    }

    const updated = await tx.volunteering.updateOccurrenceClaim(claim.id, {
      status: "WITHDRAWN",
    });

    await tx.audit.log({
      entity: "volunteer_occurrence_claim",
      entityId: claim.id,
      action: "withdrawn",
      data: {
        occurrenceId: claim.occurrenceId,
        signupId: claim.signupId,
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return updated;
  });
}

// ── assign-claim (owner / coordinator) ──────────────────────────────────────

/**
 * Post-commit assignment email context, collected in-tx.
 */
type AssignmentEmail = {
  to: string;
  contactName: string | null;
  askTitle: string;
  roleName: string;
  occurrence: { startsAt: Date; endsAt: Date; notes: string | null };
  /** Null when appBaseUrl is unset — the email omits the link. */
  askUrl: string | null;
  claimId: string;
  /** Distinguishes a fresh assign from a re-assign for the mailer key. */
  assignedAtMs: number;
};

/**
 * Owner/coordinator assigns an accepted signup to an occurrence (FR-004).
 *
 * - Owners may assign any accepted signup on the ask; coordinators only
 *   signups inside their own group — exactly `requireCoordinatorOrOwner`
 *   (the same scope rule as pool-pull; pool/unassigned signups are
 *   owner-only through that gate).
 * - Shadow (no-account) volunteers are assignable — the confirmation goes
 *   to their `contactEmail`.
 * - Same tx-scoped FOR-UPDATE capacity check as self-claim.
 * - Idempotent: already-CLAIMED returns as-is (no duplicate email);
 *   a WITHDRAWN row flips back to CLAIMED with source ASSIGNED.
 * - A withheld owner's ask (ban that sticks) refuses every NEW assignment
 *   with `VOLUNTEER_APPROVALS_PAUSED` (the staff-facing code; the volunteer's
 *   own claim gets `SHIFT_SIGNUPS_PAUSED`) and sends no email; an existing
 *   CLAIMED row still returns as-is.
 * - Post-commit: email with a `generateSingleEventIcs` attachment.
 */
export async function assignOccurrenceClaim(
  deps: OccurrenceClaimDeps,
  rawInput: unknown,
): Promise<VolunteerOccurrenceClaimRecord> {
  const input = parseInput(assignOccurrenceClaimInputSchema, rawInput);

  const { claim, email } = await deps.repos.tx(async (tx) => {
    const { occurrence, ask } = await resolveOccurrenceContext(
      tx,
      input.occurrenceId,
    );

    // Signup must exist ON THIS ASK — foreign/missing signups collapse to
    // the same not-found before any authz-derived detail can leak.
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup || signup.askId !== ask.id) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // Trust gate: owner any signup, coordinator only their own group
    // (pool/unassigned → owner-only). Loaded fresh in this tx.
    const access = await requireCoordinatorOrOwner(
      tx,
      { ask, signupGroupId: signup.groupId },
      input.actorHumanId,
    );

    // Status checks AFTER authz — status never doubles as a probe.
    if (signup.roleId !== occurrence.roleId) {
      throw fail("CONFLICT", {
        message: "signup_role_mismatch",
        meta: { reason: "signup_role_mismatch" },
      });
    }
    if (!CLAIMABLE_SIGNUP_STATUSES.has(signup.status)) {
      throw fail("SIGNUP_NOT_APPROVED");
    }

    // Same always-lock gate as self-claim: every occurrence-state check
    // below runs against the row re-read UNDER the FOR UPDATE lock, so a
    // concurrent cancel / capacity edit can't be missed by the stale
    // pre-lock read above.
    const locked = await tx.volunteering.getOccurrenceForUpdate(occurrence.id);
    if (!locked) {
      throw fail("OCCURRENCE_NOT_FOUND");
    }
    if (locked.status !== "SCHEDULED") {
      throw fail("CONFLICT", {
        message: "occurrence_cancelled",
        meta: { reason: "occurrence_cancelled" },
      });
    }

    const existing = await tx.volunteering.getClaimByOccurrenceAndSignup(
      locked.id,
      signup.id,
    );
    if (existing?.status === "CLAIMED") {
      // Idempotent replay — no duplicate email.
      return { claim: existing, email: null };
    }

    // Ban that sticks (owner ruling 2026-10-08): a withheld owner's ask
    // takes no NEW assignment either, re-assigns included. Placed like the
    // self-serve claim's check: after authz and the status checks, so an
    // unauthorised caller never learns the ask is paused, and after the
    // replay above, so a claim already held still returns. The throw rolls
    // the tx back before `email` is built, so no confirmation or .ics goes.
    // The coordinator gets the staff code, whose copy says rejecting still
    // works, not the volunteer's "your shifts still stand" one.
    if (await isAskOwnerWithheld(tx, ask)) {
      throw fail("VOLUNTEER_APPROVALS_PAUSED");
    }

    if (locked.capacity != null) {
      const claimed = await tx.volunteering.countActiveOccurrenceClaims(
        locked.id,
      );
      if (claimed >= locked.capacity) {
        throw fail("CONFLICT", {
          message: "occurrence_full",
          meta: { reason: "occurrence_full" },
        });
      }
    }

    const now = deps.clock.now();
    const claim = existing
      ? await tx.volunteering.updateOccurrenceClaim(existing.id, {
          status: "CLAIMED",
          source: "ASSIGNED",
        })
      : await tx.volunteering.createOccurrenceClaim({
          occurrenceId: occurrence.id,
          signupId: signup.id,
          source: "ASSIGNED",
        });

    const role = await tx.volunteering.getEventRole(occurrence.roleId);

    await tx.audit.log({
      entity: "volunteer_occurrence_claim",
      entityId: claim.id,
      action: existing ? "reassigned" : "assigned",
      data: {
        occurrenceId: occurrence.id,
        askId: ask.id,
        roleId: occurrence.roleId,
        signupId: signup.id,
        actorHumanId: input.actorHumanId,
        via: access.via,
      },
      at: now,
    });

    const baseUrl = normalizeBaseUrl(deps.appBaseUrl);
    const email: AssignmentEmail = {
      to: signup.contactEmail,
      contactName: signup.contactName,
      askTitle: ask.title,
      roleName: role?.name ?? "Volunteer",
      // The LOCKED row's window — never the stale pre-lock read.
      occurrence: {
        startsAt: locked.startsAt,
        endsAt: locked.endsAt,
        notes: locked.notes,
      },
      askUrl: baseUrl ? `${baseUrl}/v/${ask.id}` : null,
      claimId: claim.id,
      assignedAtMs: claim.updatedAt.getTime(),
    };

    return { claim, email };
  });

  // Post-commit best-effort email with the .ics attachment. A mail failure
  // (or an unconfigured mailer) must never roll back or fail the persisted
  // assignment — logged AND reported (CLAUDE.md swallow convention).
  //
  // At-most-once, not exactly-once: unlike the cancel fan-out (whose replay
  // path deliberately re-runs its sends under stable keys, healing a crash
  // mid-fan-out), an idempotent assign replay returns before this block —
  // so a crash between commit and this send loses THIS email until a
  // withdraw/re-assign transition mints a new one. Accepted: lower stakes
  // than a cancellation (the roster still shows the assignment), and the
  // transition-scoped idempotency key exists precisely so genuine
  // re-assignments email again.
  if (email) {
    try {
      if (!deps.mailer) {
        throw new Error("mailer_not_configured");
      }
      const icalEvent: ICalEvent = {
        uid: `volunteer-occurrence-claim-${email.claimId}@${VOLUNTEER_ICS_UID_DOMAIN}`,
        title: `${email.askTitle} — ${email.roleName}`,
        startsAt: email.occurrence.startsAt,
        endsAt: email.occurrence.endsAt,
        description: `Volunteer role: ${email.roleName}`,
        url: email.askUrl,
      };
      const greetingName = email.contactName?.trim() || "there";
      const textLines = [
        `Hi ${greetingName},`,
        `You've been scheduled for a ${email.roleName} shift for ${email.askTitle}.`,
        `Starts: ${email.occurrence.startsAt.toISOString()}`,
        `Ends: ${email.occurrence.endsAt.toISOString()}`,
        ...(email.occurrence.notes ? [`Notes: ${email.occurrence.notes}`] : []),
        // Base URL unset (mis-wired root): send without the link rather
        // than a broken one.
        ...(email.askUrl ? [`Details: ${email.askUrl}`] : []),
      ];
      await deps.mailer.send({
        to: { to: email.to, name: email.contactName ?? undefined },
        subject: `You're scheduled: ${email.roleName} for ${email.askTitle}`,
        text: textLines.join("\n\n"),
        attachments: [
          {
            filename: "volunteer-shift.ics",
            mime: "text/calendar",
            bytesBase64: Buffer.from(
              generateSingleEventIcs(icalEvent),
              "utf8",
            ).toString("base64"),
          },
        ],
        // Keyed per assignment TRANSITION (fresh assign vs. later
        // re-assign), so a genuine re-assignment emails again while the
        // idempotent-replay path above never reaches this send at all.
        idempotencyKey: `volunteer-occ-assign:${email.claimId}:${email.assignedAtMs}`,
        tags: ["volunteer", "occurrence", "assigned"],
      });
    } catch (error) {
      deps.logger?.error("volunteering.assignOccurrenceClaim.email_failed", {
        claimId: email.claimId,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "assignOccurrenceClaim", stage: "email" },
          extra: { claimId: email.claimId },
        });
      } catch {
        // Best-effort reporting only.
      }
    }
  }

  return claim;
}

// ── check-in-claim (owner / coordinator) ────────────────────────────────────

/**
 * Check a claim in, stamping duration-derived (overridable) hours (FR-005).
 * Idempotent: an already-checked-in claim returns as-is (an hours
 * correction is a re-check-in concern deferred with the reporting surface).
 *
 * FOLLOW-UP (FR-005, deliberately deferred from phase A): the "ask hours
 * report includes claim hours without double counting" acceptance criterion
 * is NOT met yet — `listSignupsForHoursReport` / `aggregateHoursByVolunteer`
 * are EVENT-scoped (`JOIN "Event"`) and no ask-scoped hours report exists to
 * extend. `claim.hoursWorked` is recorded here (claim-only, never copied
 * onto the signup) so the read-side aggregation can land with the reporting
 * surface, migration-free. When wiring it, keep the existing hours
 * semantics: override wins, 2dp rounding PER ROW before SUM (so totals
 * reconcile with per-row exports), and claim hours are ADDITIVE to
 * signup-level hours — never a second count of the same worked time.
 */
export async function checkInOccurrenceClaim(
  deps: Pick<OccurrenceClaimDeps, "repos" | "clock" | "logger">,
  rawInput: unknown,
): Promise<VolunteerOccurrenceClaimRecord> {
  const input = parseInput(checkInOccurrenceClaimInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const claim = await tx.volunteering.getOccurrenceClaim(input.claimId);
    if (!claim) {
      throw fail("NOT_FOUND", {
        message: "claim_not_found",
        meta: { entity: "volunteer_occurrence_claim" },
      });
    }
    const { occurrence, ask } = await resolveOccurrenceContext(
      tx,
      claim.occurrenceId,
    );
    const signup = await tx.volunteering.getSignup(claim.signupId);
    if (!signup) {
      throw fail("NOT_FOUND", {
        message: "claim_not_found",
        meta: { entity: "volunteer_occurrence_claim" },
      });
    }

    const access = await requireCoordinatorOrOwner(
      tx,
      { ask, signupGroupId: signup.groupId },
      input.actorHumanId,
    );

    if (claim.status !== "CLAIMED") {
      throw fail("CONFLICT", {
        message: "claim_not_active",
        meta: { reason: "claim_not_active" },
      });
    }

    // Idempotent: already checked in.
    if (claim.checkedInAt) {
      return claim;
    }

    const now = deps.clock.now();
    const hours = input.hoursOverride ?? occurrenceDurationHours(occurrence);
    // Decimal(5,2) bound. New windows are capped at 24h (schema + update
    // merged-window check), so this can only trip on a hand-crafted legacy
    // row — fail typed rather than let Postgres throw a numeric overflow.
    if (hours > MAX_CLAIM_HOURS) {
      throw fail("CONFLICT", {
        message: "hours_out_of_range",
        meta: { reason: "hours_out_of_range", hours },
      });
    }

    const updated = await tx.volunteering.updateOccurrenceClaim(claim.id, {
      checkedInAt: now,
      hoursWorked: hours,
    });

    await tx.audit.log({
      entity: "volunteer_occurrence_claim",
      entityId: claim.id,
      action: "checked_in",
      data: {
        occurrenceId: occurrence.id,
        askId: ask.id,
        signupId: claim.signupId,
        actorHumanId: input.actorHumanId,
        via: access.via,
        hoursWorked: hours,
        ...(input.hoursOverride != null ? { hoursOverridden: true } : {}),
      },
      at: now,
    });

    return updated;
  });
}

// ── occurrence roster (owner / coordinator) ─────────────────────────────────

export type OccurrenceRoster = {
  occurrence: VolunteerShiftOccurrenceRecord;
  /** Owner: every claim. Coordinator: ONLY their group's members (NFR-003). */
  claims: VolunteerOccurrenceClaimRosterRow[];
};

/**
 * Per-occurrence roster (FR-005). Owner sees every claim; a coordinator
 * sees only claims whose signup sits in a group they coordinate — the same
 * group-scope PII rule as the ask rosters. An actor with neither capacity
 * gets the uniform ownership denial (never an empty 200 probe).
 */
export async function listOccurrenceRoster(
  deps: Pick<OccurrenceClaimDeps, "repos" | "clock" | "logger">,
  rawInput: unknown,
): Promise<OccurrenceRoster> {
  const input = parseInput(listOccurrenceRosterInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const { occurrence, ask } = await resolveOccurrenceContext(
      tx,
      input.occurrenceId,
    );

    let coordinatedGroupIds: Set<string> | null = null; // null = owner
    try {
      await resolveAskOwnership(tx, ask, input.actorHumanId);
    } catch (error) {
      if (!(isAppError(error) && OWNERSHIP_DENIAL_CODES.has(error.code))) {
        throw error;
      }
      const groups = await tx.volunteering.listGroupsByAsk(ask.id);
      const own = groups.filter(
        (g) => g.coordinatorHumanId === input.actorHumanId,
      );
      if (own.length === 0) {
        // Plain stranger: rethrow the ORIGINAL denial (uniform forbidden).
        throw error;
      }
      await ensureCoordinatorEmailVerified(tx, input.actorHumanId);
      coordinatedGroupIds = new Set(own.map((g) => g.id));
    }

    const rows = await tx.volunteering.listClaimsByOccurrence(occurrence.id);
    const claims =
      coordinatedGroupIds === null
        ? rows
        : rows.filter(
            (row) =>
              row.groupId !== null && coordinatedGroupIds.has(row.groupId),
          );

    return { occurrence, claims };
  });
}

// ── public schedule ─────────────────────────────────────────────────────────

/** One public schedule row — open-slot math only, no claimant identity. */
export type PublicAskScheduleOccurrence = {
  id: string;
  roleId: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number | null;
  /** Active claims — the occupancy the open-slot count derives from. */
  claimedCount: number;
  /** `capacity - claimedCount` clamped ≥ 0; null when uncapped. */
  openCount: number | null;
};

export type GetPublicAskScheduleOutput = {
  occurrences: PublicAskScheduleOccurrence[];
};

/**
 * Bounds on the public schedule read — cheap insurance for an
 * unauthenticated endpoint: a 90-day horizon covers phase B's 8-week
 * materializer window with slack, and the row cap keeps a pathological ask
 * from turning the public page into a table scan/dump.
 */
const PUBLIC_SCHEDULE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const PUBLIC_SCHEDULE_MAX_ROWS = 200;

/**
 * Public, unauthenticated upcoming-schedule read for `/v/[askId]`
 * (NFR-003). Same visibility gate as `getPublicVolunteerAsk` (DRAFT /
 * ARCHIVED / missing collapse to `not_found`; PAUSED / CLOSED stay
 * readable), and EVENT-subject asks 404 — they have no occurrences by
 * construction. Only SCHEDULED occurrences inside the next 90 days (max
 * 200 rows) are returned, and nothing about claimants beyond the count
 * leaks.
 */
export async function getPublicAskSchedule(
  deps: Pick<OccurrenceClaimDeps, "repos" | "clock" | "logger">,
  rawInput: unknown,
): Promise<GetPublicAskScheduleOutput> {
  const input = parseInput(getPublicAskScheduleInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (
      !ask ||
      ask.subjectType === "EVENT" ||
      ask.status === "DRAFT" ||
      ask.status === "ARCHIVED" ||
      // Ban that sticks: a withheld owner's ask reads as missing.
      (await isAskOwnerWithheld(tx, ask))
    ) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    const now = deps.clock.now();
    const rows = await tx.volunteering.listOccurrencesByAsk(ask.id, {
      status: "SCHEDULED",
      from: now,
      to: new Date(now.getTime() + PUBLIC_SCHEDULE_HORIZON_MS),
      limit: PUBLIC_SCHEDULE_MAX_ROWS,
    });

    return {
      occurrences: rows.map((row) => ({
        id: row.id,
        roleId: row.roleId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        capacity: row.capacity,
        claimedCount: row.claimedCount,
        openCount:
          row.capacity == null
            ? null
            : Math.max(0, row.capacity - row.claimedCount),
      })),
    };
  });
}
