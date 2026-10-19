import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventGateType, EventVisibility } from "@th/ports/repos/events";
import type { TurnstilePort } from "@th/ports/turnstile";

import { parseInput } from "../../lib/io";
import {
  isEventPasswordSet,
  verifyEventPassword,
} from "../../lib/security/event-password";
import { rateLimitIpBucket } from "../../lib/security/rate-limit-ip-bucket";
import { createThrottledReporter } from "../../lib/throttled-reporter";
import { canViewerBypassEventGate } from "./_shared/ensure-actor-can-edit-event";
import {
  canViewerReadEvent,
  type EventStaffReadProbe,
} from "./_shared/event-public-readability";
import { fail } from "@th/errors";

export const validateEventPasswordInputSchema = z
  .object({
    eventId: z.uuid(),
    password: z.string().min(1).max(128),
    /**
     * The human attempting to unlock the event.
     * Required to persist the unlock. If null, password is validated but not persisted.
     */
    viewerHumanId: z.string().uuid().nullable().optional(),
    /**
     * Cloudflare Turnstile token. Only consulted once this IP (or the whole
     * event) has failed enough times to require a challenge; see
     * {@link EVENT_PASSWORD_IP_FAILURE_THRESHOLD}.
     */
    turnstileToken: z.string().min(1).max(4096).optional(),
    /**
     * Server-injected client IP (ctx.clientIp), never client-supplied: keys the
     * per-(event, IP) failure counter and is Turnstile's `remoteip`.
     */
    requestIp: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();

export const validateEventPasswordOutputSchema = z.object({
  eventId: z.uuid(),
  unlocked: z.boolean(),
  bypassed: z.boolean().default(false),
  /** Whether the unlock was persisted to the database */
  persisted: z.boolean().default(false),
});

export type ValidateEventPasswordInput = z.infer<
  typeof validateEventPasswordInputSchema
>;
export type ValidateEventPasswordOutput = z.infer<
  typeof validateEventPasswordOutputSchema
>;

export type ValidateEventPasswordDeps = {
  repos: Pick<Repos, "events" | "authz" | "eventUnlocks"> &
    Partial<Pick<Repos, "tickets">>;
  /**
   * The staff probe behind a community moderator's read of a hidden
   * COMMUNITY listing.
   */
  authz: EventStaffReadProbe;
  logger?: LoggerPort;
  /**
   * Failure counters behind the challenge gate. Absent → no gate (only the
   * transport's hard caps apply). A throwing counter fails OPEN.
   */
  attemptCounter?: Pick<RateLimitPort, "peek" | "consumeMany">;
  /** Absent / disabled while a challenge is due → the gate degrades (reported). */
  turnstile?: TurnstilePort | null;
  reportError?: ReporterPort;
};

// ── Failure gate ────────────────────────────────────────────────────────────
//
// Wrong passwords are counted per (event, IP) and per event. Once either
// counter reaches its threshold, every further attempt must carry a Turnstile
// token that verifies. The password is not evaluated until it does, so a
// scripted guesser stops getting answers. Correct passwords count nothing.
// The transport's per-minute hard caps still apply on top.

/**
 * Failures from one IP bucket on one event before a challenge is required.
 *
 * Not exact under concurrency: the gate peeks, then counts only after the
 * password check, so attempts fired in parallel can all read a count below
 * the threshold and all get an answer. The transport's hard caps bound the
 * overshoot: 5/min per (event, actor, IP) lets an anonymous caller land about
 * 5 guesses per 15-minute window per IPv4 address (or IPv6 /64) before the
 * gate closes; several signed-in accounts on one IP get separate actor
 * buckets, so the 20/min per-IP cap applies instead (about 20). Accepted:
 * the gate exists to stop sustained guessing, and both figures are bounded.
 */
export const EVENT_PASSWORD_IP_FAILURE_THRESHOLD = 3;
/** Window for {@link EVENT_PASSWORD_IP_FAILURE_THRESHOLD}. */
export const EVENT_PASSWORD_IP_FAILURE_WINDOW_SECONDS = 15 * 60;
/**
 * Failures on one event, across all IPs, before EVERY attempt on it needs a
 * challenge (a distributed guesser rotating IPs). Reaching it is reported once
 * per window.
 */
export const EVENT_PASSWORD_EVENT_FAILURE_BUDGET = 100;
/** Window for {@link EVENT_PASSWORD_EVENT_FAILURE_BUDGET}. */
export const EVENT_PASSWORD_EVENT_FAILURE_WINDOW_SECONDS = 60 * 60;

/**
 * Counter keys for an attempt. The IP part is bucketed (IPv6 → its /64) so a
 * single allocation cannot rotate addresses to reset its count.
 */
export function eventPasswordFailureKeys(
  eventId: string,
  requestIp: string | null | undefined,
): { ip: string; event: string } {
  return {
    ip: `pwfail:ip:${eventId}:${rateLimitIpBucket(requestIp) ?? "no-ip"}`,
    event: `pwfail:event:${eventId}`,
  };
}

/** Degrade reports repeat at most this often per tag set, per process. */
const DEGRADE_REPORT_THROTTLE_MS = 15 * 60 * 1000;

/**
 * One throttled wrapper per reporter identity, memoized so the window
 * survives across requests (same pattern as the tRPC guard's
 * `getThrottledRateLimitReporter`). A fresh reporter (e.g. a per-test mock)
 * gets fresh throttle state.
 */
const throttledReporters = new WeakMap<ReporterPort, ReporterPort>();

function throttledReporterFor(
  reportError: ReporterPort | undefined,
): ReporterPort | undefined {
  if (!reportError) return undefined;
  let throttled = throttledReporters.get(reportError);
  if (!throttled) {
    throttled = createThrottledReporter(
      reportError,
      DEGRADE_REPORT_THROTTLE_MS,
    );
    throttledReporters.set(reportError, throttled);
  }
  return throttled;
}

/** A throwing reporter must never change the outcome of an unlock attempt. */
function safeReport(
  reporter: ReporterPort | undefined,
  err: unknown,
  context: Parameters<ReporterPort>[1],
): void {
  if (!reporter) return;
  try {
    reporter(err, context);
  } catch {
    // Best-effort by contract; see ReporterPort.
  }
}

export async function validateEventPassword(
  deps: ValidateEventPasswordDeps,
  rawInput: unknown,
): Promise<ValidateEventPasswordOutput> {
  const input = parseInput(validateEventPasswordInputSchema, rawInput);
  const event = await deps.repos.events.getById(input.eventId, {
    withOwnerStanding: true,
  });
  // N3: a hidden event (DRAFT / never-live) answers like an unknown id.
  // Without this a stranger holding a draft's id could read its gate type off
  // EVENT_NOT_PASSWORD_GATED / EVENT_PASSWORD_MISSING, or unlock it.
  if (
    !event ||
    !(await canViewerReadEvent(
      deps.repos.authz,
      event,
      input.viewerHumanId ?? null,
      deps.repos.tickets,
      deps.authz,
    ))
  ) {
    throw fail("EVENT_NOT_FOUND");
  }

  const bypassed = await canViewerBypassEventGate(
    deps.repos.authz,
    event,
    input.viewerHumanId ?? null,
  );

  if (bypassed) {
    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: event.id,
      gateType: event.gateType as EventGateType,
      visibility: event.visibility as EventVisibility,
      action: "password_attempt",
      result: "bypassed",
      viewerHumanId: input.viewerHumanId ?? null,
    });
    return validateEventPasswordOutputSchema.parse({
      eventId: event.id,
      unlocked: true,
      bypassed: true,
      persisted: false,
    });
  }

  if (event.gateType !== "PASSWORD") {
    throw fail("EVENT_NOT_PASSWORD_GATED");
  }

  if (!isEventPasswordSet(event.passwordHash)) {
    throw fail("EVENT_PASSWORD_MISSING");
  }

  const keys = eventPasswordFailureKeys(event.id, input.requestIp);
  const counter = deps.attemptCounter;

  // ── Challenge gate: has this IP, or this event, failed too often? ────────
  let challengeRequired = false;
  if (counter) {
    try {
      const [ipFailures = 0, eventFailures = 0] = await counter.peek([
        keys.ip,
        keys.event,
      ]);
      challengeRequired =
        ipFailures >= EVENT_PASSWORD_IP_FAILURE_THRESHOLD ||
        eventFailures >= EVENT_PASSWORD_EVENT_FAILURE_BUDGET;
    } catch (err) {
      // Fail OPEN: a counter outage must not lock guests out of an event.
      // NOTHING else bounds guessing then: the transport's hard caps use the
      // same Redis and fail open too (guard.ts `consumeRateLimitOrAllow`), so
      // during an outage attempts are limited only by scrypt throughput. That
      // is why the outage is reported, not just logged.
      deps.logger?.error("event_password_failure_counter_unavailable", {
        eventId: event.id,
        op: "peek",
        err,
      });
      safeReport(throttledReporterFor(deps.reportError), err, {
        tags: { area: "event_password_failure_counter", op: "peek" },
        extra: { eventId: event.id },
      });
    }
  }

  if (challengeRequired) {
    if (deps.turnstile?.enabled) {
      if (!input.turnstileToken) {
        logChallenge(deps, event, input.viewerHumanId, "token_missing");
        throw fail("EVENT_PASSWORD_CHALLENGE_REQUIRED");
      }
      const verified = await deps.turnstile.verify(
        input.turnstileToken,
        input.requestIp ?? undefined,
      );
      if (!verified) {
        // Same code as a missing token, so the client re-renders the widget.
        logChallenge(deps, event, input.viewerHumanId, "token_rejected");
        throw fail("EVENT_PASSWORD_CHALLENGE_REQUIRED");
      }
    } else {
      // Deliberate degrade: Turnstile is not configured (no secret key), so
      // there is nothing to challenge with. Skip the gate; the hard caps
      // still apply. Reported (throttled) so the config gap is visible.
      deps.logger?.warn("event_password_challenge_unavailable", {
        eventId: event.id,
        reason: "turnstile_disabled",
      });
      safeReport(
        throttledReporterFor(deps.reportError),
        new Error("event_password_challenge_unavailable: turnstile disabled"),
        {
          tags: {
            area: "event_password_challenge",
            reason: "turnstile_disabled",
          },
          extra: { eventId: event.id },
        },
      );
    }
  }

  const valid = verifyEventPassword(input.password, event.passwordHash ?? null);
  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    gateType: event.gateType as EventGateType,
    visibility: event.visibility as EventVisibility,
    action: "password_attempt",
    result: valid ? "success" : "failure",
    viewerHumanId: input.viewerHumanId ?? null,
  });

  if (!valid) {
    if (counter) await countFailure(deps, counter, event.id, keys);
    throw fail("EVENT_PASSWORD_INVALID");
  }

  // Persist unlock if we have a humanId
  let persisted = false;
  if (input.viewerHumanId) {
    await deps.repos.eventUnlocks.upsert({
      eventId: event.id,
      humanId: input.viewerHumanId,
      source: "PASSWORD",
    });
    persisted = true;
  }

  return validateEventPasswordOutputSchema.parse({
    eventId: event.id,
    unlocked: true,
    bypassed: false,
    persisted,
  });
}

