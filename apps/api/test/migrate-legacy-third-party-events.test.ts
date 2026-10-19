import { describe, expect, it, vi } from "vitest";

import {
  runLegacyThirdPartyEventsMigration,
  type LegacyMigrationDeps,
} from "../src/scripts/backfill/done/migrate-legacy-third-party-events";
import {
  planLegacyThirdPartyEvents,
  type LegacyEventRow,
  type LegacyOwnershipRow,
} from "../src/scripts/backfill/done/plan-legacy-third-party-events";

/**
 * Legacy third-party events → booking requests (docs/specs/2026-08-27,
 * Migrations step 4). Two halves:
 *   - the PLAN: which published events at a place get a request — third
 *     party, unconfirmed, not yet asked, owned by somebody;
 *   - the RUNNER: one tx per candidate through the event-first primitive
 *     (system actor, performer gate bypassed, default-calendar routing for
 *     pre-hierarchy rows), notify per request, batch the undeliverable
 *     claim-invite report once per place, dry-run writes nothing, a failed
 *     candidate never stops the run.
 */

const PLACE_ORG = "00000000-0000-4000-8000-0000000000a1";
const PLACE_HUMAN = "00000000-0000-4000-8000-0000000000a2";
const PLACE_UNCLAIMED = "00000000-0000-4000-8000-0000000000a3";
const ORG_A = "00000000-0000-4000-8000-0000000000b1";
const ORG_B = "00000000-0000-4000-8000-0000000000b2";
const HUMAN_OWNER = "00000000-0000-4000-8000-0000000000c1";
const HUMAN_OTHER = "00000000-0000-4000-8000-0000000000c2";
const CALENDAR_DEFAULT = "00000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-09-07T12:00:00.000Z");

const OWNERSHIPS: LegacyOwnershipRow[] = [
  { placeId: PLACE_ORG, ownerType: "ORGANIZATION", ownerId: ORG_A },
  { placeId: PLACE_HUMAN, ownerType: "HUMAN", ownerId: HUMAN_OWNER },
];

const row = (overrides: Partial<LegacyEventRow> & { id: string }): LegacyEventRow => ({
  title: `Event ${overrides.id}`,
  orgId: ORG_B,
  humanId: null,
  placeId: PLACE_ORG,
  status: "PUBLISHED",
  venueConfirmedAt: null,
  venueConfirmedPlaceId: null,
  venueConfirmationWithdrawnAt: null,
  hasOriginRequest: false,
  ...overrides,
});

