import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventInviteRecord, EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../../lib/io";
import { plainTextRequired } from "../../../lib/sanitize-plain-text";
import {
  hashInviteToken,
  mintInviteToken,
} from "../../../lib/security/invite-token";
import { ensureActorCanEditEvent } from "../_shared/ensure-actor-can-edit-event";
import {
  assertEventTakesGuestInvites,
  assertInviteEmailConfig,
  hasErrorCode,
  type InviteLinkConfig,
  inviteOptOutOwner,
  reportSwallowed,
  resolveOrganizerName,
  sendInviteEmail,
} from "./_shared";
import { hashInviteOptOutEmail } from "../../../lib/security/invite-optout-token";
import { chargeInviteAllowance } from "./invite-allowance";
import { assertInvitesNotPaused } from "./invite-complaint-pause";

/**
 * Create PERSONAL invites and email each guest their link
 * (gated-event invite links FR-002, FR-003, R7, R12, R13, NFR-004).
 *
 * Two sources, one use case (the announcements rework will call it too, R12):
 *  - `guests`: hand-added name + email.
 *  - `contactListId`: one of the event owner's contact lists. Entries with
 *    `unsubscribedAt` are skipped and counted (FR-003); phone-only entries
 *    are skipped too.
 *
 * Opt-outs apply to EVERY recipient, both sources, org- and person-owned
 * events alike (owner ruling 2026-10-05, replacing R13's "a hand-added guest
 * is always emailed"): the org's announcement suppression list (org-owned
 * events) and the per-organiser "Stop invites from this organiser" list. An
 * opted-out address gets no invite row and no email, and is only counted
 * (`skippedOptedOut`): which addresses opted out is not echoed back. One
 * exception: without `resendExisting`, an address that already holds a live
 * invite is reported as `reused` whether or not it opted out since (see the
 * allowance note below). With `resendExisting` it is skipped and counted.
 *
 * Allowance (security review F1): every email this call will send counts
 * against the rolling 24h recipient allowance of the actor AND the event
 * owner (`invite-allowance.ts`; 10 a day while the sender's account is under
 * a week old), charged before any row is written. An actor without a
 * verified email is refused first (`EMAIL_NOT_VERIFIED`). Over it
 * = INVITE_ALLOWANCE_EXCEEDED and nothing is created or sent. Emails that
 * don't go out (the provider rejects them, or the insert throws) are
 * refunded; a limiter outage fails closed (SERVICE_UNAVAILABLE).
 *
 * Opted-out recipients are charged too (owner ruling 2026-10-07): each one
 * costs one unit, the same as a sent email, and that unit is never refunded,
 * not even when the insert throws. Without that, a throwaway organiser could
 * learn who opted out without spending anything. The charge (and so
 * `requested` on a refusal) is therefore the same whether or not an address
 * opted out. Free: unsubscribed list entries (the organiser already sees
 * that status on the audience page and export, so charging hides nothing
 * and would only refuse real sends; review ruling 2026-10-07), phone-only
 * entries (no address), repeats of one address within the call, and,
 * without `resendExisting`, an address that already holds a live invite (a
 * no-op either way). Such an address reads as `reused` even if it has opted
 * out since, so that answer is never free either.
 *
 * One send is capped at {@link MAX_GUEST_INVITE_RECIPIENTS} recipients
 * (NFR-004); a larger list goes through announcements.
 *
 * Dedupe: one live PERSONAL invite per (event, lowercased email). An email
 * that already has one REUSES it: no new row, and no email unless the caller
 * passed `resendExisting`.
 *
 * Writes: every new invite row and the audit row commit in ONE transaction.
 * Mail goes out after the commit, best-effort: a failed send keeps the invite
 * (sentAt stays null, the panel shows it Unsent with a Resend action) and is
 * reported through ReporterPort, once per batch so an ESP outage is one
 * Sentry event, not 500.
 */

export const MAX_GUEST_INVITE_RECIPIENTS = 500;
/** Minimum gap between two sends of the SAME invite (resendEventGuestInvite). */
export const INVITE_RESEND_COOLDOWN_SECONDS = 10 * 60;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const LIST_PAGE_SIZE = 200;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX)
  .pipe(z.string().email());

