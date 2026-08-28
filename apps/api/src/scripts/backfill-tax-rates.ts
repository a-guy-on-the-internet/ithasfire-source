/**
 * Backfill admission tax rates onto Places and previously-published events.
 *
 * Context: until the ZipTax coverage fix (docs/specs/2026-06-30/
 * ziptax-tax-coverage-fix.spec.md), sales tax was only ever looked up for
 * newly-created freeform SavedLocations. Events held at a registered Place or
 * a directly-picked SavedLocation collected $0 admission tax.
 *
 * This one-off, idempotent script:
 *   (a) For every Place that has a postcode but no cached admission tax rate,
 *       runs the ZipTax lookup and caches the rate on the Place.
 *   (b) For every PUBLISHED event whose taxRateSource is NOT "ziptax"
 *       (seed / legacy / null) AND that has NO issued tickets, re-resolves the
 *       rate from its backing location and stamps it on the Event. Non-US
 *       jurisdictions resolve to null (the adapter no-ops) and are skipped.
 *       We intentionally do NOT filter on the event-level countryCode: place-
 *       and saved-location-backed events often leave it null (country lives on
 *       the backing location), and those are exactly the rows this fix targets.
 *
 * Events that already have issued tickets are LEFT UNTOUCHED — tax was already
 * charged at whatever rate was in effect; restamping would be misleading.
 *
 * Idempotent: re-running only touches rows that still need work (places with a
 * null cache; events still not stamped "ziptax"). Safe to run multiple times.
 *
 * Usage (from repo root):
 *   DATABASE_URL=postgresql://... ZIPTAX_API_KEY=... \
 *     pnpm -F api exec tsx src/scripts/backfill-tax-rates.ts [--dry-run]
 *
 * Without ZIPTAX_API_KEY the script exits early (no provider, nothing to do).
 * Do NOT run against remote dev/prod without explicit sign-off.
 */

import { getPrisma } from "@th/db";
import type { LoggerPort, LogLevel } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  TaxRateLookupPort,
  TaxRateLookupResult,
} from "@th/ports/tax-rate-lookup";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createZiptaxAdapter } from "@th/adapters/tax-rate-lookup";
import { resolveTaxRateForEvent } from "@th/core/use-cases/events/publish-event";

const DRY_RUN = process.argv.includes("--dry-run");

const clock = { now: () => new Date() };

// Console-backed LoggerPort passed into `resolveTaxRateForEvent` so resolver-
// internal failures (e.g. `tax_rate_resolution_failed` after exhausted 429
// retries — the shared resolver swallows the throw and returns null) surface
// in the script output instead of silently landing in "skipped (no rate)".
function logToConsole(
  level: LogLevel,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const sink =
    level === "warn"
      ? console.warn
      : level === "error" || level === "fatal"
        ? console.error
        : console.log;
  if (extra) sink(`  [${level}] ${msg}`, extra);
  else sink(`  [${level}] ${msg}`);
}

const scriptLogger: LoggerPort = {
  child: () => scriptLogger,
  withTime: (_name, f) => f(),
  log: logToConsole,
  info: (msg, extra) => logToConsole("info", msg, extra),
  warn: (msg, extra) => logToConsole("warn", msg, extra),
  error: (msg, extra) => logToConsole("error", msg, extra),
};

// ZipTax rate-limits aggressively; space real API calls out and retry 429s.
const MIN_API_INTERVAL_MS = 1100;
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_BACKOFF_MS = 2_000; // 2s -> 4s -> 8s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("429") || /rate limit/i.test(message);
}

/**
 * Memoizing + throttling + 429-retrying wrapper around the tax lookup port.
 *
 * Many places/events share the same (country, postal code); without this the
 * backfill fires one live ZipTax HTTP call per row and trips the provider's
 * rate limit. The wrapper:
 *   - memoizes results per run, keyed by `${COUNTRY}:${POSTAL}` (trimmed,
 *     uppercased, ZIP+4 suffix stripped to match the adapter's normalization).
 *     Successful results AND null (non-US / unsupported) results are
 *     memoized; thrown errors are NOT — a later row may retry the key.
 *   - enforces a minimum interval between real (non-memoized) API calls.
 *   - retries rate-limit errors (message contains "429" / "Rate limit") up to
 *     RATE_LIMIT_MAX_RETRIES times with exponential backoff. Other errors
 *     propagate immediately (unchanged behavior).
 *
 * `port` satisfies TaxRateLookupPort, so it drops in everywhere the raw
 * adapter was used — including as the `taxRateLookup` dep of
 * `resolveTaxRateForEvent`.
 */
