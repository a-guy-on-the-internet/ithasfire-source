import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventSlugDateRow } from "@th/types";

import {
  classifyEventSlugDate,
  correctEventSlugDates,
  SLUG_DATE_CORRECTED_AUDIT_ACTION,
} from "../correct-event-slug-dates";

const NOW = new Date("2026-10-15T18:00:00.000Z");
const CHICAGO = "America/Chicago";
const PREFIX = "drkmttr/us/nashville";

// Mon 12 Oct 2026 19:00 CDT = 2026-10-13T00:00Z: the old slug said the 13th.
const EVENING = new Date("2026-10-13T00:00:00.000Z");
// 14:00 CDT = 19:00Z the same day: same date, wrong HHmm.
const AFTERNOON = new Date("2026-10-12T19:00:00.000Z");
// Rows created long before the local-slug fix was deployed.
const OLD = new Date("2026-09-01T12:00:00.000Z");
// `utcMintedBefore` in the tests: the (pretend) deploy of ba1a3df50.
const CUTOFF = new Date("2026-10-14T00:00:00.000Z");

const ID = {
  evening: "00000000-0000-4000-8000-000000000001",
  afternoon: "00000000-0000-4000-8000-000000000002",
  alreadyNew: "00000000-0000-4000-8000-000000000003",
  moved: "00000000-0000-4000-8000-000000000004",
  unparseable: "00000000-0000-4000-8000-000000000005",
  draftEvening: "00000000-0000-4000-8000-000000000006",
} as const;

type FakeEvent = EventSlugDateRow & { regionCode: string | null };

function seed(): FakeEvent[] {
  return [
    {
      id: ID.evening,
      slug: `${PREFIX}/open-mic-2026-10-13-0000--lalot88hk5`,
      startsAt: EVENING,
      timezone: CHICAGO,
      status: "PUBLISHED",
      regionCode: "TN",
      createdAt: OLD,
    },
    {
      id: ID.afternoon,
      slug: `${PREFIX}/matinee-2026-10-12-1900--aaaaaaaaa1`,
      startsAt: AFTERNOON,
      timezone: CHICAGO,
      status: "PUBLISHED",
      regionCode: "TN",
      createdAt: OLD,
    },
    {
      id: ID.alreadyNew,
      slug: `${PREFIX}/new-show-2026-10-12-1900--aaaaaaaaa2`,
      startsAt: EVENING,
      timezone: CHICAGO,
      status: "PUBLISHED",
      regionCode: "TN",
      createdAt: OLD,
    },
    {
      // Slug minted for 1 Oct; the start was moved later.
      id: ID.moved,
      slug: `${PREFIX}/moved-2026-10-01-0000--aaaaaaaaa3`,
      startsAt: EVENING,
      timezone: CHICAGO,
      status: "CANCELLED",
      regionCode: "TN",
      createdAt: OLD,
    },
    {
      id: ID.unparseable,
      slug: `${PREFIX}/no-date-here`,
      startsAt: EVENING,
      timezone: CHICAGO,
      status: "PUBLISHED",
      regionCode: "TN",
      createdAt: OLD,
    },
    {
      id: ID.draftEvening,
      slug: `${PREFIX}/draft-2026-10-13-0000--aaaaaaaaa4`,
      startsAt: EVENING,
      timezone: CHICAGO,
      status: "DRAFT",
      regionCode: null,
      createdAt: OLD,
    },
  ];
}