const guestSchema = z
  .object({
    name: plainTextRequired(NAME_MAX),
    email: emailSchema,
  })
  .strict();

const baseInput = {
  eventId: z.string().uuid(),
  actorHumanId: z.string().uuid(),
  /** Also re-send to guests who already had a live invite. */
  resendExisting: z.boolean().optional(),
};

export const createEventGuestInvitesInputSchema = z.union([
  z
    .object({
      ...baseInput,
      guests: z.array(guestSchema).min(1).max(MAX_GUEST_INVITE_RECIPIENTS),
    })
    .strict(),
  z
    .object({
      ...baseInput,
      contactListId: z.string().uuid(),
    })
    .strict(),
]);

export const createEventGuestInvitesOutputSchema = z
  .object({
    /** New invite rows. */
    created: z.number().int().nonnegative(),
    /** Recipients that already had a live invite (no new row). */
    reused: z.number().int().nonnegative(),
    /** List entries skipped for being unsubscribed from that list. */
    skippedUnsubscribed: z.number().int().nonnegative(),
    /**
     * Recipients skipped because they opted out: the org's announcement
     * suppression list, or "Stop invites from this organiser". Counted for
     * both sources; never which addresses. Each one is charged to the
     * allowance. An already-invited address is reported as `reused` instead
     * unless `resendExisting`.
     */
    skippedOptedOut: z.number().int().nonnegative(),
    /** List entries skipped for having no email address. */
    skippedNoEmail: z.number().int().nonnegative(),
    /** Emails accepted by the mailer. */
    sent: z.number().int().nonnegative(),
    /** Emails that failed; their invites exist, unsent. */
    failed: z.number().int().nonnegative(),
  })
  .strict();

export type CreateEventGuestInvitesInput = z.input<
  typeof createEventGuestInvitesInputSchema
>;
export type CreateEventGuestInvitesOutput = z.infer<
  typeof createEventGuestInvitesOutputSchema
>;

export type CreateEventGuestInvitesDeps = InviteLinkConfig & {
  repos: Repos;
  clock: ClockPort;
  mailer?: MailerPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * Backs the recipient allowance. Optional so unit tests and callers
   * without Redis still work; the API always wires it (`ctx.rateLimit`).
   */
  rateLimit?: Pick<RateLimitPort, "consumeAllowance" | "refundAllowance"> | null;
};

type Recipient = {
  email: string;
  name: string | null;
  inviteListEntryId: string | null;
};

const USE_CASE = "createEventGuestInvites";

