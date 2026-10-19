import { describe, expect, it, vi } from "vitest";

import type { EventSlugContext } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

import { assignSlugOnCreate } from "../_shared/assign-slug-on-create";

const EVENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SHORT_ID = "2dmtus8w40";
const NOW = new Date("2026-01-05T12:00:00.000Z");

function makeContext(
  overrides: Partial<EventSlugContext> = {},
): EventSlugContext {
  return {
    eventId: EVENT_ID,
    orgId: "11111111-1111-4111-8111-111111111111",
    humanId: null,
    eventTitle: "Spring Fling",
    startsAt: new Date("2026-04-18T20:30:00.000Z"),
    // 20:30Z is 15:30 CDT — the slug's date segment is the LOCAL start.
    timezone: "America/Chicago",
    orgName: "Drkmttr",
    countryCode: "US",
    regionCode: "TN",
    cityOrRegionCode: "Nashville",
    shortId: null,
    ...overrides,
  };
}

/**
 * A repo bag that is BOTH the non-transactional surface and what `repos.tx()`
 * hands the callback — the real shape (`TxRepos = Omit<Repos, "tx">`).
 *
 * `txCalls` counts how many transactions the helper opened. That is a real
 * assertion, not bookkeeping: the whole point of this helper's rewrite is that
 * the slug work runs in a transaction of ITS OWN, so a constraint violation
 * cannot silently roll back the caller's create. A version that wrote directly
 * on the bag would pass every other test here.
 */
function makeRepos(options: {
  slugContext?: EventSlugContext | null;
  getSlugContext?: () => Promise<EventSlugContext | null>;
  assignSlug?: () => Promise<unknown>;
  auditLog?: () => Promise<void>;
  /** Simulates the transaction itself rejecting (rollback). */
  txThrows?: unknown;
}) {
  const getSlugContext = vi.fn(
    options.getSlugContext ??
      (async () =>
        options.slugContext === undefined ? makeContext() : options.slugContext),
  );
  const assignSlug = vi.fn(options.assignSlug ?? (async () => ({})));
  const log = vi.fn(options.auditLog ?? (async () => {}));
  const recordSlugHistory = vi.fn(async () => {});

  const bag = {
    events: { getSlugContext, assignSlug, recordSlugHistory },
    audit: { log },
  } as unknown as TxRepos;

  const tx = vi.fn(async <R>(fn: (t: TxRepos) => Promise<R>): Promise<R> => {
    if (options.txThrows !== undefined) {
      throw options.txThrows;
    }
    return fn(bag);
  });

  const repos = { ...bag, tx } as unknown as Repos;

  return { repos, getSlugContext, assignSlug, recordSlugHistory, log, tx };
}