function createMemoizedTaxRateLookup(inner: TaxRateLookupPort): {
  port: TaxRateLookupPort;
  stats: () => { realCalls: number; memoHits: number; rateLimitRetries: number };
} {
  const cache = new Map<string, TaxRateLookupResult | null>();
  let realCalls = 0;
  let memoHits = 0;
  let rateLimitRetries = 0;
  let lastCallAt = 0;

  const port: TaxRateLookupPort = {
    async lookupByPostalCode(input) {
      // ZIP+4 suffix stripped ("78701-1234" -> "78701") — the adapter
      // normalizes it away anyway, so both forms are the same real call.
      const key = `${input.countryCode.trim().toUpperCase()}:${input.postalCode
        .trim()
        .toUpperCase()
        .replace(/-\d+$/, "")}`;
      if (cache.has(key)) {
        memoHits += 1;
        return cache.get(key) ?? null;
      }

      let attempt = 0;
      for (;;) {
        // Throttle: keep at least MIN_API_INTERVAL_MS between real calls.
        const waitMs = lastCallAt + MIN_API_INTERVAL_MS - Date.now();
        if (waitMs > 0) await sleep(waitMs);
        lastCallAt = Date.now();

        try {
          realCalls += 1;
          const result = await inner.lookupByPostalCode(input);
          // Memoize hits AND null (non-US) — both are stable per run.
          cache.set(key, result);
          return result;
        } catch (err) {
          if (isRateLimitError(err) && attempt < RATE_LIMIT_MAX_RETRIES) {
            attempt += 1;
            rateLimitRetries += 1;
            const backoffMs = RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (attempt - 1);
            console.warn(
              `  rate-limited on ${key}; retry ${attempt}/${RATE_LIMIT_MAX_RETRIES} in ${backoffMs}ms`,
            );
            await sleep(backoffMs);
            continue;
          }
          // Non-429 errors (and exhausted retries) propagate; NOT memoized.
          throw err;
        }
      }
    },
  };

  return {
    port,
    stats: () => ({ realCalls, memoHits, rateLimitRetries }),
  };
}

/**
 * Read-only counterpart to `resolveTaxRateForEvent` used in --dry-run mode.
 *
 * Mirrors the resolver's location precedence (Place -> SavedLocation -> inline
 * address) and its cache semantics, but performs ZERO writes: it reads the
 * already-cached rate and, on a cache miss, calls the tax provider directly
 * WITHOUT writing the result back. This keeps `--dry-run` honest — nothing is
 * persisted to any Place / SavedLocation / Event row.
 */
async function resolveRateReadOnly(
  repos: Repos,
  taxRateLookup: TaxRateLookupPort,
  eventId: string,
): Promise<{ rateBps: number; source: string } | null> {
  const event = await repos.events.getById(eventId);
  if (!event) return null;

  let postalCode: string | null = null;
  let countryCode: string | null = null;

  if (event.placeId) {
    const place = await repos.places.getById(event.placeId);
    if (place) {
      if (place.admissionTaxRateBps != null) {
        return {
          rateBps: place.admissionTaxRateBps,
          source: place.taxRateSource ?? "unknown",
        };
      }
      postalCode = place.postalCode ?? null;
      countryCode = place.countryCode ?? null;
    }
  }

  if (postalCode == null && event.savedLocationId) {
    const location = await repos.savedLocations.getById(event.savedLocationId);
    if (location) {
      if (location.admissionTaxRateBps != null) {
        return {
          rateBps: location.admissionTaxRateBps,
          source: location.taxRateSource ?? "unknown",
        };
      }
      postalCode = location.postalCode ?? null;
      countryCode = location.countryCode ?? null;
    }
  }

  if (postalCode == null && event.postalCode && event.countryCode) {
    postalCode = event.postalCode;
    countryCode = event.countryCode;
  }

  if (!postalCode || !countryCode) return null;

  const fresh = await taxRateLookup.lookupByPostalCode({
    postalCode,
    countryCode,
  });
  return fresh ? { rateBps: fresh.rateBps, source: fresh.source } : null;
}