function makeRepos(
  options: { failUpdateFor?: string; events?: FakeEvent[] } = {},
) {
  const store = new Map(
    (options.events ?? seed()).map((e): [string, FakeEvent] => [e.id, { ...e }]),
  );
  const history: { eventId: string; slug: string }[] = [];
  const audit: {
    entity?: string;
    entityId?: string | null;
    action: string;
    data?: unknown;
    at?: Date;
  }[] = [];
  const reindexMarks: unknown[] = [];

  const listSluggedPage = vi.fn(
    async ({ afterId, limit }: { afterId: string | null; limit: number }) =>
      [...store.values()]
        .filter((e) => e.slug && (afterId === null || e.id > afterId))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(({ id, slug, startsAt, timezone, status, createdAt }) => ({
          id,
          slug,
          startsAt,
          timezone,
          status,
          createdAt,
        })),
  );
  const lockRows = vi.fn(async () => {});
  // The narrow re-read: only the slug-date columns, null without a slug.
  const getSlugDateRow = vi.fn(async (id: string) => {
    const e = store.get(id);
    if (!e?.slug) return null;
    const { id: eventId, slug, startsAt, timezone, status, createdAt } = e;
    return { id: eventId, slug, startsAt, timezone, status, createdAt };
  });
  // The full-record read and write fail against a database behind the Prisma
  // schema (prod); the backfill must never call them.
  const getById = vi.fn(async () => {
    throw new Error("getById: full event select");
  });
  const updateSlug = vi.fn(async () => {
    throw new Error("updateSlug: full event select");
  });
  const recordSlugHistory = vi.fn(
    async (input: { eventId: string; slug: string }) => {
      history.push({ eventId: input.eventId, slug: input.slug });
    },
  );
  const setSlugOnly = vi.fn(async (input: { eventId: string; slug: string }) => {
    if (input.eventId === options.failUpdateFor) {
      throw { code: "conflict" };
    }
    store.get(input.eventId)!.slug = input.slug;
  });
  const log = vi.fn(async (entry: (typeof audit)[number]) => {
    audit.push(entry);
  });
  // Like the adapter: contains-style on `action`, exact on `entityId`,
  // ordered by each row's real `at`, then offset/limit (default 25).
  const list = vi.fn(
    async (input: {
      entityId?: string | null;
      action?: string | null;
      sort?: "at_desc" | "at_asc";
      limit?: number;
      offset?: number;
    }) => {
      const matched = audit
        .filter(
          (a) =>
            (!input.entityId || a.entityId === input.entityId) &&
            (!input.action || a.action.includes(input.action)),
        )
        .map((a, i) => ({
          id: String(i),
          entity: a.entity ?? "event",
          entityId: a.entityId ?? null,
          action: a.action,
          data: a.data,
          actorHumanId: null,
          at: a.at!,
        }))
        .sort((x, y) =>
          input.sort === "at_asc"
            ? x.at.getTime() - y.at.getTime()
            : y.at.getTime() - x.at.getTime(),
        );
      const offset = input.offset ?? 0;
      return {
        items: matched.slice(offset, offset + (input.limit ?? 25)),
        total: matched.length,
      };
    },
  );
  const mark = vi.fn(async (targets: unknown[]) => {
    reindexMarks.push(...targets);
  });

  const bag = {
    events: {
      listSluggedPage,
      lockRows,
      getSlugDateRow,
      getById,
      recordSlugHistory,
      setSlugOnly,
      updateSlug,
    },
    audit: { log, list },
    searchReindexPending: { mark },
  } as unknown as TxRepos;

  // A real transaction rolls back on throw: snapshot and restore.
  const tx = vi.fn(async <R>(fn: (t: TxRepos) => Promise<R>): Promise<R> => {
    const snapshot = new Map([...store].map(([k, v]) => [k, { ...v }]));
    const lens = [history.length, audit.length, reindexMarks.length] as const;
    try {
      return await fn(bag);
    } catch (error) {
      store.clear();
      for (const [k, v] of snapshot) store.set(k, v);
      history.length = lens[0];
      audit.length = lens[1];
      reindexMarks.length = lens[2];
      throw error;
    }
  });

  const repos = { ...bag, tx } as unknown as Repos;
  return {
    repos,
    store,
    history,
    audit,
    reindexMarks,
    tx,
    list,
    getById,
    updateSlug,
    setSlugOnly,
  };
}

function deps(repos: Repos, reportError: unknown = vi.fn(), now: Date = NOW) {
  return {
    repos,
    clock: { now: () => now },
    reportError,
  } as unknown as Parameters<typeof correctEventSlugDates>[0];
}

