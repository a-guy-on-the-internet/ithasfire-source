/**
 * Legacy third-party events → booking requests (venue-confirmation-and-
 * booking-intents spec, docs/specs/2026-08-27 — Migrations step (4)).
 *
 * "For every other PUBLISHED event with a placeId: create a PERFORM request
 * (event-first shape, originEventId), notify the venue. Unclaimed places:
 * park + claim invite." The address-only rule ALREADY applies to these
 * events (Phase 1 shipped it; no grace window — orchestrator decision
 * 2026-09-02, prod is dark); this script is what puts each of them in front
 * of its venue so it can be confirmed.
 *
 * WHAT IT DOES, per candidate (see ./plan-legacy-third-party-events for the
 * selection): one transaction through `createBookingRequestFromEvent` — the
 * SAME primitive the builder's event-first save uses — with:
 *   - the sender = the event's owner (the org, or the human), as a SYSTEM
 *     actor (`actorHumanId: null`): there is no person saving anything, so
 *     no access check runs and the ledger's opening entry has no author;
 *   - the performer-mode gate BYPASSED (`performerGate: "bypass"`): a
 *     promoter org that never enabled performer mode still has a published
 *     show at the venue, and the spec's migration step names no such gate.
 *     Every OTHER gate the pitch runs applies (claimed → verified + opted in
 *     + hours; unclaimed → parked; calendar accepts PERFORM; one open request
 *     per sender×place), and an acceptance refusal is a SKIP with its
 *     reason, not a failure — exactly as on the builder path;
 *   - the event's calendar, or the place's DEFAULT calendar when the event
 *     predates the hierarchy and has none (the request routes there; the
 *     event row itself is NOT touched — placement is the organizer's).
 * Then the request's notifications (the claim invite for a parked one, the
 * venue's "new request" notice otherwise) go out through the same
 * dispatcher the builder path uses, one call per request.
 *
 * THE CLAIM INVITE IS UNDELIVERABLE TODAY (Place has no contact email — see
 * notify-booking-request-intents.ts). The dispatcher reports that per
 * request; here those reports are BATCHED once per place, with the request
 * ids, so a venue with forty legacy shows produces one Sentry event, not
 * forty. Everything else the reporter sees is forwarded as-is.
 *
 * IDEMPOTENT. A re-run selects nothing it already handled: the plan excludes
 * events that carry an `originEventId` request, and the primitive re-checks
 * `findByOriginEventId` inside the transaction. A candidate that FAILS
 * (a thrown gate — e.g. DUPLICATE_OPEN_REQUEST because the owner also has
 * an open pitch at the venue) is logged, counted, and left for the next run
 * or a human; the script exits non-zero so a failure is never silent.
 *
 * Usage (from repo root — DATABASE_URL is REQUIRED and never read from a
 * .env file, so the target is always explicit):
 *
 *   DATABASE_URL=postgresql://... pnpm -F api exec tsx \
 *     src/scripts/backfill/done/migrate-legacy-third-party-events.ts [--dry-run]
 *
 * (The `migrate:legacy-third-party-events` npm alias was retired when this
 * script was archived here.)
 *
 * `--dry-run` prints the plan (candidates + why each other event was
 * skipped) and writes nothing.
 */

import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import {
  createBookingRequestFromEvent,
  type BookingRequestNotificationIntent,
  type CreateBookingRequestFromEventArgs,
  type CreateBookingRequestFromEventRepos,
  type CreateBookingRequestFromEventResult,
} from "@th/core/use-cases/booking-requests";

import {
  planLegacyThirdPartyEvents,
  type LegacyEventRow,
  type LegacyOwnershipRow,
  type LegacyThirdPartyEventsPlan,
} from "./plan-legacy-third-party-events";

// ─────────────────────────────────────────────────────────────────────────────
// Runner — pure over its deps so the flow is testable without a database
// ─────────────────────────────────────────────────────────────────────────────

