import type { CacheGenerationPort } from "@th/ports/read-through-cache";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  PlatformSettingsRepo,
  PlatformSettingRecord,
  PlatformSettingKey,
} from "@th/ports/repos/platform-settings";

/**
 * Read-through cache for `PlatformSettingsRepo`.
 *
 * ## Why
 *
 * `getAll()` is a full-table `findMany` with no `where`, and it sits on the
 * hottest path in the API: `getFeatureGates` calls it, and that use case runs
 * from `features.getFeatureGates`, `events.*` and `ticket-types.*` — so one
 * batched tRPC request commonly triggers it more than once.
 *
 * Measured in production over 7d on 2026-08-19 (`docs/ops/resource-burn.md`):
 * 37,700 full-table reads of `PlatformSetting` against 18,950 tRPC requests —
 * ~2 per request — for a table whose contents change on the order of days.
 * That was ~2 of the ~17.8 queries/request driving Neon's +31% growth.
 *
 * ## Freshness contract
 *
 * Identical to `createFooterDefaultsCache`, deliberately:
 *
 * - `upsert()` writes through and clears this instance's snapshot immediately,
 *   so an admin who changes a setting sees it on their next read. This covers
 *   the theme-preset and POS-terminal writers, which call
 *   `repos.platformSettings.upsert(...)` directly.
 * - **It does NOT cover `updatePlatformSetting`**, which writes inside
 *   `repos.tx(...)`. Transaction-scoped repos are constructed fresh from the
 *   tx client, so that write never touches this wrapper. The platform router
 *   calls `invalidate()` explicitly for it (see `routers/platform.ts`). Any
 *   NEW write path that goes through a transaction needs the same treatment —
 *   otherwise its only bound is the TTL.
 * - Other instances learn of a write through the shared `generation` (below);
 *   without one configured, the TTL is their only bound.
 *
 * ## Two freshness bounds (2026-09-30)
 *
 * - `getAll()` — the feature-gate read on every page render — is served from a
 *   snapshot up to `ttlMs` old, AND only while the shared `generation` (when
 *   configured) still matches the one the snapshot was loaded under. The API
 *   sets 15 minutes: at 60s, the uptime check's home-page render re-read this
 *   table every minute and kept production Neon (billed per awake
 *   compute-hour, suspends after ~5 idle minutes) awake around the clock.
 *   Every identified tRPC mutation bumps the generation, so a gate flip —
 *   `maintenanceMode`, or `humanProfilesPublic` OFF, which is a privacy hide —
 *   reaches every instance within the generation's memo window, not the TTL.
 *   Generation unknown (shared store down) → read fresh, store nothing.
 * - `get(key)` accepts the snapshot only while it is younger than
 *   `pointReadTtlMs` (default: `ttlMs`; the API sets 60s), and otherwise
 *   refreshes it. Point readers are the ones that must not see a
 *   quarter-hour-old row: `getModerationAlertState` reads a key the JOBS
 *   process writes (this instance is never told), and the theme-preset and
 *   POS-terminal writers read-modify-write a row, where a stale read on a
 *   second instance would clobber the first instance's write. None of them run
 *   on an anonymous home-page render, so the short bound costs Neon nothing
 *   there.
 *
 * `get(key)` is served from the same snapshot. It is only a `findUnique`, but
 * there is no reason to pay a round-trip for a row already in memory, and
 * serving both reads from one snapshot means they can never disagree with each
 * other mid-request.
 */
export interface CachedPlatformSettingsRepo extends PlatformSettingsRepo {
  /** Drop the cached snapshot. Called on this instance after a write. */
  invalidate(): void;
}

