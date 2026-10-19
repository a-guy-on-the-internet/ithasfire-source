import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DRAIN_JOB,
  MODERATION_CATEGORIES,
  MODERATION_JOBS,
  NO_VALUE,
  QUEUE_SIGNALS,
  REQUEUE_JOB,
  ageBasis,
  ageInstant,
  categoryLabel,
  describeJobResult,
  describeProviderBand,
  formatAgo,
  formatDurationMs,
  formatMinutes,
  formatThreshold,
  kindLabel,
  resolveProviderStatus,
  signalEmptyLabel,
  signalMeaning,
  signalShowsLastError,
  signalShowsStorageKey,
  signalTitle,
  signalWindowLabel,
  statusTone,
  splitCategoryThresholds,
  storageKeyCell,
  subjectCell,
  type ModerationRecordKind,
  type ModerationRecordStatus,
  type ProviderBandStatus,
  type QueueSignal,
  type QueueThresholds,
} from "../image-moderation-ops.helpers";

// The snapshot's own defaults (core `moderationQueueHealthWindowShape`).
const DEFAULT_THRESHOLDS: QueueThresholds = {
  pendingOverdueMinutes: 60,
  awaitingReviewHours: 24,
  degradedWindowMinutes: 120,
  maxRequeues: 3,
};

describe("formatMinutes", () => {
  it.each([
    [1, "1m"],
    [45, "45m"],
    [59, "59m"],
    [60, "1h"],
    [120, "2h"],
    [1440, "1d"],
    [2880, "2d"],
  ])("%i → %s", (minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected);
  });

  it("does NOT round an inexact division — 90 minutes stays 90m", () => {
    // A label that rounds is the same quiet lie as a hardcoded one.
    expect(formatMinutes(90)).toBe("90m");
    expect(formatMinutes(1500)).toBe("25h");
  });

  it("degrades to the em dash rather than printing NaN", () => {
    expect(formatMinutes(Number.NaN)).toBe(NO_VALUE);
  });
});

describe("formatAgo", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");
  const ago = (ms: number) => formatAgo(new Date(now.getTime() - ms), now);

  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1m ago"],
    [59 * 60_000, "59m ago"],
    [60 * 60_000, "1h ago"],
    [23 * 3_600_000, "23h ago"],
    [24 * 3_600_000, "1d ago"],
    [12 * 86_400_000, "12d ago"],
  ])("%i ms in the past → %s", (ms, expected) => {
    expect(ago(ms)).toBe(expected);
  });

  it("floors rather than rounds, so a row is never reported as older than it is", () => {
    expect(ago(119 * 60_000)).toBe("1h ago");
  });

  it("reads forwards for a future instant (nextAttemptAt can be ahead of now)", () => {
    expect(formatAgo(new Date(now.getTime() + 30_000), now)).toBe("in <1m");
    expect(formatAgo(new Date(now.getTime() + 5 * 60_000), now)).toBe("in 5m");
    expect(formatAgo(new Date(now.getTime() + 3 * 3_600_000), now)).toBe(
      "in 3h",
    );
  });
});

describe("signal copy", () => {
  it("names all five signals", () => {
    expect(QUEUE_SIGNALS).toEqual([
      "pendingOverdue",
      "awaitingReview",
      "degradedRecent",
      "degradedExhausted",
      "orphanedRecent",
    ]);
  });

  it.each(QUEUE_SIGNALS)(
    "%s has a title, meaning and empty label",
    (signal) => {
      expect(signalTitle(signal)).toBeTruthy();
      expect(signalMeaning(signal)).toBeTruthy();
      expect(signalEmptyLabel(signal)).toBeTruthy();
    },
  );

  it("gives every signal a DISTINCT title", () => {
    const titles = QUEUE_SIGNALS.map(signalTitle);
    expect(new Set(titles).size).toBe(QUEUE_SIGNALS.length);
  });
});