describe("classifyEventSlugDate", () => {
  it("corrects an evening CDT slug dated a day late", () => {
    expect(
      classifyEventSlugDate({
        slug: `${PREFIX}/open-mic-2026-10-13-0000--lalot88hk5`,
        startsAt: EVENING,
        timezone: CHICAGO,
      }),
    ).toEqual({
      outcome: "corrected",
      newSlug: `${PREFIX}/open-mic-2026-10-12-1900--lalot88hk5`,
      basis: "current_start",
    });
  });

  it("corrects an afternoon slug whose date matched but whose time was UTC", () => {
    expect(
      classifyEventSlugDate({
        slug: `${PREFIX}/matinee-2026-10-12-1900--aaaaaaaaa1`,
        startsAt: AFTERNOON,
        timezone: CHICAGO,
      }),
    ).toEqual({
      outcome: "corrected",
      newSlug: `${PREFIX}/matinee-2026-10-12-1400--aaaaaaaaa1`,
      basis: "current_start",
    });
  });

  it("replaces only the tail's date, not a lookalike in the title", () => {
    expect(
      classifyEventSlugDate({
        slug: `${PREFIX}/rerun-of-2026-10-13-0000-2026-10-13-0000--lalot88hk5`,
        startsAt: EVENING,
        timezone: CHICAGO,
      }),
    ).toEqual({
      outcome: "corrected",
      newSlug: `${PREFIX}/rerun-of-2026-10-13-0000-2026-10-12-1900--lalot88hk5`,
      basis: "current_start",
    });
  });

  it("leaves a slug alone when local and UTC render the same", () => {
    expect(
      classifyEventSlugDate({
        slug: "acme/gb/london/show-2026-12-01-2000--aaaaaaaaa9",
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        timezone: "Europe/London",
      }),
    ).toEqual({ outcome: "already_correct" });
  });

  it("reports a slug matching neither rendering as start_moved", () => {
    expect(
      classifyEventSlugDate({
        slug: `${PREFIX}/moved-2026-10-01-0000--aaaaaaaaa3`,
        startsAt: EVENING,
        timezone: CHICAGO,
      }).outcome,
    ).toBe("start_moved");
  });

  it("reports a slug without the date tail as unparseable", () => {
    expect(
      classifyEventSlugDate({
        slug: `${PREFIX}/no-date-here`,
        startsAt: EVENING,
        timezone: CHICAGO,
      }).outcome,
    ).toBe("unparseable");
  });
});

