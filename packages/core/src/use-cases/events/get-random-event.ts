import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord, VenueConfirmedFor } from "@th/ports/repos/events";

import {
  projectPublicEventLocation,
  publicDistanceMeters,
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "../../lib/location/project-public-event-location";
import {
  isVenueConfirmed,
  venueConfirmedFilterFor,
} from "../../lib/venue-confirmation";
import { fail } from "@th/errors";
import { describeError, parseInput } from "../../lib/io";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_RADIUS_KM = 50;
// Must stay >= the web slider's RADIUS_MAX_KM (apps/web/src/lib/search/radius.ts).
// They live in different layers and can't import each other, so keep them in
// lockstep by hand: the slider's top real distance (500km) must be accepted here.
const MAX_RADIUS_KM = 500;
const IDEMPOTENCY_TTL_SECONDS = 60;
const MAX_EXCLUDE_EVENT_IDS = 50;
const EVENT_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "CANCELLED",
  "COMPLETED",
] as const;

// Retained on the DTO for backwards compatibility with existing clients. Since
// the migration off the search index there are no longer distinct query
// stages, so the value is derived from the request shape (geo > text >
// fallback) rather than which stage produced the hit.
type Source = "geo" | "text" | "fallback";

type NearFilter = { lat: number; lng: number; radiusKm: number };

type NormalizedInput = {
  near: NearFilter | null;
  q: string | null;
  windowFrom: Date;
  windowTo: Date;
  orgId: string | null;
  placeId: string | null;
  excludeEventIds: string[];
  seed: string | null;
  idempotencyKey: string | null;
};

type FingerprintPayload = {
  near: NormalizedInput["near"];
  q: NormalizedInput["q"];
  window: { from: string; to: string };
  orgId: string | null;
  placeId: string | null;
  excludeEventIds: string[];
  idempotencyKey: string | null;
};

type StoredRandomEventRecord = {
  payloadHash: string;
  response: GetRandomEventOutput;
};

export type GetRandomEventDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * Deliberate-swallow reporter (ReporterPort convention) for the three
   * degrade branches: a failed random pick (→ "none available"), a failed
   * place read (→ no venue on the output) and a failed org read (→ an
   * unnamed org). All keep their null fallbacks; this makes them visible in
   * Sentry.
   */
  reportError?: ReporterPort;
};

/** Guarded report — a throwing reporter never changes behaviour. */
function reportSwallow(
  deps: Pick<GetRandomEventDeps, "reportError">,
  error: unknown,
  step: string,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "getRandomEvent", step },
      extra,
    });
  } catch {
    // Best-effort reporting only.
  }
}

const locationDto = z.object({
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  addressText: z.string().nullable(),
  distanceKm: z.number().nonnegative().nullable(),
});

const orgDto = z
  .object({
    id: z.string(),
    name: z.string().optional(),
  })
  .nullable();

const placeDto = z
  .object({
    id: z.string(),
    name: z.string().optional(),
  })
  .nullable();

export const randomEventDto = z.object({
  id: z.string(),
  /**
   * Canonical URL slug for the public event page (`/events/{slug}`). Null only
   * for events that have never been assigned a slug; published events always
   * carry one. Callers that navigate must guard against null.
   */
  slug: z.string().nullable(),
  title: z.string(),
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  status: z.enum(EVENT_STATUSES),
  org: orgDto,
  place: placeDto,
  location: locationDto,
  source: z.enum(["geo", "text", "fallback"] as const),
  algo: z.object({
    radiusKm: z.number().positive().nullable(),
    windowFrom: z.date(),
    windowTo: z.date(),
    qPresent: z.boolean(),
    hadGeoIndex: z.boolean(),
  }),
});

const nearInputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusKm: z.number().positive().max(MAX_RADIUS_KM).optional(),
});

const windowInputSchema = z.object({
  from: z.date().optional(),
  to: z.date().optional(),
});

