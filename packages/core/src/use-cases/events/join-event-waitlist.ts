import { createHash } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TurnstilePort } from "@th/ports/turnstile";
import type {
  EventGateType,
  EventVisibility,
  EventWaitlistEntryRecord,
} from "@th/ports/repos/events";

import { describeError, parseInput } from "../../lib/io";
import * as eventGateLogger from "../../lib/log-event-gate";
import {
  contactEmailSchema,
  contactPhoneSchema,
  hasViewerContact,
} from "./_shared/viewer-contact-schema";
import {
  eventWaitlistEntryRecordSchema,
  waitlistEntryStatuses,
} from "./_shared/event-waitlist-entry-schema";
import { computeWaitlistState } from "./_shared/waitlist-state";
import { sendWaitlistConfirmationEmail } from "./send-waitlist-confirmation-email";
import { fail } from "@th/errors";

const metadataSchema = z.record(z.string(), z.unknown()).default({});
const ACTIVE_WAITLIST_STATUSES = ["PENDING", "NOTIFIED", "PURCHASED"] as const;

/**
 * Confirmation-email caps (F8, 2026-09-29 scanner report). The email carries
 * organiser-written subject and body and the join is anonymous, so without a
 * ceiling an organiser could mail any address list through our sender by
 * joining their own waitlist as each victim. Consumed only when an email is
 * about to be sent; a denied cap still records the join, it just skips the
 * email.
 */
export const WAITLIST_CONFIRMATION_PER_RECIPIENT_DAILY_MAX = 3;
export const WAITLIST_CONFIRMATION_PER_EVENT_DAILY_MAX = 200;
const WAITLIST_CONFIRMATION_WINDOW_SECONDS = 24 * 60 * 60;

/** Keyed by a hash so raw addresses never sit in Redis key names. */
export const waitlistConfirmationRecipientKey = (email: string) =>
  `waitlist:confirm:to:${createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")}`;
export const waitlistConfirmationEventKey = (eventId: string) =>
  `waitlist:confirm:event:${eventId}`;
export const WAITLIST_CONFIRMATION_PER_OWNER_DAILY_MAX = 1000;
/** The event's owning org, else its owning human; null for ownerless rows. */
export const waitlistConfirmationOwnerKey = (event: {
  orgId: string | null;
  humanId: string | null;
}): string | null =>
  event.orgId
    ? `waitlist:confirm:org:${event.orgId}`
    : event.humanId
      ? `waitlist:confirm:human:${event.humanId}`
      : null;

/** Base shape without refinements — safe for `.omit()` in tRPC routers. */
export const joinEventWaitlistInputSchemaBase = z.object({
  eventId: z.string().uuid(),
  viewerHumanId: z.string().uuid().nullable().optional(),
  contactEmail: contactEmailSchema,
  contactPhone: contactPhoneSchema,
  metadata: metadataSchema.optional(),
  /**
   * Cloudflare Turnstile token. Required for ANONYMOUS joins whenever
   * Turnstile is enabled (same flag as embed checkout / event applications);
   * signed-in joins skip it.
   */
  turnstileToken: z.string().min(1).max(4096).optional(),
  /** Set by the transport from the request; never client-supplied. */
  requestIp: z.string().max(128).nullable().optional(),
});

export const joinEventWaitlistInputSchema = joinEventWaitlistInputSchemaBase
  .refine(hasViewerContact, {
    message: "contact_required",
    path: ["contactEmail"],
  })
  .strict();

export const joinEventWaitlistOutputSchema = z.object({
  eventId: z.string().uuid(),
  entry: eventWaitlistEntryRecordSchema,
  alreadyJoined: z.boolean(),
});

export type JoinEventWaitlistInput = z.infer<
  typeof joinEventWaitlistInputSchema
>;
export type JoinEventWaitlistOutput = z.infer<
  typeof joinEventWaitlistOutputSchema
>;

