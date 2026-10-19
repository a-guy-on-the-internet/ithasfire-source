import { createHash } from "node:crypto";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  VolunteerAskRecord,
  VolunteerCommitmentRecord,
  VolunteerRewardTrigger,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import type { WaiverTemplateRecord } from "@th/ports/repos/waivers";
import type { OffsetPaginatedResult } from "@th/ports/pagination";

import { describeError, parseInput } from "../../lib/io";
import { toUsSmsNumber } from "../../lib/comms/phone";
import { eventPublicUrl } from "../../lib/public-urls";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { fail, isAppError, isInternalCode } from "@th/errors";
import {
  ORG_EDIT_ROLES,
  requireOrgMembership,
  requireScannerAccessOnOrg,
} from "../../lib/rbac";
import {
  eventIdsWithAddress,
  gatedRowAddressText,
  loadHolderAddressesForEventIds,
} from "../../lib/location/load-holder-addresses";
import { volunteerMayReceiveAddress } from "../../lib/location/holder-eligibility";
import { requireCoordinatorOrOwner } from "./_shared/require-coordinator-or-owner";
import { ensureGuestHumanKeepingName } from "../../lib/ensure-guest-human";
import {
  sendContactOnlySignupMail,
  type ContactOnlyMailDeps,
} from "./_shared/contact-only-mail";
import { resolveOrCreateEventAsk } from "./_shared/resolve-event-ask";
import {
  recordVolunteerSmsConsent,
  VOLUNTEER_SIGNUP_SMS_SOURCE,
  type VolunteerSmsConsentResult,
} from "./_shared/record-volunteer-sms-consent";
import {
  findWithheldAskIds,
  isAskOwnerWithheld,
} from "./_shared/ask-owner-withheld";
import {
  signupReminderAnchor,
  type SignupReminderAnchor,
} from "./_shared/signup-reminder-anchor";
import {
  submitVolunteerSignupInputSchema,
  reviewVolunteerSignupInputSchema,
  reviewVolunteerSignupsBatchInputSchema,
  checkInVolunteerInputSchema,
  withdrawVolunteerSignupInputSchema,
  listMyVolunteerSignupsInputSchema,
  listMyVolunteerCommitmentsInputSchema,
  listVolunteerSignupsInputSchema,
  type SubmitVolunteerSignupUseCaseInput,
} from "./schemas";
import { ensureEventOpenToPublic } from "../events/_shared/event-open-to-public";

/**
 * A submit's result: the signup plus the static `smsMayNeedStart` hint
 * (reply START), which never reads the ledger and so is safe to return to
 * anonymous submits too.
 */
export type SubmitVolunteerSignupResult = VolunteerSignupRecord &
  VolunteerSmsConsentResult;

// ── Deps ────────────────────────────────────────────────────────────────────

/**
 * Optional comp-reward trigger hooks (volunteer-comp-tickets spec). Injected by
 * the composition root as thin wrappers over `grantVolunteerReward` /
 * `revokeVolunteerReward`, so the signup use cases stay decoupled from the
 * money path (idempotency, mailer, budget). Absent = rewards not wired (no-op).
 * Both fire POST-COMMIT and are individually error-swallowed — a reward failure
 * must never roll back or fail the review / check-in / withdraw it followed.
 */
export type VolunteerRewardHooks = {
  grant: (input: {
    signupId: string;
    rewardId: string;
    trigger: VolunteerRewardTrigger;
  }) => Promise<unknown>;
  revoke: (input: { grantId: string; reason: string }) => Promise<unknown>;
};

export type VolunteerSignupDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  appBaseUrl: string;
  logger?: LoggerPort;
  /**
   * Best-effort swallow reporter (Sentry) for caught-and-continued failures
   * (CLAUDE.md error-reporting convention). A throwing reporter must never
   * change behaviour.
   */
  reportError?: ReporterPort;
  /** Comp-reward triggers; omit to disable reward automation. */
  rewards?: VolunteerRewardHooks;
  /**
   * Direct mailer + limiter for signups with no linked Human (contact-only):
   * fixed-copy confirmation and decision emails, capped per recipient and
   * failing closed. Absent = those emails are skipped (logged + reported).
   */
  mailer?: ContactOnlyMailDeps["mailer"];
  rateLimit?: ContactOnlyMailDeps["rateLimit"];
  /**
   * Override for ANONYMOUS_SUBMIT_FLOOR_MS (tests). Leave unset in
   * production wiring.
   */
  anonymousSubmitFloorMs?: number;
};

/**
 * Post-commit comp-reward grant trigger. Resolves the applicable reward for the
 * signup (role-specific wins over ask-level; only ACTIVE rewards are returned)
 * and fires the grant hook when the reward's trigger matches. Only
 * EVENT-subject asks can carry rewards, and both ask-native and event-native
 * EVENT signups resolve via the signup's `askId` (backfilled for event
 * signups), so both paths can trigger. Never throws — failures are logged.
 */
async function maybeFireRewardGrant(
  deps: VolunteerSignupDeps,
  signup: VolunteerSignupRecord,
  trigger: VolunteerRewardTrigger,
): Promise<void> {
  if (!deps.rewards || !signup.askId || !signup.roleId) return;
  try {
    const reward = await deps.repos.volunteering.getRewardForSignup(
      signup.askId,
      signup.roleId,
    );
    if (!reward || !reward.active || reward.trigger !== trigger) return;
    await deps.rewards.grant({
      signupId: signup.id,
      rewardId: reward.id,
      trigger,
    });
  } catch (error) {
    // ERROR (not warn): the signup transition IS persisted but the volunteer
    // won't get their comp. Surface for replay/investigation. Never rethrow.
    deps.logger?.error("volunteering.rewardGrant.trigger_failed", {
      signupId: signup.id,
      trigger,
      error: describeError(error),
    });
  }
}

/**
 * Post-commit comp-reward revoke trigger for a withdrawn signup: void every
 * GRANTED (un-redeemed) grant on the signup and return its budget slot. A
 * REDEEMED / already-REVOKED grant is skipped here (revoke itself also guards).
 * Never throws — failures are logged.
 */
async function maybeFireRewardRevoke(
  deps: VolunteerSignupDeps,
  signup: VolunteerSignupRecord,
  reason: string,
): Promise<void> {
  if (!deps.rewards) return;
  try {
    const grants = await deps.repos.volunteering.listGrantsBySignup(signup.id);
    for (const grant of grants) {
      if (grant.status !== "GRANTED") continue;
      await deps.rewards.revoke({ grantId: grant.id, reason });
    }
  } catch (error) {
    deps.logger?.error("volunteering.rewardRevoke.trigger_failed", {
      signupId: signup.id,
      reason,
      error: describeError(error),
    });
  }
}

// ── Shared capacity rule ────────────────────────────────────────────────────

/**
 * Gap 1 capacity rule shared by submit (auto-approve degrade) and review
 * (approve gate): capacity gates *acceptance*, never application. Null
 * capacity = unlimited — no count and no lock. Otherwise accepted occupancy
 * (APPROVED | CHECKED_IN; PENDING never counts) is compared against the cap.
 * Counting locks the parent shift/role row (FOR UPDATE) until the
 * surrounding transaction commits, so concurrent acceptances of the last
 * seat serialize — only call inside `repos.tx`.
 */
async function isAtAcceptedCapacity(
  tx: TxRepos,
  target: { shiftId: string } | { roleId: string },
  capacity: number | null,
): Promise<boolean> {
  if (capacity == null) return false;
  const occupancy = await tx.volunteering.countAcceptedOccupancy(target);
  return occupancy >= capacity;
}

/**
 * Ask-level acceptance cap: accepted signups (APPROVED | CHECKED_IN) across
 * the WHOLE ask compared against `ask.capacity`. Same acceptance-not-
 * application rule as the shift/role checks above.
 *
 * Deliberately softer than `countAcceptedOccupancy`: there is no ask-scoped
 * counting primitive with a FOR UPDATE lock on the repo yet, so this derives
 * the count from two `listSignupsByAsk` totals without serializing
 * concurrent acceptances. Acceptable because `ask.capacity` is documented as
 * a soft cap; adding a locked `countAcceptedOccupancyByAsk` primitive is a
 * tracked follow-up if it ever needs to be airtight.
 */
async function isAskAtAcceptedCapacity(
  tx: TxRepos,
  ask: VolunteerAskRecord,
): Promise<boolean> {
  if (ask.capacity == null) return false;
  const [approved, checkedIn] = await Promise.all([
    tx.volunteering.listSignupsByAsk(ask.id, { status: "APPROVED", limit: 1 }),
    tx.volunteering.listSignupsByAsk(ask.id, {
      status: "CHECKED_IN",
      limit: 1,
    }),
  ]);
  return (
    approved.pageInfo.total + checkedIn.pageInfo.total >= ask.capacity
  );
}

// ── submit-volunteer-signup ─────────────────────────────────────────────────

/**
 * Submit a volunteer signup/application for a role.
 *
 * - Validates event has `volunteeringEnabled = true`.
 * - Validates the role belongs to the event.
 * - Optionally validates the shift belongs to the role.
 * - Checks duplicate signup via unique (eventId, roleId, contactEmail).
 * - Uses `ensureGuestHuman` for unauthenticated users (shadow profile).
 * - Waiver gate (Gap 3): when `event.volunteerWaiverRequired` AND the event
 *   has a resolvable waiver template, the signup requires
 *   `waiverAccepted: true` unless the resolved Human already has an
 *   acceptance on file for the same template + version (returning
 *   volunteer). New acceptances are written in the same transaction,
 *   snapshotting version/body-hash/ip/ua. Flag off, no template assigned,
 *   or template deleted → no gate (existing signups are never retro-gated).
 * - Profile carry-over: contact name/phone captured at signup fill the
 *   resolved Human's corresponding fields only when they're empty
 *   (conservative fill-if-null — never overwrites).
 * - Determines auto-approve: role-level `autoApprove` > event-level `volunteerAutoApprove`.
 * - If auto-approved, creates an `EventHuman` link with role = VOLUNTEER.
 * - Never blocks on capacity: applications always land. When auto-approve
 *   would exceed accepted occupancy (APPROVED | CHECKED_IN) of the target
 *   shift/role capacity, the signup degrades to PENDING (waitlist).
 *
 * Generic asks (A4): exactly one of `eventId` / `askId` selects the path.
 * The event path is unchanged externally except that new signups now also
 * stamp the event's EVENT-subject ask id (`resolveOrCreateEventAsk`). The
 * ask path (`submitAskVolunteerSignup`) mirrors the event flow with ask
 * semantics: ask must be OPEN, role must be ask-owned, idempotent on
 * `(askId, roleId, contactEmail)` (no duplicate row, no error — but the
 * replay echoes only the caller's own input plus the stable signup id, see
 * `sanitizeReplaySignup`; only the authenticated owner gets the full
 * record back), auto-approve per `role.autoApprove ?? ask.autoApprove`
 * with the same capacity degradation, plus the ask-level soft cap. The
 * waiver gate arms identically off `ask.waiverRequired` +
 * `ask.waiverTemplateId` (ask-level-volunteer-waivers spec) and records
 * the same in-tx acceptance snapshot.
 */
