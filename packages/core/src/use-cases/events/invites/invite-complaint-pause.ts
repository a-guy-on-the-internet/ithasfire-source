import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventInvitePauseOwner,
  EventInvitePauseReason,
  EventInvitePauseRecord,
} from "@th/ports/repos/event-invite-pauses";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";
import { plainTextMultilineOptional } from "../../../lib/sanitize-plain-text";
import {
  hashInviteOptOutEmail,
  MIN_INVITE_OPT_OUT_SECRET_LENGTH,
} from "../../../lib/security/invite-optout-token";
import { ensureActorCanEditEvent } from "../_shared/ensure-actor-can-edit-event";
import { inviteOptOutOwner, reportSwallowed } from "./_shared";
import {
  notifyInvitePauseDecided,
  notifyInvitePauseOpened,
} from "./invite-pause-notifications";
import {
  INVITE_EVENT_METADATA_KEY,
  INVITE_OWNER_METADATA_KEY,
  parseInviteEventTag,
  parseInviteSentAtTag,
  INVITE_SENT_AT_METADATA_KEY,
  parseInviteOwnerTag,
} from "./invite-owner-tag";

/**
 * Invite complaint auto-pause (W4, owner ruling 2026-10-06):
 *
 * > complaint circuit breaker: auto-pause an organiser's invites after
 * > complaints (start: 3 complaints, or >1% of recent sends), staff review
 * > to lift, organiser told why + how to ask for review.
 *
 * Design decisions (session plan `session_invite_complaint_auto_pause`):
 *  - D1 Attribution: every personal invite email carries metadata
 *    `inviteOwner` (`org-<id>` / `human-<id>`) and `inviteEvent`. A complaint
 *    without it is not an invite: ignored. With it but malformed, or naming
 *    an organiser that no longer exists: reported (ReporterPort), not thrown.
 *  - D2 Counts are of RECIPIENTS: complaints = distinct complaining addresses
 *    (keyed hash); the denominator = the organiser's PERSONAL invites whose
 *    last send falls in the window. A resend neither dilutes the rate nor
 *    adds a complaint.
 *  - D3 Window: {@link INVITE_COMPLAINT_WINDOW_DAYS} days, starting no
 *    earlier than the organiser's last LIFT (a lift wipes the slate).
 *  - D4 Trip: complaints >= {@link INVITE_COMPLAINT_COUNT_TRIP}, OR
 *    complaints / recipients > 1% (so one complaint among fewer than 100
 *    invites pauses; zero invites with a complaint trips by rate).
 *  - D5 Scope: the event OWNER. Every personal invite email (create and
 *    resend) is refused with INVITES_PAUSED; the shared link (no email) is
 *    untouched.
 *  - D6 A complaint also opts that address out of that organiser's invites.
 *  - D7 The organiser can ask for a review (one open request, optional
 *    note); staff LIFT or KEEP with a note; after a KEEP they may ask again.
 *  - D8 Trip evaluation runs under a per-owner advisory lock; one open pause
 *    per owner (partial unique index).
 */

export const INVITE_COMPLAINT_WINDOW_DAYS = 30;
/** Distinct complaining recipients that pause on their own. */
export const INVITE_COMPLAINT_COUNT_TRIP = 3;
/** Complaints must be MORE than this percent of recent recipients. */
export const INVITE_COMPLAINT_RATE_TRIP_PERCENT = 1;

const DAY_MS = 86_400_000;
const REVIEW_NOTE_MAX = 1000;
const DECISION_NOTE_MAX = 2000;

/**
 * The trip rule (D4), integer-only: rate > 1% ⇔ complaints × 100 > recipients.
 * COMPLAINT_COUNT wins when both hold (it is the plainer reason to show).
 */
export function evaluateInviteComplaintTrip(input: {
  complaints: number;
  recipients: number;
}): EventInvitePauseReason | null {
  const { complaints, recipients } = input;
  if (complaints <= 0) return null;
  if (complaints >= INVITE_COMPLAINT_COUNT_TRIP) return "COMPLAINT_COUNT";
  if (complaints * 100 > recipients * INVITE_COMPLAINT_RATE_TRIP_PERCENT) {
    return "COMPLAINT_RATE";
  }
  return null;
}

/** Start of the complaint window: 30 days back, or the last lift if later. */
export function inviteComplaintWindowStart(
  now: Date,
  lastLiftedAt: Date | null,
): Date {
  const floor = new Date(now.getTime() - INVITE_COMPLAINT_WINDOW_DAYS * DAY_MS);
  return lastLiftedAt && lastLiftedAt > floor ? lastLiftedAt : floor;
}

