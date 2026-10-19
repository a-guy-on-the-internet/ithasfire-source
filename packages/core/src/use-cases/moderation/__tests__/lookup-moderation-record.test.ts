import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import {
  lookupModerationRecord,
  type LookupModerationRecordDeps,
} from "../lookup-moderation-record";
import { listModerationQueueSignal } from "../get-moderation-queue-snapshot";

const KEY = "events/event-1/hero.jpg";

const NOTHING_WITHHELD = {
  storageKey: false,
  lastError: false,
  status: false,
  subjectType: false,
  subjectId: false,
  degraded: false,
  moderatedAt: false,
  nextAttemptAt: false,
};
const ALL_WITHHELD = Object.fromEntries(
  Object.keys(NOTHING_WITHHELD).map((k) => [k, true]),
) as typeof NOTHING_WITHHELD;

/** Everything a withheld lookup must NOT put on the wire. */
const CONTENT_DESCRIBING_FIELDS = [
  "storageKey",
  "lastError",
  "status",
  "subjectType",
  "subjectId",
  "degraded",
  "moderatedAt",
  "nextAttemptAt",
] as const;

function makeRecord(
  overrides: Partial<ImageModerationRecord> = {},
): ImageModerationRecord {
  return {
    id: "rec-1",
    storageKey: KEY,
    kind: "EVENT_HERO",
    status: "FLAGGED",
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: "https://cdn.example/events/event-1/hero.jpg",
    contentType: "image/jpeg",
    createdByHumanId: "uploader-1",
    maxSeverity: 6,
    categories: [{ category: "SEXUAL", severity: 6 }],
    provider: "azure-content-safety",
    degraded: false,
    moderatedAt: new Date("2026-09-11T00:00:00.000Z"),
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-09-11T00:00:00.000Z"),
    requeues: 0,
    createdAt: new Date("2026-09-11T00:00:00.000Z"),
    updatedAt: new Date("2026-09-11T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(record: ImageModerationRecord | null) {
  const getByKey = vi.fn(async () => record);
  const deps = {
    repos: { imageModerationRecords: { getByKey } },
  } as unknown as LookupModerationRecordDeps;
  return { deps, getByKey };
}

describe("lookupModerationRecord — the withholding", () => {
  it("WITHHOLDS every content-describing field for an un-reviewed CONTENT hold", async () => {
    // THE fix to the first cut, which withheld `storageKey`/`lastError` and
    // returned `status: "FLAGGED"`, `degraded: false`, `subjectType`,
    // `subjectId` and `moderatedAt` for the same row. That protected nothing:
    // the caller SUPPLIED the key, so the key is not the disclosure — the
    // disclosure is "this key is un-reviewed flagged content, on that event,
    // held since then", and the old shape handed all of it over.
    const { deps } = makeDeps(
      makeRecord({
        status: "FLAGGED",
        degraded: false,
        reviewedAt: null,
        lastError: "azure 401",
      }),
    );

    const out = await lookupModerationRecord(deps, { storageKey: KEY });

    expect(out.found).toBe(true);
    expect(out.withheld).toEqual(ALL_WITHHELD);

    // ABSENT, not null — "withheld" and "there is nothing here" must not
    // serialize the same way.
    for (const field of CONTENT_DESCRIBING_FIELDS) {
      expect({ field, present: Object.hasOwn(out.item!, field) }).toEqual({
        field,
        present: false,
      });
    }

    // EXACTLY what survives — an exhaustive equality, so a field added to the
    // item later has to be justified here rather than sliding in.
    expect(out.item).toEqual({
      recordId: "rec-1",
      kind: "EVENT_HERO",
      requeues: 0,
      attempts: 0,
    });

    // And nothing leaks through the serialized ITEM either — a value smuggled
    // into some other field travels just as well as one in its own.
    //
    // Scoped to `item`, NOT the whole response, and that is not a loophole:
    // the top-level `storageKey` is a verbatim echo of what the caller typed,
    // so it necessarily contains their key (and here, the substring
    // "event-1"). Asserting over the whole payload would only be asserting
    // that the caller did not look themselves up.
    const wire = JSON.stringify(out.item);
    expect(wire).not.toContain("event-1");
    expect(wire).not.toContain("FLAGGED");
    expect(wire).not.toContain("azure 401");
    expect(wire).not.toContain("hero.jpg");
  });

  it("still says `found: true` — the residual is deliberate, not an oversight", async () => {
    // A withheld body plus `found: true` does signal "this key is a content
    // hold". The alternative is answering `found: false`, which would be a lie,
    // and a lookup that lies about existence is worse than one that is clear
    // about what it will not say. The residual is bounded: existence only.
    const { deps } = makeDeps(
      makeRecord({ status: "FLAGGED", degraded: false, reviewedAt: null }),
    );

    const out = await lookupModerationRecord(deps, { storageKey: KEY });

    expect(out.found).toBe(true);
    // And the recordId survives, because handing it to a moderator is the only
    // legitimate next action.
    expect(out.item?.recordId).toBe("rec-1");
  });

  it("withholds regardless of AGE — a ten-minute-old hold is as un-reviewed as a week-old one", async () => {
    // The `awaitingReview` tile carries an age cutoff because it answers "is
    // the queue rotting". This answers "may a non-moderator see this", and age
    // has nothing to do with that.
    const { deps } = makeDeps(
      makeRecord({ moderatedAt: new Date("2026-09-12T11:59:00.000Z") }),
    );

    const out = await lookupModerationRecord(deps, { storageKey: KEY });

    expect(out.withheld).toEqual(ALL_WITHHELD);
  });

  it.each([
    ["a degraded scanner failure", { status: "FLAGGED" as const, degraded: true }],
    ["an unscanned PENDING row", { status: "PENDING" as const, degraded: false }],
    ["a vanished ORPHANED row", { status: "ORPHANED" as const, degraded: false }],
    [
      "an APPROVED row",
      {
        status: "APPROVED" as const,
        degraded: false,
        reviewedAt: new Date("2026-09-11T10:00:00.000Z"),
      },
    ],
    [
      "a REJECTED row",
      {
        status: "REJECTED" as const,
        degraded: false,
        reviewedAt: new Date("2026-09-11T10:00:00.000Z"),
      },
    ],
  ])("SHOWS the key for %s", async (_label, overrides) => {
    // These are unscanned rows, scanner failures, vanished objects and decided
    // records — operational rows an engineer must be able to name. Withholding
    // here would make the lookup useless for its actual purpose.
    const { deps } = makeDeps(
      makeRecord({ lastError: "azure 401", ...overrides }),
    );

    const out = await lookupModerationRecord(deps, { storageKey: KEY });

    expect(out.withheld).toEqual(NOTHING_WITHHELD);
    expect(out.item?.storageKey).toBe(KEY);
    expect(out.item?.lastError).toBe("azure 401");
    // The FULL record, not a partial one — withholding nothing means nothing.
    for (const field of CONTENT_DESCRIBING_FIELDS) {
      expect({ field, present: Object.hasOwn(out.item!, field) }).toEqual({
        field,
        present: true,
      });
    }
  });

  it("agrees with the DRILL-DOWN's rule for the same record", async () => {
    // The two surfaces apply one predicate from `_shared/ops-withholding.ts`.
    // If they ever diverge, the lookup becomes the way around the drill-down —
    // which is the entire threat model of this control.
    // A non-null `lastError` so "absent" is a real omission rather than a
    // fixture that happened to have nothing to hide.
    const hold = makeRecord({
      status: "FLAGGED",
      degraded: false,
      reviewedAt: null,
      lastError: "azure 401",
    });

    const drill = await listModerationQueueSignal(
      {
        repos: {
          imageModerationRecords: {
            listQueueHealthSignal: vi.fn(async () => ({
              items: [hold],
              nextCursor: null,
            })),
          },
        },
      } as never,
      {
        signal: "awaitingReview",
        pendingDueBefore: new Date("2026-09-12T11:00:00.000Z"),
        moderatedBefore: new Date("2026-09-11T12:00:00.000Z"),
        degradedSince: new Date("2026-09-12T10:00:00.000Z"),
        maxRequeues: 3,
      },
    );
    const { deps } = makeDeps(hold);
    const lookup = await lookupModerationRecord(deps, { storageKey: KEY });

    // BOTH fields, on BOTH surfaces. The drill-down used to return `lastError`
    // here and let the page hide it; that made this pair of surfaces disagree
    // about what "withheld" means, which is how a lookup becomes the way around
    // a drill-down.
    for (const field of ["storageKey", "lastError"] as const) {
      expect({ surface: "drillDown", field, present: Object.hasOwn(drill.items[0]!, field) }).toEqual(
        { surface: "drillDown", field, present: false },
      );
      expect({ surface: "lookup", field, present: Object.hasOwn(lookup.item!, field) }).toEqual(
        { surface: "lookup", field, present: false },
      );
    }
  });

  it("never returns publicUrl for ANY record", async () => {
    // Dropping `publicUrl` alone was theatre — the key reconstructs it. It is
    // still dropped, for every bucket and every state, because leaving it in
    // would be a second, more direct copy of the same disclosure.
    for (const status of ["PENDING", "APPROVED", "FLAGGED", "REJECTED", "ORPHANED"] as const) {
      const { deps } = makeDeps(makeRecord({ status, degraded: true }));
      const out = await lookupModerationRecord(deps, { storageKey: KEY });
      expect(out.item).not.toHaveProperty("publicUrl");
    }
  });
});

describe("lookupModerationRecord", () => {
  it("reports a MISS as a finding, not an error", async () => {
    // Read-time gating treats "no record" as APPROVED, so `found: false` means
    // the object is unmoderated and visible. That is something an operator
    // needs to know, and a NOT_FOUND throw would render it as a fault.
    const { deps } = makeDeps(null);

    const out = await lookupModerationRecord(deps, {
      storageKey: "events/legacy/hero.jpg",
    });

    expect(out).toEqual({
      storageKey: "events/legacy/hero.jpg",
      found: false,
      item: null,
      withheld: NOTHING_WITHHELD,
    });
  });

  it("passes the key to the repo VERBATIM — no trimming, no normalising", async () => {
    // A storage key is matched exactly against a unique column. Stripping
    // characters would silently look up a DIFFERENT key and report "not found"
    // for an object that exists, which is a worse answer than an empty result.
    const { deps, getByKey } = makeDeps(null);
    const odd = "events/  spaced /héro (1).jpg";

    await lookupModerationRecord(deps, { storageKey: odd });

    expect(getByKey).toHaveBeenCalledWith(odd);
  });

  it("bounds the key and rejects an empty one", async () => {
    const { deps } = makeDeps(null);

    await expect(
      lookupModerationRecord(deps, { storageKey: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      lookupModerationRecord(deps, { storageKey: "x".repeat(1025) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeDeps(null);

    await expect(
      lookupModerationRecord(deps, { storageKey: KEY, includeUrl: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("propagates a repo failure", async () => {
    const { deps } = makeDeps(null);
    (
      deps.repos.imageModerationRecords as unknown as {
        getByKey: ReturnType<typeof vi.fn>;
      }
    ).getByKey.mockRejectedValueOnce(new Error("db down"));

    await expect(
      lookupModerationRecord(deps, { storageKey: KEY }),
    ).rejects.toThrow("db down");
  });
});