export async function submitVolunteerSignup(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<SubmitVolunteerSignupResult> {
  const input = parseInput(submitVolunteerSignupInputSchema, rawInput);

  // Exactly-one-subject + event-only shifts are enforced here (not in the
  // schema) so the exported schema stays a plain object the transport can
  // `.omit()` on.
  if (Boolean(input.eventId) === Boolean(input.askId)) {
    throw fail("INVALID_INPUT", {
      message: "exactly_one_of_event_id_or_ask_id",
    });
  }
  if (input.shiftId && !input.eventId) {
    throw fail("INVALID_INPUT", { message: "shift_id_requires_event_id" });
  }

  // The SMS tick is kept only for a signup a reminder is really sent for
  // (`signupReminderAnchor`, volunteer-ask-reminders FR-005); the volunteer
  // chooses, the organiser's old `ask.smsOptInEnabled` switch takes no part
  // (R5). The anchor needs the role (event path: does it have shifts?) or
  // the ask, so each path decides once it has read them.
  if (input.eventId) {
    return submitEventVolunteerSignup(deps, {
      ...input,
      eventId: input.eventId,
    });
  }
  // The exactly-one check above guarantees askId here.
  return submitAskVolunteerSignup(deps, {
    ...input,
    askId: input.askId!,
  });
}

/**
 * Opting into SMS reminders needs a number we can text: US only
 * (`isUsSmsNumber`). The form takes free text, so a US number in any common
 * format is accepted and stored as E.164; anything else is refused here
 * rather than failing at every reminder. Without the opt-in the phone stays
 * free text (organizers may call it).
 */
function smsReadyPhone(
  contactPhone: string | null | undefined,
  smsOptIn: boolean,
): string | null | undefined {
  if (!smsOptIn || !contactPhone || contactPhone.trim() === "") {
    return contactPhone;
  }
  const usPhone = toUsSmsNumber(contactPhone);
  if (!usPhone) {
    throw fail("INVALID_INPUT", { message: "sms_requires_us_phone" });
  }
  return usPhone;
}

/** Event-path submit — the pre-A4 flow, plus EVENT-ask `askId` stamping. */
async function submitEventVolunteerSignup(
  deps: VolunteerSignupDeps,
  eventInput: SubmitVolunteerSignupUseCaseInput & { eventId: string },
): Promise<SubmitVolunteerSignupResult> {
  // The moment the person gave consent (if they ticked SMS): taken before
  // the signup commits, so a STOP that lands before the post-commit ledger
  // write is newer and wins (see recordVolunteerSmsConsent).
  const consentAt = deps.clock.now();
  // The input with the SMS tick decided against the role (step 3b); read
  // through `input` from there on.
  let input = eventInput;
  const { signup, event, role, shift, shadowCreated } = await deps.repos.tx(
    async (tx) => {
      // 1. Load event and validate volunteering is enabled. A banned
      // owner's event takes no signups (ban-that-sticks): EVENT_NOT_FOUND.
      const event = await ensureEventOpenToPublic(tx, input.eventId);
      if (!event.volunteeringEnabled) {
        throw fail("VOLUNTEERING_DISABLED");
      }

      // 2. Validate the role belongs to the event
      const role = await tx.volunteering.getEventRole(input.roleId);
      if (!role || role.eventId !== input.eventId) {
        throw fail("ROLE_NOT_FOUND");
      }

      // 3. If shiftId is provided, validate it belongs to the role
      let shift: Awaited<ReturnType<typeof tx.volunteering.getShift>> | null =
        null;
      if (input.shiftId) {
        shift = await tx.volunteering.getShift(input.shiftId);
        if (!shift || shift.roleId !== input.roleId) {
          throw fail("SHIFT_NOT_FOUND");
        }
      }

      // 3b. The SMS tick stands only when a reminder is sent: by the shift,
      // or by the event's start on a role with no shifts (R7). A role-level
      // signup on a role that has shifts has no anchor, so the tick drops.
      const smsOptIn =
        eventInput.smsOptIn === true &&
        signupReminderAnchor({
          shiftId: input.shiftId ?? null,
          eventId: input.eventId,
          roleHasShifts: role.shifts.length > 0,
          ask: null,
        }) !== null;
      input = {
        ...eventInput,
        contactPhone: smsReadyPhone(eventInput.contactPhone, smsOptIn),
        smsOptIn,
      };

      // 4. Check duplicate signup (legacy event-scoped uniqueness)
      const existing = await tx.volunteering.getSignupByEmail({
        eventId: input.eventId,
        roleId: input.roleId,
        contactEmail: input.contactEmail,
      });
      if (existing) {
        throw fail("ALREADY_SIGNED_UP");
      }

      // 5. Resolve humanId. An anonymous submit naming an email that
      // already has a Human is CONTACT-ONLY (humanId null) — see
      // resolveSignupHuman.
      const actorProvided = Boolean(input.actorHumanId);
      const { humanId, shadowCreated } = await resolveSignupHuman(tx, input);

      // 5b. Waiver gate (Gap 3) — see resolveWaiverGate for the full rule.
      // Throws `waiver_required` inside the tx, so a freshly created shadow
      // Human (5.) rolls back with the rejected signup.
      const { template: waiverTemplate, alreadyOnFile: waiverAlreadyOnFile } =
        await resolveWaiverGate(tx, {
          gate: {
            waiverRequired: event.volunteerWaiverRequired,
            waiverTemplateId: event.waiverTemplateId,
          },
          humanId,
          actorProvided,
          waiverAccepted: input.waiverAccepted,
        });

      // 5c. Profile carry-over — fill-if-null only; see
      // carryOverContactToProfile. Never for a contact-only signup: a
      // stranger must not write a name or phone onto someone's profile.
      if (humanId) {
        await carryOverContactToProfile(tx, humanId, {
          name: input.contactName?.trim() || null,
          phone: input.contactPhone?.trim() || null,
        });
      }

      // 6. Determine auto-approve
      let autoApprove = role.autoApprove ?? event.volunteerAutoApprove ?? false;

      // Capacity never blocks an application — the pending pool is a natural
      // waitlist — but it does gate acceptance. When auto-approve would land
      // an APPROVED signup on a full shift/role, degrade to PENDING instead
      // of throwing. See isAtAcceptedCapacity for the occupancy + locking
      // rule.
      let autoApproveDegraded = false;
      if (autoApprove) {
        autoApproveDegraded = shift
          ? await isAtAcceptedCapacity(
              tx,
              { shiftId: shift.id },
              shift.capacity,
            )
          : await isAtAcceptedCapacity(tx, { roleId: role.id }, role.capacity);
        if (autoApproveDegraded) autoApprove = false;
      }

      const status = autoApprove ? ("APPROVED" as const) : ("PENDING" as const);
      const now = deps.clock.now();

      // 6b. Resolve the event's EVENT-subject ask so the new signup carries
      // askId exactly like backfilled rows do (lazily created for events
      // that enabled volunteering after the A1 migration).
      const eventAsk = await resolveOrCreateEventAsk(tx, event);

      // 7. Create signup
      // smsOptIn defaults to false on the DB column; we only forward it
      // when explicitly true so older callers (admin-side imports, etc.)
      // never accidentally opt a volunteer in. Force-clear when no
      // phone is on file — an opt-in without a destination is
      // meaningless and unsafe to persist (TCPA defensibility).
      const hasPhone = (input.contactPhone ?? "").trim().length > 0;
      const signup = await tx.volunteering.createSignup({
        eventId: input.eventId,
        askId: eventAsk.id,
        roleId: input.roleId,
        shiftId: input.shiftId ?? null,
        humanId,
        contactEmail: input.contactEmail,
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        smsOptIn: hasPhone && input.smsOptIn === true,
        status,
        answers: input.answers ?? {},
      });

      // 7b. Record the waiver acceptance in the SAME transaction as the
      // signup, snapshotting the exact template version + body hash the
      // volunteer saw (mirrors the checkout WaiverAcceptance write in
      // finalize-from-payment-intent). Skipped when an acceptance for this
      // template+version is already on file — no duplicate rows for
      // returning volunteers. ip/ua arrive server-injected via the
      // transport, never from the client.
      const waiverEvidence = await recordWaiverAcceptance(tx, {
        template: waiverAlreadyOnFile ? null : waiverTemplate,
        humanId,
        signupId: signup.id,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });

      // 8. If auto-approved, create EventHuman link — only when the signup
      // is bound to a Human (a contact-only signup binds no account).
      if (autoApprove && humanId) {
        await tx.eventHumans.attach({
          eventId: input.eventId,
          humanId,
          role: "VOLUNTEER",
          customRoleLabel: role.name,
        });
      }

      // 9. Audit
      await tx.audit.log({
        entity: "volunteer_signup",
        entityId: signup.id,
        action: autoApprove ? "auto_approved" : "submitted",
        data: {
          eventId: input.eventId,
          roleId: input.roleId,
          contactEmail: input.contactEmail,
          humanId,
          status,
          // Traceability: this signup *would* have auto-approved but the
          // target shift/role was full, so it landed as PENDING.
          ...(autoApproveDegraded ? { autoApproveDegraded: true } : {}),
          // Traceability: a fresh waiver acceptance was recorded with this
          // signup (vs. one already on file, or no gate at all).
          ...(waiverTemplate && !waiverAlreadyOnFile
            ? { waiverAccepted: true }
            : {}),
          ...contactOnlyAuditExtra(actorProvided, humanId, waiverEvidence),
        },
        at: now,
      });

      return { signup, event, role, shift, shadowCreated };
    },
  );

  // Post-commit confirmation. Failures must NOT roll back the signup — they
  // are logged and reported. A contact-only signup (no Human) is confirmed
  // by a fixed-copy direct email instead of notify().
  let smsConsent: VolunteerSmsConsentResult = { smsMayNeedStart: false };
  const postCommit = async (): Promise<void> => {
    smsConsent = await recordSignupSmsConsent(deps, input, signup, consentAt);
    if (!signup.humanId) {
      await sendContactOnlySignupMail(deps, {
        kind: "received",
        signupId: signup.id,
        // Event signups carry their EVENT-subject ask (stamped above).
        askId: signup.askId ?? input.eventId,
        contactEmail: signup.contactEmail,
        askTitle: event.title,
      });
    } else {
      const accountCompletionUrl = shadowCreated
        ? `${deps.appBaseUrl}/auth/complete?email=${encodeURIComponent(signup.contactEmail)}&src=volunteer&event=${input.eventId}`
        : null;

      try {
        await deps.notify({
          humanId: signup.humanId,
          variant: "volunteer.signup-received",
          payload: {
            // `input.eventId` (string), not `signup.eventId` (nullable since
            // generic asks) — this path always has the event in hand.
            eventId: input.eventId,
            eventTitle: event.title,
            roleId: role.id,
            roleName: role.name,
            signupId: signup.id,
            status: signup.status === "APPROVED" ? "APPROVED" : "PENDING",
            shiftLabel: shift?.label ?? null,
            shiftStartsAtIso: shift?.startsAt?.toISOString() ?? null,
            shiftEndsAtIso: shift?.endsAt?.toISOString() ?? null,
            // A shift belongs to the event: its window renders in the
            // event's zone, not the server's (UTC on Cloud Run).
            timezone: event.timezone,
            accountCompletionUrl,
          },
          scope: { kind: "EVENT", eventId: input.eventId },
          idempotencyKey: signup.id,
        });
      } catch (error) {
        // ERROR (not warn): the signup IS persisted but the volunteer
        // won't see a confirmation. Surface to Cloud Logging error
        // alerts so we can replay / investigate.
        deps.logger?.error("volunteering.submitVolunteerSignup.notify_failed", {
          signupId: signup.id,
          humanId: signup.humanId,
          error: describeError(error),
        });
        reportSubmitSwallow(deps, error, "confirmation", { signupId: signup.id });
      }
    }
  };

  const submitted = await finishSubmit(deps, input, signup, postCommit);
  return { ...submitted, ...smsConsent };
}

/**
 * Ask-path submit (generic-volunteering-asks FR-003). Mirrors the event
 * flow with ask semantics — see `submitVolunteerSignup`'s doc for the
 * contract deltas. The waiver gate (ask-level-volunteer-waivers FR-003/
 * FR-004) is the same `resolveWaiverGate` the event path uses, armed off
 * `ask.waiverRequired` + `ask.waiverTemplateId`: unaccepted armed submits
 * throw `waiver_required`, accepted ones snapshot a
 * VolunteerWaiverAcceptance (version + body hash + ip/ua) in the signup
 * transaction, and a flag with no (or a deleted) template imposes no gate
 * — existing waiverRequired-only asks stay inert until a template is
 * assigned.
 */
async function submitAskVolunteerSignup(
  deps: VolunteerSignupDeps,
  askInput: SubmitVolunteerSignupUseCaseInput & { askId: string },
): Promise<SubmitVolunteerSignupResult> {
  // Consent time, taken before commit (see the event path).
  const consentAt = deps.clock.now();
  // The input with the SMS tick decided against the ask (below); read
  // through `input` from there on, the replay echo included.
  let input = askInput;
  const result = await deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask || (await isAskOwnerWithheld(tx, ask))) {
      // A withheld owner's ask (ban-that-sticks: an org whose every OWNER is
      // banned, a banned human, or an EVENT ask whose event's owner is
      // withheld) answers exactly like a missing one.
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }
    // Only OPEN asks accept signups (FR-007: closing/pausing stops new
    // signups but preserves the roster). Deliberately checked BEFORE the
    // duplicate lookup: replays on a non-OPEN ask get CONFLICT, which
    // narrows the idempotent-replay window to OPEN asks only.
    if (ask.status !== "OPEN") {
      throw fail("CONFLICT", {
        message: "ask_not_open",
        meta: { reason: "ask_not_open" },
      });
    }

    // Ask-OWNED roles only. Roles that carry an eventId (event roles,
    // including backfilled EVENT-ask roles) keep flowing through the event
    // path — uniformly 404 here, mirroring updateVolunteerAskRole.
    const role = await tx.volunteering.getEventRole(input.roleId);
    if (!role || role.askId !== ask.id || role.eventId) {
      throw fail("ROLE_NOT_FOUND");
    }

    // The SMS tick stands only on an ask a reminder is sent for: one-time,
    // with a start (`signupReminderAnchor`, FR-005). On any other ask it is
    // dropped, so no promise is stored that nobody keeps. Decided before the
    // replay lookup so a replay echoes the same rule.
    const smsOptIn =
      askInput.smsOptIn === true &&
      signupReminderAnchor({
        shiftId: null,
        eventId: null,
        roleHasShifts: false,
        ask,
      }) !== null;
    input = {
      ...askInput,
      contactPhone: smsReadyPhone(askInput.contactPhone, smsOptIn),
      smsOptIn,
    };

    // Idempotent on (askId, roleId, contactEmail): resubmitting the same
    // email to the same role returns the existing signup, no duplicate
    // (spec acceptance criterion). The event path predates this contract
    // and keeps throwing ALREADY_SIGNED_UP.
    const existing = await tx.volunteering.getSignupByEmail({
      askId: ask.id,
      roleId: input.roleId,
      contactEmail: input.contactEmail,
    });
    if (existing) {
      return {
        signup: existing,
        ask,
        role,
        shadowCreated: false,
        replay: true,
        poolCoordinatorIds: [] as string[],
      };
    }

    const actorProvided = Boolean(input.actorHumanId);
    const { humanId, shadowCreated } = await resolveSignupHuman(tx, input);

    // Waiver gate — armed off the ask's own template linkage
    // (ask-level-volunteer-waivers FR-003); see resolveWaiverGate for the
    // full rule. Thrown inside the tx so a freshly created shadow Human
    // rolls back with the rejected signup, exactly like the event path's
    // step 5b.
    const { template: waiverTemplate, alreadyOnFile: waiverAlreadyOnFile } =
      await resolveWaiverGate(tx, {
        gate: {
          waiverRequired: ask.waiverRequired,
          waiverTemplateId: ask.waiverTemplateId,
        },
        humanId,
        actorProvided,
        waiverAccepted: input.waiverAccepted,
      });

    // Profile carry-over — identical fill-if-null rule as the event path,
    // and likewise never for a contact-only signup.
    if (humanId) {
      await carryOverContactToProfile(tx, humanId, {
        name: input.contactName?.trim() || null,
        phone: input.contactPhone?.trim() || null,
      });
    }

    // Auto-approve: role-level wins, else the ask default. Capacity gates
    // acceptance, never application — degrade to PENDING when the role cap
    // (locked count, same as events) or the ask-level soft cap is reached.
    let autoApprove = role.autoApprove ?? ask.autoApprove;
    let autoApproveDegraded = false;
    if (autoApprove) {
      autoApproveDegraded =
        (await isAtAcceptedCapacity(tx, { roleId: role.id }, role.capacity)) ||
        (await isAskAtAcceptedCapacity(tx, ask));
      if (autoApproveDegraded) autoApprove = false;
    }

    const status = autoApprove ? ("APPROVED" as const) : ("PENDING" as const);
    const now = deps.clock.now();

    // Same TCPA rule as the event path: never an opt-in without a phone.
    // `input.smsOptIn` is already false on an ask no reminder is sent for.
    const hasPhone = (input.contactPhone ?? "").trim().length > 0;
    const signup = await tx.volunteering.createSignup({
      askId: ask.id,
      roleId: input.roleId,
      shiftId: null,
      humanId,
      contactEmail: input.contactEmail,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      smsOptIn: hasPhone && input.smsOptIn === true,
      status,
      answers: input.answers ?? {},
    });

    // Record the waiver acceptance in the SAME transaction as the signup
    // (ask-level-volunteer-waivers FR-004), snapshotting the exact template
    // version + body hash the volunteer saw — identical to the event
    // path's step 7b. Skipped when an acceptance for this template+version
    // is already on file — no duplicate rows for returning volunteers.
    // ip/ua arrive server-injected via the transport, never from the
    // client.
    const waiverEvidence = await recordWaiverAcceptance(tx, {
      template: waiverAlreadyOnFile ? null : waiverTemplate,
      humanId,
      signupId: signup.id,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    await tx.audit.log({
      entity: "volunteer_signup",
      entityId: signup.id,
      action: autoApprove ? "auto_approved" : "submitted",
      data: {
        askId: ask.id,
        roleId: input.roleId,
        contactEmail: input.contactEmail,
        humanId,
        status,
        ...(autoApproveDegraded ? { autoApproveDegraded: true } : {}),
        // Traceability: a fresh waiver acceptance was recorded with this
        // signup (vs. one already on file, or no gate at all) — mirrors
        // the event path's audit extra.
        ...(waiverTemplate && !waiverAlreadyOnFile
          ? { waiverAccepted: true }
          : {}),
        ...contactOnlyAuditExtra(actorProvided, humanId, waiverEvidence),
      },
      at: now,
    });

    // FR-008 pool arrival: a new ask signup always lands unassigned (group
    // assignment is a separate step), so when the ask HAS groups, each
    // assigned coordinator hears about the new signup in the general pool.
    // Collected in-tx, sent post-commit.
    const groups = await tx.volunteering.listGroupsByAsk(ask.id);
    const poolCoordinatorIds = [
      ...new Set(
        groups
          .map((g) => g.coordinatorHumanId)
          .filter((id): id is string => id !== null),
      ),
    ];

    return {
      signup,
      ask,
      role,
      shadowCreated,
      replay: false,
      poolCoordinatorIds,
    };
  });

  // Idempotent replay: nothing new happened — no confirmation re-send, no
  // pool-arrival fan-out. The submit endpoint is public and keyed only on
  // (askId, roleId, contactEmail), so echoing the stored record verbatim
  // would hand server-evolved state (status, reviewer notes, group
  // assignment, previously captured phone/answers) to anyone who knows an
  // email address. Only the authenticated OWNER of the existing signup gets
  // the full record (self-lookup); everyone else gets the same minimal
  // shape a fresh submit would have produced from THEIR OWN input.
  if (result.replay) {
    if (
      input.actorHumanId &&
      result.signup.humanId === input.actorHumanId
    ) {
      // A replay records nothing new (no fresh consent), so no START hint.
      return { ...result.signup, smsMayNeedStart: false };
    }
    return {
      ...sanitizeReplaySignup(result.signup, result.ask, input),
      smsMayNeedStart: false,
    };
  }

  const { signup, ask, role, shadowCreated, poolCoordinatorIds } = result;
  const scope = ask.orgId
    ? ({ kind: "ORG", orgId: ask.orgId } as const)
    : ({ kind: "GLOBAL" } as const);

  // Responder confirmation + pool fan-out — post-commit, failures logged and
  // reported, never re-thrown (mirrors the event path). A contact-only
  // signup is confirmed by a fixed-copy direct email instead of notify().
  let smsConsent: VolunteerSmsConsentResult = { smsMayNeedStart: false };
  const postCommit = async (): Promise<void> => {
    smsConsent = await recordSignupSmsConsent(deps, input, signup, consentAt);
    if (!signup.humanId) {
      await sendContactOnlySignupMail(deps, {
        kind: "received",
        signupId: signup.id,
        askId: ask.id,
        contactEmail: signup.contactEmail,
        askTitle: ask.title,
      });
    } else {
      const accountCompletionUrl = shadowCreated
        ? `${deps.appBaseUrl}/auth/complete?email=${encodeURIComponent(signup.contactEmail)}&src=volunteer&ask=${ask.id}`
        : null;

      try {
        await deps.notify({
          humanId: signup.humanId,
          variant: "volunteer.signup-received",
          payload: {
            askId: ask.id,
            eventId: null,
            // Container title — the renderer treats eventTitle as "event
            // title (event path) or ask title (ask path)".
            eventTitle: ask.title,
            roleId: role.id,
            roleName: role.name,
            signupId: signup.id,
            status: signup.status === "APPROVED" ? "APPROVED" : "PENDING",
            shiftLabel: null,
            shiftStartsAtIso: null,
            shiftEndsAtIso: null,
            accountCompletionUrl,
          },
          scope,
          idempotencyKey: signup.id,
        });
      } catch (error) {
        deps.logger?.error("volunteering.submitVolunteerSignup.notify_failed", {
          signupId: signup.id,
          humanId: signup.humanId,
          askId: ask.id,
          error: describeError(error),
        });
        reportSubmitSwallow(deps, error, "confirmation", {
          signupId: signup.id,
          askId: ask.id,
        });
      }
    }

    // Pool-arrival fan-out to the ask's coordinators (FR-008). Per-recipient
    // idempotency keys, same convention as the withdraw spot-opened fan-out.
    //
    // B2: a coordinator seat can be given BY EMAIL to an existing account, so
    // an unverified coordinator may be someone else's account. Email still
    // goes; in-app and push only to verified coordinators.
    const verifiedCoordinators = await loadVerifiedRecipientIds({
      humans: deps.repos.humans,
      humanIds: poolCoordinatorIds,
      onLookupFailed: (error) => {
        deps.logger?.error(
          "volunteering.submitVolunteerSignup.pool_arrival_verified_lookup_failed",
          { signupId: signup.id, askId: ask.id, error: describeError(error) },
        );
        reportSubmitSwallow(deps, error, "pool_arrival_verified_lookup", {
          signupId: signup.id,
          askId: ask.id,
        });
      },
    });
    for (const coordinatorHumanId of poolCoordinatorIds) {
      try {
        await deps.notify({
          ...channelsForRecipient(verifiedCoordinators, coordinatorHumanId),
          humanId: coordinatorHumanId,
          variant: "volunteer.pool-signup-received",
          payload: {
            askId: ask.id,
            askTitle: ask.title,
            signupId: signup.id,
            roleId: role.id,
            roleName: role.name,
            status: signup.status === "APPROVED" ? "APPROVED" : "PENDING",
            coordinateUrl: `${deps.appBaseUrl}/volunteers/coordinate/${ask.id}`,
          },
          scope,
          idempotencyKey: `${signup.id}:pool-arrival:${coordinatorHumanId}`,
        });
      } catch (error) {
        deps.logger?.error(
          "volunteering.submitVolunteerSignup.pool_arrival_notify_failed",
          {
            signupId: signup.id,
            coordinatorHumanId,
            askId: ask.id,
            error: describeError(error),
          },
        );
        reportSubmitSwallow(deps, error, "pool_arrival", {
          signupId: signup.id,
          askId: ask.id,
        });
      }
    }
  };

  const submitted = await finishSubmit(deps, input, signup, postCommit);
  return { ...submitted, ...smsConsent };
}