describe("signalWindowLabel", () => {
  it("reads the default window off the thresholds", () => {
    expect(signalWindowLabel("pendingOverdue", DEFAULT_THRESHOLDS)).toBe(
      "over 1h late",
    );
    expect(signalWindowLabel("awaitingReview", DEFAULT_THRESHOLDS)).toBe(
      "held over 1d",
    );
    expect(signalWindowLabel("degradedRecent", DEFAULT_THRESHOLDS)).toBe(
      "last 2h",
    );
    expect(signalWindowLabel("degradedExhausted", DEFAULT_THRESHOLDS)).toBe(
      "3+ requeues",
    );
    expect(signalWindowLabel("orphanedRecent", DEFAULT_THRESHOLDS)).toBe(
      "last 2h",
    );
  });

  // THE regression this helper exists for: a tile that says "last 2h" while
  // the snapshot was taken with a different window is a lie nobody catches.
  it("TRACKS non-default thresholds — nothing is hardcoded", () => {
    const custom: QueueThresholds = {
      pendingOverdueMinutes: 15,
      awaitingReviewHours: 5,
      degradedWindowMinutes: 30,
      maxRequeues: 7,
    };
    expect(signalWindowLabel("pendingOverdue", custom)).toBe("over 15m late");
    expect(signalWindowLabel("awaitingReview", custom)).toBe("held over 5h");
    expect(signalWindowLabel("degradedRecent", custom)).toBe("last 30m");
    expect(signalWindowLabel("degradedExhausted", custom)).toBe("7+ requeues");
    expect(signalWindowLabel("orphanedRecent", custom)).toBe("last 30m");
  });

  it("never contains the default numbers when the thresholds differ", () => {
    const custom: QueueThresholds = {
      pendingOverdueMinutes: 15,
      awaitingReviewHours: 5,
      degradedWindowMinutes: 30,
      maxRequeues: 7,
    };
    for (const signal of QUEUE_SIGNALS) {
      const label = signalWindowLabel(signal, custom);
      expect(label).not.toMatch(/\b(1h|1d|2h|3\+)\b/);
    }
  });
});

describe("storage-key withholding", () => {
  it("shows a storage key for every bucket EXCEPT awaitingReview", () => {
    expect(signalShowsStorageKey("awaitingReview")).toBe(false);
    for (const signal of QUEUE_SIGNALS.filter((s) => s !== "awaitingReview")) {
      expect(signalShowsStorageKey(signal)).toBe(true);
    }
  });

  it("returns null for awaitingReview even if a key somehow arrives", () => {
    // Defence in depth: the backend omits the field, but the UI must not
    // render it if a future payload regresses.
    expect(storageKeyCell("awaitingReview", "events/hero/abc.jpg")).toBeNull();
  });

  it("NEVER stringifies an absent key — no `String(undefined)`", () => {
    for (const signal of QUEUE_SIGNALS) {
      const cell = storageKeyCell(signal, undefined);
      expect(cell).toBeNull();
      expect(cell).not.toBe("undefined");
    }
  });

  it("treats an empty / whitespace key as absent", () => {
    expect(storageKeyCell("degradedRecent", "")).toBeNull();
    expect(storageKeyCell("degradedRecent", "   ")).toBeNull();
  });

  it("passes a real key through, trimmed", () => {
    expect(storageKeyCell("orphanedRecent", " events/hero/abc.jpg ")).toBe(
      "events/hero/abc.jpg",
    );
  });
});

describe("age basis", () => {
  const moderatedAt = new Date("2026-09-12T10:00:00.000Z");
  const nextAttemptAt = new Date("2026-09-12T11:00:00.000Z");
  const row = { moderatedAt, nextAttemptAt };

  it("reads nextAttemptAt for pendingOverdue (those rows were never moderated)", () => {
    expect(ageBasis("pendingOverdue")).toEqual({
      field: "nextAttemptAt",
      header: "Due",
    });
    expect(ageInstant("pendingOverdue", row)).toBe(nextAttemptAt);
  });

  it.each(QUEUE_SIGNALS.filter((s) => s !== "pendingOverdue"))(
    "reads moderatedAt for %s",
    (signal) => {
      expect(ageBasis(signal).field).toBe("moderatedAt");
      expect(ageInstant(signal, row)).toBe(moderatedAt);
    },
  );

  it("returns null when the chosen basis is null", () => {
    expect(
      ageInstant("degradedRecent", { moderatedAt: null, nextAttemptAt }),
    ).toBeNull();
  });
});