export async function createEventGuestInvites(
  deps: CreateEventGuestInvitesDeps,
  rawInput: unknown,
): Promise<CreateEventGuestInvitesOutput> {
  const input = parseInput(createEventGuestInvitesInputSchema, rawInput);

  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  // NFR-004 + owner ruling 2026-10-06: this mails on the organizer's
  // behalf, so only from a verified account. Before any charge or write.
  await ensureSenderEmailVerified(deps, input.actorHumanId);
  const now = deps.clock.now();
  assertEventTakesGuestInvites(event, now);
  assertInviteEmailConfig(deps);
  // Complaint auto-pause (W4): refused before any charge or write; checked
  // once, so a pause opening mid-batch doesn't stop this batch.
  await assertInvitesNotPaused(deps, event, USE_CASE);

  const listed =
    "guests" in input
      ? {
          recipients: dedupeByEmail(
            input.guests.map((g) => ({
              email: g.email,
              name: g.name,
              inviteListEntryId: null,
            })),
          ),
          skippedUnsubscribed: 0,
          skippedNoEmail: 0,
        }
      : await recipientsFromList(deps, event, input.contactListId);
  const { skippedUnsubscribed, skippedNoEmail } = listed;
  const { kept: recipients } = await withoutOptedOut(
    deps,
    event,
    listed.recipients,
  );
  const keptEmails = new Set(recipients.map((r) => r.email));
  const optedOutEmails = listed.recipients
    .map((r) => r.email)
    .filter((email) => !keptEmails.has(email));

  // Read outside the insert transaction, so a concurrent send can shift a
  // guest between "new" and "reused"; the send below never exceeds the
  // mail share of the charge.
  const live = await liveInviteEmails(deps, event.id);
  // Already invited and not re-sending: a no-op whether or not they opted
  // out, so free and reported as reused. Counting it as skipped here (and
  // charging for it) would make the charge differ by opt-out status.
  const optedOutReused = input.resendExisting
    ? 0
    : optedOutEmails.filter((email) => live.has(email)).length;
  const skippedOptedOut = optedOutEmails.length - optedOutReused;

  // Charge before any row is written. Two shares:
  //  - mail: the emails this call will send (new invites, plus the reused
  //    ones when re-sending); what doesn't go out is refunded below;
  //  - skips: opted-out addresses (owner ruling 2026-10-07), never
  //    refunded. Unsubscribed list entries are free: the organiser already
  //    sees that status, so there is nothing to hide.
  const mailCharge = input.resendExisting
    ? recipients.length
    : recipients.filter((r) => !live.has(r.email)).length;
  const skipCharge = skippedOptedOut;
  const charge = await chargeInviteAllowance(deps, {
    event,
    actorHumanId: input.actorHumanId,
    recipients: mailCharge + skipCharge,
    now,
    useCase: USE_CASE,
  });

  // A concurrent send for the same email can win the unique index between
  // our pre-check and insert. The transaction then rolls back whole, so the
  // retry re-plans from scratch and sees that invite as reused.
  let plan: Awaited<ReturnType<typeof planAndInsert>>;
  try {
    try {
      plan = await planAndInsert(deps, event, input.actorHumanId, recipients, now);
    } catch (error) {
      if (!hasErrorCode(error, "personal_invite_already_live")) throw error;
      plan = await planAndInsert(deps, event, input.actorHumanId, recipients, now);
    }
  } catch (error) {
    // Nothing was written or mailed: hand back the mail share. The skip
    // share is kept, so a failed insert never refunds opted-out units. A
    // kept address's refund is the same accepted residual as a provider
    // failure: it needs an outage the sender can't cause.
    await charge.refund(mailCharge);
    throw error;
  }

  const wanted = input.resendExisting
    ? [...plan.created, ...plan.reused]
    : plan.created;
  // Never more mail than was charged. Only a race can make `wanted` longer;
  // the extra invites stay Unsent, and their Resend charges for itself.
  const toSend = wanted.slice(0, mailCharge);
  const { sent, failed, mailed } = await sendBatch(deps, event, toSend, now);
  // Hand back the mail share that didn't go out: provider rejections, plus
  // any charge a race left unused (a guest that turned from new into
  // reused). Never the skip share. Accepted residual risk (review
  // 2026-10-07): a provider rejection refunds the unit of a guest who is
  // NOT opted out, so a failed send hints at "not opted out" for free. That
  // takes a provider outage the sender can't cause, so the refund stays.
  await charge.refund(mailCharge - mailed);

  return createEventGuestInvitesOutputSchema.parse({
    created: plan.created.length,
    reused: plan.reused.length + optedOutReused,
    skippedUnsubscribed,
    skippedOptedOut,
    skippedNoEmail,
    sent,
    failed,
  });
}

// ─── Resend one ──────────────────────────────────────────────────────────

export const resendEventGuestInviteInputSchema = z
  .object({
    eventId: z.string().uuid(),
    inviteId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
  })
  .strict();

export const resendEventGuestInviteOutputSchema = z
  .object({
    inviteId: z.string().uuid(),
    /** False when the mailer failed (reported, not thrown) or `optedOut`. */
    sent: z.boolean(),
    /**
     * True when the guest has since opted out (org suppression list or
     * "Stop invites from this organiser"): nothing was sent, but the
     * allowance unit is kept (owner ruling 2026-10-07).
     */
    optedOut: z.boolean(),
    sentAt: z.date().nullable(),
  })
  .strict();

export type ResendEventGuestInviteInput = z.infer<
  typeof resendEventGuestInviteInputSchema
>;
export type ResendEventGuestInviteOutput = z.infer<
  typeof resendEventGuestInviteOutputSchema