describe("planLegacyThirdPartyEvents", () => {
  it("selects PUBLISHED third-party, unconfirmed, not-yet-asked, owned events; names why every other row is left alone", () => {
    const plan = planLegacyThirdPartyEvents(
      [
        row({ id: "third-party-org" }),
        row({ id: "third-party-human", orgId: null, humanId: HUMAN_OTHER, placeId: PLACE_HUMAN }),
        row({ id: "venue-owned-org", orgId: ORG_A }),
        row({ id: "venue-owned-human", orgId: null, humanId: HUMAN_OWNER, placeId: PLACE_HUMAN }),
        row({ id: "confirmed", venueConfirmedAt: NOW, venueConfirmedPlaceId: PLACE_ORG }),
        // A stamp for ANOTHER place is not this venue's word → still a candidate.
        row({ id: "stale-stamp", venueConfirmedAt: NOW, venueConfirmedPlaceId: PLACE_HUMAN }),
        // Withdrawn ("not mine") → the request is how the venue looks again.
        row({ id: "withdrawn", venueConfirmedAt: NOW, venueConfirmedPlaceId: PLACE_ORG, venueConfirmationWithdrawnAt: NOW }),
        row({ id: "already-asked", hasOriginRequest: true }),
        row({ id: "draft", status: "DRAFT" }),
        row({ id: "no-place", placeId: null }),
        row({ id: "ownerless", orgId: null, humanId: null }),
        // Unclaimed place (no verified owners): a candidate — it parks.
        row({ id: "at-unclaimed", placeId: PLACE_UNCLAIMED }),
      ],
      OWNERSHIPS,
    );

    expect(plan.candidates.map((c) => [c.eventId, c.ownerType, c.ownerId])).toEqual([
      ["third-party-org", "org", ORG_B],
      ["third-party-human", "human", HUMAN_OTHER],
      ["stale-stamp", "org", ORG_B],
      ["withdrawn", "org", ORG_B],
      ["at-unclaimed", "org", ORG_B],
    ]);
    expect(plan.skipped).toEqual([
      { eventId: "venue-owned-org", reason: "venue_owned" },
      { eventId: "venue-owned-human", reason: "venue_owned" },
      { eventId: "confirmed", reason: "venue_confirmed" },
      { eventId: "already-asked", reason: "already_requested" },
      { eventId: "draft", reason: "not_published" },
      { eventId: "no-place", reason: "no_place" },
      { eventId: "ownerless", reason: "no_owner" },
    ]);
  });

  it("an empty world plans nothing", () => {
    expect(planLegacyThirdPartyEvents([], [])).toEqual({ candidates: [], skipped: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

type EventStub = {
  id: string;
  placeId: string | null;
  calendarId: string | null;
  orgId: string | null;
  humanId: string | null;
  title: string;
};

function buildDeps(options: {
  events: LegacyEventRow[];
  rows?: Record<string, EventStub>;
  defaultCalendar?: string | null;
  createRequest?: LegacyMigrationDeps["createRequest"];
  dispatch?: LegacyMigrationDeps["dispatch"];
}) {
  const rows =
    options.rows ??
    Object.fromEntries(
      options.events.map((e) => [
        e.id,
        { id: e.id, placeId: e.placeId, calendarId: null, orgId: e.orgId, humanId: e.humanId, title: e.title },
      ]),
    );
  const tx = {
    events: { getById: vi.fn(async (id: string) => rows[id] ?? null) },
    calendars: {
      findDefaultForPlace: vi.fn(async () =>
        options.defaultCalendar === null ? null : { id: options.defaultCalendar ?? CALENDAR_DEFAULT },
      ),
    },
  };
  const createRequest =
    options.createRequest ??
    vi.fn(async (_tx: unknown, args: { event: { id: string } }) => ({
      outcome: "created" as const,
      bookingRequestId: `req-${args.event.id}`,
      parked: false,
      notificationIntents: [
        { kind: "request.received" as const, bookingRequestId: `req-${args.event.id}`, placeId: PLACE_ORG, at: NOW },
      ],
    }));
  const dispatch = options.dispatch ?? vi.fn(async () => undefined);
  const reportError = vi.fn();
  const log: string[] = [];
  const deps: LegacyMigrationDeps = {
    listCandidates: async () => ({ events: options.events, ownerships: OWNERSHIPS }),
    repos: { tx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as never },
    dispatch,
    reportError,
    now: () => NOW,
    log: (line) => log.push(line),
    createRequest: createRequest as never,
  };
  return { deps, tx, createRequest: createRequest as ReturnType<typeof vi.fn>, dispatch: dispatch as ReturnType<typeof vi.fn>, reportError, log };
}

describe("runLegacyThirdPartyEventsMigration", () => {
  it("creates one PERFORM request per candidate through the primitive as a SYSTEM actor with the performer gate bypassed, routed to the place's default calendar when the event has none, and notifies per request", async () => {
    const { deps, createRequest, dispatch, tx } = buildDeps({
      events: [row({ id: "e1" }), row({ id: "e2", orgId: null, humanId: HUMAN_OTHER }), row({ id: "venue-owned", orgId: ORG_A })],
    });

    const summary = await runLegacyThirdPartyEventsMigration(deps, { dryRun: false });

    expect(summary).toMatchObject({ created: 2, parked: 0, existing: 0, failed: [], dryRun: false });
    expect(createRequest).toHaveBeenCalledTimes(2);
    expect(createRequest).toHaveBeenNthCalledWith(
      1,
      tx,
      expect.objectContaining({
        event: expect.objectContaining({ id: "e1", calendarId: CALENDAR_DEFAULT }),
        intent: "PERFORM",
        actorHumanId: null,
        performerGate: "bypass",
        now: NOW,
      }),
    );
    // Each request's intents go out on their own, with the run's reporter.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ kind: "request.received", bookingRequestId: "req-e1" }),
    ]);
    expect(dispatch.mock.calls[0]![1]).toEqual(expect.any(Function));
  });

  it("an event that already has its own calendar keeps it; a place with no default calendar is skipped (backfill first), never failed", async () => {
    const { deps, createRequest, tx } = buildDeps({
      events: [row({ id: "routed" }), row({ id: "unrouted" })],
      rows: {
        routed: { id: "routed", placeId: PLACE_ORG, calendarId: "own-cal", orgId: ORG_B, humanId: null, title: "Routed" },
        unrouted: { id: "unrouted", placeId: PLACE_ORG, calendarId: null, orgId: ORG_B, humanId: null, title: "Unrouted" },
      },
      defaultCalendar: null,
    });

    const summary = await runLegacyThirdPartyEventsMigration(deps, { dryRun: false });

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest.mock.calls[0]![1].event.calendarId).toBe("own-cal");
    expect(tx.calendars.findDefaultForPlace).toHaveBeenCalledTimes(1);
    expect(summary.skippedByReason).toEqual({ no_default_calendar: 1 });
    expect(summary.failed).toEqual([]);
  });

  it("--dry-run prints the plan and neither writes nor notifies", async () => {
    const { deps, createRequest, dispatch, log } = buildDeps({
      events: [row({ id: "e1" }), row({ id: "venue-owned", orgId: ORG_A })],
    });

    const summary = await runLegacyThirdPartyEventsMigration(deps, { dryRun: true });

    expect(summary).toMatchObject({ dryRun: true, created: 0 });
    expect(summary.plan.candidates.map((c) => c.eventId)).toEqual(["e1"]);
    expect(createRequest).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(log.some((l) => l.includes("would request: event=e1"))).toBe(true);
    expect(log.some((l) => l.includes("not a candidate (venue_owned): 1"))).toBe(true);
    expect(log.some((l) => l.includes("DRY RUN"))).toBe(true);
  });

  it("is idempotent: an event already carrying an origin request is not a candidate, and the primitive's own 'existing' answer counts as such", async () => {
    const { deps, createRequest } = buildDeps({
      events: [row({ id: "asked", hasOriginRequest: true }), row({ id: "raced" })],
      createRequest: vi.fn(async () => ({ outcome: "existing" as const, bookingRequestId: "req-raced", notificationIntents: [] as [] })),
    });

    const summary = await runLegacyThirdPartyEventsMigration(deps, { dryRun: false });

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ created: 0, existing: 1 });
  });

  it("an absorbed gate refusal is a skip by reason; a thrown gate is a FAILURE that does not stop the run", async () => {
    let call = 0;
    const { deps, dispatch } = buildDeps({
      events: [row({ id: "paused" }), row({ id: "dup" }), row({ id: "ok" })],
      createRequest: vi.fn(async (_tx: unknown, args: { event: { id: string } }) => {
        call += 1;
        if (args.event.id === "paused") {
          return {
            outcome: "skipped" as const,
            reason: "venue_not_accepting" as const,
            code: "PLACE_NOT_ACCEPTING_REQUESTS",
            message: "PLACE_NOT_ACCEPTING_REQUESTS",
            notificationIntents: [] as [],
          };
        }
        if (args.event.id === "dup") {
          throw Object.assign(new Error("DUPLICATE_OPEN_REQUEST"), { code: "DUPLICATE_OPEN_REQUEST" });
        }
        return { outcome: "created" as const, bookingRequestId: "req-ok", parked: false, notificationIntents: [] };
      }),
    });

    const summary = await runLegacyThirdPartyEventsMigration(deps, { dryRun: false });

    expect(call).toBe(3);
    expect(summary.skippedByReason).toEqual({ "venue_not_accepting:PLACE_NOT_ACCEPTING_REQUESTS": 1 });
    expect(summary.failed).toEqual([{ eventId: "dup", error: "Error: DUPLICATE_OPEN_REQUEST" }]);
    expect(summary.created).toBe(1);
    // A created request with nothing owed still goes through dispatch (a no-op there).
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // P3a (amendment 2026-09-25): an unclaimed place takes no requests, so the
  // event-first create absorbs PLACE_NOT_TAKING_REQUESTS into a skip; nothing
  // is parked and no claim invite exists. The dispatch path is the claimed
  // venue's received notice.
  it("an unclaimed place is a skip by reason (nothing parked, nothing dispatched); a received-notice dispatch throw is reported and the run continues", async () => {
    const { deps, dispatch, reportError } = buildDeps({
      events: [row({ id: "u1", placeId: PLACE_UNCLAIMED }), row({ id: "c1" }), row({ id: "c2" })],
      createRequest: vi.fn(async (_tx: unknown, args: { event: { id: string } }) =>
        args.event.id === "u1"
          ? {
              outcome: "skipped" as const,
              reason: "venue_not_accepting" as const,
              code: "PLACE_NOT_TAKING_REQUESTS",
              message: "PLACE_NOT_TAKING_REQUESTS",
              placeId: PLACE_UNCLAIMED,
              placeName: "Unclaimed Room",
              intent: "PERFORM" as const,
              notificationIntents: [] as [],
            }
          : {
              outcome: "created" as const,
              bookingRequestId: `req-${args.event.id}`,
              placeId: PLACE_HUMAN,
              placeName: "Human Room",
              intent: "PERFORM" as const,
              parked: false as const,
              notificationIntents: [
                { kind: "request.received" as const, bookingRequestId: `req-${args.event.id}`, placeId: PLACE_HUMAN, at: NOW },
              ],
            },
      ),
      dispatch: vi.fn(async (intents: readonly { bookingRequestId?: string }[]) => {
        if (intents[0]?.bookingRequestId === "req-c2") throw new Error("notify down");
      }),
    });

    const summary = await runLegacyThirdPartyEventsMigration(deps, { dryRun: false });

    expect(summary).toMatchObject({ created: 2, parked: 0, failed: [] });
    expect(summary.skippedByReason).toEqual({ "venue_not_accepting:PLACE_NOT_TAKING_REQUESTS": 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ eventId: "c2", step: "dispatch" }) }),
    );
  });
});
