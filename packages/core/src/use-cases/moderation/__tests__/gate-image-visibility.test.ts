import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  ImageModerationRecord,
  ImageModerationStatus,
} from "@th/ports/repos/image-moderation-records";

import {
  isImageKeyVisible,
  resolveVisibleImageKeys,
} from "../gate-image-visibility";

function record(
  storageKey: string,
  status: ImageModerationStatus,
): ImageModerationRecord {
  return {
    id: `rec-${storageKey}`,
    storageKey,
    kind: "EVENT_HERO",
    status,
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: `https://cdn.example/${storageKey}`,
    contentType: "image/png",
    createdByHumanId: "human-1",
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-07-08T00:00:00.000Z"),
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    updatedAt: new Date("2026-07-08T00:00:00.000Z"),
  };
}

function makeRepos(records: Map<string, ImageModerationRecord>): {
  repos: Pick<Repos, "imageModerationRecords">;
  resolveByKeys: ReturnType<typeof vi.fn>;
} {
  const resolveByKeys = vi.fn(
    async (keys: string[]) =>
      new Map(
        keys.filter((k) => records.has(k)).map((k) => [k, records.get(k)!]),
      ),
  );
  return {
    repos: {
      imageModerationRecords: { resolveByKeys },
    } as unknown as Pick<Repos, "imageModerationRecords">,
    resolveByKeys,
  };
}

const KEY = (n: number) => `events/event-${n}/images/img-${n}.png`;

describe("resolveVisibleImageKeys", () => {
  it("keeps an APPROVED key", async () => {
    const { repos } = makeRepos(
      new Map([[KEY(1), record(KEY(1), "APPROVED")]]),
    );
    const visible = await resolveVisibleImageKeys(repos, [KEY(1)]);
    expect(visible.has(KEY(1))).toBe(true);
  });

  it.each<ImageModerationStatus>([
    "PENDING",
    "FLAGGED",
    "REJECTED",
    "ORPHANED",
  ])("drops a %s key", async (status) => {
    const { repos } = makeRepos(new Map([[KEY(1), record(KEY(1), status)]]));
    const visible = await resolveVisibleImageKeys(repos, [KEY(1)]);
    expect(visible.has(KEY(1))).toBe(false);
  });

  it("is an ALLOWLIST: an unknown future status is hidden, not shown", async () => {
    // The shape of the rule, asserted directly. A blacklist of known-bad
    // statuses would fail OPEN here — and would have published every ORPHANED
    // image the moment that status was introduced. Cast because the point of
    // the test is a value OUTSIDE the current union.
    const { repos } = makeRepos(
      new Map([
        [KEY(1), record(KEY(1), "SOME_STATUS_NOBODY_HAS_WRITTEN_YET" as ImageModerationStatus)],
      ]),
    );
    const visible = await resolveVisibleImageKeys(repos, [KEY(1)]);
    expect(visible.has(KEY(1))).toBe(false);
  });

  it("keeps a key with NO record (legacy / pre-moderation, fail-open)", async () => {
    const { repos } = makeRepos(new Map());
    const visible = await resolveVisibleImageKeys(repos, [KEY(1)]);
    expect(visible.has(KEY(1))).toBe(true);
  });

  it("filters a mixed batch in a SINGLE resolveByKeys call", async () => {
    const { repos, resolveByKeys } = makeRepos(
      new Map([
        [KEY(1), record(KEY(1), "APPROVED")],
        [KEY(2), record(KEY(2), "FLAGGED")],
        [KEY(3), record(KEY(3), "PENDING")],
        [KEY(4), record(KEY(4), "REJECTED")],
        // KEY(5) has no record -> visible (legacy)
      ]),
    );
    const visible = await resolveVisibleImageKeys(repos, [
      KEY(1),
      KEY(2),
      KEY(3),
      KEY(4),
      KEY(5),
    ]);
    expect([...visible].sort()).toEqual([KEY(1), KEY(5)].sort());
    // Exactly one batched round-trip, not one-per-key.
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it("dedupes keys and drops empties without querying on an empty set", async () => {
    const { repos, resolveByKeys } = makeRepos(new Map());
    const empty = await resolveVisibleImageKeys(repos, ["", ""]);
    expect(empty.size).toBe(0);
    expect(resolveByKeys).not.toHaveBeenCalled();

    await resolveVisibleImageKeys(repos, [KEY(1), KEY(1)]);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
    expect(resolveByKeys).toHaveBeenCalledWith([KEY(1)]);
  });
});

describe("isImageKeyVisible", () => {
  it("returns true for a null/empty key without querying", async () => {
    const { repos, resolveByKeys } = makeRepos(new Map());
    expect(await isImageKeyVisible(repos, null)).toBe(true);
    expect(await isImageKeyVisible(repos, undefined)).toBe(true);
    expect(await isImageKeyVisible(repos, "")).toBe(true);
    expect(resolveByKeys).not.toHaveBeenCalled();
  });

  it("returns true for APPROVED and absent, false otherwise", async () => {
    const { repos } = makeRepos(
      new Map([
        [KEY(1), record(KEY(1), "APPROVED")],
        [KEY(2), record(KEY(2), "FLAGGED")],
      ]),
    );
    expect(await isImageKeyVisible(repos, KEY(1))).toBe(true);
    expect(await isImageKeyVisible(repos, KEY(2))).toBe(false);
    expect(await isImageKeyVisible(repos, KEY(3))).toBe(true); // no record
  });
});