>;

/** The Resend action on one guest row (FR-002). Live invites only. */
export async function resendEventGuestInvite(
  deps: CreateEventGuestInvitesDeps,
  rawInput: unknown,
): Promise<ResendEventGuestInviteOutput> {
  const input = parseInput(resendEventGuestInviteInputSchema, rawInput);
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  await ensureSenderEmailVerified(deps, input.actorHumanId);
  const now = deps.clock.now();
  assertEventTakesGuestInvites(event, now);
  assertInviteEmailConfig(deps);
  await assertInvitesNotPaused(deps, event, "resendEventGuestInvite");

  const invite = await deps.repos.eventInvites.getById(input.inviteId);
  if (!invite || invite.eventId !== event.id || invite.kind !== "PERSONAL") {
    throw fail("MAGIC_LINK_NOT_FOUND");
  }
  if (invite.revokedAt) {
    throw fail("INVALID_STATUS", { message: "invite_revoked" });
  }
  // Cooldown: one invite can't be re-mailed within
  // INVITE_RESEND_COOLDOWN_SECONDS of its last send (a double click, or a
  // loop hammering one inbox). Checked before the allowance, so a refused
  // resend costs nothing, and before the opt-out, so this free refusal
  // never depends on (or hints at) whether the guest opted out.
  if (invite.sentAt) {
    const elapsedMs = now.getTime() - invite.sentAt.getTime();
    const cooldownMs = INVITE_RESEND_COOLDOWN_SECONDS * 1000;
    if (elapsedMs < cooldownMs) {
      throw fail("INVITE_RESEND_TOO_SOON", {
        meta: {
          retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000)),
        },
      });
    }
  }

  const charge = await chargeInviteAllowance(deps, {
    event,
    actorHumanId: input.actorHumanId,
    recipients: 1,
    now,
    useCase: "resendEventGuestInvite",
  });

  // The opt-out answer costs the unit too (owner ruling 2026-10-07), so it
  // is read only after the charge and that unit is kept.
  let optedOut: number;
  try {
    // A PERSONAL row always has an email (DB CHECK).
    ({ optedOut } = await withoutOptedOut(deps, event, [
      { email: invite.inviteeEmail ?? "", name: null, inviteListEntryId: null },
    ]));
  } catch (error) {
    // Nothing answered, nothing sent: hand the unit back, then rethrow.
    await charge.refund(charge.charged);
    throw error;
  }
  if (optedOut > 0) {
    return resendEventGuestInviteOutputSchema.parse({
      inviteId: invite.id,
      sent: false,
      optedOut: true,
      sentAt: invite.sentAt,
    });
  }

  const { sent, sentAt, mailed } = await sendBatch(deps, event, [invite], now);
  // Accepted residual risk (review 2026-10-07): a provider rejection here
  // refunds the unit of a guest who is NOT opted out, a free hint. It needs
  // a provider outage the sender can't cause, so the refund stays.
  await charge.refund(charge.charged - mailed);
  return resendEventGuestInviteOutputSchema.parse({
    inviteId: invite.id,
    sent: sent === 1,
    optedOut: false,
    sentAt: sentAt.get(invite.id) ?? invite.sentAt,
  });
}

// ─── Internals ───────────────────────────────────────────────────────────

/**
 * Sending invites needs a verified account email (owner ruling 2026-10-06).
 * `EMAIL_NOT_VERIFIED` (FORBIDDEN at the transport), the code the web
 * already maps; an actor with no account identity can't prove an address
 * either, so it gets the same answer.
 */
async function ensureSenderEmailVerified(
  deps: CreateEventGuestInvitesDeps,
  actorHumanId: string,
): Promise<void> {
  const actor = await deps.repos.humans.getByIdWithIdentity(actorHumanId);
  if (!actor?.identity.emailVerified) {
    throw fail("EMAIL_NOT_VERIFIED");
  }
}

function dedupeByEmail(recipients: Recipient[]): Recipient[] {
  const seen = new Map<string, Recipient>();
  for (const r of recipients) {
    if (!seen.has(r.email)) seen.set(r.email, r);
  }
  return [...seen.values()];
}