export type LegacyMigrationDeps = {
  /** The raw rows the plan decides over (Prisma in `main`, fakes in tests). */
  listCandidates(): Promise<{
    events: LegacyEventRow[];
    ownerships: LegacyOwnershipRow[];
  }>;
  repos: Pick<Repos, "tx">;
  /**
   * Post-commit dispatch of one request's intents (the S1 dispatcher). The
   * reporter handed in is the runner's PLACE-BATCHING one — the dispatcher
   * must report through it, not through the raw Sentry reporter.
   */
  dispatch(
    intents: readonly BookingRequestNotificationIntent[],
    reportError: ReporterPort,
  ): Promise<void>;
  /** The raw reporter (Sentry); the runner wraps it for the run. */
  reportError?: ReporterPort;
  now(): Date;
  log(line: string): void;
  /** The event-first primitive; injectable so the runner's flow is testable. */
  createRequest?: (
    tx: CreateBookingRequestFromEventRepos,
    args: CreateBookingRequestFromEventArgs,
  ) => Promise<CreateBookingRequestFromEventResult>;
};

export type LegacyMigrationSummary = {
  plan: LegacyThirdPartyEventsPlan;
  created: number;
  parked: number;
  existing: number;
  /** Absorbed gate refusals + "no default calendar", by reason. */
  skippedByReason: Record<string, number>;
  failed: Array<{ eventId: string; error: string }>;
  dryRun: boolean;
};

export async function runLegacyThirdPartyEventsMigration(
  deps: LegacyMigrationDeps,
  options: { dryRun: boolean },
): Promise<LegacyMigrationSummary> {
  const { events, ownerships } = await deps.listCandidates();
  const plan = planLegacyThirdPartyEvents(events, ownerships);
  const createRequest = deps.createRequest ?? createBookingRequestFromEvent;

  deps.log(
    `published events at a place: ${events.length}; candidates (third-party, unconfirmed, not yet asked): ${plan.candidates.length}`,
  );
  const planSkips = countBy(plan.skipped.map((s) => s.reason));
  for (const [reason, count] of Object.entries(planSkips)) {
    deps.log(`  not a candidate (${reason}): ${count}`);
  }

  const summary: LegacyMigrationSummary = {
    plan,
    created: 0,
    parked: 0,
    existing: 0,
    skippedByReason: {},
    failed: [],
    dryRun: options.dryRun,
  };

  if (options.dryRun) {
    for (const c of plan.candidates) {
      deps.log(
        `  would request: event=${c.eventId} "${c.title}" place=${c.placeId} sender=${c.ownerType}:${c.ownerId}`,
      );
    }
    deps.log("  (DRY RUN — no rows were written, nothing was sent.)");
    return summary;
  }

  // One reporter for the whole run: the claim-invite "undeliverable" reports
  // are held back and flushed once per place at the end.
  const reporter = batchUndeliverableInvitesByPlace(deps.reportError);

  for (const candidate of plan.candidates) {
    let result: CreateBookingRequestFromEventResult;
    try {
      result = await deps.repos.tx(async (tx) => {
        const event = await tx.events.getById(candidate.eventId);
        if (!event) {
          return {
            outcome: "skipped",
            reason: "event_gone",
            notificationIntents: [],
          } as unknown as CreateBookingRequestFromEventResult;
        }
        const routed = await routeToCalendar(tx, event);
        if (!routed) {
          return {
            outcome: "skipped",
            reason: "no_default_calendar",
            notificationIntents: [],
          } as unknown as CreateBookingRequestFromEventResult;
        }
        return createRequest(tx, {
          event: routed,
          intent: "PERFORM",
          actorHumanId: null,
          performerGate: "bypass",
          now: deps.now(),
        });
      });
    } catch (error) {
      const message = describe(error);
      summary.failed.push({ eventId: candidate.eventId, error: message });
      deps.log(`  FAILED: event=${candidate.eventId} "${candidate.title}" — ${message}`);
      continue;
    }

    switch (result.outcome) {
      case "created": {
        summary.created += 1;
        if (result.parked) summary.parked += 1;
        deps.log(
          `  requested: event=${candidate.eventId} "${candidate.title}" request=${result.bookingRequestId}${result.parked ? " (parked — venue unclaimed)" : ""}`,
        );
        // Post-commit, per request. A notify outage must not stop the run:
        // the dispatcher swallows + reports per intent; a throw here is a
        // wiring failure, reported and moved past.
        try {
          await deps.dispatch(result.notificationIntents, reporter);
        } catch (error) {
          report(reporter, error, {
            eventId: candidate.eventId,
            bookingRequestId: result.bookingRequestId,
            step: "dispatch",
          });
          deps.log(`  notify failed for request=${result.bookingRequestId}: ${describe(error)}`);
        }
        break;
      }
      case "existing":
        summary.existing += 1;
        deps.log(`  already requested: event=${candidate.eventId} request=${result.bookingRequestId}`);
        break;
      case "skipped": {
        const key =
          result.reason === "venue_not_accepting" && result.message
            ? `${result.reason}:${result.message}`
            : result.reason;
        summary.skippedByReason[key] = (summary.skippedByReason[key] ?? 0) + 1;
        deps.log(`  skipped (${key}): event=${candidate.eventId} "${candidate.title}"`);
        break;
      }
    }
  }

  reporter.flush();

  deps.log("\nmigrate-legacy-third-party-events summary:");
  deps.log(`  candidates:        ${plan.candidates.length}`);
  deps.log(`  requests created:  ${summary.created} (parked at unclaimed venues: ${summary.parked})`);
  deps.log(`  already requested: ${summary.existing}`);
  for (const [reason, count] of Object.entries(summary.skippedByReason)) {
    deps.log(`  skipped ${reason}: ${count}`);
  }
  deps.log(`  failed:            ${summary.failed.length}`);
  return summary;
}

