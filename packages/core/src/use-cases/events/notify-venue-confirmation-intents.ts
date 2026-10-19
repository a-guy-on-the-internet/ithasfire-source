import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../lib/io";
import {
  LEGACY_PLACE_CONFIRMATION_KEY_KINDS,
  LEGACY_PLACE_CONFIRMATION_KEY_PREFIX,
} from "../../lib/legacy-place-values";
import {
  listOrgEditMembers,
  resolveHumanAdminSlug,
} from "../booking-holds/notify-booking-hold-intents";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import type { VenueConfirmationNotificationIntent } from "./_shared/venue-confirmation-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Venue-confirmation notification dispatcher (venue-confirmation-and-booking-
// intents spec, docs/specs/2026-08-27). Mirrors `notify-booking-hold-intents`:
// the use cases return the notifications they OWE as data; this module turns
// them into notify() calls post-commit, composed at the transport layer and
// fired inside a swallow.
//
// Routing: the intent's `recipient` is the EVENT's owner — a human directly
// (their admin event page), or an org's ORG_EDIT_ROLES members (the org's
// admin event page). Nobody else is ever told: the venue is the actor.
//
// Channels: in-app + push + email for both kinds (the hold notifier's posture
// for a confirmation and for a release — the two decisions that change what
// the act can rely on). SMS never. The email is text-only for now: no ui-email
// template exists yet (Step 4 may add `event.place_confirmed` /
// `event.place_confirmation_withdrawn` templates and switch the renderers
// to them).
//
// Idempotency key: `venue-confirmation:{eventId}:{kind}:{at}:{recipient}`.
// `at` is the stamp instant the transition wrote, so a re-confirm after a
// withdrawal (new `venueConfirmedAt`) or a withdrawal with a NEW reason (new
// `withdrawnAt`) sends again, while a retry of the same transition claims
// the same key.
//
// RESOLVE EVERYTHING BEFORE ANY notify() CALL (same reason as the hold
// dispatcher: notify() claims its key before sending).
// ─────────────────────────────────────────────────────────────────────────────

export const VENUE_CONFIRMATION_VARIANTS = {
  confirmed: "event.venue-confirmed",
  withdrawn: "event.venue-confirmation-withdrawn",
} as const;

/** Renderer `.min(1)` guarantee for a row that vanished mid-flight. */
const PLACE_NAME_FALLBACK = "The place";
const EVENT_TITLE_FALLBACK = "Your event";
const NAME_MAX = 200;

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type DispatchVenueConfirmationIntentsDeps = {
  repos: Pick<
    Repos,
    "events" | "places" | "organizations" | "humans" | "entityPages"
  >;
  notify: NotifyFn;
  logger?: LoggerPort;
  /** Per-recipient swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
  /** Base web URL for the deep links — required (the caller's swallow reports). */
  publicAppUrl?: string | null;
};

export type DispatchVenueConfirmationIntentsArgs = {
  intents: readonly VenueConfirmationNotificationIntent[];
};

/**
 * Caller-facing hook the transport composes and fires post-commit inside a
 * swallow, once per confirm / withdraw mutation (Step 3).
 */
export type NotifyVenueConfirmationIntentsFn = (
  args: DispatchVenueConfirmationIntentsArgs,
) => Promise<void>;

/** One fully-resolved send. Exported for tests only. */
export type PlannedVenueConfirmationSend = {
  humanId: string;
  variant: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  channels: NotifyInput["channels"];
};

export async function dispatchVenueConfirmationIntents(
  deps: DispatchVenueConfirmationIntentsDeps,
  args: DispatchVenueConfirmationIntentsArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "dispatchVenueConfirmationIntents",
  });
  if (args.intents.length === 0) return;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "dispatchVenueConfirmationIntents: publicAppUrl is required to build the event links",
    );
  }

  const sends = await planSends(deps, logger, args.intents, baseUrl);

  for (const send of sends) {
    try {
      await deps.notify({
        humanId: send.humanId,
        variant: send.variant,
        idempotencyKey: send.idempotencyKey,
        payload: send.payload,
        channels: send.channels,
      });
    } catch (error) {
      logger?.error("events.venue_confirmation.notify.recipient_failed", {
        variant: send.variant,
        humanId: send.humanId,
        idempotencyKey: send.idempotencyKey,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "dispatchVenueConfirmationIntents",
            variant: send.variant,
          },
          extra: { humanId: send.humanId, idempotencyKey: send.idempotencyKey },
        });
      } catch {
        // Best-effort reporting only.
      }
    }
  }
}