function ownerAuditEntity(owner: EventInvitePauseOwner): {
  entity: string;
  entityId: string;
} {
  return owner.kind === "ORG"
    ? { entity: "organization", entityId: owner.orgId }
    : { entity: "human", entityId: owner.humanId };
}

function ownerLogFields(owner: EventInvitePauseOwner): Record<string, string> {
  return owner.kind === "ORG"
    ? { ownerKind: "ORG", orgId: owner.orgId }
    : { ownerKind: "HUMAN", humanOwnerId: owner.humanId };
}

// ─── Record a complaint (webhook) ────────────────────────────────────────

export type RecordInviteComplaintDeps = {
  repos: Pick<Repos, "tx" | "organizations" | "humans" | "events"> &
    // The in-app pause notice (invite-pause-notifications.ts). Optional so a
    // caller without them still records; the notice is then reported missing.
    Partial<Pick<Repos, "notifications" | "entityPages" | "eventInvitePauses">>;
  clock: ClockPort;
  /** Keys the address hash (same as the opt-out list). */
  inviteOptOutSecret?: string | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type RecordInviteComplaintInput = {
  /** The provider's event id; unique per complaint (replays are no-ops). */
  providerEventId: string;
  /** The complaining recipient. Hashed here; never stored or logged. */
  email: string;
  occurredAt: Date;
  /** The mail's metadata echoed back (`inviteOwner`, `inviteEvent`). */
  metadata: Record<string, string> | null;
};

export type RecordInviteComplaintResult =
  /** No invite metadata: some other email. */
  | { outcome: "NOT_AN_INVITE" }
  /** Invite metadata present but unusable (reported). */
  | { outcome: "UNATTRIBUTABLE" }
  /**
   * A failure a retry can't fix (missing secret, a constraint/validation
   * error); reported, nothing written. Transient failures THROW instead.
   */
  | { outcome: "FAILED" }
  | {
      outcome: "RECORDED";
      /** False on a webhook replay. */
      created: boolean;
      /** Set when THIS complaint opened a pause. */
      paused: EventInvitePauseReason | null;
      /** True when the organiser was already paused. */
      alreadyPaused: boolean;
    };

const USE_CASE_RECORD = "recordInviteComplaint";

/**
 * A recipient marked an email as spam. When it was a personal invite, record
 * it against the organiser, opt the address out of that organiser (D6) and
 * pause the organiser's invites if the trip rule now holds.
 *
 * Failure posture (runs inside the provider webhook):
 *  - problems a retry can't fix (no tag, malformed tag, owner gone, missing
 *    secret, a Prisma constraint/validation error) are logged at error,
 *    reported (guarded) and answered with a result, so the webhook ACKs;
 *  - anything else (DB down, timeouts) THROWS: the route answers 500 and
 *    Svix retries on its backoff schedule (then gives up), so a transient
 *    outage doesn't lose the complaint.
 * Safe on retries and replays: the complaint insert is unique on
 * `providerEventId`, the opt-out is idempotent, and an already-open pause is
 * left alone.
 *
 * The complaint counts by the SEND it is about (`inviteSentAt` tag; the
 * complaint's own time when untagged), so a late complaint about mail sent
 * before a staff LIFT can't re-pause the organiser.
 */
export async function recordInviteComplaint(
  deps: RecordInviteComplaintDeps,
  input: RecordInviteComplaintInput,
): Promise<RecordInviteComplaintResult> {
  const ownerTag = input.metadata?.[INVITE_OWNER_METADATA_KEY];
  if (!ownerTag) {
    deps.logger?.info("invite_complaint_ignored", {
      providerEventId: input.providerEventId,
      reason: "not_an_invite",
    });
    return { outcome: "NOT_AN_INVITE" };
  }

  const swallow = (
    reason: string,
    error: unknown,
    extra: Record<string, unknown> = {},
  ) => {
    // Report FIRST, then log in a guard: Sentry hears even when the logger
    // is what broke, and a throwing logger never turns a handled outcome
    // into a throw (which the webhook would answer with a retry).
    reportSwallowed(deps.reportError, error, {
      tags: { useCase: USE_CASE_RECORD, channel: reason },
      extra: { providerEventId: input.providerEventId, ...extra },
    });
    try {
      deps.logger?.error(`events.${USE_CASE_RECORD}.${reason}`, {
        providerEventId: input.providerEventId,
        ...extra,
        err: error,
        error: describeError(error),
      });
    } catch {
      // Logging is best-effort.
    }
  };

  const owner = parseInviteOwnerTag(ownerTag);
  if (!owner) {
    // Never echo the raw tag value into Sentry beyond its length: it is
    // provider-supplied text.
    swallow("malformed_owner_tag", new Error("invite_complaint_malformed_owner_tag"), {
      tagLength: ownerTag.length,
    });
    return { outcome: "UNATTRIBUTABLE" };
  }
  const logOwner = ownerLogFields(owner);

  const secret = deps.inviteOptOutSecret;
  // A short secret would make hashing throw: same answer as a missing one.
  if (!secret || secret.length < MIN_INVITE_OPT_OUT_SECRET_LENGTH) {
    swallow("not_configured", new Error("invite_complaint_secret_missing"), logOwner);
    return { outcome: "FAILED" };
  }

  try {
    const ownerExists =
      owner.kind === "ORG"
        ? (await deps.repos.organizations.getById(owner.orgId)) !== null
        : (await deps.repos.humans.getById(owner.humanId)) !== null;
    if (!ownerExists) {
      swallow("owner_gone", new Error("invite_complaint_owner_gone"), logOwner);
      return { outcome: "UNATTRIBUTABLE" };
    }

    const eventId = await resolveComplaintEventId(
      deps.repos,
      owner,
      parseInviteEventTag(input.metadata?.[INVITE_EVENT_METADATA_KEY]),
    );
    const emailHash = hashInviteOptOutEmail(input.email, secret);
    const now = deps.clock.now();

    const outcome = await deps.repos.tx(async (tx) => {
      await tx.eventInvitePauses.lockOwner(owner);
      const { created } = await tx.eventInvitePauses.recordComplaint({
        providerEventId: input.providerEventId,
        owner,
        eventId,
        emailHash,
        sentAt: parseInviteSentAtTag(
          input.metadata?.[INVITE_SENT_AT_METADATA_KEY],
          now,
        ),
        occurredAt: input.occurredAt,
      });
      // D6: they marked it spam, so they said no. Idempotent.
      await tx.eventInviteOptOuts.add({ owner, emailHash });

      const open = await tx.eventInvitePauses.getOpenPause(owner);
      if (open) {
        return { created, paused: null, alreadyPaused: true, opened: null };
      }
      const opened = await evaluateAndPause(tx, owner, now);
      return {
        created,
        paused: opened?.reason ?? null,
        alreadyPaused: false,
        opened,
      };
    });

    // After the commit, and only when THIS complaint opened the pause (a
    // replay finds it already open). Never throws: a failed notice is
    // reported and the pause stands.
    // Accepted gap (coordinator ruling 2026-10-07, no outbox): a crash
    // between the commit above and this call loses the notice, and the
    // replay won't resend it. The organiser still learns: the Invited
    // guests panel shows the pause, and every invite email is refused with
    // INVITES_PAUSED.
    if (outcome.opened) {
      await notifyInvitePauseOpened(deps, {
        pauseId: outcome.opened.pauseId,
        owner,
        eventId,
        reason: outcome.opened.reason,
        complaintCount: outcome.opened.complaintCount,
        recipientCount: outcome.opened.recipientCount,
        windowDays: INVITE_COMPLAINT_WINDOW_DAYS,
      });
    }
    // Committed: a throwing logger must not reach the catch below, which
    // would rethrow and make the provider retry an already-recorded event.
    try {
      deps.logger?.info("invite_complaint_recorded", {
        providerEventId: input.providerEventId,
        eventId,
        ...logOwner,
        created: outcome.created,
        paused: outcome.paused,
        alreadyPaused: outcome.alreadyPaused,
      });
    } catch {
      // Logging is best-effort.
    }
    return {
      outcome: "RECORDED",
      created: outcome.created,
      paused: outcome.paused,
      alreadyPaused: outcome.alreadyPaused,
    };
  } catch (error) {
    if (!isUnretryableStoreError(error)) {
      // Transient: let the webhook 500 so the provider retries. Info only:
      // the route logs at error and Sentry captures the throw, so an error
      // here would capture the same failure twice more.
      deps.logger?.info(`events.${USE_CASE_RECORD}.record_failed_retryable`, {
        providerEventId: input.providerEventId,
        ...logOwner,
        err: error,
        error: describeError(error),
      });
      throw error;
    }
    swallow("record_failed", error, logOwner);
    return { outcome: "FAILED" };
  }
}

/**
 * Prisma errors a retry can't fix: value/constraint/validation failures
 * (P2000-P2004, P2011, P2012) and Postgres CHECK violations (23514), however
 * the driver adapter nests them. Everything else is treated as transient.
 */
const UNRETRYABLE_PRISMA_CODES = new Set([
  "P2000",
  "P2001",
  "P2002",
  // NOT P2003: an FK miss (the tagged event or the owner deleted between the
  // lookup and the insert) resolves on retry (event → null, or owner_gone).
  "P2004",
  "P2011",
  "P2012",
]);

export function isUnretryableStoreError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNRETRYABLE_PRISMA_CODES.has(code)) {
    return true;
  }
  if ((error as { name?: unknown }).name === "PrismaClientValidationError") {
    return true;
  }
  let text = "";
  try {
    text = `${(error as { message?: unknown }).message ?? ""} ${JSON.stringify(
      (error as { meta?: unknown }).meta ?? null,
    )}`;
  } catch {
    // Unserialisable meta: judge by the message alone.
    text = String((error as { message?: unknown }).message ?? "");
  }
  return /\b23514\b|CheckConstraintViolation|violates check constraint/i.test(text);
}