async function recipientsFromList(
  deps: CreateEventGuestInvitesDeps,
  event: EventRecord,
  contactListId: string,
): Promise<{
  recipients: Recipient[];
  skippedUnsubscribed: number;
  skippedNoEmail: number;
}> {
  const list = await deps.repos.inviteLists.getListById(contactListId);
  // Only the event owner's own lists. A list of another org reads exactly
  // like a missing one.
  const ownedByEventOwner =
    list !== null &&
    ((list.ownerType === "ORGANIZATION" && list.ownerId === event.orgId) ||
      (list.ownerType === "HUMAN" && list.ownerId === event.humanId));
  if (!list || !ownedByEventOwner) {
    throw fail("TARGET_LIST_NOT_FOUND");
  }

  // Read one past the cap so an over-cap list is refused, not truncated.
  const entries = [];
  for (let offset = 0; entries.length <= MAX_GUEST_INVITE_RECIPIENTS; ) {
    const page = await deps.repos.inviteLists.listEntries({
      inviteListId: list.id,
      limit: LIST_PAGE_SIZE,
      offset,
    });
    entries.push(...page);
    if (page.length < LIST_PAGE_SIZE) break;
    offset += page.length;
  }
  if (entries.length > MAX_GUEST_INVITE_RECIPIENTS) {
    throw fail("INVALID_INPUT", {
      message: "guest_invite_list_too_large",
      meta: { max: MAX_GUEST_INVITE_RECIPIENTS },
    });
  }

  let skippedUnsubscribed = 0;
  let skippedNoEmail = 0;
  const candidates: Recipient[] = [];
  for (const entry of entries) {
    const email = entry.contactEmail?.trim().toLowerCase() ?? "";
    if (!email) {
      skippedNoEmail += 1;
      continue;
    }
    if (entry.unsubscribedAt) {
      skippedUnsubscribed += 1;
      continue;
    }
    candidates.push({
      email,
      name: entry.displayName?.trim() || null,
      inviteListEntryId: entry.id,
    });
  }

  return {
    recipients: dedupeByEmail(candidates),
    skippedUnsubscribed,
    skippedNoEmail,
  };
}

/**
 * Drop every recipient who opted out of this organiser's mail: the org's
 * announcement suppression list (the one `sendAnnouncement` honours; org-
 * owned events only), "Stop invites from this organiser" and "Stop all
 * event invites", matched on the keyed hash of each candidate's CANONICAL
 * address (so "+tag" and Gmail dot aliases of an opted-out address are
 * dropped too). One count for every kind: an organiser never learns which
 * "no" it was. Lookup failures propagate: an unanswerable opt-out must
 * never read as "send".
 */
async function withoutOptedOut(
  deps: CreateEventGuestInvitesDeps,
  event: EventRecord,
  recipients: Recipient[],
): Promise<{ kept: Recipient[]; optedOut: number }> {
  if (recipients.length === 0) return { kept: recipients, optedOut: 0 };
  const emails = recipients.map((r) => r.email);
  const owner = inviteOptOutOwner(event);
  // assertInviteEmailConfig ran first, so the secret is there.
  const secret = deps.inviteOptOutSecret ?? "";
  const hashOf = new Map(
    emails.map((e) => [e, hashInviteOptOutEmail(e, secret)] as const),
  );
  const [suppressed, optedOut] = await Promise.all([
    event.orgId
      ? deps.repos.announcements.getAnonymousSuppressedEmails({
          orgId: event.orgId,
          emails,
        })
      : Promise.resolve(new Set<string>()),
    // A null owner still checks "Stop all event invites".
    deps.repos.eventInviteOptOuts.listOptedOut({
      owner,
      emailHashes: [...hashOf.values()],
    }),
  ]);
  const kept = recipients.filter((r) => {
    const hash = hashOf.get(r.email);
    return (
      !suppressed.has(r.email.toLowerCase()) &&
      !(hash !== undefined && optedOut.has(hash))
    );
  });
  return { kept, optedOut: recipients.length - kept.length };
}