describe("resolveProviderStatus", () => {
  it.each(["azure", "stub", "fail-closed"] as const)(
    "passes through the real provider %s",
    (provider) => {
      expect(resolveProviderStatus({ provider, isLoading: false })).toBe(
        provider,
      );
    },
  );

  it("keeps a known provider through a background refetch", () => {
    // A resolved value outranks isLoading, so the band never flickers back to
    // "checking" while react-query revalidates.
    expect(resolveProviderStatus({ provider: "azure", isLoading: true })).toBe(
      "azure",
    );
  });

  it("is `loading` only while nothing is known", () => {
    expect(resolveProviderStatus({ isLoading: true })).toBe("loading");
    expect(resolveProviderStatus({ provider: null, isLoading: true })).toBe(
      "loading",
    );
  });

  it("is `unknown` when the query settled without a provider", () => {
    // PRECONDITION_FAILED (jobs-service URL unset) lands here.
    expect(resolveProviderStatus({ isLoading: false })).toBe("unknown");
    expect(resolveProviderStatus({ provider: null, isLoading: false })).toBe(
      "unknown",
    );
  });

  it("NEVER promotes an unrecognised value to a real provider", () => {
    for (const bogus of ["", "AZURE", "azure ", "openai", "Stub", "1"]) {
      expect(resolveProviderStatus({ provider: bogus, isLoading: false })).toBe(
        "unknown",
      );
    }
  });
});

describe("describeProviderBand", () => {
  it("treats azure as the normal, non-alarming state", () => {
    const band = describeProviderBand("azure");
    expect(band.tone).toBe("neutral");
    expect(band.value).toBe("AZURE");
  });

  it("warns loudly for stub without calling it an incident", () => {
    const band = describeProviderBand("stub");
    expect(band.tone).toBe("warning");
    expect(band.value).toBe("STUB");
    expect(band.headline.toLowerCase()).toContain("auto-approving");
  });

  it("warns for fail-closed and names the consequence", () => {
    const band = describeProviderBand("fail-closed");
    expect(band.tone).toBe("warning");
    expect(band.value).toBe("FAIL-CLOSED");
    expect(band.headline.toLowerCase()).toContain("held for human review");
  });

  it.each(["loading", "unknown"] as const)(
    "%s renders its own tone — never a provider value",
    (status) => {
      const band = describeProviderBand(status);
      expect(band.tone).toBe("unknown");
      expect(["AZURE", "STUB", "FAIL-CLOSED"]).not.toContain(band.value);
    },
  );

  it("gives every state a distinct badge value", () => {
    const statuses: ProviderBandStatus[] = [
      "azure",
      "stub",
      "fail-closed",
      "loading",
      "unknown",
    ];
    const values = statuses.map((s) => describeProviderBand(s).value);
    expect(new Set(values).size).toBe(statuses.length);
  });

  it("echoes the status it was given", () => {
    expect(describeProviderBand("unknown").status).toBe("unknown");
  });
});

describe("formatThreshold", () => {
  it.each([
    [0, "0"],
    [2, "2"],
    [6, "6"],
  ])("renders the Azure severity %i verbatim", (value, expected) => {
    expect(formatThreshold(value)).toBe(expected);
  });

  it("shows a fractional threshold rather than silently flooring it", () => {
    expect(formatThreshold(1.5)).toBe("1.50");
  });

  it("degrades a missing threshold to the em dash", () => {
    expect(formatThreshold(Number.NaN)).toBe(NO_VALUE);
  });
});

describe("labels", () => {
  it.each([
    ["SEXUAL", "Sexual"],
    ["VIOLENCE", "Violence"],
    ["HATE", "Hate"],
    ["SELF_HARM", "Self-harm"],
  ] as const)("categoryLabel(%s) → %s", (category, expected) => {
    expect(categoryLabel(category)).toBe(expected);
  });

  it("covers exactly the four scanned categories", () => {
    expect(MODERATION_CATEGORIES).toEqual([
      "SEXUAL",
      "VIOLENCE",
      "HATE",
      "SELF_HARM",
    ]);
  });

  it.each([
    ["EVENT_HERO", "Event hero"],
    ["AVATAR", "Avatar"],
    ["BANNER", "Banner"],
    ["PAGE_MEDIA", "Page media"],
  ] as ReadonlyArray<[ModerationRecordKind, string]>)(
    "kindLabel(%s) → %s",
    (kind, expected) => {
      expect(kindLabel(kind)).toBe(expected);
    },
  );
});

