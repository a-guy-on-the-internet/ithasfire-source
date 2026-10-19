import type {
  EmailFooterDefaults,
  FooterDefaultsCachePort,
} from "@th/ports/comms/footer-defaults";
import type { PlatformSettingsRepo } from "@th/ports/repos/platform-settings";
import type { LoggerPort } from "@th/ports/logger";

/** TTL backstop so non-writing instances self-heal without cross-process invalidation. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface FooterDefaultsCacheOptions {
  /** Read side of the platform settings repo (only `getAll` is used). */
  platformSettings: Pick<PlatformSettingsRepo, "getAll">;
  /** Env-derived fallbacks used when a setting row is absent or blank. */
  fallback?: EmailFooterDefaults;
  /** TTL backstop in milliseconds. Defaults to 10 minutes. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  logger?: LoggerPort;
}

const cleaned = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Builds a cached resolver for platform-level email footer defaults.
 *
 * Resolution order per field: platform setting → env fallback → undefined.
 * Results are cached until the TTL backstop expires; `invalidate()` clears
 * the cache immediately on the instance that handled a settings write.
 */
export function createFooterDefaultsCache(
  options: FooterDefaultsCacheOptions,
): FooterDefaultsCachePort {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const fallback = options.fallback ?? {};

  let cached: EmailFooterDefaults | null = null;
  let expiresAt = 0;

  const load = async (): Promise<EmailFooterDefaults> => {
    const rows = await options.platformSettings.getAll();
    const map = new Map(rows.map((row) => [row.key, row.value]));
    return {
      physicalAddress:
        cleaned(map.get("email:physicalAddress")) ??
        cleaned(fallback.physicalAddress),
      contactEmail:
        cleaned(map.get("supportEmail")) ?? cleaned(fallback.contactEmail),
      brandName: cleaned(map.get("platformName")) ?? cleaned(fallback.brandName),
    };
  };

  return {
    async resolve(): Promise<EmailFooterDefaults> {
      if (cached && now() < expiresAt) {
        return cached;
      }
      try {
        cached = await load();
        expiresAt = now() + ttlMs;
        return cached;
      } catch (error) {
        // A settings read failure must never block an email send — fall back
        // to env defaults and don't poison the cache with a failed load.
        options.logger?.warn?.("footer_defaults.load_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          physicalAddress: cleaned(fallback.physicalAddress),
          contactEmail: cleaned(fallback.contactEmail),
          brandName: cleaned(fallback.brandName),
        };
      }
    },
    invalidate(): void {
      cached = null;
      expiresAt = 0;
    },
  };
}