/**
 * Minimal replay echo for the idempotent ask-path submit (PII guard).
 *
 * A replay hit means the (askId, roleId, contactEmail) key already exists,
 * but the caller has proven knowledge of nothing beyond that key — so the
 * response must not reveal anything a fresh submit wouldn't have. The shape
 * mirrors a fresh submit's output built from the CALLER's input:
 *
 * - `id`/`createdAt` come from the existing row — the stable idempotency
 *   handle a fresh submit would also have returned.
 * - contact fields / `answers` / `smsOptIn` echo THIS request's input (with
 *   the same TCPA + reminder-anchor rule as a real create), never stored
 *   values.
 * - Server-evolved state is reset to fresh-submit defaults: `status` is the
 *   neutral "application on file" PENDING (the true status is review state,
 *   visible only to the owner or reviewers), and notes / reviewer fields /
 *   groupId / hoursWorked / checkedInAt / metadata are nulled.
 * - `humanId` is withheld too: it links an email address to an account id,
 *   which a non-owner caller must not learn.
 * - `updatedAt` echoes `createdAt` — the real value tracks review activity.
 */
function sanitizeReplaySignup(
  existing: VolunteerSignupRecord,
  ask: VolunteerAskRecord,
  // `smsOptIn` already decided against the ask (submitAskVolunteerSignup).
  input: SubmitVolunteerSignupUseCaseInput,
): VolunteerSignupRecord {
  const hasPhone = (input.contactPhone ?? "").trim().length > 0;
  return {
    id: existing.id,
    eventId: null,
    askId: ask.id,
    roleId: existing.roleId,
    shiftId: null,
    groupId: null,
    humanId: null,
    contactEmail: input.contactEmail,
    contactName: input.contactName ?? null,
    contactPhone: input.contactPhone ?? null,
    smsOptIn: hasPhone && input.smsOptIn === true,
    status: "PENDING",
    hoursWorked: null,
    answers: input.answers ?? {},
    reviewerHumanId: null,
    reviewedAt: null,
    checkedInAt: null,
    waiverAcceptedAt: null,
    // Like waiverAcceptedAt: whether the stored signup carries an
    // acceptance is server-side state a non-owner must not learn.
    waiverAccepted: false,
    notes: null,
    metadata: {},
    createdAt: existing.createdAt,
    updatedAt: existing.createdAt,
  };
}