export const getRandomEventInput = z
  .object({
    near: nearInputSchema.optional(),
    q: z.string().min(1).max(256).optional(),
    window: windowInputSchema.optional(),
    orgId: z.string().min(1).optional(),
    placeId: z.string().min(1).optional(),
    excludeEventIds: z
      .array(z.string().min(1))
      .max(MAX_EXCLUDE_EVENT_IDS)
      .optional(),
    /**
     * DEPRECATED — accepted only as the literal `true` for clients that still
     * send it, and ignored. This is an anonymous endpoint: the pick is ALWAYS
     * published + PUBLIC + ungated (the repo applies it unconditionally). A
     * client that could send `false` pulled drafts and private events, with
     * their exact addresses, out of it.
     */
    publishedOnly: z.literal(true).optional(),
    seed: z.string().min(1).max(128).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export type GetRandomEventInput = z.infer<typeof getRandomEventInput>;
export type GetRandomEventOutput = z.infer<typeof randomEventDto>;

export async function getRandomEvent(
  deps: GetRandomEventDeps,
  rawInput: unknown,
): Promise<GetRandomEventOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getRandomEvent" });

  const execute = async () => {
    const parsedInput = parseInput(getRandomEventInput, rawInput);
    const normalized = normalizeInput(parsedInput, deps.clock.now());

    const fingerprint = buildFingerprint(normalized);
    const payloadHash = sha1(stableStringify(fingerprint));
    const cacheKey = normalized.idempotencyKey ? `lucky:${payloadHash}` : null;

    if (cacheKey) {
      const replay =
        await deps.idempotency.get<StoredRandomEventRecord>(cacheKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return replay.response;
      }

      const claimed = await deps.idempotency.begin(
        cacheKey,
        IDEMPOTENCY_TTL_SECONDS,
      );
      if (!claimed) {
        const afterWait =
          await deps.idempotency.get<StoredRandomEventRecord>(cacheKey);
        if (afterWait) {
          if (afterWait.payloadHash !== payloadHash) {
            throw fail("IDEMPOTENCY_KEY_CONFLICT");
          }
          return afterWait.response;
        }
        throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
      }
    }

    const startedAt = Date.now();
    const source = deriveSource(normalized);
    const hadGeoParam = normalized.near !== null;
    const hadQ = normalized.q !== null;

    try {
      const event = await pickRandomEvent(deps, normalized, scopedLogger);

      const durationMs = Date.now() - startedAt;

      if (!event) {
        scopedLogger?.warn("getRandomEvent.none", {
          hadGeo: hadGeoParam,
          hadQ,
          radiusKm: normalized.near?.radiusKm ?? null,
          windowFrom: normalized.windowFrom,
          windowTo: normalized.windowTo,
        });

        deps.metrics?.increment("search.lucky.request", {
          source: "none",
          hadGeo: String(hadGeoParam),
          hadQ: String(hadQ),
        });
        deps.metrics?.record("search.lucky.duration_ms", durationMs, {
          source: "none",
          hadGeo: String(hadGeoParam),
          hadQ: String(hadQ),
        });

        throw fail("NO_RANDOM_EVENT_AVAILABLE");
      }

      const output = await buildOutput({
        event,
        normalized,
        deps,
        source,
      });

      deps.metrics?.increment("search.lucky.request", {
        source,
        hadGeo: String(hadGeoParam),
        hadQ: String(hadQ),
      });
      deps.metrics?.increment("search.lucky.found", { source });
      deps.metrics?.record("search.lucky.duration_ms", durationMs, {
        source,
        hadGeo: String(hadGeoParam),
        hadQ: String(hadQ),
      });

      scopedLogger?.info("getRandomEvent.success", {
        eventId: output.id,
        source,
        hadGeo: hadGeoParam,
        hadQ,
        radiusKm: normalized.near?.radiusKm ?? null,
        windowFrom: normalized.windowFrom,
        windowTo: normalized.windowTo,
      });

      if (cacheKey) {
        await deps.idempotency.commit<StoredRandomEventRecord>(
          cacheKey,
          { payloadHash, response: output },
          IDEMPOTENCY_TTL_SECONDS,
        );
      }

      return output;
    } catch (error) {
      if (cacheKey) {
        await deps.idempotency.fail(cacheKey, describeError(error));
      }
      throw error;
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getRandomEvent", execute);
  }

  return execute();
}

/**
 * Fetch a random matching event from the Postgres-backed repo. Any repo/DB
 * failure is treated as "no event available" (graceful degradation) rather
 * than bubbling up as a 500 — a random-event pick is best-effort discovery.
 */
async function pickRandomEvent(
  deps: GetRandomEventDeps,
  normalized: NormalizedInput,
  logger?: LoggerPort,
): Promise<EventRecord | null> {
  try {
    // Venue-confirmation spec (security review H2): a `placeId` filter reads
    // ONLY events the venue vouches for — otherwise "surprise me at venue X"
    // enumerates unconfirmed third-party claims on X's room one by one,
    // which the output gate below would name-strip but still expose. An
    // unknown place is "nothing to pick", exactly like an empty pick.
    let venueConfirmedFor: VenueConfirmedFor | undefined;
    if (normalized.placeId) {
      const place = await deps.repos.places.getById(normalized.placeId);
      if (!place) {
        logger?.info("getRandomEvent.placeFilterUnknown", {
          placeId: normalized.placeId,
        });
        return null;
      }
      venueConfirmedFor = venueConfirmedFilterFor(place);
    }
    // The repo ALWAYS restricts the pick to published + PUBLIC + ungated
    // events — there is no caller-controlled scope on this public read.
    return await deps.repos.events.pickRandomEvent({
      window: { from: normalized.windowFrom, to: normalized.windowTo },
      near: normalized.near,
      q: normalized.q,
      orgId: normalized.orgId,
      placeId: normalized.placeId,
      excludeEventIds: normalized.excludeEventIds,
      ...(venueConfirmedFor ? { venueConfirmedFor } : {}),
    });
  } catch (error) {
    logger?.error("getRandomEvent.repoError", {
      error: describeError(error),
    });
    reportSwallow(deps, error, "pickRandomEvent", {
      placeId: normalized.placeId,
      orgId: normalized.orgId,
    });
    // Degrade gracefully: surface the domain "none available" outcome instead
    // of an INTERNAL_SERVER_ERROR so the UI can show a friendly empty state.
    return null;
  }
}

type BuildOutputParams = {
  event: EventRecord;
  normalized: NormalizedInput;
  deps: GetRandomEventDeps;
  source: Source;
};

async function buildOutput({
  event,
  normalized,
  deps,
  source,
}: BuildOutputParams): Promise<GetRandomEventOutput> {
  // Deliberate swallow: a failed org read degrades to an unnamed org on the
  // output (never a 500 on a discovery read) — reported so it is not silent.
  const org = event.orgId
    ? await deps.repos.organizations
        .getById(event.orgId)
        .catch((error: unknown) => {
          reportSwallow(deps, error, "orgRead", {
            eventId: event.id,
            orgId: event.orgId,
          });
          return null;
        })
    : null;

  // Deliberate swallow: a failed place read degrades to "no venue" on the
  // output (never a 500 on a discovery read) — reported so it is not silent.
  const place = event.placeId
    ? await deps.repos.places.getById(event.placeId).catch((error: unknown) => {
        reportSwallow(deps, error, "placeRead", {
          eventId: event.id,
          placeId: event.placeId,
        });
        return null;
      })
    : null;

  // Venue-confirmation spec (docs/specs/2026-08-27): the venue is NAMED on a
  // public read only when it vouches for the event — venue-owned, or stamped
  // and not withdrawn (`lib/venue-confirmation`, THE derivation). Otherwise
  // the event is address-only: `place` is null and `placeId` never leaves
  // the server. A vanished place row cannot vouch either.
  const venueConfirmed = place !== null && isVenueConfirmed(event, place);

  // THE public projection: an OBSCURED event (or one at a venue that
  // withholds its address) emits its keyed circle centre and a coarse label
  // — never the stored pin or street. A place row that is gone or failed to
  // read fails closed (fully hidden). The adapter's `near` filter decides
  // inclusion from this SAME emitted point.
  const location = projectPublicEventLocation(event, {
    place: place
      ? toPlaceLocationSource(place)
      : event.placeId
        ? unreadablePlaceLocation(event.placeId)
        : null,
  });

  // Distance from the EMITTED point, never the stored one: a true distance,
  // read from a few viewer positions, trilaterates the house.
  const distanceMeters = normalized.near
    ? publicDistanceMeters(normalized.near, location)
    : null;
  const distanceKm = distanceMeters === null ? null : distanceMeters / 1000;

  return randomEventDto.parse({
    id: event.id,
    slug: event.slug ?? null,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt ?? null,
    status: event.status,
    org: event.orgId
      ? {
          id: event.orgId,
          name: org?.name ?? undefined,
        }
      : null,
    place:
      event.placeId && venueConfirmed
        ? {
            id: event.placeId,
            name: (place as { name?: string } | null)?.name,
          }
        : null,
    location: {
      lat: location.lat,
      lng: location.lng,
      addressText: location.label,
      distanceKm,
    },
    source,
    algo: {
      radiusKm: normalized.near?.radiusKm ?? null,
      windowFrom: normalized.windowFrom,
      windowTo: normalized.windowTo,
      qPresent: Boolean(normalized.q),
      hadGeoIndex: normalized.near !== null,
    },
  });
}

function deriveSource(normalized: NormalizedInput): Source {
  if (normalized.near) {
    return "geo";
  }
  if (normalized.q) {
    return "text";
  }
  return "fallback";
}

function normalizeInput(
  input: GetRandomEventInput,
  now: Date,
): NormalizedInput {
  const near = input.near
    ? {
        lat: input.near.lat,
        lng: input.near.lng,
        radiusKm: clampRadius(input.near.radiusKm ?? DEFAULT_RADIUS_KM),
      }
    : null;

  const windowFrom = cloneDate(input.window?.from ?? now);
  const windowTo = cloneDate(
    input.window?.to ??
      new Date(
        windowFrom.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ),
  );

  if (windowTo.getTime() < windowFrom.getTime()) {
    throw fail("INVALID_TIME_WINDOW");
  }

  const q = input.q?.trim();
  const seed = input.seed?.trim();
  const excludeEventIds = Array.from(
    new Set((input.excludeEventIds ?? []).filter((id) => id && id.length > 0)),
  );

  return {
    near,
    q: q && q.length > 0 ? q : null,
    windowFrom,
    windowTo,
    orgId: input.orgId ?? null,
    placeId: input.placeId ?? null,
    excludeEventIds,
    seed: seed && seed.length > 0 ? seed : null,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

function buildFingerprint(normalized: NormalizedInput): FingerprintPayload {
  return {
    near: normalized.near,
    q: normalized.q,
    window: {
      from: normalized.windowFrom.toISOString(),
      to: normalized.windowTo.toISOString(),
    },
    orgId: normalized.orgId,
    placeId: normalized.placeId,
    excludeEventIds: normalized.excludeEventIds,
    idempotencyKey: normalized.idempotencyKey,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function clampRadius(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0) {
    return DEFAULT_RADIUS_KM;
  }
  return Math.min(Math.max(Math.floor(radius), 1), MAX_RADIUS_KM);
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}