export type JoinEventWaitlistDeps = {
  repos: Pick<Repos, "events" | "eventWaitlists">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** When provided, a confirmation email is sent to the entrant (best-effort). */
  mailer?: MailerPort;
  /** Required when mailer is provided. Public app base URL (e.g. https://ithasfire.com). */
  publicAppUrl?: string;
  /** Bot protection for anonymous joins; enforced when `enabled`. */
  turnstile?: TurnstilePort | null;
  /**
   * Backs the confirmation-email caps. When a mailer is wired but this is
   * not, the email is skipped rather than sent uncapped.
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  /** Reports the cap check's swallow branch (limiter backend failure). */
  reportError?: ReporterPort;
};

export async function joinEventWaitlist(
  deps: JoinEventWaitlistDeps,
  rawInput: unknown,
): Promise<JoinEventWaitlistOutput> {
  const input = parseInput(joinEventWaitlistInputSchema, rawInput);
  const event = await deps.repos.events.getById(input.eventId, {
    withOwnerStanding: true,
  });
  // A banned owner's event is hidden (ban-that-sticks): it answers like a
  // missing event, and nobody new joins its waitlist.
  if (!event || event.ownerBanned === true) {
    throw fail("EVENT_NOT_FOUND");
  }

  const now = deps.clock.now();
  const waitlistState = computeWaitlistState(
    event.waitlistStatus,
    event.waitlistPublishAt,
    now,
  );
  if (!waitlistState.open) {
    throw fail("WAITLIST_NOT_OPEN");
  }

  const viewerHumanId = input.viewerHumanId ?? null;

  // ── Turnstile (bot protection) — anonymous joins only ──────────────────
  // Same enforcement shape as submitEventApplication / embed checkout. Runs
  // before the dedupe read so a bot can't probe which addresses are already
  // on the list.
  if (!viewerHumanId && deps.turnstile?.enabled) {
    if (!input.turnstileToken) {
      throw fail("TURNSTILE_TOKEN_REQUIRED");
    }
    const valid = await deps.turnstile.verify(
      input.turnstileToken,
      input.requestIp ?? undefined,
    );
    if (!valid) {
      deps.logger?.warn("joinEventWaitlist.turnstileFailed", {
        eventId: event.id,
      });
      throw fail("TURNSTILE_VERIFICATION_FAILED");
    }
  }
  // A signed-in join is keyed to the account (viewerHumanId). A client-typed
  // address is ignored there: it skipped Turnstile, so accepting it would let
  // any signed-in account aim the organiser-written email at a third party.
  // The web's signed-in path never sends one.
  const contactEmail = viewerHumanId ? null : (input.contactEmail ?? null);
  const contactPhone = viewerHumanId ? null : (input.contactPhone ?? null);

  const existingEntry = await findExistingEntry(
    deps.repos.eventWaitlists,
    event.id,
    viewerHumanId,
    contactEmail,
    contactPhone,
  );

  if (existingEntry) {
    // ── Durable record of INDEPENDENT join intent ────────────────────────
    // The dedupe branch is otherwise a pure no-op, which silently loses a
    // fact the rescind path needs: this person asked to be on the waitlist
    // THEMSELVES. That matters when an application decision created the
    // entry first (source APPLICATION) and the applicant then joins via the
    // gate's WaitlistJoinForm — without a marker, rescinding the decision
    // would DROP an entry the person independently signed up for.
    // `publicJoinedAt` makes the intent durable instead of inferred from
    // `source`; `dropWaitlistEntryForSubmission` refuses to drop a stamped
    // entry. Stamped at most once (no write on every repeat call), status
    // and existing metadata preserved. Entries CREATED by this use case
    // need no marker — their `source: PUBLIC` already proves the intent.
    let entry = existingEntry;
    if (!existingEntry.metadata.publicJoinedAt) {
      entry = await deps.repos.eventWaitlists.updateEntry({
        entryId: existingEntry.id,
        status: existingEntry.status,
        metadata: {
          ...existingEntry.metadata,
          publicJoinedAt: now.toISOString(),
        },
        updatedAt: now,
      });
    }

    logWaitlistJoin(
      deps.logger,
      event.visibility as EventVisibility,
      event.gateType as EventGateType,
      {
        eventId: event.id,
        viewerHumanId,
        entryId: entry.id,
        deduped: true,
        result: "noop",
      },
    );

    return joinEventWaitlistOutputSchema.parse({
      eventId: event.id,
      entry,
      alreadyJoined: true,
    });
  }

  const waitlistFull = await isWaitlistFull(
    deps.repos.eventWaitlists,
    event.id,
    event.waitlistCap,
  );
  if (waitlistFull) {
    throw fail("WAITLIST_FULL");
  }

  const entry = await deps.repos.eventWaitlists.createEntry({
    eventId: event.id,
    humanId: viewerHumanId,
    contactEmail,
    contactPhone,
    source: "PUBLIC",
    status: "PENDING",
    metadata: input.metadata ?? {},
  });

  logWaitlistJoin(
    deps.logger,
    event.visibility as EventVisibility,
    event.gateType as EventGateType,
    {
      eventId: event.id,
      viewerHumanId,
      entryId: entry.id,
      deduped: false,
      result: "success",
    },
  );

  // Best-effort confirmation email (fire-and-forget), capped per recipient
  // and per event (see WAITLIST_CONFIRMATION_*).
  const recipientEmail = contactEmail;
  // `waitlistEmailEnabled` is checked HERE, before any budget is spent —
  // otherwise joins on an email-off event would burn the recipient's and the
  // organiser's daily allowance for sends that never happen.
  if (
    deps.mailer &&
    deps.publicAppUrl &&
    recipientEmail &&
    event.waitlistEmailEnabled
  ) {
    const mailer = deps.mailer;
    const publicAppUrl = deps.publicAppUrl;
    void (async () => {
      const allowed = await consumeConfirmationEmailBudget(
        deps,
        {
          id: event.id,
          orgId: event.orgId ?? null,
          humanId: event.humanId ?? null,
        },
        recipientEmail,
      );
      if (!allowed) return;
      await sendWaitlistConfirmationEmail(
        { repos: deps.repos, mailer, logger: deps.logger },
        { eventId: event.id, recipientEmail, publicAppUrl },
      );
    })().catch((err) => {
      // Deliberate swallow (the join already succeeded): log at error AND
      // report, or a broken confirmation path is invisible in Sentry.
      deps.logger?.error("joinEventWaitlist.confirmationEmailFailed", {
        eventId: event.id,
        entryId: entry.id,
        error: describeError(err),
      });
      try {
        deps.reportError?.(err, {
          tags: { area: "waitlist_confirmation", useCase: "joinEventWaitlist" },
          extra: { eventId: event.id, entryId: entry.id },
        });
      } catch {
        // Best-effort reporting must never change the outcome.
      }
    });
  }

  return joinEventWaitlistOutputSchema.parse({
    eventId: event.id,
    entry,
    alreadyJoined: false,
  });
}