describe("assignSlugOnCreate", () => {
  it("assigns the derived slug and audits it", async () => {
    const { repos, assignSlug, log, tx } = makeRepos({});
    const reportError = vi.fn();

    const slug = await assignSlugOnCreate({ reportError }, repos, {
      eventId: EVENT_ID,
      now: NOW,
      useCase: "saveEvent",
    });

    expect(slug).toBe(
      `drkmttr/us/nashville/spring-fling-2026-04-18-1530--${SHORT_ID}`,
    );
    expect(assignSlug).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      slug,
      shortId: SHORT_ID,
      regionCode: "TN",
      assignedAt: NOW,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "event.slug_assigned",
        data: { slug, shortId: SHORT_ID },
        at: NOW,
      }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("NEVER writes an EventSlugHistory row", async () => {
    // The table means SUPERSEDED slugs only. A row for the current slug is
    // unreachable via `resolveBySlug` AND, because the column is globally
    // unique, it is what used to blow up the first later `regenerateEventSlug`.
    const { repos, recordSlugHistory } = makeRepos({});

    await assignSlugOnCreate({}, repos, {
      eventId: EVENT_ID,
      now: NOW,
      useCase: "saveEvent",
    });

    expect(recordSlugHistory).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Expected no-ops — silent, and deliberately NOT reported
  // -------------------------------------------------------------------------
  it("is a silent no-op when there is no slug context", async () => {
    const { repos, assignSlug, log, tx } = makeRepos({ slugContext: null });
    const reportError = vi.fn();

    const slug = await assignSlugOnCreate({ reportError }, repos, {
      eventId: EVENT_ID,
      now: NOW,
      useCase: "saveEvent",
    });

    expect(slug).toBeNull();
    expect(assignSlug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the event has no country code", async () => {
    // The common real case: location is optional at create, and even a linked
    // Place may have `country: null`. `generateEventSlug` throws
    // EVENT_LOCATION_REQUIRED, which is an EXPECTED outcome, not an incident.
    const { repos, assignSlug, tx } = makeRepos({
      slugContext: makeContext({ countryCode: null }),
    });
    const reportError = vi.fn();
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    const slug = await assignSlugOnCreate(
      { reportError, logger: logger as never },
      repos,
      { eventId: EVENT_ID, now: NOW, useCase: "saveEvent" },
    );

    expect(slug).toBeNull();
    expect(assignSlug).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Swallow + report (ReporterPort convention, CLAUDE.md)
  // -------------------------------------------------------------------------
  it("swallows an assignSlug conflict and REPORTS it", async () => {
    const conflict = { code: "conflict" };
    const { repos } = makeRepos({
      assignSlug: async () => {
        throw conflict;
      },
    });
    const reportError = vi.fn();
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    const slug = await assignSlugOnCreate(
      { reportError, logger: logger as never },
      repos,
      { eventId: EVENT_ID, now: NOW, useCase: "saveEvent" },
    );

    expect(slug).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0]!;
    expect(reported).toBe(conflict);
    expect(context?.tags?.useCase).toBe("saveEvent");
    expect(context?.tags?.stage).toBe("assign_slug_on_create");
    expect(context?.extra).toMatchObject({ eventId: EVENT_ID });
    // The log line SURVIVES alongside the report (never demoted to warn —
    // warn is not captured by Sentry's pino integration).
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("swallows and reports a throwing getSlugContext", async () => {
    const boom = new Error("neon blip");
    const { repos, assignSlug, tx } = makeRepos({
      getSlugContext: async () => {
        throw boom;
      },
    });
    const reportError = vi.fn();

    const slug = await assignSlugOnCreate({ reportError }, repos, {
      eventId: EVENT_ID,
      now: NOW,
      useCase: "generateEventsFromSeries",
    });

    expect(slug).toBeNull();
    expect(assignSlug).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBe(boom);
    expect(reportError.mock.calls[0]![1]?.tags?.useCase).toBe(
      "generateEventsFromSeries",
    );
  });

  it("reports a non-EVENT_LOCATION_REQUIRED failure from slug generation", async () => {
    // A context with a non-Date `startsAt` makes `formatDateSegment` throw —
    // stands in for any unexpected generator failure. It must NOT be mistaken
    // for the expected no-country case.
    const { repos } = makeRepos({
      slugContext: makeContext({
        startsAt: "not-a-date" as unknown as Date,
      }),
    });
    const reportError = vi.fn();

    const slug = await assignSlugOnCreate({ reportError }, repos, {
      eventId: EVENT_ID,
      now: NOW,
      useCase: "saveEvent",
    });

    expect(slug).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the REPORTER itself throws", async () => {
    const { repos } = makeRepos({
      assignSlug: async () => {
        throw new Error("nope");
      },
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    await expect(
      assignSlugOnCreate({ reportError }, repos, {
        eventId: EVENT_ID,
        now: NOW,
        useCase: "saveEvent",
      }),
    ).resolves.toBeNull();
  });

  it("works with no reporter and no logger wired at all", async () => {
    const { repos } = makeRepos({
      assignSlug: async () => {
        throw new Error("nope");
      },
    });

    await expect(
      assignSlugOnCreate({}, repos, {
        eventId: EVENT_ID,
        now: NOW,
        useCase: "saveEvent",
      }),
    ).resolves.toBeNull();
  });
  // -------------------------------------------------------------------------
  // Transaction isolation — the reason this helper takes `Repos`, not `TxRepos`
  // -------------------------------------------------------------------------
  describe("transaction isolation", () => {
    it("opens its OWN transaction for the write pair", async () => {
      // Not decoration. A statement that fails at the database aborts the
      // ENCLOSING Postgres transaction, and the COMMIT that follows is
      // answered with ROLLBACK and no error — which Prisma does not surface.
      // So a try/catch around a slug write inside the CALLER's transaction
      // silently discards the caller's work while reporting success. The only
      // fix is for the slug work to own the transaction it can poison.
      const { repos, tx, assignSlug, log } = makeRepos({});

      await assignSlugOnCreate({}, repos, {
        eventId: EVENT_ID,
        now: NOW,
        useCase: "saveEvent",
      });

      expect(tx).toHaveBeenCalledTimes(1);
      // Both writes are inside it, so the slug and the audit row that explains
      // it commit together.
      expect(assignSlug).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it("reads the slug context OUTSIDE the transaction", async () => {
      // A pure read has nothing to roll back and no ability to poison anything,
      // so it stays out — the transaction is opened only once there is
      // something to write, keeping it as short as possible.
      const { repos, tx, getSlugContext } = makeRepos({});

      await assignSlugOnCreate({}, repos, {
        eventId: EVENT_ID,
        now: NOW,
        useCase: "saveEvent",
      });

      expect(getSlugContext).toHaveBeenCalledTimes(1);
      expect(tx.mock.invocationCallOrder[0]).toBeGreaterThan(
        getSlugContext.mock.invocationCallOrder[0]!,
      );
    });

    it("opens NO transaction when there is nothing to write", async () => {
      const { repos, tx } = makeRepos({
        slugContext: makeContext({ countryCode: null }),
      });

      await assignSlugOnCreate({}, repos, {
        eventId: EVENT_ID,
        now: NOW,
        useCase: "saveEvent",
      });

      expect(tx).not.toHaveBeenCalled();
    });

    it("swallows and reports a ROLLED-BACK transaction", async () => {
      // What a real P2002 looks like from out here: `repos.tx()` REJECTS, the
      // database rolled the slug transaction back cleanly, and nothing the
      // caller committed earlier is affected.
      const rollback = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
      const { repos } = makeRepos({ txThrows: rollback });
      const reportError = vi.fn();

      const slug = await assignSlugOnCreate({ reportError }, repos, {
        eventId: EVENT_ID,
        now: NOW,
        useCase: "saveEvent",
      });

      expect(slug).toBeNull();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![0]).toBe(rollback);
      expect(reportError.mock.calls[0]![1]?.tags?.stage).toBe(
        "assign_slug_on_create",
      );
    });
  });
});