describe("statusTone", () => {
  it.each([
    ["PENDING", "neutral"],
    ["APPROVED", "success"],
    ["FLAGGED", "warning"],
    ["REJECTED", "danger"],
    ["ORPHANED", "danger"],
  ] as ReadonlyArray<[ModerationRecordStatus, string]>)(
    "%s → %s",
    (status, tone) => {
      expect(statusTone(status)).toBe(tone);
    },
  );

  it("keeps FLAGGED out of the danger tone — it is work, not failure", () => {
    expect(statusTone("FLAGGED")).not.toBe("danger");
  });
});

describe("subjectCell", () => {
  it("splits a full subject", () => {
    expect(subjectCell({ subjectType: "EVENT", subjectId: "abc" })).toEqual({
      type: "EVENT",
      id: "abc",
    });
  });

  it("renders each half independently when the other is missing", () => {
    expect(subjectCell({ subjectType: "PLACE", subjectId: null })).toEqual({
      type: "PLACE",
      id: null,
    });
    expect(subjectCell({ subjectType: null, subjectId: "abc" })).toEqual({
      type: null,
      id: "abc",
    });
  });

  it("treats an empty id as absent", () => {
    expect(subjectCell({ subjectType: null, subjectId: "" })).toEqual({
      type: null,
      id: null,
    });
  });
});

describe("formatDurationMs", () => {
  it.each([
    [12, "12ms"],
    [999, "999ms"],
    [1500, "1.5s"],
    [90_000, "1.5m"],
  ])("%i → %s", (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });
});

/**
 * Walk up from the vitest cwd to the repo root and read the jobs manifest.
 *
 * `readFileSync` rather than an import: `apps/jobs/jobs.manifest.json` is
 * outside the web tsconfig's program, and pulling it in through the module
 * graph would drag another app into this one's typecheck for a test fixture.
 */
function readJobsManifest(): { scheduled?: Record<string, unknown> } {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "apps", "jobs", "jobs.manifest.json");
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")) as {
        scheduled?: Record<string, unknown>;
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "apps/jobs/jobs.manifest.json not found from " + process.cwd(),
  );
}

describe("MODERATION_JOBS", () => {
  it("lists exactly the two moderation jobs, in order", () => {
    expect(MODERATION_JOBS.map((j) => j.name)).toEqual([
      DRAIN_JOB,
      REQUEUE_JOB,
    ]);
  });

  // A literal asserted against the same literal cannot catch the constant
  // being WRONG, which is the only failure this is named for. The manifest is
  // the single source of truth Terraform and the jobs service both read, so
  // check against that: a renamed or typo'd job fails here instead of 404ing
  // at `runJob` in production.
  it("names jobs that actually exist in apps/jobs/jobs.manifest.json", () => {
    const scheduled = readJobsManifest().scheduled ?? {};
    const names = Object.keys(scheduled);
    expect(names).toContain(DRAIN_JOB);
    expect(names).toContain(REQUEUE_JOB);
    for (const job of MODERATION_JOBS) {
      expect(names).toContain(job.name);
    }
  });

  it("confirms before REQUEUE (it moves rows back into the scan queue)", () => {
    const requeue = MODERATION_JOBS.find((j) => j.name === REQUEUE_JOB);
    expect(requeue?.confirm).not.toBeNull();
    expect(requeue?.confirm?.title).toBeTruthy();
    expect(requeue?.confirm?.description).toBeTruthy();
  });

  it("does NOT confirm before the drain (idempotent catch-up work)", () => {
    const drain = MODERATION_JOBS.find((j) => j.name === DRAIN_JOB);
    expect(drain?.confirm).toBeNull();
  });
});

describe("exhaustiveness", () => {
  // `signalTitle` & friends switch without a default, so a new signal added to
  // the backend enum fails `tsc` at the switch rather than silently rendering
  // `undefined`. This asserts the runtime half of the same property.
  it("returns a string for every declared signal", () => {
    for (const signal of QUEUE_SIGNALS as readonly QueueSignal[]) {
      expect(typeof signalTitle(signal)).toBe("string");
      expect(typeof signalWindowLabel(signal, DEFAULT_THRESHOLDS)).toBe(
        "string",
      );
      expect(typeof signalShowsStorageKey(signal)).toBe("boolean");
    }
  });
});