/** The tagged event, only when it still exists AND belongs to the owner. */
async function resolveComplaintEventId(
  repos: Pick<Repos, "events">,
  owner: EventInvitePauseOwner,
  eventId: string | null,
): Promise<string | null> {
  if (!eventId) return null;
  const event = await repos.events.getById(eventId);
  if (!event) return null;
  const eventOwner = inviteOptOutOwner(event);
  const same =
    eventOwner !== null &&
    (eventOwner.kind === "ORG"
      ? owner.kind === "ORG" && owner.orgId === eventOwner.orgId
      : owner.kind === "HUMAN" && owner.humanId === eventOwner.humanId);
  return same ? event.id : null;
}

type OpenedPause = {
  pauseId: string;
  reason: EventInvitePauseReason;
  complaintCount: number;
  recipientCount: number;
};

/**
 * Count, decide, and open the pause when the rule holds. Caller holds the
 * owner lock and has checked there is no open pause.
 */
async function evaluateAndPause(
  tx: TxRepos,
  owner: EventInvitePauseOwner,
  now: Date,
): Promise<OpenedPause | null> {
  const since = inviteComplaintWindowStart(
    now,
    await tx.eventInvitePauses.getLastLiftedAt(owner),
  );
  const complaints = await tx.eventInvitePauses.countDistinctComplainants({
    owner,
    since,
  });
  if (complaints === 0) return null;
  const recipients = await tx.eventInvitePauses.countInviteRecipients({
    owner,
    since,
  });
  const reason = evaluateInviteComplaintTrip({ complaints, recipients });
  if (!reason) return null;

  const pause = await tx.eventInvitePauses.openPause({
    owner,
    reason,
    complaintCount: complaints,
    recipientCount: recipients,
    pausedAt: now,
  });
  await tx.audit.log({
    ...ownerAuditEntity(owner),
    action: "event_invites_paused",
    data: {
      pauseId: pause.id,
      reason,
      complaintCount: complaints,
      recipientCount: recipients,
      windowStart: since.toISOString(),
    },
    at: now,
  });
  return {
    pauseId: pause.id,
    reason,
    complaintCount: complaints,
    recipientCount: recipients,
  };
}