export interface CachedPlatformSettingsOptions {
  /** Max snapshot age served by `getAll()`, in milliseconds. Defaults to 60s. */
  ttlMs?: number;
  /**
   * Max snapshot age served by `get(key)`, in milliseconds. Defaults to
   * `ttlMs`. Clamped to `ttlMs` — a point read never accepts an older snapshot
   * than `getAll()` would.
   */
  pointReadTtlMs?: number;
  /**
   * Cross-instance invalidation for the `getAll()` snapshot. Absent → the TTL
   * is the only cross-instance bound (tests, jobs).
   */
  generation?: CacheGenerationPort;
  /**
   * Reports a generation port that rejects (the snapshot then reads fresh and
   * stores nothing — a deliberate swallow). Pass a throttled reporter: it
   * fires on every feature-gate read while the port is broken.
   */
  reportError?: ReporterPort;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 1000;
/** Generation used when no `generation` port is configured. */
const STATIC_GENERATION = "static";

export function withCachedPlatformSettings(
  inner: PlatformSettingsRepo,
  options: CachedPlatformSettingsOptions = {},
): CachedPlatformSettingsRepo {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const pointReadTtlMs = Math.min(options.pointReadTtlMs ?? ttlMs, ttlMs);
  const now = options.now ?? Date.now;

  let snapshot: PlatformSettingRecord[] | null = null;
  let loadedAt = 0;
  /** Shared generation the snapshot was loaded under. */
  let snapshotGeneration: string | null = null;
  /**
   * In-flight load, shared by concurrent callers OF THE SAME GENERATION.
   * Without this a cold cache under a batched request lets every caller miss
   * and issue its own full-table read — the exact pileup this decorator exists
   * to remove. A caller under a newer generation must not join a read that may
   * predate the write that moved it.
   */
  let inFlight: {
    generation: string | null;
    promise: Promise<PlatformSettingRecord[]>;
  } | null = null;
  /**
   * Bumped on every local invalidation. A read that was already in flight when
   * a write landed may have seen pre-write rows; it still answers its own
   * callers, but it may not become the snapshot — otherwise the writing
   * instance would hold the old value for a full TTL, breaking the "writer
   * sees its change on the next read" contract above.
   */
  let dropEpoch = 0;

  const currentGeneration = async (): Promise<string | null> => {
    if (!options.generation) return STATIC_GENERATION;
    // Unknown (or a port that rejects) → null → read fresh, store nothing.
    return options.generation.current().catch((err: unknown) => {
      try {
        options.reportError?.(err, {
          tags: { cache: "platform-settings", fallback: "uncached" },
        });
      } catch {
        // Best-effort: reporting must not change the fallback.
      }
      return null;
    });
  };

  const refresh = (
    generation: string | null,
  ): Promise<PlatformSettingRecord[]> => {
    if (inFlight && inFlight.generation === generation) return inFlight.promise;

    const startedIn = dropEpoch;
    // Chained off `Promise.resolve()` so `finally` can never run before
    // `promise` is assigned, even if `getAll` throws synchronously.
    const promise: Promise<PlatformSettingRecord[]> = Promise.resolve()
      .then(() => inner.getAll())
      .then((rows) => {
        if (generation !== null && startedIn === dropEpoch) {
          snapshot = rows;
          loadedAt = now();
          snapshotGeneration = generation;
        }
        return rows;
      })
      .finally(() => {
        // Cleared so a failed read does not wedge every subsequent caller
        // onto a rejected promise. Only if it is still ours: an invalidation
        // may already have detached it.
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { generation, promise };

    return promise;
  };

  const drop = () => {
    snapshot = null;
    loadedAt = 0;
    snapshotGeneration = null;
    // Later callers must not join a read that may predate the write.
    inFlight = null;
    dropEpoch += 1;
  };

  return {
    async getAll(): Promise<PlatformSettingRecord[]> {
      const generation = await currentGeneration();
      if (
        generation !== null &&
        snapshot !== null &&
        snapshotGeneration === generation &&
        now() - loadedAt < ttlMs
      ) {
        return snapshot;
      }
      return refresh(generation);
    },

    async get(key: PlatformSettingKey): Promise<PlatformSettingRecord | null> {
      // Point reads keep their own short age bound and do not consult the
      // generation while inside it.
      const rows =
        snapshot !== null && now() - loadedAt < pointReadTtlMs
          ? snapshot
          : await refresh(await currentGeneration());
      return rows.find((row) => row.key === key) ?? null;
    },

    async upsert(
      key: PlatformSettingKey,
      value: string,
    ): Promise<PlatformSettingRecord> {
      const result = await inner.upsert(key, value);
      // Invalidate AFTER the write succeeds. Clearing first would let a
      // concurrent read repopulate the snapshot from pre-write state and then
      // hold it for the full TTL.
      drop();
      return result;
    },

    invalidate(): void {
      drop();
    },
  };
}
