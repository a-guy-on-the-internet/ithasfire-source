import { createHash } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { PlaceReviewSessionRecord } from "@th/ports/repos/place-review-sessions";

import { describeError, parseInput } from "../../lib/io";

/**
 * One abandonment reminder per address per day, across every session and
 * place (F16, 2026-09-29): session emails are typed into an anonymous form,
 * so without this a script could queue a reminder to any address per
 * session it opens.
 */
export const ABANDONMENT_EMAIL_PER_ADDRESS_DAILY_MAX = 1;
const ABANDONMENT_EMAIL_WINDOW_SECONDS = 24 * 60 * 60;
export const abandonmentEmailAddressKey = (email: string) =>
  `place-review:abandon-email:${createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")}`;

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

export const findAndMarkAbandonedSessionsInputSchema = z
  .object({
    staleAfterMinutes: z.number().int().min(1).optional().default(60),
    limit: z.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

export type FindAndMarkAbandonedSessionsInput = z.infer<
  typeof findAndMarkAbandonedSessionsInputSchema
>;

export interface AbandonedSessionForEmail {
  sessionId: string;
  email: string;
  placeName: string;
  lastStepKey: string | null;
  pageReached: number;
  sessionToken: string;
  placeId: string;
}

export type FindAndMarkAbandonedSessionsOutput = {
  found: number;
  sessions: AbandonedSessionForEmail[];
};

export type FindAndMarkAbandonedSessionsDeps = {
  repos: Pick<Repos, "placeReviewSessions" | "places">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Backs the per-address daily cap (required: this path sends email). */
  rateLimit: Pick<RateLimitPort, "consume">;
  /** Reports a limiter failure (the cap fails closed: no email). */
  reportError?: ReporterPort;
};

export async function findAndMarkAbandonedSessions(
  deps: FindAndMarkAbandonedSessionsDeps,
  rawInput: unknown,
): Promise<FindAndMarkAbandonedSessionsOutput> {
  const input = parseInput(findAndMarkAbandonedSessionsInputSchema, rawInput);
  const staleAfter = new Date(
    deps.clock.now().getTime() - input.staleAfterMinutes * 60 * 1000,
  );

  const abandoned = await deps.repos.placeReviewSessions.findAbandoned({
    staleAfter,
    limit: input.limit,
  });

  if (abandoned.length === 0) {
    return { found: 0, sessions: [] };
  }

  // Resolve place names for email content
  const placeIds = [...new Set(abandoned.map((s) => s.placeId))];
  const placeNames = new Map<string, string>();
  for (const placeId of placeIds) {
    const place = await deps.repos.places.getById(placeId);
    if (place) placeNames.set(placeId, place.name);
  }

  const sessions: AbandonedSessionForEmail[] = [];

  for (const session of abandoned) {
    if (!session.email) continue;

    const allowed = await consumeAddressBudget(deps, session);
    if (!allowed) {
      // Mark it anyway: a capped session must not come back every sweep.
      await deps.repos.placeReviewSessions.markAbandonmentEmailSent(session.id);
      continue;
    }

    sessions.push({
      sessionId: session.id,
      email: session.email,
      placeName: placeNames.get(session.placeId) ?? "a place",
      lastStepKey: session.lastStepKey,
      pageReached: session.pageReached,
      sessionToken: session.sessionToken,
      placeId: session.placeId,
    });

    // Mark as sent to prevent re-processing
    await deps.repos.placeReviewSessions.markAbandonmentEmailSent(session.id);
  }

  return { found: sessions.length, sessions };
}

/**
 * Spend the address's daily reminder budget. Fails CLOSED (no email) when
 * the limiter errors — a skipped reminder is cheaper than an uncapped send —
 * and that swallow logs AND reports.
 */
async function consumeAddressBudget(
  deps: FindAndMarkAbandonedSessionsDeps,
  session: PlaceReviewSessionRecord,
): Promise<boolean> {
  try {
    const result = await deps.rateLimit.consume(
      abandonmentEmailAddressKey(session.email ?? ""),
      ABANDONMENT_EMAIL_PER_ADDRESS_DAILY_MAX,
      ABANDONMENT_EMAIL_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      deps.logger?.info("place_reviews.abandonment_email_capped", {
        sessionId: session.id,
      });
    }
    return result.allowed;
  } catch (err) {
    deps.logger?.error("place_reviews.abandonment_cap_consume_failed", {
      sessionId: session.id,
      error: describeError(err),
    });
    try {
      deps.reportError?.(err, {
        tags: {
          area: "abandonment_email_cap",
          useCase: "findAndMarkAbandonedSessions",
        },
        extra: { sessionId: session.id },
      });
    } catch {
      // Best-effort reporting must never change the outcome.
    }
    return false;
  }
}