/** Trim trailing slashes so URL joins never emit `//admin/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────────

type Recipient = { humanId: string; targetUrl: string };

async function planSends(
  deps: DispatchVenueConfirmationIntentsDeps,
  logger: LoggerPort | undefined,
  intents: readonly VenueConfirmationNotificationIntent[],
  baseUrl: string,
): Promise<PlannedVenueConfirmationSend[]> {
  const sends: PlannedVenueConfirmationSend[] = [];

  // Intents in one dispatch share an event/place in practice, but never
  // assume it — cache per id.
  const placeNameCache = new Map<string, Promise<string>>();
  const eventTitleCache = new Map<string, Promise<string>>();
  const recipientCache = new Map<string, Promise<Recipient[]>>();

  const loadPlaceName = (placeId: string) => {
    let pending = placeNameCache.get(placeId);
    if (!pending) {
      pending = deps.repos.places
        .getById(placeId)
        .then((place) => clipName(place?.name) ?? PLACE_NAME_FALLBACK);
      placeNameCache.set(placeId, pending);
    }
    return pending;
  };
  const loadEventTitle = (eventId: string) => {
    let pending = eventTitleCache.get(eventId);
    if (!pending) {
      pending = deps.repos.events
        .getById(eventId)
        .then((event) => clipName(event?.title) ?? EVENT_TITLE_FALLBACK);
      eventTitleCache.set(eventId, pending);
    }
    return pending;
  };
  const loadRecipients = (intent: VenueConfirmationNotificationIntent) => {
    const key =
      intent.recipient.type === "human"
        ? `human:${intent.recipient.humanId}:${intent.eventId}`
        : `org:${intent.recipient.orgId}:${intent.eventId}`;
    let pending = recipientCache.get(key);
    if (!pending) {
      pending = resolveRecipients(deps, intent, baseUrl);
      recipientCache.set(key, pending);
    }
    return pending;
  };

  for (const intent of intents) {
    const [placeName, eventTitle, recipients] = await Promise.all([
      loadPlaceName(intent.placeId),
      loadEventTitle(intent.eventId),
      loadRecipients(intent),
    ]);

    if (recipients.length === 0) {
      // An org with no edit-role member left: the owner cannot be reached.
      logger?.error("events.venue_confirmation.notify.no_recipients", {
        eventId: intent.eventId,
        kind: intent.kind,
        recipient: intent.recipient,
      });
      try {
        deps.reportError?.(
          new Error("venue_confirmation_notify_no_recipients"),
          {
            tags: {
              useCase: "dispatchVenueConfirmationIntents",
              kind: intent.kind,
            },
            extra: { eventId: intent.eventId, recipient: intent.recipient },
          },
        );
      } catch {
        // Best-effort reporting only.
      }
      continue;
    }

    const message = buildMessage(intent);
    if (!message) {
      // Contract violation upstream — a withdrawal without its reason.
      logger?.error("events.venue_confirmation.notify.reason_missing", {
        eventId: intent.eventId,
        kind: intent.kind,
      });
      try {
        deps.reportError?.(
          new Error("venue_confirmation_notify_reason_missing"),
          {
            tags: {
              useCase: "dispatchVenueConfirmationIntents",
              kind: intent.kind,
            },
            extra: { eventId: intent.eventId },
          },
        );
      } catch {
        // Best-effort reporting only.
      }
      continue;
    }

    for (const recipient of recipients) {
      sends.push({
        humanId: recipient.humanId,
        variant: message.variant,
        idempotencyKey: buildVenueConfirmationIdempotencyKey(
          intent,
          recipient.humanId,
        ),
        payload: {
          eventId: intent.eventId,
          eventTitle,
          placeId: intent.placeId,
          placeName,
          bookingRequestId: intent.bookingRequestId,
          targetUrl: recipient.targetUrl,
          ...message.extra,
        },
        // Email + in-app; SMS never.
        channels: { sms: { enabled: false } },
      });
    }
  }

  return sends;
}

function buildMessage(
  intent: VenueConfirmationNotificationIntent,
): { variant: string; extra: Record<string, unknown> } | null {
  switch (intent.kind) {
    case "event.place_confirmed":
      return { variant: VENUE_CONFIRMATION_VARIANTS.confirmed, extra: {} };
    case "event.place_confirmation_withdrawn": {
      const reason = intent.reason?.trim();
      if (!reason) return null;
      return {
        variant: VENUE_CONFIRMATION_VARIANTS.withdrawn,
        extra: { reason },
      };
    }
    default: {
      const never: never = intent.kind;
      return never;
    }
  }
}

/**
 * The notification's idempotency key. BYTE-IDENTICAL to the keys claimed
 * before the intent kinds took the place spelling (2026-10-18): the prefix
 * and the kind segment are the old spellings, read from
 * `lib/legacy-place-values`, so one transition always claims one key and a
 * dispatch on either side of a deploy is sent once. Changing this format
 * changes every key.
 */
export function buildVenueConfirmationIdempotencyKey(
  intent: Pick<VenueConfirmationNotificationIntent, "eventId" | "kind" | "at">,
  humanId: string,
): string {
  const kind = LEGACY_PLACE_CONFIRMATION_KEY_KINDS[intent.kind];
  return `${LEGACY_PLACE_CONFIRMATION_KEY_PREFIX}:${intent.eventId}:${kind}:${intent.at.getTime()}:${humanId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution — the event's owner, with their admin event page
// ─────────────────────────────────────────────────────────────────────────────

async function resolveRecipients(
  deps: DispatchVenueConfirmationIntentsDeps,
  intent: VenueConfirmationNotificationIntent,
  baseUrl: string,
): Promise<Recipient[]> {
  const eventPath = `/events/${encodeURIComponent(intent.eventId)}`;
  if (intent.recipient.type === "human") {
    const slug = await resolveHumanAdminSlug(deps, intent.recipient.humanId);
    return [
      {
        humanId: intent.recipient.humanId,
        targetUrl: `${baseUrl}/admin/${slug}${eventPath}`,
      },
    ];
  }
  const org = await deps.repos.organizations.getById(intent.recipient.orgId);
  const slug = encodeURIComponent(org?.slug || intent.recipient.orgId);
  const targetUrl = `${baseUrl}/admin/${slug}${eventPath}`;
  return (await listOrgEditMembers(deps, intent.recipient.orgId)).map(
    (humanId) => ({ humanId, targetUrl }),
  );
}

function clipName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().slice(0, NAME_MAX).trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
