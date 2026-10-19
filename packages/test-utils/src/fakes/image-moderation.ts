import { vi } from "vitest";

import type {
  ImageModerationRecord,
  ImageModerationStatus,
} from "@th/types/repos/image-moderation-records";

/**
 * Build a full {@link ImageModerationRecord} for a storage key + status, with
 * sensible defaults for the fields read-time gating never touches. Handy for
 * exercising the visibility gate in use-case unit tests.
 */
export function fakeImageModerationRecord(
  storageKey: string,
  status: ImageModerationStatus,
  overrides: Partial<ImageModerationRecord> = {},
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
    // Degraded-requeue counter. Missing here since the column was added —
    // invisible because `packages/test-utils/**` is excluded from
    // `tsconfig.base.json`, so nothing typechecks this file. The
    // queue-health drill-down reads `requeues`, so an absent field would have
    // surfaced as `undefined` in any test that used this builder for it.
    requeues: 0,
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    updatedAt: new Date("2026-07-08T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * A minimal fake of the `imageModerationRecords` repo for read-time gating
 * tests: only {@link resolveByKeys} is implemented (the sole method the gate
 * uses). Pass a map of storageKey → status; keys absent from the map resolve to
 * "no record" (treated as visible/legacy). The returned `resolveByKeys` is a
 * vi mock so tests can assert the single-batched-call invariant.
 */
export function makeImageModerationGateFake(
  statusByKey: Record<string, ImageModerationStatus> = {},
): {
  imageModerationRecords: { resolveByKeys: ReturnType<typeof vi.fn> };
} {
  const records = new Map<string, ImageModerationRecord>();
  for (const [key, status] of Object.entries(statusByKey)) {
    records.set(key, fakeImageModerationRecord(key, status));
  }
  const resolveByKeys = vi.fn(
    async (keys: string[]) =>
      new Map(
        keys
          .filter((k) => records.has(k))
          .map((k) => [k, records.get(k)!] as const),
      ),
  );
  return { imageModerationRecords: { resolveByKeys } };
}