describe("correctEventSlugDates", () => {
  it("dry run (the default) classifies every event and writes nothing", async () => {
    const r = makeRepos();
    const before = new Map([...r.store].map(([k, v]) => [k, v.slug]));

    const out = await correctEventSlugDates(deps(r.repos), {});

    expect(out.applied).toBe(false);
    expect(out.scanned).toBe(6);
    expect(out.counts).toEqual({
      corrected: 3,
      already_correct: 1,
      start_moved: 1,
      unparseable: 1,
      minted_after_cutoff: 0,
      gone: 0,
      failed: 0,
    });
    expect(out.rows.find((row) => row.eventId === ID.evening)).toEqual({
      eventId: ID.evening,
      previousSlug: `${PREFIX}/open-mic-2026-10-13-0000--lalot88hk5`,
      newSlug: `${PREFIX}/open-mic-2026-10-12-1900--lalot88hk5`,
      outcome: "corrected",
      basis: "current_start",
    });
    expect(r.tx).not.toHaveBeenCalled();
    expect(r.history).toEqual([]);
    expect(r.audit).toEqual([]);
    expect(r.reindexMarks).toEqual([]);
    expect(new Map([...r.store].map(([k, v]) => [k, v.slug]))).toEqual(before);
  });

  it("apply rewrites the date, records history, audits, and marks only PUBLISHED for reindex", async () => {
    const r = makeRepos();

    const out = await correctEventSlugDates(deps(r.repos), { apply: true });

    expect(out.applied).toBe(true);
    expect(out.counts.corrected).toBe(3);
    expect(r.store.get(ID.evening)!.slug).toBe(
      `${PREFIX}/open-mic-2026-10-12-1900--lalot88hk5`,
    );
    expect(r.store.get(ID.afternoon)!.slug).toBe(
      `${PREFIX}/matinee-2026-10-12-1400--aaaaaaaaa1`,
    );
    expect(r.store.get(ID.draftEvening)!.slug).toBe(
      `${PREFIX}/draft-2026-10-12-1900--aaaaaaaaa4`,
    );
    // region code passes through unchanged
    expect(r.store.get(ID.evening)!.regionCode).toBe("TN");
    expect(r.store.get(ID.draftEvening)!.regionCode).toBeNull();

    // untouched
    expect(r.store.get(ID.alreadyNew)!.slug).toBe(
      `${PREFIX}/new-show-2026-10-12-1900--aaaaaaaaa2`,
    );
    expect(r.store.get(ID.moved)!.slug).toBe(
      `${PREFIX}/moved-2026-10-01-0000--aaaaaaaaa3`,
    );
    expect(r.store.get(ID.unparseable)!.slug).toBe(`${PREFIX}/no-date-here`);

    expect(r.history).toEqual([
      { eventId: ID.evening, slug: `${PREFIX}/open-mic-2026-10-13-0000--lalot88hk5` },
      { eventId: ID.afternoon, slug: `${PREFIX}/matinee-2026-10-12-1900--aaaaaaaaa1` },
      { eventId: ID.draftEvening, slug: `${PREFIX}/draft-2026-10-13-0000--aaaaaaaaa4` },
    ]);
    expect(r.audit).toHaveLength(3);
    expect(r.audit[0]).toEqual({
      entity: "event",
      entityId: ID.evening,
      action: SLUG_DATE_CORRECTED_AUDIT_ACTION,
      data: {
        previousSlug: `${PREFIX}/open-mic-2026-10-13-0000--lalot88hk5`,
        newSlug: `${PREFIX}/open-mic-2026-10-12-1900--lalot88hk5`,
        basis: "current_start",
        source: "BACKFILL",
        actorHumanId: null,
      },
      at: NOW,
    });
    // the DRAFT was corrected but not marked
    expect(r.reindexMarks).toEqual([
      { entityType: "event", entityId: ID.evening },
      { entityType: "event", entityId: ID.afternoon },
    ]);
    // one transaction per corrected event
    expect(r.tx).toHaveBeenCalledTimes(3);
  });

  it("is idempotent: a second apply changes nothing", async () => {
    const r = makeRepos();
    await correctEventSlugDates(deps(r.repos), { apply: true });
    const slugsAfterFirst = new Map([...r.store].map(([k, v]) => [k, v.slug]));
    const historyLen = r.history.length;
    const auditLen = r.audit.length;

    const second = await correctEventSlugDates(deps(r.repos), { apply: true });

    expect(second.counts).toEqual({
      corrected: 0,
      already_correct: 4,
      start_moved: 1,
      unparseable: 1,
      minted_after_cutoff: 0,
      gone: 0,
      failed: 0,
    });
    expect(new Map([...r.store].map(([k, v]) => [k, v.slug]))).toEqual(
      slugsAfterFirst,
    );
    expect(r.history).toHaveLength(historyLen);
    expect(r.audit).toHaveLength(auditLen);
  });

  it("one failing event does not stop the rest and is reported", async () => {
    const r = makeRepos({ failUpdateFor: ID.afternoon });
    const reportError = vi.fn();

    const out = await correctEventSlugDates(deps(r.repos, reportError), {
      apply: true,
    });

    expect(out.counts.corrected).toBe(2);
    expect(out.counts.failed).toBe(1);
    const failed = out.rows.find((row) => row.outcome === "failed")!;
    expect(failed.eventId).toBe(ID.afternoon);
    expect(failed.newSlug).toBe(`${PREFIX}/matinee-2026-10-12-1400--aaaaaaaaa1`);
    expect(failed.error).toContain("event_slug_conflict");
    // rolled back: slug and history untouched for the failed one
    expect(r.store.get(ID.afternoon)!.slug).toBe(
      `${PREFIX}/matinee-2026-10-12-1900--aaaaaaaaa1`,
    );
    expect(r.history.map((h) => h.eventId)).not.toContain(ID.afternoon);
    // later events still corrected
    expect(r.store.get(ID.draftEvening)!.slug).toBe(
      `${PREFIX}/draft-2026-10-12-1900--aaaaaaaaa4`,
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "conflict", message: "event_slug_conflict" }),
      {
        tags: { useCase: "correctEventSlugDates" },
        extra: {
          eventId: ID.afternoon,
          previousSlug: `${PREFIX}/matinee-2026-10-12-1900--aaaaaaaaa1`,
        },
      },
    );
  });

  it("a throwing reporter does not change the batch's outcome", async () => {
    const r = makeRepos({ failUpdateFor: ID.evening });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const out = await correctEventSlugDates(deps(r.repos, reportError), {
      apply: true,
    });

    expect(out.counts.failed).toBe(1);
    expect(out.counts.corrected).toBe(2);
  });

  it("re-classifies under the lock: a slug changed since the page read is not overwritten", async () => {
    const r = makeRepos({ events: seed().filter((e) => e.id === ID.evening) });
    const listed = r.repos.events.listSluggedPage as ReturnType<typeof vi.fn>;
    listed.mockImplementationOnce(async () => {
      const row = { ...r.store.get(ID.evening)! };
      // An organiser regenerates between the read and the write.
      r.store.get(ID.evening)!.slug = `${PREFIX}/renamed-2026-10-12-1900--lalot88hk5`;
      return [row];
    });

    const out = await correctEventSlugDates(deps(r.repos), { apply: true });

    expect(out.rows[0]!.outcome).toBe("already_correct");
    expect(r.store.get(ID.evening)!.slug).toBe(
      `${PREFIX}/renamed-2026-10-12-1900--lalot88hk5`,
    );
    expect(r.history).toEqual([]);
  });

  it("pages by keyset and reports the next cursor", async () => {
    const r = makeRepos();

    const first = await correctEventSlugDates(deps(r.repos), { limit: 4 });
    expect(first.scanned).toBe(4);
    expect(first.nextAfterId).toBe(ID.moved);

    const second = await correctEventSlugDates(deps(r.repos), {
      limit: 4,
      afterId: first.nextAfterId,
    });
    expect(second.rows.map((row) => row.eventId)).toEqual([
      ID.unparseable,
      ID.draftEvening,
    ]);
    expect(second.nextAfterId).toBeNull();
  });

  it("rejects unknown input keys", async () => {
    const r = makeRepos();
    await expect(
      correctEventSlugDates(deps(r.repos), { apply: true, force: true }),
    ).rejects.toBeTruthy();
  });
});

