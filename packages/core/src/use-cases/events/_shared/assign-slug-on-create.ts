import { isAppError } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../../lib/io";
import { generateEventSlug } from "./slug";

/**
 * Best-effort slug assignment for a JUST-CREATED event.
 *
 * WHY THIS EXISTS. Until this landed, `publish-event` was the ONLY place that
 * ever set `Event.slug`, so a never-published draft had none — and its public
 * page 500'd rather than rendering: `mapEventToSeo` throws
 * `TypeError("event.slug is required")` on a null slug and the web server's
 * `fetchEventSeo` only catches NOT_FOUND, so the TypeError escaped. A draft IS
 * meant to be publicly viewable by anyone holding the link (noindex + draft
 * banner — see `lib/public-urls.ts`), and the event builder's "Open preview in
 * a new tab" is shown ONLY pre-publish, so it pointed at exactly the one URL
 * guaranteed to break.
 *
 * WHY IT IS BEST-EFFORT AND NOT A HARD STEP OF THE CREATE. A location is
 * OPTIONAL at create time (`locationSchema` is `.partial().default({})`), and
 * `generateEventSlug` refuses to build a slug without at least a country code.
 * Even picking a venue does not guarantee one: the My Places branch sends only
 * `placeId`, and `Place.country` is nullable. Failing the create because we
 * could not derive a nice URL would break event creation for every organiser
 * whose venue has no country on file — so a slugless event is an accepted
 * outcome and the create proceeds.
 *
 * ── THIS MUST NEVER RUN INSIDE THE CALLER'S TRANSACTION ───────────────────
 *
 * It takes the full `Repos` bag, not a `TxRepos` handle, and that is the whole
 * point. A `try/catch` placed INSIDE an interactive transaction does not make
 * a failing statement survivable — it makes the failure SILENT AND LYING:
 *
 *   - a statement that errors at the database (a P2002 on `Event.slug`,
 *     `Event.shortId` or `EventSlugHistory.slug`) puts the Postgres
 *     transaction into the aborted state;
 *   - Postgres answers the subsequent COMMIT with ROLLBACK and NO error;
 *   - Prisma does not surface that, so `$transaction` RESOLVES with whatever
 *     the callback returned.
 *
 * Measured on this repo's Prisma 7.1.0 + PrismaPg: a write, then a swallowed
 * unique violation, then a normal return — the transaction resolved with the
 * success value, threw nothing, and the first write was not in the database.
 * Every caller downstream then treats a rolled-back transaction as committed:
 * the save returns an `eventId` for a row that does not exist and caches that
 * response under its idempotency key for 120 seconds.
 *
 * Catching around `repos.tx(...)` — which is what this function does — is a
 * completely different thing and genuinely works: the callback's rejection
 * propagates, Prisma rolls back cleanly, and the promise rejects where we can
 * see it. So the slug work gets its OWN transaction (the assign and its audit
 * row commit together) and the caller's transaction is never at risk.
 *
 * THE COST, ACCEPTED DELIBERATELY: this runs AFTER the create has committed,
 * so a crash in between leaves a slugless event. That is exactly the state
 * `apps/api/src/scripts/backfill/backfill-event-slugs.ts` exists to repair, and it is
 * the correct trade — a missing slug is a cosmetic gap the backfill closes,
 * whereas a silently-rolled-back create is lost work reported as success.
 *
 * Two outcomes are EXPECTED, not errors, and are deliberately NOT reported:
 *   - `getSlugContext` returns null (the row is gone / not visible);
 *   - `generateEventSlug` throws `EVENT_LOCATION_REQUIRED` (no country code).
 * Everything else is a genuine surprise and goes to the reporter per the
 * repo's Sentry convention (CLAUDE.md): a swallow that is only logged is
 * invisible.
 *
 * NO `EventSlugHistory` ROW IS WRITTEN. That table means exactly one thing —
 * SUPERSEDED slugs. `resolveBySlug` checks `Event.slug` first and only then
 * history, so a history row for the CURRENT slug is unreachable and redundant;
 * worse, `EventSlugHistory.slug` is GLOBALLY `@unique`, so recording the
 * current slug is what made the first `regenerateEventSlug` after a publish
 * blow up on P2002.
 */
export async function assignSlugOnCreate(
  deps: {
    logger?: LoggerPort;
    reportError?: ReporterPort;
  },
  /**
   * The NON-transactional repo bag. Passing a `TxRepos` handle from inside an
   * open transaction would reintroduce the silent-rollback hazard above; the
   * `Repos` type is the guard that makes that a compile error.
   */
  repos: Repos,
  params: {
    eventId: string;
    now: Date;
    /** Tag for the report/log line, e.g. `"saveEvent"`. */
    useCase: string;
  },
): Promise<string | null> {
  try {
    const context = await repos.events.getSlugContext(params.eventId);
    if (!context) {
      return null;
    }

    let generated;
    try {
      generated = generateEventSlug(context);
    } catch (error) {
      if (isAppError(error) && error.code === "EVENT_LOCATION_REQUIRED") {
        // Expected: no country code yet. The event stays slugless and picks
        // one up at publish, which re-derives from the final title anyway.
        return null;
      }
      throw error;
    }

    // Own transaction: the slug and the audit row that explains it commit
    // together, and a constraint violation aborts only THIS transaction —
    // which the caller's `await` then surfaces to the catch below.
    await repos.tx(async (tx) => {
      await tx.events.assignSlug({
        eventId: params.eventId,
        slug: generated.slug,
        shortId: generated.shortId,
        regionCode: generated.regionCode,
        assignedAt: params.now,
      });

      await tx.audit.log({
        entity: "event",
        entityId: params.eventId,
        action: "event.slug_assigned",
        data: {
          slug: generated.slug,
          shortId: generated.shortId,
        },
        at: params.now,
      });
    });

    return generated.slug;
  } catch (error) {
    try {
      deps.reportError?.(error, {
        tags: { useCase: params.useCase, stage: "assign_slug_on_create" },
        extra: { eventId: params.eventId },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never escape the
      // swallow branch and turn a survivable slug failure into a failed create.
    }
    deps.logger?.error("event_slug_assign_on_create_failed", {
      eventId: params.eventId,
      useCase: params.useCase,
      error: describeError(error),
    });
    return null;
  }
}