// ─── Send-time check ─────────────────────────────────────────────────────

export type AssertInvitesNotPausedDeps = {
  repos: Pick<Repos, "eventInvitePauses">;
  logger?: LoggerPort;
};

/**
 * Refuse a personal invite email while the event owner is paused:
 * `INVITES_PAUSED` with `meta: { reason, pausedAt, reviewRequestedAt }`
 * (ISO strings). Called before any allowance charge or write.
 *
 * Fails CLOSED like the allowance: a lookup failure is `SERVICE_UNAVAILABLE`
 * (thrown, so the transport backstop captures it), never "send".
 */
export async function assertInvitesNotPaused(
  deps: AssertInvitesNotPausedDeps,
  event: Pick<EventRecord, "id" | "orgId" | "humanId">,
  useCase: string,
): Promise<void> {
  const owner = inviteOptOutOwner(event);
  if (!owner) return;
  let open: EventInvitePauseRecord | null;
  try {
    open = await deps.repos.eventInvitePauses.getOpenPause(owner);
  } catch (error) {
    deps.logger?.error(`events.${useCase}.invite_pause_lookup_failed`, {
      eventId: event.id,
      err: error,
      error: describeError(error),
    });
    throw fail("SERVICE_UNAVAILABLE", {
      message: "Invite sending is briefly unavailable. Try again shortly.",
      meta: { retryable: true },
    });
  }
  if (!open) return;
  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    action: "invites_paused",
    result: "denied",
    metadata: { pauseId: open.id, reason: open.reason },
  });
  throw fail("INVITES_PAUSED", {
    meta: {
      reason: open.reason,
      pausedAt: open.pausedAt.toISOString(),
      reviewRequestedAt: open.reviewRequestedAt?.toISOString() ?? null,
    },
  });
}