describe("utcMintedBefore: reading the slug's own segment as UTC", () => {
  // A weekly open mic: the slug was minted (in UTC) from the first night, Mon
  // 12 Oct 19:00 CDT = 13 Oct 00:00Z, and `Event.startsAt` has since moved on
  // to the next night, Mon 19 Oct 19:00 CDT.
  const COBRA_SLUG = `${PREFIX}/cobra-comedy-open-mic-at-cobra-nashville-2026-10-13-0000--lalot88hk5`;
  const COBRA_FIXED = `${PREFIX}/cobra-comedy-open-mic-at-cobra-nashville-2026-10-12-1900--lalot88hk5`;
  const NEXT_NIGHT = new Date("2026-10-20T00:00:00.000Z");
  const COBRA_ID = "00000000-0000-4000-8000-0000000000c0";

  function cobra(overrides: Partial<FakeEvent> = {}): FakeEvent {
    return {
      id: COBRA_ID,
      slug: COBRA_SLUG,
      startsAt: NEXT_NIGHT,
      timezone: CHICAGO,
      status: "PUBLISHED",
      regionCode: "TN",
      createdAt: OLD,
      ...overrides,
    };
  }

  it("classifies a series slug created before the cutoff as corrected via slug_instant", () => {
    expect(
      classifyEventSlugDate(cobra(), { utcMintedBefore: CUTOFF }),
    ).toEqual({
      outcome: "corrected",
      newSlug: COBRA_FIXED,
      basis: "slug_instant",
    });
  });

  it("never reinterprets an event created at or after the cutoff", () => {
    expect(
      classifyEventSlugDate(cobra({ createdAt: CUTOFF }), {
        utcMintedBefore: CUTOFF,
      }).outcome,
    ).toBe("start_moved");
    expect(
      classifyEventSlugDate(
        cobra({ createdAt: new Date("2026-10-14T09:00:00.000Z") }),
        { utcMintedBefore: CUTOFF },
      ).outcome,
    ).toBe("start_moved");
  });

  it("without the flag the series slug stays start_moved", () => {
    expect(classifyEventSlugDate(cobra()).outcome).toBe("start_moved");
    expect(
      classifyEventSlugDate(cobra(), { utcMintedBefore: null }).outcome,
    ).toBe("start_moved");
  });

  it("an impossible date or time in the segment stays start_moved", () => {
    for (const segment of [
      "2026-13-01-0000",
      "2026-02-30-1900",
      "2026-10-12-2400",
      "2026-10-12-1960",
    ]) {
      expect(
        classifyEventSlugDate(
          cobra({ slug: `${PREFIX}/open-mic-${segment}--lalot88hk5` }),
          { utcMintedBefore: CUTOFF },
        ).outcome,
      ).toBe("start_moved");
    }
  });

  it("a zone where the UTC reading renders the same stays start_moved", () => {
    // London in winter is UTC+0: re-rendering changes nothing.
    expect(
      classifyEventSlugDate(
        {
          slug: "acme/gb/london/weekly-2026-12-01-2000--aaaaaaaaa9",
          startsAt: new Date("2026-12-08T20:00:00.000Z"),
          timezone: "Europe/London",
          createdAt: OLD,
        },
        { utcMintedBefore: CUTOFF },
      ).outcome,
    ).toBe("start_moved");
  });

  it("apply corrects the series slug, records the basis, and audits it", async () => {
    const r = makeRepos({ events: [cobra()] });

    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows).toEqual([
      {
        eventId: COBRA_ID,
        previousSlug: COBRA_SLUG,
        newSlug: COBRA_FIXED,
        outcome: "corrected",
        basis: "slug_instant",
      },
    ]);
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
    // the start is not touched: only the slug moves
    expect(r.store.get(COBRA_ID)!.startsAt).toEqual(NEXT_NIGHT);
    expect(r.history).toEqual([{ eventId: COBRA_ID, slug: COBRA_SLUG }]);
    expect(r.audit).toEqual([
      {
        entity: "event",
        entityId: COBRA_ID,
        action: SLUG_DATE_CORRECTED_AUDIT_ACTION,
        data: {
          previousSlug: COBRA_SLUG,
          newSlug: COBRA_FIXED,
          basis: "slug_instant",
          source: "BACKFILL",
          actorHumanId: null,
        },
        at: NOW,
      },
    ]);
    expect(r.reindexMarks).toEqual([{ entityType: "event", entityId: COBRA_ID }]);
  });

  it("the dry run reports slug_instant and writes nothing", async () => {
    const r = makeRepos({ events: [cobra()] });

    const out = await correctEventSlugDates(deps(r.repos), {
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]).toMatchObject({
      outcome: "corrected",
      newSlug: COBRA_FIXED,
      basis: "slug_instant",
    });
    expect(r.tx).not.toHaveBeenCalled();
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_SLUG);
  });

  it("the same series event created after the cutoff is left alone", async () => {
    const r = makeRepos({
      events: [cobra({ createdAt: new Date("2026-10-14T09:00:00.000Z") })],
    });

    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]!.outcome).toBe("start_moved");
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_SLUG);
    expect(r.audit).toEqual([]);
  });

  it("without the flag apply leaves the series slug alone and reads no audit", async () => {
    const r = makeRepos({ events: [cobra()] });

    const out = await correctEventSlugDates(deps(r.repos), { apply: true });

    expect(out.rows[0]!.outcome).toBe("start_moved");
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_SLUG);
    expect(r.list).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run with the flag does not shift the corrected slug again", async () => {
    const r = makeRepos({ events: [cobra()] });
    await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
    // Read as UTC, the corrected `…-2026-10-12-1900` would become
    // `…-2026-10-12-1400`: the audit check is what stops it.
    expect(
      classifyEventSlugDate(r.store.get(COBRA_ID)!, { utcMintedBefore: CUTOFF }),
    ).toMatchObject({ outcome: "corrected", basis: "slug_instant" });

    const dry = await correctEventSlugDates(deps(r.repos), {
      utcMintedBefore: CUTOFF,
    });
    const again = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    for (const out of [dry, again]) {
      expect(out.rows).toEqual([
        {
          eventId: COBRA_ID,
          previousSlug: COBRA_FIXED,
          newSlug: null,
          outcome: "already_correct",
        },
      ]);
    }
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
    expect(r.history).toHaveLength(1);
    expect(r.audit).toHaveLength(1);
  });

  it("a series corrected by current_start is not reinterpreted after its start moves on", async () => {
    // First night still current: the current-start rule corrects it.
    const r = makeRepos({ events: [cobra({ startsAt: EVENING })] });
    await correctEventSlugDates(deps(r.repos), { apply: true });
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);

    // A week later the series mirrors the next night.
    r.store.get(COBRA_ID)!.startsAt = NEXT_NIGHT;
    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]!.outcome).toBe("already_correct");
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
    expect(r.audit).toHaveLength(1);
  });

  it("apply never uses the full-record getById / updateSlug (schema-narrow)", async () => {
    const r = makeRepos({ events: [...seed(), cobra()] });

    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    // 3 by current_start; `moved` (also created before the cutoff) and Cobra
    // by slug_instant.
    expect(out.counts.failed).toBe(0);
    expect(out.counts.corrected).toBe(5);
    expect(r.setSlugOnly).toHaveBeenCalledTimes(5);
    expect(r.getById).not.toHaveBeenCalled();
    expect(r.updateSlug).not.toHaveBeenCalled();
    expect(r.setSlugOnly).toHaveBeenCalledWith({
      eventId: COBRA_ID,
      slug: COBRA_FIXED,
    });
  });

  // A slug write by the app, as its audit row looks (`at` = when it ran).
  function slugWrite(action: string, at: Date) {
    return { entity: "event", entityId: COBRA_ID, action, data: {}, at };
  }
  const BEFORE_CUTOFF = new Date("2026-10-05T12:00:00.000Z");
  const AFTER_CUTOFF = new Date("2026-10-14T09:00:00.000Z");

  it("a pre-cutoff event whose slug was re-derived after the cutoff is minted_after_cutoff", async () => {
    // A draft from 1 Sep first published after the deploy: the re-derived
    // slug is already local. Reading it as UTC would shift it to 14:00.
    const r = makeRepos({
      events: [cobra({ slug: COBRA_FIXED })],
    });
    r.audit.push(
      slugWrite("event.slug_assigned", OLD),
      slugWrite("event.slug_rederived_at_publish", AFTER_CUTOFF),
    );

    const dry = await correctEventSlugDates(deps(r.repos), {
      utcMintedBefore: CUTOFF,
    });
    const applied = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    for (const out of [dry, applied]) {
      expect(out.rows).toEqual([
        {
          eventId: COBRA_ID,
          previousSlug: COBRA_FIXED,
          newSlug: null,
          outcome: "minted_after_cutoff",
        },
      ]);
      expect(out.counts.minted_after_cutoff).toBe(1);
    }
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
    expect(r.history).toEqual([]);
    expect(r.audit).toHaveLength(2);
  });

  it("a slug regenerated before the cutoff was minted in UTC and is corrected", async () => {
    const r = makeRepos({ events: [cobra()] });
    r.audit.push(
      slugWrite("event.slug_assigned", OLD),
      slugWrite("event.slug_regenerated", BEFORE_CUTOFF),
    );

    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]).toMatchObject({
      outcome: "corrected",
      basis: "slug_instant",
      newSlug: COBRA_FIXED,
    });
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
  });

  it("corrected, then re-minted in UTC by old code before the deploy: the next run corrects it again", async () => {
    // Run 1 happens BEFORE the deploy (cutoff C1, clock T1).
    const C1 = new Date("2026-10-10T00:00:00.000Z");
    const T1 = new Date("2026-10-11T00:00:00.000Z");
    const r = makeRepos({ events: [cobra()] });
    await correctEventSlugDates(deps(r.repos, vi.fn(), T1), {
      apply: true,
      utcMintedBefore: C1,
    });
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);

    // Old code (still live) regenerates on 12 Oct: back to a UTC segment.
    const REMINTED = `${PREFIX}/cobra-renamed-2026-10-13-0000--lalot88hk5`;
    r.store.get(COBRA_ID)!.slug = REMINTED;
    r.audit.push(
      slugWrite("event.slug_regenerated", new Date("2026-10-12T00:00:00.000Z")),
    );

    // Run 2 after the deploy, cutoff at the deploy.
    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]).toMatchObject({
      outcome: "corrected",
      basis: "slug_instant",
      newSlug: `${PREFIX}/cobra-renamed-2026-10-12-1900--lalot88hk5`,
    });
    expect(r.audit.filter((a) => a.action === SLUG_DATE_CORRECTED_AUDIT_ACTION))
      .toHaveLength(2);
  });

  it("newest slug write is this backfill's own: skipped, even with older writes before the cutoff", async () => {
    const r = makeRepos({ events: [cobra({ slug: COBRA_FIXED })] });
    r.audit.push(
      // Pushed out of order on purpose: the gate must sort by `at`.
      slugWrite(SLUG_DATE_CORRECTED_AUDIT_ACTION, new Date("2026-10-06T00:00:00.000Z")),
      slugWrite("event.slug_assigned", OLD),
      slugWrite("event.slug_regenerated", BEFORE_CUTOFF),
    );

    const out = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]!.outcome).toBe("already_correct");
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
  });

  it("clock skew: our row stamped EARLIER than another writer's still wins when it wrote the current slug", async () => {
    // The operator's laptop clock ran behind the server's: our correction
    // row reads as older than a regenerate that really happened before it.
    const r = makeRepos({ events: [cobra({ slug: COBRA_FIXED })] });
    r.audit.push(
      {
        entity: "event",
        entityId: COBRA_ID,
        action: SLUG_DATE_CORRECTED_AUDIT_ACTION,
        data: { previousSlug: COBRA_SLUG, newSlug: COBRA_FIXED },
        at: new Date("2026-10-01T00:00:00.000Z"),
      },
      slugWrite("event.slug_regenerated", BEFORE_CUTOFF),
    );

    const dry = await correctEventSlugDates(deps(r.repos), {
      utcMintedBefore: CUTOFF,
    });
    const applied = await correctEventSlugDates(deps(r.repos), {
      apply: true,
      utcMintedBefore: CUTOFF,
    });

    for (const out of [dry, applied]) {
      expect(out.rows[0]!.outcome).toBe("already_correct");
    }
    expect(r.store.get(COBRA_ID)!.slug).toBe(COBRA_FIXED);
    expect(r.history).toEqual([]);
    expect(r.audit).toHaveLength(2);
  });

  it("the newest slug write is found past the first page of audit rows", async () => {
    const r = makeRepos({ events: [cobra({ slug: COBRA_FIXED })] });
    // 150 unrelated rows under the same prefix, NEWER than the slug write,
    // so the slug write sits on the second page.
    for (let i = 0; i < 150; i += 1) {
      r.audit.push(
        slugWrite("event.slug_lookalike", new Date(AFTER_CUTOFF.getTime() + 60_000 + i)),
      );
    }
    r.audit.push(slugWrite("event.slug_rederived_at_publish", AFTER_CUTOFF));

    const out = await correctEventSlugDates(deps(r.repos), {
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]!.outcome).toBe("minted_after_cutoff");
    expect(r.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("no slug-writing audit rows: the createdAt rule decides", async () => {
    const r = makeRepos({ events: [cobra()] });
    // An unrelated audit row for the same event does not count.
    r.audit.push(slugWrite("event.published", AFTER_CUTOFF));

    const out = await correctEventSlugDates(deps(r.repos), {
      utcMintedBefore: CUTOFF,
    });

    expect(out.rows[0]).toMatchObject({
      outcome: "corrected",
      basis: "slug_instant",
    });
  });

  it("rejects a cutoff in the future", async () => {
    const r = makeRepos({ events: [cobra()] });
    await expect(
      correctEventSlugDates(deps(r.repos), {
        utcMintedBefore: new Date(NOW.getTime() + 1),
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "utc_minted_before_in_future",
    });
    expect(r.repos.events.listSluggedPage).not.toHaveBeenCalled();
  });

  it("rejects a cutoff that is not a Date", async () => {
    const r = makeRepos({ events: [cobra()] });
    await expect(
      correctEventSlugDates(deps(r.repos), {
        utcMintedBefore: "2026-10-14T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      correctEventSlugDates(deps(r.repos), {
        utcMintedBefore: new Date("not a date"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