describe("signalShowsLastError", () => {
  it("withholds lastError from awaitingReview and only from it", () => {
    expect(signalShowsLastError("awaitingReview")).toBe(false);
    for (const signal of QUEUE_SIGNALS.filter((s) => s !== "awaitingReview")) {
      expect(signalShowsLastError(signal)).toBe(true);
    }
  });

  it("withholds exactly the same bucket as the storage key does", () => {
    // The two controls exist for one reason; they must never drift apart.
    for (const signal of QUEUE_SIGNALS) {
      expect(signalShowsLastError(signal)).toBe(signalShowsStorageKey(signal));
    }
  });
});

describe("describeJobResult", () => {
  it("renders the drain's counters as prose, non-zero only", () => {
    expect(
      describeJobResult(
        JSON.stringify({
          processed: 6,
          moderated: 4,
          orphaned: 1,
          retried: 1,
          deadLettered: 0,
          unprocessed: 0,
        }),
      ),
    ).toBe("Processed 6 · moderated 4 · orphaned 1 · retried 1");
  });

  it("says so in words when every counter is zero (the common case)", () => {
    expect(
      describeJobResult(
        JSON.stringify({
          processed: 0,
          moderated: 0,
          orphaned: 0,
          retried: 0,
          deadLettered: 0,
          unprocessed: 0,
        }),
      ),
    ).toBe("Nothing was due");
  });

  it("NEVER returns raw JSON — the whole point of the helper", () => {
    const inputs = [
      // `.slice(0, 500)` in the jobs service truncates a large result.
      '{"processed":6,"moderated":4,"orph',
      "{}",
      "[1,2,3]",
      '{"ok":true}',
      '{"detail":{"nested":1}}',
      "",
      "   ",
    ];
    for (const input of inputs) {
      const out = describeJobResult(input);
      if (out === null) continue;
      expect(out).not.toContain("{");
      expect(out).not.toContain('"');
    }
  });

  it("returns null for a truncated or malformed payload", () => {
    expect(describeJobResult('{"processed":6,"moder')).toBeNull();
    expect(describeJobResult("{}")).toBeNull();
    expect(describeJobResult("[1,2,3]")).toBeNull();
    expect(describeJobResult('{"ok":true}')).toBeNull();
  });

  it("returns null for absent input", () => {
    expect(describeJobResult(undefined)).toBeNull();
    expect(describeJobResult(null)).toBeNull();
    expect(describeJobResult("")).toBeNull();
  });

  it("passes non-JSON prose through untouched", () => {
    expect(describeJobResult("completed 3")).toBe("completed 3");
  });

  it("keeps an unforeseen counter rather than dropping it, spaced out of camelCase", () => {
    expect(describeJobResult(JSON.stringify({ someNewThing: 2 }))).toBe(
      "Some new thing 2",
    );
  });

  it("orders known counters before unknown ones", () => {
    expect(describeJobResult(JSON.stringify({ zebra: 1, processed: 2 }))).toBe(
      "Processed 2 · zebra 1",
    );
  });

  it("hyphenates deadLettered", () => {
    expect(describeJobResult(JSON.stringify({ deadLettered: 3 }))).toBe(
      "Dead-lettered 3",
    );
  });
});

describe("splitCategoryThresholds", () => {
  const all = (value: number) => ({
    SEXUAL: value,
    VIOLENCE: value,
    HATE: value,
    SELF_HARM: value,
  });

  it("collapses to uniform when all four equal the review threshold", () => {
    const out = splitCategoryThresholds(4, all(4));
    expect(out.uniform).toBe(true);
    expect(out.overrides).toEqual([]);
  });

  it("breaks out only the categories that genuinely differ", () => {
    const out = splitCategoryThresholds(4, { ...all(4), HATE: 2 });
    expect(out.uniform).toBe(false);
    expect(out.overrides).toEqual([{ category: "HATE", value: 2 }]);
  });

  it("treats a MISSING category as an override of null, never as equal", () => {
    // An unknown threshold is exactly the thing that must not render as a
    // confident number.
    const { SELF_HARM: _omitted, ...partial } = all(4);
    const out = splitCategoryThresholds(4, partial);
    expect(out.uniform).toBe(false);
    expect(out.overrides).toEqual([{ category: "SELF_HARM", value: null }]);
  });

  it("is not uniform when the review threshold itself differs", () => {
    expect(splitCategoryThresholds(6, all(4)).uniform).toBe(false);
    expect(splitCategoryThresholds(6, all(4)).overrides).toHaveLength(4);
  });
});