/**
 * Spend one unit of the per-recipient and per-event daily email budgets.
 * Returns false (skip the email) when either is exhausted, when no limiter is
 * wired, or when the limiter backend fails — this is an outbound-email abuse
 * cap, so it fails CLOSED: a lost confirmation is cheaper than an open relay.
 * The failure branch is a deliberate swallow, so it logs AND reports.
 */
async function consumeConfirmationEmailBudget(
  deps: Pick<JoinEventWaitlistDeps, "rateLimit" | "logger" | "reportError">,
  event: { id: string; orgId: string | null; humanId: string | null },
  recipientEmail: string,
): Promise<boolean> {
  const eventId = event.id;
  if (!deps.rateLimit) {
    deps.logger?.warn("joinEventWaitlist.confirmationEmailSkipped", {
      eventId,
      reason: "rate_limiter_not_wired",
    });
    return false;
  }
  try {
    const perRecipient = await deps.rateLimit.consume(
      waitlistConfirmationRecipientKey(recipientEmail),
      WAITLIST_CONFIRMATION_PER_RECIPIENT_DAILY_MAX,
      WAITLIST_CONFIRMATION_WINDOW_SECONDS,
    );
    if (!perRecipient.allowed) {
      deps.logger?.info("joinEventWaitlist.confirmationEmailSkipped", {
        eventId,
        reason: "recipient_daily_cap",
      });
      return false;
    }
    const perEvent = await deps.rateLimit.consume(
      waitlistConfirmationEventKey(eventId),
      WAITLIST_CONFIRMATION_PER_EVENT_DAILY_MAX,
      WAITLIST_CONFIRMATION_WINDOW_SECONDS,
    );
    if (!perEvent.allowed) {
      deps.logger?.warn("joinEventWaitlist.confirmationEmailSkipped", {
        eventId,
        reason: "event_daily_cap",
      });
      return false;
    }
    // Per-organiser ceiling across ALL their events, so minting fresh
    // events doesn't mint fresh per-event budgets.
    const ownerKey = waitlistConfirmationOwnerKey(event);
    if (ownerKey) {
      const perOwner = await deps.rateLimit.consume(
        ownerKey,
        WAITLIST_CONFIRMATION_PER_OWNER_DAILY_MAX,
        WAITLIST_CONFIRMATION_WINDOW_SECONDS,
      );
      if (!perOwner.allowed) {
        deps.logger?.warn("joinEventWaitlist.confirmationEmailSkipped", {
          eventId,
          reason: "owner_daily_cap",
        });
        return false;
      }
    }
    return true;
  } catch (err) {
    deps.logger?.error("joinEventWaitlist.confirmationCapConsumeFailed", {
      eventId,
      error: describeError(err),
    });
    try {
      deps.reportError?.(err, {
        tags: {
          area: "waitlist_confirmation_cap",
          useCase: "joinEventWaitlist",
        },
        extra: { eventId },
      });
    } catch {
      // Best-effort reporting must never change the outcome.
    }
    return false;
  }
}

