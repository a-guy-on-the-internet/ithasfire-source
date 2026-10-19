import { z } from "zod";
import { eventPublicUrl, eventShortUrl } from "../../lib/public-urls";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { describeError, parseInput } from "../../lib/io";
import {
  resolveHolderAddress,
  STAMP_ARM_REVEAL_LEAD_MS,
} from "../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import type { NotifyInput } from "../comms/notify";
import { isEventPubliclyReadable } from "./_shared/event-public-readability";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `notify` is intentionally typed against `NotifyInput` only (return value
 * ignored) so this dispatcher stays decoupled from the comms wiring — same
 * shape as dispatch-event-change-notifications: the jobs layer closes over the
 * real `notify` use case with the mailer bound, and tests pass a plain spy.
 */
export type DispatchAddressRevealNotificationsDeps = {
  /**
   * `places` is read for place-linked events only: at a venue that withholds
   * its address the Event row is the venue's public projection, and the
   * address being revealed lives on the Place.
   */
  /**
   * `humans` says which holders proved their email: the rest get the reveal
   * by email only (B2, see the fan-out).
   */
  repos: Pick<
    Repos,
    "events" | "tickets" | "notifications" | "places" | "humans"
  >;
  notify: (input: NotifyInput) => Promise<unknown>;
  clock: ClockPort;
  /** Public web origin used to build absolute email URLs (event page). */
  appBaseUrl: string;
  logger?: LoggerPort;
  /**
   * Reports a swallowed failure (the SMS short-link read, which degrades to
   * the canonical URL instead of failing the notice). Best-effort: a throwing
   * reporter never changes behaviour.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const ADDRESS_REVEAL_VARIANT = "event.location-revealed" as const;

/**
 * Default scan lookback when the caller supplies no explicit windowStart.
 * The `addressRevealNotifiedAt IS NULL` cursor already makes overlapping
 * windows free (a notified event is never re-picked), so the lookback only
 * bounds how STALE a missed reveal can be and still fan out — it covers a
 * full day of cron outage without retro-spamming arbitrarily old events
 * (the Step A migration also backfilled the cursor for already-past reveals).
 */
export const DEFAULT_WINDOW_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * The renderer caps `address` at 500 chars (`z.string().max(500)`); slice the
 * stored addressText defensively so an oversized row can't fail the whole
 * event's fan-out every tick.
 */
export const MAX_ADDRESS_LENGTH = 500;

export const dispatchAddressRevealNotificationsInputSchema = z
  .object({
    /**
     * Explicit window start (exclusive) for backfills. Defaults to
     * `windowEnd - DEFAULT_WINDOW_LOOKBACK_MS`.
     */
    windowStartIso: z.string().datetime({ offset: true }).optional(),
    /**
     * Explicit window end (inclusive) for backfills. Defaults to
     * `clock.now()`, and is CLAMPED to `clock.now()` either way — a future
     * end must never fan out an exact address before its reveal moment.
     */
    windowEndIso: z.string().datetime({ offset: true }).optional(),
    /**
     * Narrow the scan to a single event — the ops RE-DRIVE path for an event
     * whose first fan-out partially failed. Unlike the scheduled scan, an
     * explicit eventId BYPASSES the `addressRevealNotifiedAt` cursor gate;
     * the durable notification-ledger subtraction confines the re-run to the
     * still-un-notified gap (already-notified holders are never re-sent).
     * PUBLISHED/OBSCURED/window guards still apply.
     */
    eventId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.windowStartIso ||
      !value.windowEndIso ||
      new Date(value.windowStartIso).getTime() <
        new Date(value.windowEndIso).getTime(),
    { message: "windowStartIso must be before windowEndIso", path: ["windowStartIso"] },
  );

export type DispatchAddressRevealNotificationsInput = z.infer<
  typeof dispatchAddressRevealNotificationsInputSchema
>;

export const dispatchAddressRevealNotificationsOutputSchema = z
  .object({
    /** Events picked up by the scan this run. */
    processed: z.number().int().nonnegative(),
    /**
     * Events whose fan-out fully succeeded this run AND whose cursor stamp
     * was won by this run. An event whose stamp was already claimed by a
     * concurrent tick (or an explicit re-drive of a stamped event) is not
     * counted anywhere — another run owns it.
     */
    notifiedEvents: z.number().int().nonnegative(),
    /**
     * Events picked up whose address is still locked for their holders, so
     * nothing was sent and the cursor stays unset: the venue withholds its
     * address and has not confirmed the event, or the event's EFFECTIVE
     * reveal (a venue-confirmed event's day-before floor) is still ahead. Not
     * failures — a later tick picks the deferred ones up.
     */
    lockedEvents: z.number().int().nonnegative(),
    /**
     * Events with at least one failed recipient this run, OR events that
     * failed before fan-out (missing address / repo error). Post-fan-out
     * failures still stamp the cursor (at-most-once — no scheduled retry,
     * no duplicate storm); the failed remainder is ERROR-logged
     * (`event_partial_failure` → failedHumanIds) for an explicit eventId
     * re-drive. Pre-fan-out failures leave the cursor unset and DO retry.
     */
    failedEvents: z.number().int().nonnegative(),
    /** Individual recipient `notify` calls that succeeded. */
    recipientsNotified: z.number().int().nonnegative(),
    /**
     * Recipients that are PERMANENTLY unnotifiable (HUMAN_NOT_FOUND — e.g. a
     * ticket whose owner Human row was deleted). Logged and skipped: retrying
     * can never fix them, so they must not starve the event cursor and block
     * every OTHER holder's event from completing.
     */
    recipientsSkipped: z.number().int().nonnegative(),
    /**
     * Recipients subtracted from the fan-out because a persisted reveal
     * notification already exists for them — the durable ledger dedup on
     * overlapping ticks and explicit re-drives.
     */
    recipientsAlreadyNotified: z.number().int().nonnegative(),
  })
  .strict();

export type DispatchAddressRevealNotificationsOutput = z.infer<
  typeof dispatchAddressRevealNotificationsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fans out the `event.location-revealed` notification to every ACTIVE ticket
 * holder (VALID | SCANNED | LISTED) of each PUBLISHED OBSCURED event whose
 * EFFECTIVE reveal crossed inside the scan window (FR-006): its own
 * `addressRevealAt`, or, for an event a withheld venue confirmed by stamp,
 * `max(startsAt, venueConfirmedStartsAt) − 24h` when that is later. An event at a withheld venue that the
 * venue has not vouched for is never revealed (see `resolveHolderAddress`).
 *
 * Channels: in-app is forced on via notify()'s per-call channel override —
 * the reveal is safety-relevant ("where do I go?"), so in-app delivery is
 * non-suppressible; email stays preference-driven (FR-012 + product
 * decision). Push (FR-006): the Expo PushPort IS wired server-side (api +
 * jobs containers bind it into notify()), so push delivery is
 * preference-driven and starts for each holder as soon as their client
 * registers a push device token (mobile-side registration still pending;
 * recipients with no registered devices skip with `no_devices`).
 *
 * Duplicate-storm safety is three-layer (NFR-002):
 *   1. AT-MOST-ONCE EVENT CURSOR — `addressRevealNotifiedAt` is stamped after
 *      the FIRST fan-out attempt regardless of per-recipient failures, via a
 *      CONDITIONAL update (only while still null). The scheduled scan never
 *      re-picks a stamped event, so a persistent one-recipient failure can
 *      never re-fan-out to the healthy majority tick after tick. The failed
 *      remainder is ERROR-logged (`event_partial_failure` → failedHumanIds);
 *      the reveal stays pull-visible on the event page, and ops can re-drive
 *      the gap with an explicit `eventId` run after fixing the cause.
 *   2. DURABLE LEDGER SUBTRACTION — the in-app Notification rows notify()
 *      persists are queryable by (variant, metadata.eventId, humanId), so the
 *      fan-out subtracts already-notified holders up front. Overlapping ticks
 *      and explicit re-drives therefore touch ONLY the un-notified gap. (An
 *      explicit re-drive may also pick up holders who bought after the stamp
 *      — acceptable for a deliberate ops action; their purchase email already
 *      carried the address.)
 *      INVARIANT: ledger completeness depends on (a) this dispatcher forcing
 *      the in-app channel ON (`channels: { inApp: { enabled: true } }`) and
 *      (b) notify() persisting the in-app row BEFORE dispatching email/SMS.
 *      DO NOT make in-app suppressible for this variant (or reorder notify's
 *      channels) without replacing the ledger — re-drives would silently
 *      duplicate emails for holders missing their in-app row.
 *   3. PER-RECIPIENT KEY — `event-location-revealed:{eventId}:{humanId}`
 *      makes truly concurrent ticks a per-recipient no-op inside notify()'s
 *      idempotency TTL.
 *
 * Losing the conditional cursor stamp means another (overlapping) run owns
 * the event — it is skipped from this run's event counts.
 *
 * Late buyers (purchase AFTER the reveal crossed) are deliberately NOT in the
 * scheduled fan-out (FR-007): once the cursor is stamped the event is never
 * re-scanned, and their TicketIssued purchase email already carries the
 * unlocked address.
 *
 * TODO(location-visibility-reveal spec, out_of_scope): re-revealing to
 * attendees after a venue/address CHANGE past the reveal date is a separate
 * location-change flow — this dispatcher only fires on the first crossing.
 *
 * Best-effort throughout: one event's failure must NEVER abort the others.
 */
export async function dispatchAddressRevealNotifications(
  deps: DispatchAddressRevealNotificationsDeps,
  rawInput: unknown,
): Promise<DispatchAddressRevealNotificationsOutput> {
  const { repos, clock } = deps;
  const input = parseInput(
    dispatchAddressRevealNotificationsInputSchema,
    rawInput,
  );
  const logger = deps.logger?.child({
    useCase: "events.dispatchAddressRevealNotifications",
  });

  const now = clock.now();
  const requestedWindowEnd = input.windowEndIso
    ? new Date(input.windowEndIso)
    : now;
  // CLAMP to now: an explicit future windowEnd would fan out exact addresses
  // BEFORE their reveal moment — irreversible, since the cursor stamps.
  // Clamping (rather than rejecting) lets a fat-fingered backfill still
  // process its valid past portion.
  const windowEnd =
    requestedWindowEnd.getTime() > now.getTime() ? now : requestedWindowEnd;
  if (windowEnd !== requestedWindowEnd) {
    logger?.warn(
      "events.dispatchAddressRevealNotifications.window_end_clamped",
      {
        requestedWindowEndIso: requestedWindowEnd.toISOString(),
        clampedWindowEndIso: windowEnd.toISOString(),
      },
    );
  }
  const windowStart = input.windowStartIso
    ? new Date(input.windowStartIso)
    : new Date(windowEnd.getTime() - DEFAULT_WINDOW_LOOKBACK_MS);

  const crossedOwnDate = await repos.events.findObscuredEventsCrossingReveal({
    windowStart,
    windowEnd,
    ...(input.eventId ? { eventId: input.eventId } : {}),
  });

  // The second scan. At a venue that withholds its address, an event the
  // venue confirmed by stamp unlocks at the LATER of its own date and
  // `max(startsAt, venueConfirmedStartsAt) − 24h` (the confirmed start is
  // the date the venue vouched for; a show moved earlier keeps it). When its
  // own date is earlier, it was picked up (and held back, still locked) back
  // then; the moment it really unlocks is keyed on one of the two starts, and
  // only a start-keyed read finds that — the repo matches either. The window
  // is the same one shifted by the lead; the holder gate below decides.
  const crossedVenueFloor = await repos.events.findObscuredPlaceEventsStartingIn(
    {
      startsAfter: new Date(windowStart.getTime() + STAMP_ARM_REVEAL_LEAD_MS),
      startsAtOrBefore: new Date(windowEnd.getTime() + STAMP_ARM_REVEAL_LEAD_MS),
      ...(input.eventId ? { eventId: input.eventId } : {}),
    },
  );
  const seen = new Set(crossedOwnDate.map((event) => event.id));
  const candidates: Array<{ event: EventRecord; via: ScanSource }> = [
    ...crossedOwnDate.map((event) => ({ event, via: "ownDate" as const })),
    ...crossedVenueFloor
      .filter((event) => !seen.has(event.id))
      .map((event) => ({ event, via: "venueFloor" as const })),
  ];

  const result: DispatchAddressRevealNotificationsOutput = {
    processed: 0,
    notifiedEvents: 0,
    lockedEvents: 0,
    failedEvents: 0,
    recipientsNotified: 0,
    recipientsSkipped: 0,
    recipientsAlreadyNotified: 0,
  };

  for (const { event, via } of candidates) {
    result.processed += 1;
    // Outer guard: one event must NEVER abort the batch, not even if a repo
    // bookkeeping call throws unexpectedly. Any escape is contained here.
    // Anything that throws BEFORE the fan-out loop (holder query, ledger
    // query) lands here with nothing sent and the cursor untouched — safe to
    // retry next tick.
    try {
      await processEvent({
        event,
        via,
        deps,
        result,
        logger,
        redrive: Boolean(input.eventId),
      });
    } catch (error) {
      result.failedEvents += 1;
      logger?.error(
        "events.dispatchAddressRevealNotifications.event_unhandled",
        {
          eventId: event.id,
          error: describeError(error),
        },
      );
    }
  }

  logger?.info("events.dispatchAddressRevealNotifications.completed", {
    ...result,
    windowStartIso: windowStart.toISOString(),
    windowEndIso: windowEnd.toISOString(),
  });

  return dispatchAddressRevealNotificationsOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-event processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which scan found the event: its own `addressRevealAt` crossed, or its
 * `startsAt − 24h` did (the venue-confirmed floor). Only changes how a
 * still-locked NEVER event is logged.
 */
type ScanSource = "ownDate" | "venueFloor";

/**
 * The event's short link (`/e/<shortId>`) for the SMS leg, or null when the
 * SMS must keep the canonical `eventUrl`.
 *
 * Only a link that will RESOLVE, decided exactly as `resolveEventShortLink`
 * decides it: re-read the event, then require a short ID, a current slug
 * (the link is a redirect to it) and `isEventPubliclyReadable`. Short IDs are
 * derived from the event id and never change, so a scan row without one
 * skips the read.
 *
 * The link is a convenience; the address is the point. A failing re-read
 * DEGRADES to the canonical URL (reported + ERROR-logged) and never costs
 * holders the notice — failing the event here would leave its cursor unset
 * until it aged out of the lookback window with nobody told.
 */
async function resolveSmsShortUrl(args: {
  event: EventRecord;
  deps: DispatchAddressRevealNotificationsDeps;
  logger: LoggerPort | undefined;
}): Promise<string | null> {
  const { event, deps, logger } = args;
  if (!event.shortId) return null;
  let current: EventRecord | null;
  try {
    current = await deps.repos.events.getById(event.id);
  } catch (error) {
    logger?.error(
      "events.dispatchAddressRevealNotifications.sms_short_url_failed",
      { eventId: event.id, error: describeError(error) },
    );
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "events.dispatchAddressRevealNotifications",
          step: "sms_short_url",
        },
        extra: { eventId: event.id },
      });
    } catch {
      // Best-effort: a throwing reporter must not change the outcome.
    }
    return null;
  }
  if (!current || !current.slug || !isEventPubliclyReadable(current)) {
    return null;
  }
  return eventShortUrl({ baseUrl: deps.appBaseUrl, shortId: current.shortId });
}