/** Lowercased emails of the event's live PERSONAL invites. */
async function liveInviteEmails(
  deps: CreateEventGuestInvitesDeps,
  eventId: string,
): Promise<Set<string>> {
  const rows = await deps.repos.eventInvites.listByEvent(eventId);
  return new Set(
    rows
      .filter((i) => i.kind === "PERSONAL" && i.revokedAt === null)
      .map((i) => (i.inviteeEmail ?? "").toLowerCase()),
  );
}

async function planAndInsert(
  deps: CreateEventGuestInvitesDeps,
  event: EventRecord,
  actorHumanId: string,
  recipients: Recipient[],
  now: Date,
): Promise<{ created: EventInviteRecord[]; reused: EventInviteRecord[] }> {
  return deps.repos.tx(async (tx) => {
    const created: EventInviteRecord[] = [];
    const reused: EventInviteRecord[] = [];
    for (const recipient of recipients) {
      const live = await tx.eventInvites.findLivePersonalByEmail(
        event.id,
        recipient.email,
      );
      if (live) {
        reused.push(live);
        continue;
      }
      const id = randomUUID();
      created.push(
        await tx.eventInvites.create({
          id,
          eventId: event.id,
          kind: "PERSONAL",
          tokenHash: hashInviteToken(mintInviteToken(id, deps.inviteTokenSecret)),
          createdByHumanId: actorHumanId,
          inviteeName: recipient.name,
          inviteeEmail: recipient.email,
          inviteListEntryId: recipient.inviteListEntryId,
        }),
      );
    }
    if (created.length > 0) {
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "event_guest_invites_created",
        data: {
          actorHumanId,
          inviteIds: created.map((i) => i.id),
          reusedCount: reused.length,
        },
        at: now,
      });
    }
    return { created, reused };
  });
}

/**
 * Post-commit sends. Each success stamps `sentAt`; each failure is counted
 * and the invite stays unsent. Deliberate swallow → logger.error + ONE
 * guarded report for the batch (never the token: extras carry ids only).
 */
async function sendBatch(
  deps: CreateEventGuestInvitesDeps,
  event: EventRecord,
  invites: EventInviteRecord[],
  now: Date,
): Promise<{
  sent: number;
  failed: number;
  /** Emails the provider accepted (a later markSent failure still counts). */
  mailed: number;
  sentAt: Map<string, Date>;
}> {
  const sentAt = new Map<string, Date>();
  if (invites.length === 0) return { sent: 0, failed: 0, mailed: 0, sentAt };

  let organizerName: string | null = null;
  try {
    organizerName = await resolveOrganizerName(deps.repos, event);
  } catch (error) {
    // Costs the email its organizer line, not the send.
    deps.logger?.error(`events.${USE_CASE}.organizer_lookup_failed`, {
      eventId: event.id,
      err: error,
      error: describeError(error),
    });
    reportSwallowed(deps.reportError, error, {
      tags: { useCase: USE_CASE, channel: "organizerLookup" },
      extra: { eventId: event.id },
    });
  }

  let failed = 0;
  let mailed = 0;
  let firstError: unknown = undefined;
  let firstFailedInviteId: string | null = null;
  for (const invite of invites) {
    try {
      await sendInviteEmail(deps, { event, invite, organizerName, at: now });
      mailed += 1;
      await deps.repos.eventInvites.markSent(invite.id, now);
      sentAt.set(invite.id, now);
    } catch (error) {
      failed += 1;
      if (firstError === undefined) {
        firstError = error;
        firstFailedInviteId = invite.id;
      }
    }
  }

  if (failed > 0) {
    deps.logger?.error(`events.${USE_CASE}.invite_email_failed`, {
      eventId: event.id,
      failed,
      attempted: invites.length,
      firstFailedInviteId,
      err: firstError,
      error: describeError(firstError),
    });
    reportSwallowed(deps.reportError, firstError, {
      tags: { useCase: USE_CASE, channel: "inviteEmail" },
      extra: {
        eventId: event.id,
        failed,
        attempted: invites.length,
        firstFailedInviteId,
      },
    });
  }

  return { sent: sentAt.size, failed, mailed, sentAt };
}