// ─── Organiser: status + review request ──────────────────────────────────

const decisionSchema = z.enum(["LIFTED", "KEPT"]);

export const invitePauseStatusOutputSchema = z
  .object({
    paused: z.boolean(),
    /** The open pause, or null. Never which addresses complained. */
    pause: z
      .object({
        reason: z.enum(["COMPLAINT_COUNT", "COMPLAINT_RATE"]),
        pausedAt: z.date(),
        /** Distinct recipients who complained in the window, at the trip. */
        complaintCount: z.number().int().nonnegative(),
        /** Personal invites sent in the window, at the trip. */
        recipientCount: z.number().int().nonnegative(),
        windowDays: z.number().int().positive(),
        reviewRequestedAt: z.date().nullable(),
        reviewRequestNote: z.string().nullable(),
        /** True when no review request is waiting. */
        canRequestReview: z.boolean(),
      })
      .strict()
      .nullable(),
    /**
     * Staff's latest answer: a KEEP on the open pause, or the LIFT of the
     * last one. Null when there is none.
     */
    lastDecision: z
      .object({
        decision: decisionSchema,
        decidedAt: z.date(),
        note: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type InvitePauseStatus = z.infer<typeof invitePauseStatusOutputSchema>;

export const getInvitePauseStatusInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export type InvitePauseOrganiserDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The organiser's view of their pause, from one of their events. Same bar as
 * sending invites (event edit rights): anyone who can send can see why they
 * can't.
 */
export async function getInvitePauseStatus(
  deps: Pick<InvitePauseOrganiserDeps, "repos">,
  rawInput: unknown,
): Promise<InvitePauseStatus> {
  const input = parseInput(getInvitePauseStatusInputSchema, rawInput);
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  return statusForOwner(deps.repos, inviteOptOutOwner(event));
}

async function statusForOwner(
  repos: Pick<Repos, "eventInvitePauses">,
  owner: EventInvitePauseOwner | null,
): Promise<InvitePauseStatus> {
  if (!owner) {
    return { paused: false, pause: null, lastDecision: null };
  }
  const open = await repos.eventInvitePauses.getOpenPause(owner);
  const latest = open ?? (await repos.eventInvitePauses.getLatestPause(owner));
  const lastDecision =
    latest?.decision && latest.decidedAt
      ? {
          decision: latest.decision,
          decidedAt: latest.decidedAt,
          note: latest.decisionNote,
        }
      : null;
  return invitePauseStatusOutputSchema.parse({
    paused: open !== null,
    pause: open
      ? {
          reason: open.reason,
          pausedAt: open.pausedAt,
          complaintCount: open.complaintCount,
          recipientCount: open.recipientCount,
          windowDays: INVITE_COMPLAINT_WINDOW_DAYS,
          reviewRequestedAt: open.reviewRequestedAt,
          reviewRequestNote: open.reviewRequestNote,
          canRequestReview: open.reviewRequestedAt === null,
        }
      : null,
    lastDecision,
  });
}

export const requestInvitePauseReviewInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    /** Optional note to staff; sanitized, <= 1000 chars. */
    note: plainTextMultilineOptional(REVIEW_NOTE_MAX).nullable().optional(),
  })
  .strict();

/**
 * "Ask for a review" (D7). One waiting request per pause: a second ask while
 * one waits is CONFLICT; not paused is INVALID_STATUS. Returns the new
 * status.
 */
export async function requestInvitePauseReview(
  deps: InvitePauseOrganiserDeps,
  rawInput: unknown,
): Promise<InvitePauseStatus> {
  const input = parseInput(requestInvitePauseReviewInputSchema, rawInput);
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  const owner = inviteOptOutOwner(event);
  if (!owner) {
    throw fail("INVALID_STATUS", { message: "invites_not_paused" });
  }
  const note = input.note?.trim() ? input.note.trim() : null;
  const now = deps.clock.now();

  await deps.repos.tx(async (tx) => {
    // Serialised with staff decisions (see decideInvitePause).
    await tx.eventInvitePauses.lockOwner(owner);
    const open = await tx.eventInvitePauses.getOpenPause(owner);
    if (!open) {
      throw fail("INVALID_STATUS", { message: "invites_not_paused" });
    }
    if (open.reviewRequestedAt) {
      throw fail("CONFLICT", { message: "invite_pause_review_already_requested" });
    }
    const updated = await tx.eventInvitePauses.requestReview({
      id: open.id,
      note,
      at: now,
    });
    if (!updated) {
      // Lifted, or another editor asked, between the read and the update.
      throw fail("CONFLICT", { message: "invite_pause_review_already_requested" });
    }
    await tx.audit.log({
      ...ownerAuditEntity(owner),
      action: "event_invite_pause_review_requested",
      data: {
        pauseId: open.id,
        actorHumanId: input.actorHumanId,
        eventId: event.id,
        hasNote: note !== null,
      },
      at: now,
    });
  });

  deps.logger?.info("invite_pause_review_requested", {
    eventId: event.id,
    ...ownerLogFields(owner),
  });
  return statusForOwner(deps.repos, owner);
}

// ─── Staff: queue + decision ─────────────────────────────────────────────

/** Who may see the queue (support answers organisers' questions too). */
export const INVITE_PAUSE_VIEW_ROLES = ["ADMIN", "REVIEWER", "SUPPORT"] as const;
/** Who may lift or keep a pause (trust state, like place verification). */
export const INVITE_PAUSE_DECIDE_ROLES = ["ADMIN", "REVIEWER"] as const;

export type InvitePauseStaffDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports a failed in-app decision notice (the decision stands). */
  reportError?: ReporterPort;
};

export const invitePauseStaffItemSchema = z
  .object({
    id: z.string(),
    ownerKind: z.enum(["ORG", "HUMAN"]),
    ownerId: z.string(),
    ownerName: z.string().nullable(),
    /**
     * The organiser's PUBLIC-PAGE slug. ORG: their ORGANIZATION
     * `EntityPage.slug` (what `/orgs/[slug]` resolves; never
     * `Organization.slug`, the `/admin/[slug]` key); the staff queue links
     * it. HUMAN: their HUMAN `EntityPage.slug` (never `@username`); the
     * queue links people to `/platform/humans?q=<name>` instead, since
     * `/humans/[slug]` 404s while public profiles are off. Null when there
     * is none, or when the lookup failed (reported).
     */
    ownerSlug: z.string().nullable(),
    reason: z.enum(["COMPLAINT_COUNT", "COMPLAINT_RATE"]),
    complaintCount: z.number().int().nonnegative(),
    recipientCount: z.number().int().nonnegative(),
    pausedAt: z.date(),
    reviewRequestedAt: z.date().nullable(),
    reviewRequestNote: z.string().nullable(),
    decision: decisionSchema.nullable(),
    decidedAt: z.date().nullable(),
    decidedByHumanId: z.string().nullable(),
    decisionNote: z.string().nullable(),
    liftedAt: z.date().nullable(),
  })
  .strict();

export type InvitePauseStaffItem = z.infer<typeof invitePauseStaffItemSchema>;

function ownerIdOf(owner: EventInvitePauseOwner): string {
  return owner.kind === "ORG" ? owner.orgId : owner.humanId;
}

function ownerKeyOf(owner: EventInvitePauseOwner): string {
  return `${owner.kind}:${ownerIdOf(owner)}`;
}

function toStaffItem(
  record: EventInvitePauseRecord,
  ownerName: string | null,
  ownerSlug: string | null,
): InvitePauseStaffItem {
  return {
    id: record.id,
    ownerKind: record.owner.kind,
    ownerId: ownerIdOf(record.owner),
    ownerName,
    ownerSlug,
    reason: record.reason,
    complaintCount: record.complaintCount,
    recipientCount: record.recipientCount,
    pausedAt: record.pausedAt,
    reviewRequestedAt: record.reviewRequestedAt,
    reviewRequestNote: record.reviewRequestNote,
    decision: record.decision,
    decidedAt: record.decidedAt,
    decidedByHumanId: record.decidedByHumanId,
    decisionNote: record.decisionNote,
    liftedAt: record.liftedAt,
  };
}

export const listInvitePausesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    status: z.enum(["AWAITING_REVIEW", "OPEN", "LIFTED"]).default("AWAITING_REVIEW"),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const listInvitePausesOutputSchema = z
  .object({ items: z.array(invitePauseStaffItemSchema) })
  .strict();

export type ListInvitePausesOutput = z.infer<typeof listInvitePausesOutputSchema>;

/**
 * Public-page slugs for a page of owners, batched: one
 * `entityPages.getByOwners("ORGANIZATION", …)` and one
 * `entityPages.getByOwners("HUMAN", …)` per call, never per row. ORG uses the
 * org's `EntityPage.slug` (what `/orgs/[slug]` resolves), NOT
 * `Organization.slug` (the `/admin/[slug]` key, built differently).
 * Keyed by `ORG:<id>` / `HUMAN:<id>`; an owner without a slug is absent.
 *
 * BEST-EFFORT: a failure degrades every slug to null (the queue renders the
 * organiser unlinked) and is logged and reported, guarded.
 */
async function resolveOwnerSlugs(
  deps: Pick<InvitePauseStaffDeps, "repos" | "logger" | "reportError">,
  owners: readonly EventInvitePauseOwner[],
  useCase: string,
): Promise<Map<string, string>> {
  const orgIds = new Set<string>();
  const humanIds = new Set<string>();
  for (const owner of owners) {
    if (owner.kind === "ORG") orgIds.add(owner.orgId);
    else humanIds.add(owner.humanId);
  }
  const slugs = new Map<string, string>();
  if (orgIds.size === 0 && humanIds.size === 0) return slugs;
  try {
    const [orgPages, humanPages] = await Promise.all([
      orgIds.size > 0
        ? deps.repos.entityPages.getByOwners("ORGANIZATION", [...orgIds])
        : Promise.resolve([]),
      humanIds.size > 0
        ? deps.repos.entityPages.getByOwners("HUMAN", [...humanIds])
        : Promise.resolve([]),
    ]);
    for (const page of orgPages) {
      if (page.slug) slugs.set(`ORG:${page.ownerId}`, page.slug);
    }
    for (const page of humanPages) {
      if (page.slug) slugs.set(`HUMAN:${page.ownerId}`, page.slug);
    }
  } catch (error) {
    reportSwallowed(deps.reportError, error, {
      tags: { useCase, channel: "owner_slug_lookup_failed" },
      extra: { orgIds: orgIds.size, humanIds: humanIds.size },
    });
    try {
      deps.logger?.error(`events.${useCase}.owner_slug_lookup_failed`, {
        orgIds: orgIds.size,
        humanIds: humanIds.size,
        err: error,
        error: describeError(error),
      });
    } catch {
      // Logging is best-effort.
    }
    return new Map();
  }
  return slugs;
}

/** Staff queue of paused organisers (platform staff only). */
export async function listInvitePauses(
  deps: Pick<InvitePauseStaffDeps, "repos" | "authz" | "logger" | "reportError">,
  rawInput: unknown,
): Promise<ListInvitePausesOutput> {
  const input = parseInput(listInvitePausesInputSchema, rawInput);
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: INVITE_PAUSE_VIEW_ROLES,
  });
  const rows = await deps.repos.eventInvitePauses.list({
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });
  const slugs = await resolveOwnerSlugs(
    deps,
    rows.map((row) => row.owner),
    "listInvitePauses",
  );
  return listInvitePausesOutputSchema.parse({
    items: rows.map((row) =>
      toStaffItem(row, row.ownerName, slugs.get(ownerKeyOf(row.owner)) ?? null),
    ),
  });
}