async function processEvent(args: {
  event: EventRecord;
  via: ScanSource;
  deps: DispatchAddressRevealNotificationsDeps;
  result: DispatchAddressRevealNotificationsOutput;
  logger: LoggerPort | undefined;
  /** An explicit `eventId` re-drive (see the email-only holders below). */
  redrive: boolean;
}): Promise<void> {
  const { event, via, deps, result, logger } = args;
  const { repos, clock } = deps;

  // WHAT is revealed, and WHETHER it may be, comes from the ONE holder-address
  // decision every holder surface shares. Things it catches that the scan
  // alone does not:
  //   - a NEVER event is never revealed, even if a stale row also carries a
  //     reveal date that crossed the window;
  //   - at a venue that withholds its address, only an event the VENUE
  //     vouched for is revealed at all (its own show, or one it confirmed;
  //     never an unconfirmed third party's or a community listing), and a
  //     confirmed third party's no earlier than a day before the start;
  //   - there, the Event row holds only the venue's PUBLIC projection (area
  //     label, public circle centre). The true address is on the Place;
  //     sending the Event row would "reveal" the area label and point
  //     directions at the fuzzed circle.
  // A place lookup that throws escapes to the outer guard: nothing sent,
  // cursor untouched, retried next tick.
  const place = event.placeId
    ? await repos.places.getById(event.placeId)
    : null;
  const holderAddress = resolveHolderAddress({
    event,
    place,
    venueConfirmationArm: venueConfirmationArm(event, place),
    // The audience is `activeTicketHolderHumanIds` below: active holders by
    // construction. The gate's other questions are about the event.
    activeHolder: true,
    actOnBill: false,
    now: clock.now(),
  });

  if (holderAddress.locked) {
    // Nothing is sent and the cursor stays unset in every locked case.
    if (holderAddress.reason === "never" && via === "ownDate") {
      // A NEVER event whose own reveal date crossed is a data defect (NEVER
      // stores no date). It ages out of the lookback window with an ERROR
      // trail.
      result.failedEvents += 1;
      logger?.error("events.dispatchAddressRevealNotifications.reveal_locked", {
        eventId: event.id,
        never: true,
      });
      return;
    }
    // Expected, not a failure: the venue has not confirmed this event (its
    // holders never get the address from us), or a venue-confirmed event's
    // real reveal is still ahead (the start-keyed scan finds it then).
    result.lockedEvents += 1;
    logger?.info("events.dispatchAddressRevealNotifications.reveal_withheld", {
      eventId: event.id,
      reason: holderAddress.reason,
      revealAtIso: holderAddress.revealAt?.toISOString() ?? null,
    });
    return;
  }

  // An OBSCURED event without a stored address can't reveal anything. Leave
  // the cursor UNSET (never silently swallow the reveal) — the event retries
  // while inside the scan window and ages out with an ERROR trail for ops.
  // (Pre-fan-out failure: nothing is sent, so retrying can't cause a storm.)
  const revealedAddress = holderAddress.addressText;
  if (!revealedAddress) {
    result.failedEvents += 1;
    logger?.error("events.dispatchAddressRevealNotifications.missing_address", {
      eventId: event.id,
    });
    return;
  }

  // Slug-based, never `event.id`: the public route resolves by slug / slug
  // history only, so the id fallback this used to carry produced a 404 link in
  // the email, the SMS and the in-app action.
  //
  // A missing slug DEGRADES rather than suppresses. The payload IS the address:
  // suppressing would cost the recipient the reveal permanently once the event
  // ages out of the lookback window, which is a far worse outcome than a notice
  // with no "View event" button. (PUBLISHED implies a slug anyway — publish-event
  // assigns one in the publishing transaction — so this is defensive.)
  const eventUrl = eventPublicUrl({
    baseUrl: deps.appBaseUrl,
    slug: event.slug,
  });
  if (!eventUrl) {
    logger?.error("events.dispatchAddressRevealNotifications.missing_slug", {
      eventId: event.id,
      slug: event.slug ?? null,
    });
  }

  const { lat, lng } = holderAddress;
  const hasCoords = lat != null && lng != null;
  const payload = {
    eventId: event.id,
    eventTitle: event.title,
    // Slice to the renderer's max(500) so an oversized stored address can't
    // fail the event's entire fan-out.
    address: revealedAddress.slice(0, MAX_ADDRESS_LENGTH),
    // `||` (not `??`): a stored empty-string label would fail the renderer's
    // min(1) and poison the whole event's fan-out every run.
    venueName: event.locationLabel || null,
    startsAtIso: event.startsAt.toISOString(),
    timezone: event.timezone ?? null,
    // Same Google Maps deep-links the TicketIssued purchase email uses.
    mapUrl: hasCoords
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
      : null,
    directionsUrl: hasCoords
      ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
      : null,
    eventUrl,
  };

  const holders = await repos.tickets.activeTicketHolderHumanIds(event.id);

  // DURABLE LEDGER SUBTRACTION: the in-app Notification rows persisted by
  // prior attempts identify already-notified holders — subtract them so
  // overlapping ticks and explicit eventId re-drives fan out ONLY to the
  // gap. A ledger query failure escapes to the outer guard (nothing sent,
  // cursor untouched) rather than risking a duplicate fan-out.
  let alreadyNotified: ReadonlySet<string>;
  if (repos.notifications) {
    alreadyNotified = new Set(
      await repos.notifications.findNotifiedHumanIdsForEvent({
        eventId: event.id,
        variant: ADDRESS_REVEAL_VARIANT,
        humanIds: holders,
      }),
    );
  } else {
    // No notifications repo wired (should not happen in real containers —
    // createPrismaRepos always binds one). Degrade to no subtraction; the
    // at-most-once cursor stamp below still prevents storms.
    alreadyNotified = new Set();
    logger?.warn(
      "events.dispatchAddressRevealNotifications.ledger_unavailable",
      { eventId: event.id },
    );
  }

  const remainder = holders.filter((humanId) => !alreadyNotified.has(humanId));
  result.recipientsAlreadyNotified += holders.length - remainder.length;

  // SMS-only short link (one segment instead of two); null ⇒ the SMS carries
  // `eventUrl`, exactly as before. Read only when someone is about to be sent
  // the notice — a no-op tick or a fully-notified re-drive skips it.
  const smsShortUrl =
    remainder.length > 0
      ? await resolveSmsShortUrl({ event, deps, logger })
      : null;
  const sendPayload = { ...payload, eventShortUrl: smsShortUrl };

  // B2 (account squatting through guest checkout): guest checkout, comps and
  // door sales attach tickets BY EMAIL, so a holder whose email is unverified
  // may be an account someone else opened under the buyer's address. The
  // reveal still goes to that address's INBOX (the real buyer reads it), but
  // not in-app, push or SMS, which reach whoever is signed in or whose phone
  // is on the account. A lookup failure escapes to the outer guard like the
  // ledger read: nothing sent, cursor untouched.
  const verifiedHolders: ReadonlySet<string> =
    remainder.length > 0
      ? new Set(await repos.humans.listEmailVerifiedIds(remainder))
      : new Set();

  // An email-only holder leaves no in-app row, so the ledger above cannot
  // subtract them, and `notify`'s own idempotency lasts 60 s. An explicit
  // re-drive (run after the first pass, to fill its gap) would mail them the
  // reveal again, so it skips them. Overlapping scheduled ticks run seconds
  // apart and are inside notify's replay window. The cost: an email-only
  // holder whose FIRST send failed is not retried by a re-drive (the failure
  // was ERROR-logged with their id).
  const recipients = args.redrive
    ? remainder.filter((humanId) => verifiedHolders.has(humanId))
    : remainder;
  if (recipients.length < remainder.length) {
    result.recipientsSkipped += remainder.length - recipients.length;
    logger?.info(
      "events.dispatchAddressRevealNotifications.redrive_email_only_skipped",
      { eventId: event.id, skipped: remainder.length - recipients.length },
    );
  }

  let failureCount = 0;
  let succeededThisEvent = 0;
  const failedHumanIds: string[] = [];

  for (const humanId of recipients) {
    try {
      await deps.notify({
        humanId,
        variant: ADDRESS_REVEAL_VARIANT,
        payload: sendPayload,
        idempotencyKey: `event-location-revealed:${event.id}:${humanId}`,
        // PRODUCT DECISION: the in-app notification is NOT suppressible —
        // the per-call channel override wins over the user's stored
        // transactional × in_app preference inside notify(). Email/SMS are
        // left preference-driven (no override); push is likewise
        // preference-driven (FR-006 — the PushPort is wired server-side and
        // delivers once the holder has a registered device).
        //
        // An unverified holder gets email only (see `verifiedHolders`).
        channels: verifiedHolders.has(humanId)
          ? { inApp: { enabled: true } }
          : {
              inApp: { enabled: false },
              push: { enabled: false },
              sms: { enabled: false },
            },
      });
      succeededThisEvent += 1;
      result.recipientsNotified += 1;
    } catch (error) {
      // PERMANENT per-recipient condition: the owner Human no longer resolves
      // (deleted account with a still-referencing ticket). Retrying can never
      // fix it, so it must not fail the event. Skip + warn.
      if (isPermanentRecipientError(error)) {
        result.recipientsSkipped += 1;
        logger?.warn(
          "events.dispatchAddressRevealNotifications.recipient_skipped",
          {
            eventId: event.id,
            humanId,
            error: describeError(error),
          },
        );
        continue;
      }
      failureCount += 1;
      failedHumanIds.push(humanId);
      logger?.warn("events.dispatchAddressRevealNotifications.notify_error", {
        eventId: event.id,
        humanId,
        error: describeError(error),
      });
    }
  }

  if (failureCount > 0) {
    // AT-MOST-ONCE: failures do NOT hold the cursor open — the stamp below
    // still happens, so the scheduled scan can never re-fan-out to the
    // healthy majority (duplicate-storm guard). The gap is ERROR-logged for
    // ops; the reveal stays pull-visible on the event page, and an explicit
    // eventId re-drive (after fixing the cause) re-notifies ONLY this gap
    // thanks to the ledger subtraction above.
    result.failedEvents += 1;
    logger?.error(
      "events.dispatchAddressRevealNotifications.event_partial_failure",
      {
        eventId: event.id,
        holders: holders.length,
        succeeded: succeededThisEvent,
        failed: failureCount,
        failedHumanIds,
      },
    );
  }

  // CONDITIONAL STAMP: updates only while the cursor is still null. Losing
  // means another overlapping run already claimed the event (or this was an
  // explicit re-drive of an already-stamped event) — that run owns the event,
  // so it isn't counted as notified here.
  const wonStamp = await repos.events.markAddressRevealNotified(
    event.id,
    clock.now(),
  );
  if (!wonStamp) {
    logger?.info(
      "events.dispatchAddressRevealNotifications.cursor_already_stamped",
      { eventId: event.id },
    );
    return;
  }
  if (failureCount > 0) {
    return;
  }

  result.notifiedEvents += 1;
  logger?.info("events.dispatchAddressRevealNotifications.event_notified", {
    eventId: event.id,
    holders: holders.length,
  });
}

/**
 * Whether a per-recipient `notify` error can never succeed on retry.
 * `notify` rethrows the underlying AppError untouched (asKnownError passes
 * known-code errors through), so the canonical code is inspectable here
 * without importing the comms internals.
 */
function isPermanentRecipientError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "HUMAN_NOT_FOUND"
  );
}