/** Count a wrong password against both buckets in one round trip. */
async function countFailure(
  deps: ValidateEventPasswordDeps,
  counter: Pick<RateLimitPort, "consumeMany">,
  eventId: string,
  keys: { ip: string; event: string },
): Promise<void> {
  let eventResult: RateLimitResult | undefined;
  try {
    [, eventResult] = await counter.consumeMany([
      {
        key: keys.ip,
        maxTokens: EVENT_PASSWORD_IP_FAILURE_THRESHOLD,
        windowSeconds: EVENT_PASSWORD_IP_FAILURE_WINDOW_SECONDS,
      },
      {
        key: keys.event,
        maxTokens: EVENT_PASSWORD_EVENT_FAILURE_BUDGET,
        windowSeconds: EVENT_PASSWORD_EVENT_FAILURE_WINDOW_SECONDS,
      },
    ]);
  } catch (err) {
    // Fail OPEN: the attempt still answers EVENT_PASSWORD_INVALID; it just
    // goes uncounted. The hard caps are no backstop here: they share this
    // Redis and fail open as well (guard.ts `consumeRateLimitOrAllow`), so
    // during an outage guessing is limited only by scrypt throughput. Hence
    // the report.
    deps.logger?.error("event_password_failure_counter_unavailable", {
      eventId,
      op: "consume",
      err,
    });
    safeReport(throttledReporterFor(deps.reportError), err, {
      tags: { area: "event_password_failure_counter", op: "consume" },
      extra: { eventId },
    });
    return;
  }

  // Exactly the budget-th failure in this window: `allowed` with nothing left
  // means the counter just reached the budget. INCR is atomic, so exactly one
  // request in the window sees this, however many run concurrently. Not
  // throttled: it already fires once per window by construction.
  if (eventResult?.allowed && eventResult.remaining === 0) {
    deps.logger?.warn("event_password_failure_budget_exhausted", {
      eventId,
      budget: EVENT_PASSWORD_EVENT_FAILURE_BUDGET,
      windowSeconds: EVENT_PASSWORD_EVENT_FAILURE_WINDOW_SECONDS,
    });
    safeReport(
      deps.reportError,
      new Error("event_password_failure_budget_exhausted"),
      {
        tags: { area: "event_password_failure_budget" },
        extra: { eventId },
      },
    );
  }
}

function logChallenge(
  deps: ValidateEventPasswordDeps,
  event: { id: string; gateType: unknown; visibility: unknown },
  viewerHumanId: string | null | undefined,
  reason: "token_missing" | "token_rejected",
): void {
  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    gateType: event.gateType as EventGateType,
    visibility: event.visibility as EventVisibility,
    action: "password_attempt",
    result: "challenge_required",
    reason,
    viewerHumanId: viewerHumanId ?? null,
  });
}