/**
 * Waiver gate (Gap 3 / ask-level-volunteer-waivers FR-003), evaluated
 * inside the submit transaction. Source-agnostic: the event path arms it
 * off `event.volunteerWaiverRequired` + `event.waiverTemplateId`, the ask
 * path off `ask.waiverRequired` + `ask.waiverTemplateId`. Only active when
 * the flag is set AND a waiver template is assigned AND it still resolves
 * (deleted templates degrade to "no waiver", mirroring get-event-waiver
 * and the checkout acceptance path). Acceptances are keyed to the Human,
 * so a returning volunteer with one on file for the SAME template +
 * version proceeds without re-accepting; a version bump re-arms the gate.
 *
 * The on-file skip applies only to authenticated actors. A guest submit
 * resolves the Human by email, so honoring an email-matched acceptance would
 * (a) give anyone a probe for whether an email address has accepted this
 * container's waiver and (b) attach the new signup to an acceptance the
 * submitter never made. Guests always re-accept; the fresh row is keyed to
 * the shadow Human anyway.
 *
 * Throws `waiver_required` (conflict) when the gate is armed and the
 * submitter neither has an acceptance on file nor accepted now.
 */
async function resolveWaiverGate(
  tx: TxRepos,
  args: {
    /** Arming source — event or ask waiver fields, spelled uniformly. */
    gate: {
      waiverRequired?: boolean;
      waiverTemplateId?: string | null;
    };
    humanId: string | null;
    actorProvided: boolean;
    waiverAccepted: boolean | undefined;
  },
): Promise<{ template: WaiverTemplateRecord | null; alreadyOnFile: boolean }> {
  if (!args.gate.waiverRequired || !args.gate.waiverTemplateId) {
    return { template: null, alreadyOnFile: false };
  }

  const template = await tx.waiverTemplates.getById(
    args.gate.waiverTemplateId,
  );
  if (!template) {
    return { template: null, alreadyOnFile: false };
  }

  let alreadyOnFile = false;
  if (args.actorProvided && args.humanId) {
    const onFile = await tx.volunteerWaiverAcceptances.findCurrentForHuman(
      args.humanId,
      template.id,
      template.version,
    );
    alreadyOnFile = onFile !== null;
  }

  if (!alreadyOnFile && args.waiverAccepted !== true) {
    throw fail("WAIVER_REQUIRED");
  }

  return { template, alreadyOnFile };
}

/**
 * Who an incoming signup belongs to.
 *
 * - Authenticated: the actor.
 * - Anonymous, and the email is NEW: a freshly minted shadow profile
 *   (named from contactName only — never after the address).
 * - Anonymous, and the email ALREADY has a Human: CONTACT-ONLY
 *   (humanId null). Nobody has proved they own that address, so the signup
 *   must not bind to that person's identity: no profile carry-over, no
 *   waiver acceptance recorded against them, no EventHuman link, no
 *   confirmation sent to their account, and nothing listed as theirs. The
 *   organiser still gets the contact fields on the roster.
 *
 * Contact-only uses the schema's existing humanId-null signup shape. Nothing
 * links such a signup to the account later; the account holder can sign in
 * and sign up again to own it. What a contact-only signup still gets:
 *
 * - its waiver acceptance row, with humanId NULL (the roster badge reads
 *   the row; a NULL row is never "already on file" for anyone);
 * - a fixed-copy confirmation, and later the approve/decline decision, by
 *   direct email to contactEmail (`_shared/contact-only-mail.ts`, capped
 *   per recipient, fails closed);
 * - a comp reward, which lands with the OWNER of contactEmail
 *   (`grantVolunteerReward` resolves the buyer by email): the rightful
 *   inbox owner gets the ticket, the person who typed the address gets
 *   nothing. No account-claim link, since that address already has a Human.
 *
 * What it does not get: a volunteer QR / badge (tokens are keyed to a
 * Human) — the organiser checks them in manually from the roster.
 */
async function resolveSignupHuman(
  tx: TxRepos,
  input: Pick<
    SubmitVolunteerSignupUseCaseInput,
    "actorHumanId" | "contactEmail" | "contactName"
  >,
): Promise<{ humanId: string | null; shadowCreated: boolean }> {
  if (input.actorHumanId) {
    return { humanId: input.actorHumanId, shadowCreated: false };
  }
  const guest = await ensureGuestHumanKeepingName(tx.humans, {
    email: input.contactEmail,
    name: input.contactName ?? null,
  });
  return guest.created
    ? { humanId: guest.humanId, shadowCreated: true }
    : { humanId: null, shadowCreated: false };
}