async function main() {
  const apiKey = process.env.ZIPTAX_API_KEY;
  if (!apiKey) {
    console.error(
      "ZIPTAX_API_KEY is not set — no tax provider available, nothing to do.",
    );
    process.exit(1);
  }

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const { port: taxRateLookup, stats: lookupStats } =
    createMemoizedTaxRateLookup(createZiptaxAdapter(apiKey));

  console.log(`backfill-tax-rates starting${DRY_RUN ? " (DRY RUN)" : ""}`);

  // ── (a) Places with a postcode but no cached rate ──────────────────────────
  const places = await prisma.place.findMany({
    where: {
      admissionTaxRateBps: null,
      postcode: { not: null },
      country: { not: null },
    },
    select: { id: true, postcode: true, country: true },
  });

  let placesStamped = 0;
  let placesSkipped = 0;
  let placesFailed = 0;

  for (const place of places) {
    if (!place.postcode || !place.country) {
      placesSkipped += 1;
      continue;
    }
    try {
      const result = await taxRateLookup.lookupByPostalCode({
        postalCode: place.postcode,
        countryCode: place.country,
      });
      if (!result) {
        // Non-US / unsupported jurisdiction — leave null (untaxed by design).
        placesSkipped += 1;
        continue;
      }
      if (!DRY_RUN) {
        await repos.places.updateTaxRate({
          id: place.id,
          admissionTaxRateBps: result.rateBps,
          taxRateSource: result.source,
          taxRateFetchedAt: clock.now(),
        });
      }
      placesStamped += 1;
      console.log(
        `  place ${place.id} ${place.postcode} -> ${result.rateBps}bps (${result.source})`,
      );
    } catch (err) {
      placesFailed += 1;
      console.warn(`  place ${place.id} lookup failed:`, err);
    }
  }

  // ── (b) PUBLISHED events not stamped "ziptax" with no issued tickets ────────
  // No event-level countryCode filter: place/saved-location-backed events often
  // have a null event-level country, and the resolver (live) / adapter (both)
  // already return null for non-US, so non-US rows are simply skipped.
  // `{ not: "ziptax" }` alone would drop NULL-source rows (SQL `<> 'ziptax'`
  // is UNKNOWN for NULL) — but those are exactly the legacy place/saved-location
  // events that never got stamped and charge $0 tax. Match NULL explicitly.
  const events = await prisma.event.findMany({
    where: {
      status: "PUBLISHED",
      OR: [{ taxRateSource: null }, { taxRateSource: { not: "ziptax" } }],
    },
    select: { id: true },
  });

  let eventsStamped = 0;
  let eventsSkippedTickets = 0;
  let eventsSkippedNoRate = 0;
  let eventsMissing = 0;
  let eventsFailed = 0;

  for (const { id: eventId } of events) {
    try {
      const issuedTickets = await prisma.ticket.count({ where: { eventId } });
      if (issuedTickets > 0) {
        // Tax already charged at the old rate — never restamp.
        eventsSkippedTickets += 1;
        continue;
      }

      if (DRY_RUN) {
        // Read-only resolution — never writes back to any location or event.
        const stamp = await resolveRateReadOnly(repos, taxRateLookup, eventId);
        if (!stamp) {
          eventsSkippedNoRate += 1;
          continue;
        }
        eventsStamped += 1;
        console.log(
          `  event ${eventId} -> ${stamp.rateBps}bps (${stamp.source}) [dry-run]`,
        );
        continue;
      }

      // Pre-warm the lookup memo OUTSIDE the transaction: the read-only
      // resolution below performs any live API call (throttle sleeps + 429
      // backoff, worst case well past the 30s repos.tx timeout) here, so the
      // in-tx resolver's cache-miss lookup is an instant memo hit. A throw
      // here (e.g. exhausted 429 retries) is caught by the outer try/catch
      // and counts the row as FAILED without ever opening the transaction.
      // The result itself is intentionally unused: the read-only path has no
      // Canada branch, so null here does NOT mean the live resolver finds
      // no rate — always proceed to the tx and let it decide.
      await resolveRateReadOnly(repos, taxRateLookup, eventId);

      await repos.tx(async (tx) => {
        const event = await tx.events.getById(eventId);
        if (!event) {
          // Anomaly: the row vanished between the query and the read.
          eventsMissing += 1;
          return;
        }

        // Resolver caches the resolved rate back onto the backing location and
        // returns it; we then stamp it onto the event. The console logger
        // surfaces resolver-internal failures the shared resolver would
        // otherwise swallow into a silent null.
        const stamp = await resolveTaxRateForEvent(
          { taxRateLookup, clock },
          tx,
          event,
          scriptLogger,
        );

        if (!stamp) {
          eventsSkippedNoRate += 1;
          return;
        }

        await tx.events.publish({
          eventId,
          publishedAt: event.publishedAt ?? clock.now(),
          currentAttestationId: event.currentAttestationId ?? null,
          currency: event.currency ?? "usd",
          admissionTaxRateBps: stamp.rateBps,
          taxRateSource: stamp.source,
        });
        eventsStamped += 1;
        console.log(
          `  event ${eventId} -> ${stamp.rateBps}bps (${stamp.source})`,
        );
      });
    } catch (err) {
      eventsFailed += 1;
      console.warn(`  event ${eventId} backfill failed:`, err);
    }
  }

  console.log("\nbackfill-tax-rates summary:");
  console.log(`  places considered:        ${places.length}`);
  console.log(`    stamped:                ${placesStamped}`);
  console.log(`    skipped (no/0 rate):    ${placesSkipped}`);
  console.log(`    failed:                 ${placesFailed}`);
  console.log(`  events considered:        ${events.length}`);
  console.log(`    stamped:                ${eventsStamped}`);
  console.log(`    skipped (has tickets):  ${eventsSkippedTickets}`);
  console.log(`    skipped (no rate):      ${eventsSkippedNoRate}`);
  console.log(`    missing (anomaly):      ${eventsMissing}`);
  console.log(`    failed:                 ${eventsFailed}`);
  const { realCalls, memoHits, rateLimitRetries } = lookupStats();
  console.log(
    `  api calls: ${realCalls} real, ${memoHits} memo hits, ${rateLimitRetries} 429 retries`,
  );
  if (DRY_RUN) {
    console.log("\n(DRY RUN — no rows were written.)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