/**
 * The event as the primitive wants it: its own calendar, else the place's
 * default (pre-hierarchy rows have none). Null = the place has no default
 * calendar either — run backfill-venue-defaults first.
 */
async function routeToCalendar(
  tx: CreateBookingRequestFromEventRepos,
  event: EventRecord,
): Promise<EventRecord | null> {
  if (event.calendarId) return event;
  if (!event.placeId) return null;
  const calendar = await tx.calendars.findDefaultForPlace(event.placeId);
  return calendar ? { ...event, calendarId: calendar.id } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporter batching — one "claim invite undeliverable" per place
// ─────────────────────────────────────────────────────────────────────────────

type BatchingReporter = ReporterPort & { flush(): void };

const UNDELIVERABLE_REASONS = new Set([
  "place_has_no_contact_email",
  "place_not_found",
]);

export function batchUndeliverableInvitesByPlace(
  inner: ReporterPort | undefined,
): BatchingReporter {
  const held = new Map<string, { reason: string; bookingRequestIds: string[] }>();
  const reporter = ((error, context) => {
    const extra = (context?.extra ?? {}) as Record<string, unknown>;
    const reason = typeof extra.reason === "string" ? extra.reason : null;
    const placeId = typeof extra.placeId === "string" ? extra.placeId : null;
    const requestId =
      typeof extra.bookingRequestId === "string" ? extra.bookingRequestId : null;
    if (
      error instanceof Error &&
      error.message === "venue_claim_invite_undeliverable" &&
      reason !== null &&
      UNDELIVERABLE_REASONS.has(reason) &&
      placeId !== null
    ) {
      const bucket = held.get(placeId) ?? { reason, bookingRequestIds: [] };
      if (requestId) bucket.bookingRequestIds.push(requestId);
      held.set(placeId, bucket);
      return;
    }
    inner?.(error, context);
  }) as BatchingReporter;
  reporter.flush = () => {
    for (const [placeId, bucket] of held) {
      try {
        inner?.(new Error("venue_claim_invite_undeliverable"), {
          tags: {
            useCase: "migrateLegacyThirdPartyEvents",
            step: "venue_claim_invite",
          },
          extra: {
            placeId,
            reason: bucket.reason,
            requestCount: bucket.bookingRequestIds.length,
            bookingRequestIds: bucket.bookingRequestIds,
          },
        });
      } catch {
        // A throwing reporter must never fail the run.
      }
    }
    held.clear();
  };
  return reporter;
}

function report(
  reporter: ReporterPort,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    reporter(error, {
      tags: { useCase: "migrateLegacyThirdPartyEvents" },
      extra,
    });
  } catch {
    // Best-effort.
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object" && "code" in error) {
    const e = error as { code: unknown; message?: unknown };
    return `${String(e.code)}${e.message ? `: ${String(e.message)}` : ""}`;
  }
  return String(error);
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set explicitly (this script never loads .env files — the target DB must be deliberate).",
    );
  }
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `migrate-legacy-third-party-events → ${target.hostname}:${target.port || "5432"}${target.pathname}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  // The composition root: the same repos, notify (email-bound), mailer and
  // reporter the API serves with, so a request created here is notified
  // exactly as one created by the builder.
  const { buildDeps } = await import("../../../lib/dep");
  const { dispatchBookingRequestIntents } = await import(
    "@th/core/use-cases/booking-requests"
  );
  const app = await buildDeps();
  const { prisma, trpc } = app;

  try {
    const summary = await runLegacyThirdPartyEventsMigration(
      {
        listCandidates: async () => {
          const rows = await prisma.event.findMany({
            where: { status: "PUBLISHED", placeId: { not: null } },
            select: {
              id: true,
              title: true,
              orgId: true,
              humanId: true,
              placeId: true,
              status: true,
              venueConfirmedAt: true,
              venueConfirmedPlaceId: true,
              venueConfirmationWithdrawnAt: true,
              bookingRequestOriginating: { select: { id: true } },
            },
            orderBy: { createdAt: "asc" },
          });
          const placeIds = [
            ...new Set(
              rows.map((r) => r.placeId).filter((p): p is string => !!p),
            ),
          ];
          const ownerships = placeIds.length
            ? await prisma.placeOwnership.findMany({
                where: {
                  placeId: { in: placeIds },
                  verified: true,
                  revokedAt: null,
                },
                select: { placeId: true, ownerType: true, ownerId: true },
              })
            : [];
          return {
            events: rows.map((r) => ({
              id: r.id,
              title: r.title,
              orgId: r.orgId,
              humanId: r.humanId,
              placeId: r.placeId,
              status: r.status,
              venueConfirmedAt: r.venueConfirmedAt,
              venueConfirmedPlaceId: r.venueConfirmedPlaceId,
              venueConfirmationWithdrawnAt: r.venueConfirmationWithdrawnAt,
              hasOriginRequest: r.bookingRequestOriginating !== null,
            })),
            ownerships: ownerships.map((o) => ({
              placeId: o.placeId,
              ownerType: o.ownerType as "HUMAN" | "ORGANIZATION",
              ownerId: o.ownerId,
            })),
          };
        },
        repos: trpc.repos,
        dispatch: (intents, reportError) =>
          dispatchBookingRequestIntents(
            {
              repos: trpc.repos,
              notify: trpc.notifyWithEmail ?? trpc.notify,
              logger: trpc.logger,
              reportError,
              publicAppUrl: trpc.publicAppUrl ?? null,
            },
            { intents },
          ),
        reportError: trpc.reportError ?? undefined,
        now: () => trpc.clock.now(),
        log: (line) => console.log(line),
      },
      { dryRun: DRY_RUN },
    );
    if (summary.failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

// `import.meta.url` vs `process.argv[1]`: only run as a script, never on
// import (the test imports the runner).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    return Boolean(entry && import.meta.url.endsWith(entry.split("/").pop()!));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