type WaiverEvidence = {
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * Record a fresh waiver acceptance in the signup transaction, snapshotting
 * the exact template version + body hash the volunteer saw (mirrors the
 * checkout WaiverAcceptance write). `template` is null when there is no
 * gate or an acceptance is already on file.
 *
 * The row is ALWAYS written (it is what the roster's waiver badge reads).
 * For a contact-only signup its humanId is NULL: recording it against the
 * address's existing account would put words in that person's mouth, and
 * `findCurrentForHuman` matches on humanId, so a NULL row can never satisfy
 * anyone's "already on file" skip. The evidence is also returned so the
 * caller keeps a copy on the signup's audit entry.
 */
async function recordWaiverAcceptance(
  tx: TxRepos,
  args: {
    template: WaiverTemplateRecord | null;
    humanId: string | null;
    signupId: string;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<WaiverEvidence | null> {
  if (!args.template) return null;
  const evidence: WaiverEvidence = {
    waiverTemplateId: args.template.id,
    waiverVersion: args.template.version,
    waiverBodyHash: createHash("sha256")
      .update(args.template.body)
      .digest("hex"),
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  };
  await tx.volunteerWaiverAcceptances.create({
    humanId: args.humanId,
    signupId: args.signupId,
    ...evidence,
  });
  return evidence;
}

/**
 * Minimum wall time for an ANONYMOUS submit's response (timing oracle).
 *
 * An anonymous submit takes one of two post-commit branches depending on
 * whether the typed email already has an account: notify() to a fresh
 * shadow profile, or the contact-only direct mail. If the response time
 * tracked the branch, anyone could learn whether an address has an account
 * by timing the public endpoint. So the anonymous path waits for its work
 * AND for this floor, whichever is longer, and both branches look alike.
 *
 * The work is awaited — never detached — because the API runs on Cloud Run
 * with request-based CPU (`cpu_idle = true`, see
 * infra/terraform/modules/cloud-run-service/variables.tf): anything after
 * the response gets no CPU, so a detached confirmation (and its error
 * report) would be silently lost.
 *
 * 500ms sits above the slower branch's p95 (a mailer round-trip) with room
 * to spare; a send slower than the floor would still leak its own latency,
 * but not which branch ran. Authenticated submits have no floor.
 */
export const ANONYMOUS_SUBMIT_FLOOR_MS = 500;

/**
 * Run a submit's post-commit work, then return what the caller sees.
 * Authenticated: awaited as before. Anonymous: awaited alongside the
 * timing floor (see ANONYMOUS_SUBMIT_FLOOR_MS). Failures are logged and
 * reported, never surfaced — the signup is already persisted.
 */
async function finishSubmit(
  deps: VolunteerSignupDeps,
  input: Pick<SubmitVolunteerSignupUseCaseInput, "actorHumanId">,
  signup: VolunteerSignupRecord,
  postCommit: () => Promise<void>,
): Promise<VolunteerSignupRecord> {
  const work = postCommit().catch((error: unknown) => {
    // Guarded: neither a throwing logger nor a throwing reporter may turn a
    // persisted signup into a failed request.
    try {
      deps.logger?.error("volunteering.submitVolunteerSignup.post_commit_failed", {
        signupId: signup.id,
        error: describeError(error),
      });
    } catch {
      // Logging is best-effort.
    }
    reportSubmitSwallow(deps, error, "post_commit", { signupId: signup.id });
  });

  if (input.actorHumanId) {
    await work;
    return signup;
  }
  const floorMs = deps.anonymousSubmitFloorMs ?? ANONYMOUS_SUBMIT_FLOOR_MS;
  await Promise.all([
    work,
    floorMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, floorMs))
      : Promise.resolve(),
  ]);
  return anonymousSubmitView(signup);
}

/**
 * A signup that saved with SMS reminders ticked is consent to them (owner,
 * 2026-10-17). The fresh opt-in reaches the phone-level ledger only for the
 * signed-in actor's own verified phone. Any other number gets the static
 * `smsMayNeedStart` hint (reply START), which never reads the ledger (see
 * recordVolunteerSmsConsent). Post-commit and never throws: the signup
 * keeps `smsOptIn` when the ledger write fails, and the failure is
 * reported. The opt-in is stamped `consentAt` (taken before commit), not
 * the time of this later write.
 */
async function recordSignupSmsConsent(
  deps: VolunteerSignupDeps,
  input: Pick<SubmitVolunteerSignupUseCaseInput, "actorHumanId">,
  signup: VolunteerSignupRecord,
  consentAt: Date,
): Promise<VolunteerSmsConsentResult> {
  if (!signup.smsOptIn || !signup.contactPhone) {
    return { smsMayNeedStart: false };
  }
  return recordVolunteerSmsConsent(deps, {
    phone: signup.contactPhone,
    source: VOLUNTEER_SIGNUP_SMS_SOURCE,
    actorHumanId: input.actorHumanId ?? null,
    signupId: signup.id,
    eventId: signup.eventId,
    askId: signup.askId ?? null,
    useCase: "submitVolunteerSignup",
    consentAt,
  });
}

/**
 * Report a swallowed post-commit notify failure on the submit paths (the
 * signup is persisted; only the notice was lost). Guarded: a throwing
 * reporter never changes the result.
 */
function reportSubmitSwallow(
  deps: Pick<VolunteerSignupDeps, "reportError">,
  error: unknown,
  stage: string,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "submitVolunteerSignup", stage },
      extra,
    });
  } catch {
    // Best-effort reporting only.
  }
}

/** Audit extra marking a contact-only signup (and its waiver evidence). */
function contactOnlyAuditExtra(
  actorProvided: boolean,
  humanId: string | null,
  waiverEvidence: WaiverEvidence | null,
): Record<string, unknown> {
  if (actorProvided || humanId) return {};
  return {
    contactOnly: true,
    ...(waiverEvidence ? { waiverEvidence } : {}),
  };
}

/**
 * What an ANONYMOUS caller gets back from a fresh submit. `humanId` is
 * nulled for every anonymous submit — a new shadow and a contact-only
 * signup must look identical, or the response itself would reveal whether
 * the address has an account.
 */
function anonymousSubmitView(
  signup: VolunteerSignupRecord,
): VolunteerSignupRecord {
  return { ...signup, humanId: null };
}

/**
 * Profile carry-over: contact details captured at signup conservatively
 * fill the resolved Human's empty fields so they follow the volunteer to
 * their next event (shadow → real account merge already carries Human
 * fields). Fill-if-null only — an existing profile name/phone is never
 * overwritten by a signup form.
 */
async function carryOverContactToProfile(
  tx: TxRepos,
  humanId: string,
  contact: { name: string | null; phone: string | null },
): Promise<void> {
  if (!contact.name && !contact.phone) return;

  const human = await tx.humans.getById(humanId);
  if (!human) return;

  const patch: { name?: string; phone?: string } = {};
  if (contact.name && !human.name) patch.name = contact.name;
  if (contact.phone && !human.phone) patch.phone = contact.phone;
  if (Object.keys(patch).length > 0) {
    await tx.humans.update(humanId, patch);
  }
}

// ── review-volunteer-signup ─────────────────────────────────────────────────

/**
 * The resolved review/check-in container of a signup: the legacy event
 * surface (org-gated) or a generic ask (owner-or-coordinator gated).
 */
type SignupContainer =
  | { kind: "event"; event: EventRecord }
  | {
      kind: "ask";
      ask: VolunteerAskRecord;
      via: "owner" | "coordinator";
    };

/**
 * Is the owner of this signup's container withheld (ban that sticks)? Same
 * derived rule as every public read: the event path uses the owner standing
 * read with the event (`ensureEventOpenToPublic`'s rule); the ask path uses
 * `isAskOwnerWithheld`, which covers ORG, HUMAN and EVENT asks.
 */
async function isSignupContainerWithheld(
  tx: TxRepos,
  container: SignupContainer,
): Promise<boolean> {
  if (container.kind === "event") {
    return container.event.ownerBanned === true;
  }
  return isAskOwnerWithheld(tx, container.ask);
}

/**
 * Admin approves or rejects a pending volunteer signup.
 *
 * On approval: enforces shift/role capacity against accepted occupancy
 * (APPROVED | CHECKED_IN — pending never counts) and throws `shift_full` /
 * `role_full` (conflict) when at capacity, then creates an `EventHuman`
 * entry with role = VOLUNTEER. No force flag — admins raise capacity and
 * retry.
 * On rejection: records reviewer info; no capacity logic.
 * Runs in a single transaction; the occupancy count locks the parent
 * shift/role row so concurrent approvals serialize.
 *
 * Ask-only signups (A4, null `eventId`): the actor must be the ask's owner
 * OR the coordinator of the signup's group (`requireCoordinatorOrOwner`).
 * Pool/unassigned signups are owner-only — a coordinator can't review what
 * isn't in their group yet. Approval additionally enforces the ask-level
 * soft cap (`ask_full`, conflict) alongside the role cap.
 *
 * Ban that sticks (owner ruling 2026-10-08): while the event's or ask's
 * owner is withheld, approval is refused with `VOLUNTEER_APPROVALS_PAUSED`
 * (no write, audit or notification). Rejection always goes through, so every
 * applicant still gets an answer. The check runs after RBAC and the PENDING
 * check, so it never tells a foreign actor anything.
 */