async function findExistingEntry(
  repo: Pick<Repos["eventWaitlists"], "findEntry">,
  eventId: string,
  viewerHumanId: string | null,
  contactEmail: string | null,
  contactPhone: string | null,
): Promise<EventWaitlistEntryRecord | null> {
  if (viewerHumanId) {
    const byHuman = await repo.findEntry({ eventId, humanId: viewerHumanId });
    if (byHuman) {
      return byHuman;
    }
  }

  if (contactEmail) {
    const byEmail = await repo.findEntry({ eventId, contactEmail });
    if (byEmail) {
      return byEmail;
    }
  }

  if (contactPhone) {
    const byPhone = await repo.findEntry({ eventId, contactPhone });
    if (byPhone) {
      return byPhone;
    }
  }

  return null;
}

async function isWaitlistFull(
  repo: Repos["eventWaitlists"],
  eventId: string,
  cap: number | null | undefined,
): Promise<boolean> {
  if (cap === null || cap === undefined) {
    return false;
  }

  if (cap <= 0) {
    return true;
  }

  let counted = 0;
  while (counted < cap) {
    const remaining = cap - counted;
    const pageSize = Math.min(remaining, 200);
    const entries = await repo.listEntries({
      eventId,
      statuses: [...ACTIVE_WAITLIST_STATUSES],
      limit: pageSize,
      offset: counted,
    });

    counted += entries.length;
    if (entries.length < pageSize) {
      return false;
    }
  }

  return true;
}

type WaitlistLogContext = {
  eventId: string;
  viewerHumanId: string | null;
  entryId: string;
  deduped: boolean;
  result: "success" | "noop";
};

function logWaitlistJoin(
  logger: LoggerPort | undefined,
  visibility: EventVisibility,
  gateType: EventGateType,
  context: WaitlistLogContext,
): void {
  eventGateLogger.logEventGate?.(logger, {
    eventId: context.eventId,
    visibility,
    gateType,
    action: "waitlist_join",
    result: context.result,
    viewerHumanId: context.viewerHumanId,
    metadata: {
      entryId: context.entryId,
      deduped: context.deduped,
    },
  });
}