export const decideInvitePauseInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    pauseId: z.string().uuid(),
    decision: decisionSchema,
    /** Shown to the organiser. Required for KEPT, optional for LIFTED. */
    note: plainTextMultilineOptional(DECISION_NOTE_MAX).nullable().optional(),
  })
  .strict();

export const decideInvitePauseOutputSchema = z
  .object({ pause: invitePauseStaffItemSchema })
  .strict();

export type DecideInvitePauseOutput = z.infer<typeof decideInvitePauseOutputSchema>;

/**
 * Staff LIFT (invites resume, the complaint window restarts) or KEEP (the
 * organiser is told why and may ask again). KEEP needs a note; the organiser
 * sees it. Only an OPEN pause can be decided (INVALID_STATUS otherwise).
 */
export async function decideInvitePause(
  deps: InvitePauseStaffDeps,
  rawInput: unknown,
): Promise<DecideInvitePauseOutput> {
  const input = parseInput(decideInvitePauseInputSchema, rawInput);
  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: INVITE_PAUSE_DECIDE_ROLES,
  });
  const note = input.note?.trim() ? input.note.trim() : null;
  if (input.decision === "KEPT" && !note) {
    throw fail("INVALID_INPUT", { message: "invite_pause_keep_needs_note" });
  }
  const now = deps.clock.now();

  const { record: decided, repeated } = await deps.repos.tx(async (tx) => {
    const found = await tx.eventInvitePauses.getById(input.pauseId);
    if (!found) throw fail("NOT_FOUND", { message: "invite_pause_not_found" });
    // Same lock as the trip and the review request, so a decision never
    // interleaves with either for the same organiser. Re-read under it: the
    // KEEP audit row must hold the request note it is about to clear.
    await tx.eventInvitePauses.lockOwner(found.owner);
    const pause = (await tx.eventInvitePauses.getById(found.id)) ?? found;
    // The same reviewer's repeated KEEP (a double submit) that changes
    // nothing: same note, no review request since. Idempotent: no audit row,
    // no second notice. Another reviewer's identical KEEP is a real decision
    // (it is recorded and audited under their name).
    if (
      input.decision === "KEPT" &&
      pause.liftedAt === null &&
      pause.decision === "KEPT" &&
      pause.decidedByHumanId === input.actorHumanId &&
      pause.decisionNote === note &&
      pause.reviewRequestedAt === null
    ) {
      return { record: pause, repeated: true };
    }
    const updated = await tx.eventInvitePauses.decide({
      id: pause.id,
      decision: input.decision,
      note,
      decidedByHumanId: input.actorHumanId,
      at: now,
    });
    if (!updated) {
      throw fail("INVALID_STATUS", { message: "invite_pause_already_lifted" });
    }
    await tx.audit.log({
      ...ownerAuditEntity(pause.owner),
      action:
        input.decision === "LIFTED"
          ? "event_invite_pause_lifted"
          : "event_invite_pause_kept",
      data: {
        pauseId: pause.id,
        actorHumanId: input.actorHumanId,
        decisionNote: note,
        // A KEEP clears the organiser's request from the row; the audit log
        // keeps what they asked.
        ...(input.decision === "KEPT"
          ? {
              clearedReviewRequestedAt:
                pause.reviewRequestedAt?.toISOString() ?? null,
              clearedReviewRequestNote: pause.reviewRequestNote,
            }
          : {}),
      },
      at: now,
    });
    return { record: updated, repeated: false };
  });

  deps.logger?.info("invite_pause_decided", {
    pauseId: decided.id,
    decision: input.decision,
    repeated,
    ...ownerLogFields(decided.owner),
  });
  // After the commit; never throws (a failed notice is reported). Same
  // accepted crash-window gap as the "opened" notice; the panel still shows
  // the decision.
  if (!repeated) {
    await notifyInvitePauseDecided(deps, {
      pauseId: decided.id,
      owner: decided.owner,
      decision: input.decision,
      note,
    });
  }
  const slugs = await resolveOwnerSlugs(deps, [decided.owner], "decideInvitePause");
  return decideInvitePauseOutputSchema.parse({
    pause: toStaffItem(
      decided,
      await resolveOwnerNameAfterCommit(deps, decided.owner),
      slugs.get(ownerKeyOf(decided.owner)) ?? null,
    ),
  });
}