export async function reviewVolunteerSignup(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord> {
  const input = parseInput(reviewVolunteerSignupInputSchema, rawInput);

  const { updated, container, role, shift, reviewerName } = await deps.repos.tx(
    async (tx) => {
      const signup = await tx.volunteering.getSignup(input.signupId);
      if (!signup) {
        throw fail("SIGNUP_NOT_FOUND");
      }

      // RBAC: authorize BEFORE any state inspection. Checking `status`
      // first would let an authenticated user probe arbitrary signup ids
      // and distinguish "exists + already reviewed" (conflict) from
      // "exists + pending" (forbidden) in orgs they don't belong to — a
      // review-status oracle the batch endpoint would amplify to 100
      // probes per call. With RBAC first, every existing foreign signup
      // uniformly yields a forbidden error regardless of its status.
      let container: SignupContainer;
      if (signup.eventId) {
        // Event path — unchanged pre-A4 gate: EDIT role on the event's org.
        // Read with the owner's standing so approval can refuse a withheld
        // owner's event below (`isSignupContainerWithheld`).
        const event = await tx.events.getById(signup.eventId, {
          withOwnerStanding: true,
        });
        if (!event || !event.orgId) {
          throw fail("EVENT_NOT_FOUND");
        }
        await requireOrgMembership({
          repos: tx,
          orgId: event.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_EDIT_ROLES,
        });
        container = { kind: "event", event };
      } else {
        // Ask path. A signup with neither container is malformed — surface
        // it as SIGNUP_NOT_FOUND so probing ids never confirms existence
        // (same anti-oracle rule as above). The ask FK cascades on delete,
        // so a dangling askId is equally unreachable-but-defended.
        if (!signup.askId) {
          throw fail("SIGNUP_NOT_FOUND");
        }
        const ask = await tx.volunteering.getAsk(signup.askId);
        if (!ask) {
          throw fail("SIGNUP_NOT_FOUND");
        }
        const access = await requireCoordinatorOrOwner(
          tx,
          { ask, signupGroupId: signup.groupId },
          input.actorHumanId,
        );
        container = { kind: "ask", ask, via: access.via };
      }

      if (signup.status !== "PENDING") {
        throw fail("SIGNUP_NOT_REVIEWABLE");
      }

      // Ban that sticks (owner ruling 2026-10-08): no NEW volunteer joins a
      // withheld owner's event or ask. After RBAC and the PENDING check
      // (anti-oracle), before any capacity read or write. Rejection is never
      // refused: applicants always get an answer.
      if (
        input.decision === "APPROVED" &&
        (await isSignupContainerWithheld(tx, container))
      ) {
        throw fail("VOLUNTEER_APPROVALS_PAUSED");
      }

      const now = deps.clock.now();

      // Role + shift load before the status flip: the approve path needs
      // their capacities, and the post-commit notification needs them on
      // both the approve and reject paths.
      const role = await tx.volunteering.getEventRole(signup.roleId);
      const shift = signup.shiftId
        ? await tx.volunteering.getShift(signup.shiftId)
        : null;

      // Capacity check — see isAtAcceptedCapacity for the occupancy +
      // locking rule. Shift capacity governs shifted signups; role capacity
      // applies only when the signup has no shift (it caps the whole role,
      // which the shifted count rolls into). Ask-only signups additionally
      // respect the ask-level soft cap.
      if (input.decision === "APPROVED") {
        if (signup.shiftId) {
          if (
            shift &&
            (await isAtAcceptedCapacity(
              tx,
              { shiftId: signup.shiftId },
              shift.capacity,
            ))
          ) {
            throw fail("SHIFT_FULL");
          }
        } else if (
          role &&
          (await isAtAcceptedCapacity(
            tx,
            { roleId: signup.roleId },
            role.capacity,
          ))
        ) {
          throw fail("ROLE_FULL");
        }
        if (
          container.kind === "ask" &&
          (await isAskAtAcceptedCapacity(tx, container.ask))
        ) {
          throw fail("CONFLICT", {
            message: "ask_full",
            meta: { reason: "ask_full" },
          });
        }
      }

      const updated = await tx.volunteering.updateSignupStatus(input.signupId, {
        status: input.decision,
        reviewerHumanId: input.actorHumanId,
        reviewedAt: now,
        notes: input.notes ?? undefined,
      });

      // If approving, create EventHuman link. Ask-only signups have no
      // event to attach to.
      if (input.decision === "APPROVED" && signup.humanId && signup.eventId) {
        await tx.eventHumans.attach({
          eventId: signup.eventId,
          humanId: signup.humanId,
          role: "VOLUNTEER",
          customRoleLabel: role?.name ?? "Volunteer",
        });
      }

      const reviewer = await tx.humans.getById(input.actorHumanId);

      await tx.audit.log({
        entity: "volunteer_signup",
        entityId: input.signupId,
        action: input.decision === "APPROVED" ? "approved" : "rejected",
        data: {
          reviewerHumanId: input.actorHumanId,
          signupId: input.signupId,
          decision: input.decision,
          // Coordinator actions must be distinguishable from owner actions
          // after the fact (spec authz note) — ask path only, so the event
          // path audit shape stays byte-identical.
          ...(container.kind === "ask"
            ? {
                askId: container.ask.id,
                via: container.via,
                groupId: signup.groupId,
              }
            : {}),
        },
        at: now,
      });

      return {
        updated,
        container,
        role,
        shift,
        reviewerName: reviewer?.name ?? null,
      };
    },
  );

  // Post-commit notification. Email failures must not roll back the review.
  // A signup with no Human (contact-only) has no notify() identity: tell the
  // contact address instead, with the fixed-copy direct email.
  if (!updated.humanId) {
    await sendContactOnlySignupMail(deps, {
      kind: input.decision === "APPROVED" ? "approved" : "declined",
      signupId: updated.id,
      askId:
        updated.askId ??
        (container.kind === "event" ? container.event.id : container.ask.id),
      contactEmail: updated.contactEmail,
      askTitle:
        container.kind === "event" ? container.event.title : container.ask.title,
    });
  } else if (role) {
    const variant =
      input.decision === "APPROVED"
        ? ("volunteer.signup-approved" as const)
        : ("volunteer.signup-rejected" as const);

    // Event path: `event.id`, not `updated.eventId` — the record field is
    // nullable since generic asks, and this path already resolved the
    // event. Ask path: no event — the renderer treats eventTitle as the
    // container title (ask title here).
    const containerFields =
      container.kind === "event"
        ? {
            eventId: container.event.id,
            eventTitle: container.event.title,
          }
        : {
            askId: container.ask.id,
            eventId: null,
            eventTitle: container.ask.title,
          };
    // Approved volunteers need a way back to what they were approved for:
    // the event page or the public ask page.
    //
    // The event link MUST be slug-based. It used to be `/events/{id}` with a
    // comment claiming a UUID redirects to the canonical slug — it does NOT:
    // the public route resolves through `events.resolveBySlug`, which matches
    // the current slug or slug history and has no id branch, so that link 404'd.
    // (Seeded dev rows redirect only because the seed left the uuid in
    // EventSlugHistory.) No slug → no link, rather than a dead one.
    const destinationUrl =
      container.kind === "event"
        ? eventPublicUrl({
            baseUrl: deps.appBaseUrl,
            slug: container.event.slug,
          })
        : `${deps.appBaseUrl}/v/${container.ask.id}`;
    const payload =
      input.decision === "APPROVED"
        ? {
            ...containerFields,
            roleId: role.id,
            roleName: role.name,
            signupId: updated.id,
            shiftLabel: shift?.label ?? null,
            shiftStartsAtIso: shift?.startsAt?.toISOString() ?? null,
            shiftEndsAtIso: shift?.endsAt?.toISOString() ?? null,
            // The window renders in the container's zone, not the server's.
            timezone:
              container.kind === "event"
                ? container.event.timezone
                : container.ask.timezone,
            reviewerName,
            destinationUrl,
          }
        : {
            ...containerFields,
            roleId: role.id,
            roleName: role.name,
            signupId: updated.id,
            reviewerName,
            rejectionNote: input.notes ?? null,
          };

    const scope =
      container.kind === "event"
        ? ({ kind: "EVENT", eventId: container.event.id } as const)
        : container.ask.orgId
          ? ({ kind: "ORG", orgId: container.ask.orgId } as const)
          : ({ kind: "GLOBAL" } as const);

    try {
      await deps.notify({
        humanId: updated.humanId,
        variant,
        payload,
        scope,
        idempotencyKey: `${updated.id}:${input.decision}`,
      });
    } catch (error) {
      // ERROR (not warn): the review decision IS persisted but the
      // volunteer won't see approval/rejection notice. Surface to
      // Cloud Logging error alerts so we can replay / investigate.
      deps.logger?.error("volunteering.reviewVolunteerSignup.notify_failed", {
        signupId: updated.id,
        humanId: updated.humanId,
        decision: input.decision,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "reviewVolunteerSignup", stage: "notify" },
          extra: { signupId: updated.id, decision: input.decision },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail
        // the already-persisted review.
      }
    }
  }

  // Comp-reward trigger: an APPROVED signup fires an ON_APPROVAL reward grant
  // (idempotent; failures logged, never thrown). Post-commit so a mail/grant
  // hiccup can't roll back the review.
  if (input.decision === "APPROVED") {
    await maybeFireRewardGrant(deps, updated, "ON_APPROVAL");
  }

  return updated;
}

// ── review-volunteer-signups-batch ──────────────────────────────────────────

export type ReviewVolunteerSignupsBatchItemResult = {
  id: string;
  ok: boolean;
  /** Use-case error message on failure, e.g. "shift_full", "signup_not_found". */
  code?: string;
};

export type ReviewVolunteerSignupsBatchResult = {
  results: ReviewVolunteerSignupsBatchItemResult[];
};

/**
 * The canonical codes `reviewVolunteerSignup` itself throws — a
 * deliberate 4-code subset of `toTrpcError`'s map, NOT the full set.
 * Do not "complete" it: extended codes (`not_configured`, …) never
 * originate from this use case, and widening the allowlist widens what
 * a per-id batch result may echo back to the client. Structured
 * non-Error throws from adapters/ports (e.g. `{ code: "redis_down",
 * message: "ECONNREFUSED …" }`) deliberately fail this allowlist and
 * collapse to `internal_error`.
 */
const USE_CASE_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_input",
  "forbidden",
  "not_found",
  "conflict",
]);

/**
 * Admin approves or rejects many pending signups in one action.
 *
 * Delegates each id to `reviewVolunteerSignup` so every side effect stays
 * identical: per-signup transaction, RBAC, capacity enforcement
 * (shift_full / role_full), EventHuman creation, audit entry, and the
 * status email. No batch-level audit — the single path already audits
 * each signup.
 *
 * Partial success is the contract: a failed id (full shift, already
 * reviewed, missing) yields `{ id, ok: false, code }` and the batch
 * continues. RBAC also runs per signup inside the single path, so a
 * forbidden actor gets a per-id `insufficient_org_role` result rather
 * than a thrown error — acceptable, since it keeps the logic identical
 * and the input itself caps at 100 ids.
 *
 * Ids are NOT deduped: each occurrence is reviewed in order, so a
 * duplicate's later occurrence surfaces `signup_not_reviewable` (the
 * first occurrence already flipped it out of PENDING).
 *
 * Iteration is sequential, not Promise.all: each single review takes a
 * FOR UPDATE lock on the parent shift/role row, so serial execution
 * avoids self-inflicted lock contention and keeps notification ordering
 * deterministic.
 */
