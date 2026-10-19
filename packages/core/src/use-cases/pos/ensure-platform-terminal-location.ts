import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

const SETTING_KEY = "pos:terminalLocationId" as const;

const DEFAULT_DISPLAY_NAME = "Ithas Fire";
const DEFAULT_ADDRESS = {
  line1: "548 Market St",
  city: "San Francisco",
  state: "CA",
  postalCode: "94104",
  country: "US",
};

export type EnsurePlatformTerminalLocationDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  /**
   * Override the platform Location's metadata at creation time. The
   * address never drives tax/regulation — it's a label Stripe shows in
   * the Terminal dashboard. Defaults are fine for dev; prod can pin
   * a real address via env in the composition layer.
   */
  config?: {
    displayName?: string;
    address?: {
      line1: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
};

export type EnsurePlatformTerminalLocationOutput = {
  locationId: string;
  /** True when this call provisioned the Location; false on cache hit. */
  created: boolean;
};

/**
 * Idempotent: returns the cached `tml_xxx` for the platform if one is
 * stored in PlatformSettings, else creates one on the platform Stripe
 * account and persists the ID.
 *
 * Single-platform Location is correct under SCT (separate-charge-and-
 * transfer): the PaymentIntent is created on the platform account, so
 * the Reader/Location must too. Per-org Locations would only apply
 * under direct charges.
 *
 * Concurrent first-callers may race here. The worst case is two
 * `tml_xxx` rows in Stripe; the second writer's upsert wins in
 * `PlatformSetting`. Stripe doesn't bill per Location, so the
 * orphaned one is harmless. We log a warn so an operator can clean
 * up if they care.
 */
export async function ensurePlatformTerminalLocation(
  deps: EnsurePlatformTerminalLocationDeps,
): Promise<EnsurePlatformTerminalLocationOutput> {
  const existing = await deps.repos.platformSettings.get(SETTING_KEY);
  if (existing?.value) {
    return { locationId: existing.value, created: false };
  }

  const displayName = deps.config?.displayName ?? DEFAULT_DISPLAY_NAME;
  const address = deps.config?.address ?? DEFAULT_ADDRESS;

  const { locationId } = await deps.payments.createTerminalLocation({
    displayName,
    address,
  });

  // Re-check before persist in case a sibling request created one
  // between our initial read and Stripe create. If yes, log + keep
  // the cached one (the orphan is harmless metadata in Stripe).
  const racedExisting = await deps.repos.platformSettings.get(SETTING_KEY);
  if (racedExisting?.value) {
    deps.logger?.warn("pos.platform_terminal_location.race_orphaned", {
      keptLocationId: racedExisting.value,
      orphanedLocationId: locationId,
    });
    return { locationId: racedExisting.value, created: false };
  }

  await deps.repos.platformSettings.upsert(SETTING_KEY, locationId);

  deps.logger?.info("pos.platform_terminal_location.created", {
    locationId,
    displayName,
  });

  return { locationId, created: true };
}