/**
 * {@link resolveOwnerName} for after the decision committed: a failed read
 * degrades to null (reported, guarded) so a recorded decision never comes
 * back to staff as an error.
 */
async function resolveOwnerNameAfterCommit(
  deps: Pick<InvitePauseStaffDeps, "repos" | "logger" | "reportError">,
  owner: EventInvitePauseOwner,
): Promise<string | null> {
  try {
    return await resolveOwnerName(deps.repos, owner);
  } catch (error) {
    reportSwallowed(deps.reportError, error, {
      tags: { useCase: "decideInvitePause", channel: "owner_name_lookup_failed" },
      extra: ownerLogFields(owner),
    });
    try {
      deps.logger?.error("events.decideInvitePause.owner_name_lookup_failed", {
        ...ownerLogFields(owner),
        err: error,
        error: describeError(error),
      });
    } catch {
      // Logging is best-effort.
    }
    return null;
  }
}

/** Display name of the organiser (org name, else the human's), or null. */
async function resolveOwnerName(
  repos: Pick<Repos, "organizations" | "humans">,
  owner: EventInvitePauseOwner,
): Promise<string | null> {
  if (owner.kind === "ORG") {
    return (await repos.organizations.getById(owner.orgId))?.name ?? null;
  }
  return (await repos.humans.getById(owner.humanId))?.name ?? null;
}