export async function reviewVolunteerSignupsBatch(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<ReviewVolunteerSignupsBatchResult> {
  const input = parseInput(reviewVolunteerSignupsBatchInputSchema, rawInput);

  const results: ReviewVolunteerSignupsBatchItemResult[] = [];
  for (const signupId of input.signupIds) {
    try {
      await reviewVolunteerSignup(deps, {
        actorHumanId: input.actorHumanId,
        signupId,
        decision: input.decision,
        notes: input.notes,
      });
      results.push({ id: signupId, ok: true });
    } catch (error) {
      // Per-item failures surface a specific user-facing code. A typed
      // `AppError` (the go-forward shape) carries its canonical code directly;
      // a legacy `{ code, message }` object (allowlisted category) surfaces its
      // `message` (the specific domain reason). Anything else — internal-tier
      // AppErrors, raw Error instances, structured port errors with
      // non-standard codes — must not leak internals; collapse to generic + log.
      const maybe = error as { code?: unknown; message?: unknown } | null;
      const useCaseMessage = isAppError(error)
        ? isInternalCode(error.code)
          ? null
          : error.code
        : maybe !== null &&
            typeof maybe === "object" &&
            !(maybe instanceof Error) &&
            typeof maybe.code === "string" &&
            USE_CASE_ERROR_CODES.has(maybe.code) &&
            typeof maybe.message === "string"
          ? maybe.message
          : null;
      if (!useCaseMessage) {
        deps.logger?.error(
          "volunteering.reviewVolunteerSignupsBatch.item_failed",
          { signupId, decision: input.decision, error: describeError(error) },
        );
      }
      results.push({
        id: signupId,
        ok: false,
        code: useCaseMessage ?? "internal_error",
      });
    }
  }

  return { results };
}

// ── check-in-volunteer ──────────────────────────────────────────────────────

/**
 * Mark a volunteer as checked in (scanner/admin use).
 *
 * Validates signup is APPROVED. Idempotent: if already CHECKED_IN, returns success.
 *
 * Ask-only signups (A4, null `eventId`): the actor must be the ask's owner
 * OR the coordinator of the signup's group. There is no shift to derive a
 * duration from, so when the signup has no explicit `hoursWorked`, the
 * role's owner-set `defaultHours` is stamped at check-in (2026-07-01
 * resolutions: `default_hours`). The event/shift path is unchanged.
 */
export async function checkInVolunteer(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord> {
  const input = parseInput(checkInVolunteerInputSchema, rawInput);

  const updated = await deps.repos.tx(async (tx) => {
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // RBAC before any status branch. Signup ids circulate in
    // volunteer-facing manage URLs, so the idempotent CHECKED_IN early
    // return below would otherwise hand the full signup record (contact
    // email/phone, answers) to any authenticated user holding an id —
    // and the status errors would leak review state across orgs (same
    // oracle closed in reviewVolunteerSignup).
    //
    // `eventId` is nullable since generic asks — ask-only signups take the
    // owner-or-coordinator gate below instead of the org scanner gate.
    if (!signup.eventId) {
      return checkInAskVolunteer(deps, tx, signup, input.actorHumanId);
    }
    const event = await tx.events.getById(signup.eventId);
    if (!event || !event.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }
    const access = await requireScannerAccessOnOrg({
      repos: tx,
      authz: deps.authz,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    // Idempotent: already checked in
    if (signup.status === "CHECKED_IN") {
      return signup;
    }

    if (signup.status !== "APPROVED") {
      throw fail("SIGNUP_NOT_APPROVED");
    }

    const now = deps.clock.now();

    const updated = await tx.volunteering.updateSignupStatus(input.signupId, {
      status: "CHECKED_IN",
      checkedInAt: now,
    });

    await tx.audit.log({
      entity: "volunteer_signup",
      entityId: input.signupId,
      action:
        access.via === "platform_admin"
          ? "checked_in.platform_admin_override"
          : "checked_in",
      data: {
        signupId: input.signupId,
        actorHumanId: input.actorHumanId,
        scannerDeviceId: input.scannerDeviceId ?? null,
        viaPlatformAdmin: access.via === "platform_admin",
        orgId: event.orgId,
      },
      at: now,
    });

    return updated;
  });

  // Comp-reward trigger: a CHECKED_IN signup fires an ON_CHECK_IN reward grant
  // (idempotent; failures logged, never thrown). Covers the idempotent
  // re-check-in too — the grant's own idempotency stops a second comp.
  if (updated.status === "CHECKED_IN") {
    await maybeFireRewardGrant(deps, updated, "ON_CHECK_IN");
  }

  return updated;
}

/**
 * Ask-path check-in, invoked inside `checkInVolunteer`'s transaction for
 * ask-only signups. Owner-or-coordinator gated; stamps `hoursWorked` from
 * the role's `defaultHours` when the signup has no shift and no explicit
 * hours (2026-07-01 resolutions: `default_hours`). An explicit
 * `hoursWorked` — admin override before check-in — is always preserved.
 */
async function checkInAskVolunteer(
  deps: VolunteerSignupDeps,
  tx: TxRepos,
  signup: VolunteerSignupRecord,
  actorHumanId: string,
): Promise<VolunteerSignupRecord> {
  // Malformed row (neither container) — same anti-probe rule as review:
  // never confirm the id exists.
  if (!signup.askId) {
    throw fail("SIGNUP_NOT_FOUND");
  }
  const ask = await tx.volunteering.getAsk(signup.askId);
  if (!ask) {
    throw fail("SIGNUP_NOT_FOUND");
  }

  const access = await requireCoordinatorOrOwner(
    tx,
    { ask, signupGroupId: signup.groupId },
    actorHumanId,
  );

  // Idempotent: already checked in.
  if (signup.status === "CHECKED_IN") {
    return signup;
  }

  if (signup.status !== "APPROVED") {
    throw fail("SIGNUP_NOT_APPROVED");
  }

  const now = deps.clock.now();

  let updated = await tx.volunteering.updateSignupStatus(signup.id, {
    status: "CHECKED_IN",
    checkedInAt: now,
  });

  // defaultHours stamping — only when nothing already set the hours and
  // the signup has no shift to derive a duration from (ask signups never
  // do, but keep the guard honest).
  let stampedDefaultHours: number | null = null;
  if (signup.hoursWorked == null && !signup.shiftId) {
    const role = await tx.volunteering.getEventRole(signup.roleId);
    if (role?.defaultHours != null) {
      updated = await tx.volunteering.updateSignupHoursWorked({
        id: signup.id,
        hoursWorked: role.defaultHours,
      });
      stampedDefaultHours = role.defaultHours;
    }
  }

  await tx.audit.log({
    entity: "volunteer_signup",
    entityId: signup.id,
    action: "checked_in",
    data: {
      signupId: signup.id,
      actorHumanId,
      askId: ask.id,
      groupId: signup.groupId,
      via: access.via,
      ...(stampedDefaultHours != null
        ? { hoursWorkedFromDefault: stampedDefaultHours }
        : {}),
    },
    at: now,
  });

  return updated;
}

// ── withdraw-volunteer-signup ───────────────────────────────────────────────

/**
 * Everything the post-commit spot-opened fan-out needs, collected inside
 * the withdraw transaction so the notify loop never re-opens repos.
 * `eventTitle` carries the container title: event title on the event path,
 * ask title on the ask path (renderer convention).
 */
type SpotOpenedNotification = {
  recipientHumanIds: string[];
  scope:
    | { kind: "EVENT"; eventId: string }
    | { kind: "ORG"; orgId: string }
    | { kind: "GLOBAL" };
  payload: {
    eventId: string | null;
    askId?: string;
    eventTitle: string;
    roleId: string;
    roleName: string;
    shiftId: string | null;
    shiftLabel: string | null;
    pendingCount: number;
    withdrawnSignupId: string;
    signupsUrl: string;
  };
};

const ORG_MEMBERS_PAGE_SIZE = 100;

/**
 * Volunteer cancels their own signup.
 *
 * Validates the signup belongs to the authenticated human.
 * Removes the corresponding EventHuman entry if one was created.
 *
 * Spot-opened notification (Gap 9): when the withdrawn signup was APPROVED
 * and the freed shift (or shiftless role) still has ≥1 PENDING signup, the
 * org's edit-role members are notified after commit so the waitlist gets
 * acted on. No auto-promotion — capacity governs acceptance and acceptance
 * stays an admin decision. PENDING withdrawals and withdrawals with zero
 * pending applicants send nothing.
 */
export async function withdrawVolunteerSignup(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord> {
  const input = parseInput(withdrawVolunteerSignupInputSchema, rawInput);

  const { updated, spotOpened } = await deps.repos.tx(async (tx) => {
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // Must be the signup owner
    if (signup.humanId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "signup" } });
    }

    // Can only withdraw from PENDING or APPROVED
    if (signup.status !== "PENDING" && signup.status !== "APPROVED") {
      throw fail("SIGNUP_NOT_WITHDRAWABLE");
    }

    const wasApproved = signup.status === "APPROVED";
    const now = deps.clock.now();

    const updated = await tx.volunteering.updateSignupStatus(input.signupId, {
      status: "WITHDRAWN",
    });

    // Occurrence-claim cascade (generic-volunteer-shifts-occurrences
    // FR-003): withdrawing the signup auto-withdraws its FUTURE claims in
    // the SAME tx — past/checked-in claim history stays intact. Sits
    // alongside the post-commit reward-revoke hook below as the withdraw
    // side effects. Idempotent (re-running flips zero rows).
    const withdrawnClaimCount =
      await tx.volunteering.withdrawFutureClaimsBySignup(signup.id, now);

    // If was approved, remove the EventHuman entry. Ask-only signups
    // (nullable eventId since generic asks) have no EventHuman to detach.
    if (wasApproved && signup.humanId && signup.eventId) {
      // Find and detach the volunteer EventHuman
      const eventHumans = await tx.eventHumans.listByEvent(signup.eventId);
      const volunteerEntry = eventHumans.find(
        (eh) => eh.humanId === signup.humanId && eh.role === "VOLUNTEER",
      );
      if (volunteerEntry) {
        await tx.eventHumans.detach(volunteerEntry.id);
      }
    }

    // Gap 9: only an APPROVED withdrawal frees a seat. Count the waitlist
    // depth behind it — shift-scoped when the signup had a shift, else
    // role-scoped (same target scoping as the Gap 1 capacity checks) — and
    // collect the notification context while we still hold the tx repos.
    // Event signups notify the org's edit roster; ask-only signups notify
    // the ask's owner side instead (org members / HUMAN subject).
    let spotOpened: SpotOpenedNotification | null = null;
    if (wasApproved) {
      const pendingCount = await tx.volunteering.countPendingSignups(
        signup.shiftId
          ? { shiftId: signup.shiftId }
          : { roleId: signup.roleId },
      );
      if (pendingCount > 0) {
        spotOpened = signup.eventId
          ? await collectSpotOpenedNotification(
              tx,
              deps.appBaseUrl,
              signup,
              pendingCount,
            )
          : await collectAskSpotOpenedNotification(
              tx,
              deps.appBaseUrl,
              signup,
              pendingCount,
            );
      }
    }

    await tx.audit.log({
      entity: "volunteer_signup",
      entityId: input.signupId,
      action: "withdrawn",
      data: {
        humanId: input.actorHumanId,
        // Traceability: how many future occurrence claims this withdrawal
        // cascaded onto (FR-003).
        ...(withdrawnClaimCount > 0 ? { withdrawnClaimCount } : {}),
      },
      at: now,
    });

    return { updated, spotOpened };
  });

  // Post-commit fan-out to org admins. Mirrors submit/review: notification
  // failures must NOT roll back (or appear to fail) the withdrawal, so each
  // send is wrapped and error-logged. The idempotency key is per recipient
  // (`<signupId>:spot-opened:<humanId>`) — the spec's "key = signup id"
  // can't dedupe across N recipients, so the signup id anchors the key and
  // the recipient id refines it.
  if (spotOpened) {
    for (const recipientHumanId of spotOpened.recipientHumanIds) {
      try {
        await deps.notify({
          humanId: recipientHumanId,
          variant: "volunteer.spot-opened",
          payload: spotOpened.payload,
          scope: spotOpened.scope,
          idempotencyKey: `${updated.id}:spot-opened:${recipientHumanId}`,
        });
      } catch (error) {
        // ERROR (not warn): the withdrawal IS persisted but an admin won't
        // learn a seat opened — the waitlist silently rots. Surface to
        // Cloud Logging error alerts so we can replay / investigate.
        deps.logger?.error(
          "volunteering.withdrawVolunteerSignup.spot_opened_notify_failed",
          {
            signupId: updated.id,
            recipientHumanId,
            error: describeError(error),
          },
        );
        try {
          deps.reportError?.(error, {
            tags: { useCase: "withdrawVolunteerSignup", stage: "notify" },
            extra: { signupId: updated.id, recipientHumanId },
          });
        } catch {
          // Best-effort reporting only: the withdrawal is already persisted.
        }
      }
    }
  }

  // Comp-reward trigger: WITHDRAWN revokes any GRANTED (un-redeemed) grant on
  // this signup and returns its budget slot (2026-07-01 resolutions: withdraw
  // + manual are the only revoke paths — no no-show). Post-commit, idempotent,
  // failures logged.
  await maybeFireRewardRevoke(deps, updated, "signup_withdrawn");

  return updated;
}

/**
 * Build the spot-opened notification context inside the withdraw tx:
 * event title + org slug for the deep link, role/shift names, and the
 * org's edit-role members (the set that can review signups). Returns null
 * when the link or recipients can't be resolved — a missing event/org or
 * an empty admin set just means nothing to send, never a failed withdrawal.
 */
async function collectSpotOpenedNotification(
  tx: TxRepos,
  appBaseUrl: string,
  signup: VolunteerSignupRecord,
  pendingCount: number,
): Promise<SpotOpenedNotification | null> {
  // Ask-only signups (nullable eventId since generic asks) have no
  // event-scoped admin roster to notify — nothing to send.
  if (!signup.eventId) return null;
  const event = await tx.events.getById(signup.eventId);
  if (!event?.orgId) return null;

  const org = await tx.organizations.getById(event.orgId);
  if (!org) return null;

  const role = await tx.volunteering.getEventRole(signup.roleId);
  const shift = signup.shiftId
    ? await tx.volunteering.getShift(signup.shiftId)
    : null;

  // Edit-role members (OWNER/ADMIN/EDITOR) — the same set
  // reviewVolunteerSignup authorizes, so every recipient can act on the
  // link. Paginated like the dispute-lifecycle fan-out; deduped by humanId.
  const recipientHumanIds = new Set<string>();
  let offset = 0;
  let total = 0;
  do {
    const page = await tx.organizations.listMembers({
      orgId: event.orgId,
      limit: ORG_MEMBERS_PAGE_SIZE,
      offset,
    });
    total = page.total;
    for (const member of page.items) {
      if (ORG_EDIT_ROLES.includes(member.role)) {
        recipientHumanIds.add(member.humanId);
      }
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);

  if (recipientHumanIds.size === 0) return null;

  return {
    recipientHumanIds: [...recipientHumanIds],
    scope: { kind: "EVENT", eventId: signup.eventId },
    payload: {
      eventId: signup.eventId,
      eventTitle: event.title,
      roleId: signup.roleId,
      roleName: role?.name ?? "Volunteer",
      shiftId: signup.shiftId ?? null,
      // Stored labels may be "" (schema trims but allows empty); the renderer
      // schema requires min(1), so normalize to null to keep the send alive.
      shiftLabel: shift?.label?.trim() || null,
      pendingCount,
      withdrawnSignupId: signup.id,
      signupsUrl: `${appBaseUrl}/admin/${org.slug}/events/${signup.eventId}/volunteers`,
    },
  };
}

/**
 * Ask-path spot-opened context (A4): an APPROVED ask-only volunteer
 * withdrew and the freed role still has pending applicants. Recipients
 * mirror the spot-opened convention on the ask's owner side:
 *
 * - `orgId` set → the org's edit-role members (same set that can review),
 * - else a HUMAN subject → that human,
 * - else skip: a PLACE ask without a granting org has no resolvable owner
 *   roster here (place ownership can be a human owner set we don't fan out
 *   to yet) — nothing to send beats guessing.
 */
async function collectAskSpotOpenedNotification(
  tx: TxRepos,
  appBaseUrl: string,
  signup: VolunteerSignupRecord,
  pendingCount: number,
): Promise<SpotOpenedNotification | null> {
  if (!signup.askId) return null;
  const ask = await tx.volunteering.getAsk(signup.askId);
  if (!ask) return null;

  const role = await tx.volunteering.getEventRole(signup.roleId);

  let recipientHumanIds: string[];
  let scope: SpotOpenedNotification["scope"];
  if (ask.orgId) {
    const ids = new Set<string>();
    let offset = 0;
    let total = 0;
    do {
      const page = await tx.organizations.listMembers({
        orgId: ask.orgId,
        limit: ORG_MEMBERS_PAGE_SIZE,
        offset,
      });
      total = page.total;
      for (const member of page.items) {
        if (ORG_EDIT_ROLES.includes(member.role)) {
          ids.add(member.humanId);
        }
      }
      offset += page.items.length;
      if (page.items.length === 0) break;
    } while (offset < total);
    if (ids.size === 0) return null;
    recipientHumanIds = [...ids];
    scope = { kind: "ORG", orgId: ask.orgId };
  } else if (ask.subjectType === "HUMAN") {
    recipientHumanIds = [ask.subjectId];
    scope = { kind: "GLOBAL" };
  } else {
    return null;
  }

  return {
    recipientHumanIds,
    scope,
    payload: {
      eventId: null,
      askId: ask.id,
      eventTitle: ask.title,
      roleId: signup.roleId,
      roleName: role?.name ?? "Volunteer",
      shiftId: null,
      shiftLabel: null,
      pendingCount,
      withdrawnSignupId: signup.id,
      // Owner-side ask dashboards aren't built yet (A4 is core-only); the
      // coordinator console route is the closest review surface today.
      signupsUrl: `${appBaseUrl}/volunteers/coordinate/${ask.id}`,
    },
  };
}

// ── list-my-volunteer-signups ───────────────────────────────────────────────

/**
 * Authenticated user views their volunteering commitments across events.
 */
export async function listMyVolunteerSignups(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord[]> {
  const input = parseInput(listMyVolunteerSignupsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    return tx.volunteering.listSignupsByHuman(input.actorHumanId);
  });
}

// ── list-my-volunteer-commitments ───────────────────────────────────────────

/**
 * Read model behind the attendee-facing `/my-volunteering` page: every
 * volunteer commitment the signed-in human holds, past and future, in every
 * status — unlike `listMyVolunteerSignups` (bare id-only signup rows, kept
 * for the event-page section) these carry the display join the page needs
 * (event/ask title, role, shift window, venue).
 *
 * Authenticated SELF-read: the actor is the only human whose rows can be
 * reached — there is no id parameter to point somewhere else.
 *
 * INCLUDES standing/recurring commitments: a `VolunteerOccurrenceClaim` on a
 * dated slot becomes its own row carrying the OCCURRENCE's window, and the
 * bare parent signup row is suppressed so the volunteer sees their actual
 * dates rather than those dates plus a windowless duplicate. Row identity is
 * `claimId ?? signupId` — one signup emits many occurrence rows.
 *
 * BOUNDED and unpaginated: the port caps each source separately (signups,
 * upcoming claims, past claims) and drops the oldest first within each, so a
 * very long-serving volunteer loses the tail of their history. Callers must
 * not present this as exhaustive history. See the port doc for exactly what
 * each bound can and cannot guarantee.
 *
 * `deps.clock` is passed through to split the claim read at "now"; it filters
 * nothing — past commitments are in the result either way.
 *
 * `signupsPaused` (ban that sticks, owner ruling 2026-10-08): true when the
 * row's ask belongs to a withheld owner, so the page can say the ask takes
 * no new shifts. The row itself is still listed exactly as before: claims
 * already held stand. The flag never says why. One batched owner read and
 * one `bans.findBannedOwners` call cover every row; no per-row queries.
 */
export type MyVolunteerCommitment = Omit<
  VolunteerCommitmentRecord,
  "reminderBasis"
> & {
  signupsPaused: boolean;
  /**
   * Whether a text reminder is sent for this signup at all
   * (`signupReminderAnchor`), derived here per read, never stored: a shift
   * row, a shiftless row on an event role with no shifts, or a ONE_TIME
   * non-EVENT ask with a start. The row's texts switch shows only when true.
   */
  textRemindersOffered: boolean;
  /**
   * What the reminder comes before, or null when none is sent. The web words
   * the texts switch from this, never from the row's shape.
   */
  reminderAnchor: SignupReminderAnchor | null;
};

export async function listMyVolunteerCommitments(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<MyVolunteerCommitment[]> {
  const input = parseInput(listMyVolunteerCommitmentsInputSchema, rawInput);
  const now = deps.clock.now();

  return deps.repos.tx(async (tx) => {
    const rows = await tx.volunteering.listCommitmentsByHuman(
      input.actorHumanId,
      now,
    );
    // The venue line is gated like a ticket holder's address: no street
    // before the event's reveal, none ever for NEVER (organizers can tell
    // their volunteers directly), the Place's street — not the Event row's
    // public projection — for a venue that withholds its address, and only
    // when that venue vouched for the event. This page lists EVERY status,
    // so each row is gated on its own: only an accepted volunteer (APPROVED
    // or CHECKED_IN) is a holder. PENDING, REJECTED, WITHDRAWN and NO_SHOW
    // rows carry no location at all.
    const holderAddresses = await loadHolderAddressesForEventIds({
      repos: tx,
      eventIds: eventIdsWithAddress(
        rows.filter((row) => volunteerMayReceiveAddress(row.status)),
      ),
      activeHolder: true,
      now,
    });
    // Ban that sticks: which rows' asks belong to a withheld owner. One
    // owner read for the distinct ask ids, one bans call for all of them;
    // an empty list (or a list with no ask rows) makes neither call.
    const askIds = [
      ...new Set(
        rows.map((row) => row.askId).filter((id): id is string => id != null),
      ),
    ];
    const withheldAskIds =
      askIds.length > 0
        ? await findWithheldAskIds(
            tx,
            await tx.volunteering.listAskOwnersByIds(askIds),
          )
        : new Set<string>();
    return rows.map(({ reminderBasis, ...row }) => {
      const reminderAnchor = signupReminderAnchor({
        shiftId: reminderBasis.shiftId,
        eventId: row.eventId,
        roleHasShifts: reminderBasis.roleHasShifts,
        ask: reminderBasis.ask,
      });
      return {
        ...row,
        addressText: gatedRowAddressText(row, holderAddresses, {
          activeHolder: volunteerMayReceiveAddress(row.status),
        }),
        signupsPaused: row.askId != null && withheldAskIds.has(row.askId),
        textRemindersOffered: reminderAnchor !== null,
        reminderAnchor,
      };
    });
  });
}

// ── list-volunteer-signups (admin) ──────────────────────────────────────────

/**
 * Admin lists volunteer signups for an event, with optional filters.
 */
export async function listVolunteerSignups(
  deps: VolunteerSignupDeps,
  rawInput: unknown,
): Promise<OffsetPaginatedResult<VolunteerSignupRecord>> {
  const input = parseInput(listVolunteerSignupsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);
    if (!event || !event.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }

    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });

    return tx.volunteering.listSignups(input.eventId, {
      roleId: input.roleId,
      shiftId: input.shiftId,
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
  });
}
