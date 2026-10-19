import { createHash } from "node:crypto";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { OrgRole } from "@th/types/repos/authz";

import { describeError } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { resolvePerformerActName } from "../booking-requests/_shared/act-name";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import type {
  BookingHoldIntentKind,
  BookingHoldNotificationIntent,
  BookingHoldStaffRecipientHint,
} from "./_shared/booking-hold-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-hold notification dispatcher (booking-holds spec FR-016).
//
// Every hold use case returns the notifications it OWES as data
// (`notificationIntents` + `staffRecipientHint`, see
// _shared/booking-hold-intents.ts). This module turns that list into notify()
// calls post-commit. It is composed at the transport layer (step 4) and fired
// inside a swallow, exactly like the booking-request notifiers.
//
// Routing (FR-016):
//   act   → the request's performer owner: a human directly, an org's
//           ORG_EDIT_ROLES members, an anonymous/unclaimed sender → skipped.
//   staff → intent.staff.assigneeHumanId → else intent.staff.placedByHumanId
//           (only while still an edit-role member / direct owner) → else every
//           edit-role member of the owning org (a directly human-owned venue:
//           its direct owners).
//
// Channels (locked decision): acts get email + in-app for placed / challenged
// / extended / released / lost date / confirmed / expired, and for a move-up
// to FIRST; other position changes and "the first hold stands" are in-app
// only. Staff get in-app for everything and email only for a challenge
// answer and a challenge expiry. SMS is never used.
//
// Idempotency key: `booking-hold:{holdId}:{kind}:{audience}:{recipient}`, plus a
// discriminator where the same (hold, kind) legitimately recurs — the new
// position for position_changed, the deadline for challenged / extended.
// `hold.placed_batch` is the exception: it covers a SET of holds, so its key
// is `booking-hold-batch:{sha256(sorted holdIds)}:…` (see buildIdempotencyKey).
//
// RESOLVE EVERYTHING BEFORE ANY notify() CALL: notify() claims its
// idempotency key before sending, so a lookup failure mid-loop would leave
// earlier recipients claimed and later ones never attempted. Every send is
// fully materialised first, then dispatched with per-recipient isolation.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_HOLD_VARIANTS = {
  placed: "booking.hold-placed",
  placedBatch: "booking.hold-placed-batch",
  positionChanged: "booking.hold-position-changed",
  challenged: "booking.hold-challenged",
  challengeExtended: "booking.hold-challenge-extended",
  challengeAnswered: "booking.hold-challenge-answered",
  released: "booking.hold-released",
  lostDate: "booking.hold-lost-date",
  expired: "booking.hold-expired",
  confirmed: "booking.hold-confirmed",
} as const;

const NOTIFY_ORG_ROLES: ReadonlySet<OrgRole> = new Set(ORG_EDIT_ROLES);

/** Renderer `.min(1)` guarantee for a place row that vanished mid-flight. */
const PLACE_NAME_FALLBACK = "The place";
const PLACE_NAME_MAX = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Deps / args
// ─────────────────────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type DispatchBookingHoldIntentsDeps = {
  repos: Pick<
    Repos,
    | "bookingRequests"
    | "places"
    | "organizations"
    | "humans"
    | "entityPages"
    | "performerBookingDefaults"
  >;
  notify: NotifyFn;
  logger?: LoggerPort;
  /** Per-recipient swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
  /** Base web URL for the deep links — required (the caller's swallow reports). */
  publicAppUrl?: string | null;
};

export type DispatchBookingHoldIntentsArgs = {
  intents: readonly BookingHoldNotificationIntent[];
  /** The PRIMARY request's staff routing hint (orgId / placeId apply to all). */
  hint: BookingHoldStaffRecipientHint;
  /** The primary request the use case acted on (logging + no-recipient reports). */
  bookingRequestId: string;
};

/**
 * Caller-facing hook the transport composes and fires post-commit inside a
 * swallow, once per hold mutation (step 4).
 */
export type NotifyBookingHoldIntentsFn = (
  args: DispatchBookingHoldIntentsArgs,
) => Promise<void>;

/** One fully-resolved send. Exported for tests only. */
export type PlannedBookingHoldSend = {
  humanId: string;
  variant: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  channels: NotifyInput["channels"];
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchBookingHoldIntents(
  deps: DispatchBookingHoldIntentsDeps,
  args: DispatchBookingHoldIntentsArgs,
): Promise<void> {
  const logger = deps.logger?.child({ useCase: "dispatchBookingHoldIntents" });
  const { intents, hint, bookingRequestId } = args;

  if (intents.length === 0) return;

  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error(
      "dispatchBookingHoldIntents: publicAppUrl is required to build the hold links",
    );
  }

  const sends = await planSends(deps, logger, {
    intents,
    hint,
    bookingRequestId,
    baseUrl,
  });

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
      logger?.error("booking_holds.notify.recipient_failed", {
        bookingRequestId,
        variant: send.variant,
        humanId: send.humanId,
        idempotencyKey: send.idempotencyKey,
        err: error,
        error: describeError(error),
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: "dispatchBookingHoldIntents",
            variant: send.variant,
          },
          extra: {
            bookingRequestId,
            humanId: send.humanId,
            idempotencyKey: send.idempotencyKey,
          },
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
// Planning — every lookup happens here, before the first notify()
// ─────────────────────────────────────────────────────────────────────────────

type Recipient = { humanId: string; targetUrl: string };

type PlanContext = {
  intents: readonly BookingHoldNotificationIntent[];
  hint: BookingHoldStaffRecipientHint;
  bookingRequestId: string;
  baseUrl: string;
};

async function planSends(
  deps: DispatchBookingHoldIntentsDeps,
  logger: LoggerPort | undefined,
  ctx: PlanContext,
): Promise<PlannedBookingHoldSend[]> {
  const place = await deps.repos.places.getById(ctx.hint.placeId);
  const placeName = clipName(place?.name) ?? PLACE_NAME_FALLBACK;
  const timezone = resolveBookingTimezone(place?.timezone);

  // Intents can span several requests (competitors on confirm, movers on a
  // release), so requests are loaded once each and cached.
  const requestCache = new Map<string, Promise<BookingRequestRecord | null>>();
  const loadRequest = (id: string) => {
    let pending = requestCache.get(id);
    if (!pending) {
      pending = deps.repos.bookingRequests.getById(id);
      requestCache.set(id, pending);
    }
    return pending;
  };

  const actRecipientCache = new Map<string, Promise<Recipient[]>>();
  const staffRecipientCache = new Map<string, Promise<Recipient[]>>();
  const actNameCache = new Map<string, Promise<string>>();
  let staffPool: Promise<StaffPool> | null = null;
  const loadStaffPool = () => {
    staffPool ??= resolveStaffPool(deps, ctx.hint, place, ctx.baseUrl);
    return staffPool;
  };

  const sends: PlannedBookingHoldSend[] = [];

  for (const intent of ctx.intents) {
    const request = await loadRequest(intent.bookingRequestId);
    if (!request) {
      logger?.error("booking_holds.notify.request_missing", {
        bookingRequestId: intent.bookingRequestId,
        holdId: intent.holdId,
        kind: intent.kind,
      });
      continue;
    }

    let recipients: Recipient[];
    let actName: string | undefined;
    if (intent.audience === "act") {
      let pending = actRecipientCache.get(intent.bookingRequestId);
      if (!pending) {
        pending = resolveActRecipients(deps, logger, request, ctx.baseUrl);
        actRecipientCache.set(intent.bookingRequestId, pending);
      }
      recipients = await pending;
    } else {
      const staff = intent.staff;
      if (!staff) {
        // Contract violation upstream — a staff intent without its hint.
        logger?.error("booking_holds.notify.staff_hint_missing", {
          bookingRequestId: intent.bookingRequestId,
          holdId: intent.holdId,
          kind: intent.kind,
        });
        continue;
      }
      const cacheKey = `${staff.assigneeHumanId ?? ""}:${staff.placedByHumanId}`;
      let pending = staffRecipientCache.get(cacheKey);
      if (!pending) {
        pending = loadStaffPool().then((pool) =>
          pickStaffRecipients(pool, staff),
        );
        staffRecipientCache.set(cacheKey, pending);
      }
      recipients = await pending;

      let pendingName = actNameCache.get(intent.bookingRequestId);
      if (!pendingName) {
        pendingName = resolveActNameForStaff(deps, request);
        actNameCache.set(intent.bookingRequestId, pendingName);
      }
      actName = await pendingName;

      if (recipients.length === 0) {
        // Staff with nobody to tell: the venue is shouting into the void.
        logger?.error("booking_holds.notify.no_staff_recipients", {
          bookingRequestId: intent.bookingRequestId,
          holdId: intent.holdId,
          kind: intent.kind,
          orgId: ctx.hint.orgId,
          placeId: ctx.hint.placeId,
        });
        try {
          deps.reportError?.(
            new Error("booking_hold_notify_no_staff_recipients"),
            {
              tags: {
                useCase: "dispatchBookingHoldIntents",
                kind: intent.kind,
              },
              extra: {
                bookingRequestId: intent.bookingRequestId,
                holdId: intent.holdId,
              },
            },
          );
        } catch {
          // Best-effort reporting only.
        }
      }
    }

    const message = buildMessage(intent, { placeName, timezone, actName });
    if (!message) {
      if (
        intent.kind === "hold.placed_batch" &&
        (intent.dates?.length ?? 0) < 2
      ) {
        // Contract violation upstream — a digest with nothing to digest.
        logger?.error("booking_holds.notify.batch_dates_missing", {
          bookingRequestId: intent.bookingRequestId,
          holdId: intent.holdId,
          kind: intent.kind,
          dateCount: intent.dates?.length ?? 0,
        });
        try {
          deps.reportError?.(new Error("booking_hold_notify_batch_too_small"), {
            tags: { useCase: "dispatchBookingHoldIntents", kind: intent.kind },
            extra: {
              bookingRequestId: intent.bookingRequestId,
              holdId: intent.holdId,
              dateCount: intent.dates?.length ?? 0,
            },
          });
        } catch {
          // Best-effort reporting only.
        }
      }
      if (
        (intent.kind === "hold.challenged" ||
          intent.kind === "hold.challenge_extended") &&
        !intent.respondBy
      ) {
        // Contract violation upstream — a challenge without its deadline.
        logger?.error("booking_holds.notify.respond_by_missing", {
          bookingRequestId: intent.bookingRequestId,
          holdId: intent.holdId,
          kind: intent.kind,
        });
        try {
          deps.reportError?.(
            new Error("booking_hold_notify_respond_by_missing"),
            {
              tags: {
                useCase: "dispatchBookingHoldIntents",
                kind: intent.kind,
              },
              extra: {
                bookingRequestId: intent.bookingRequestId,
                holdId: intent.holdId,
              },
            },
          );
        } catch {
          // Best-effort reporting only.
        }
      }
      continue;
    }

    for (const recipient of recipients) {
      sends.push({
        humanId: recipient.humanId,
        variant: message.variant,
        idempotencyKey: buildIdempotencyKey(intent, recipient.humanId),
        payload: {
          bookingRequestId: intent.bookingRequestId,
          holdId: intent.holdId,
          placeName,
          date: intent.date,
          timezone,
          targetUrl: recipient.targetUrl,
          ...message.extra,
        },
        channels: message.email
          ? { sms: { enabled: false } }
          : { sms: { enabled: false }, email: { enabled: false } },
      });
    }
  }

  return sends;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kind → variant / payload / channel matrix
// ─────────────────────────────────────────────────────────────────────────────

type Message = {
  variant: string;
  extra: Record<string, unknown>;
  /** Whether this (kind, audience) gets an email at all. */
  email: boolean;
};

function buildMessage(
  intent: BookingHoldNotificationIntent,
  ctx: { placeName: string; timezone: string; actName: string | undefined },
): Message | null {
  const isStaff = intent.audience === "staff";
  const staffName = isStaff ? { actName: ctx.actName } : {};

  switch (intent.kind) {
    case "hold.placed":
      if (isStaff) return null;
      return {
        variant: BOOKING_HOLD_VARIANTS.placed,
        extra: { position: intent.position ?? 1 },
        email: true,
      };
    case "hold.placed_batch": {
      if (isStaff) return null;
      // The digest exists to collapse N placements into ONE send; a batch
      // that somehow arrives with fewer than two dates has nothing to
      // digest, and the plain `hold.placed` intent is the right shape for
      // it. Emitting it here would be a lie the copy can't tell ("holding 1
      // dates"), so drop it and let the emit-site invariant be the contract.
      const dates = intent.dates ?? [];
      if (dates.length < 2) return null;
      return {
        variant: BOOKING_HOLD_VARIANTS.placedBatch,
        // Same channels as `placed` (email + in-app + push) — ONE of each for
        // the whole batch instead of one per hold.
        extra: { dates },
        email: true,
      };
    }
    case "hold.position_changed":
      if (isStaff) return null;
      return {
        variant: BOOKING_HOLD_VARIANTS.positionChanged,
        extra: { position: intent.position ?? 1 },
        email: intent.position === 1,
      };
    case "hold.challenged":
    case "hold.challenge_extended": {
      if (!intent.respondBy) return null;
      const respondByISO = intent.respondBy.toISOString();
      if (isStaff) {
        // The assignee's "a challenge is open" ping rides the same challenge
        // renderer as the act, but in-app only (FR-016).
        return {
          variant:
            intent.kind === "hold.challenged"
              ? BOOKING_HOLD_VARIANTS.challenged
              : BOOKING_HOLD_VARIANTS.challengeExtended,
          extra: { audience: "staff", position: 1, respondByISO, ...staffName },
          email: false,
        };
      }
      return {
        variant:
          intent.kind === "hold.challenged"
            ? BOOKING_HOLD_VARIANTS.challenged
            : BOOKING_HOLD_VARIANTS.challengeExtended,
        extra: {
          position: intent.position === 2 ? 2 : 1,
          respondByISO,
          // booking-the-night N19 / FR-014: the challenged act is told what
          // Keep will do. Its own terms only; never on the position-2 copy.
          ...(intent.position !== 2 && intent.keepWill
            ? { keepWill: intent.keepWill }
            : {}),
        },
        email: true,
      };
    }
    case "hold.kept":
      return {
        variant: BOOKING_HOLD_VARIANTS.challengeAnswered,
        extra: {
          audience: intent.audience,
          answer: "kept",
          ...staffName,
          // booking-the-night FR-014: kept with no terms sent — staff are
          // asked to send them; the keeper is told the deadline the keep set
          // (review W2). The position-2 act's intent never carries it.
          ...(intent.awaitingTerms && intent.respondBy
            ? { awaitingTerms: true, respondByISO: intent.respondBy.toISOString() }
            : {}),
        },
        email: isStaff,
      };
    case "hold.released":
      if (intent.reason === "EVENT_SCHEDULED") {
        // FR-018: the venue scheduled an event on the date. The act is told
        // (email on); the assignee gets an in-app note, like an expiry.
        if (isStaff) {
          return {
            variant: BOOKING_HOLD_VARIANTS.released,
            extra: { reason: "EVENT_SCHEDULED", audience: "staff", ...staffName },
            email: false,
          };
        }
        return {
          variant: BOOKING_HOLD_VARIANTS.released,
          extra: { reason: "EVENT_SCHEDULED" },
          email: true,
        };
      }
      if (isStaff) {
        // Only the act's own release answer reaches staff (FR-006).
        return {
          variant: BOOKING_HOLD_VARIANTS.challengeAnswered,
          extra: { audience: "staff", answer: "released", ...staffName },
          email: true,
        };
      }
      return {
        variant: BOOKING_HOLD_VARIANTS.released,
        extra: {
          reason:
            intent.reason === "SIBLING_CONFIRMED" ||
            intent.reason === "REQUEST_CLOSED"
              ? intent.reason
              : "MANUAL",
        },
        email: true,
      };
    case "hold.lost_date":
      if (isStaff) return null;
      return {
        variant: BOOKING_HOLD_VARIANTS.lostDate,
        extra: {},
        email: true,
      };
    case "hold.confirmed":
      if (isStaff) return null;
      return {
        variant: BOOKING_HOLD_VARIANTS.confirmed,
        extra: {},
        email: true,
      };
    case "hold.expired":
      return {
        variant: BOOKING_HOLD_VARIANTS.expired,
        extra: { audience: intent.audience, ...staffName },
        email: true,
      };
    default: {
      const never: never = intent.kind;
      return never;
    }
  }
}

const RECURRING_KINDS: ReadonlySet<BookingHoldIntentKind> = new Set([
  "hold.challenged",
  "hold.challenge_extended",
  // booking-the-night P2d-2: the staff "kept — send terms" notice carries the
  // act's new deadline, so a keep in a LATER challenge of the same hold is
  // its own send. The act-side "first hold stands" has no deadline and keeps
  // its plain key.
  "hold.kept",
]);

/**
 * Batch digest key prefix. Deliberately NOT `booking-hold:` — a single-hold
 * key's next segment is always a UUID, which can never be the literal
 * `-batch`, so the two namespaces cannot collide.
 */
const BATCH_KEY_PREFIX = "booking-hold-batch";
/**
 * 32 hex chars = 128 bits of the digest. Long enough that a collision is not
 * a thing that happens, short enough that the composed
 * `notify:{humanId}:{scope}:{key}` stays ~110 chars — well inside Postgres'
 * b-tree index entry limit for `Idempotency.key` (the alternative, joining up
 * to 12 raw UUIDs, would be ~450 chars of key for no benefit).
 */
const BATCH_DIGEST_HEX = 32;

/** Stable over the SET of holds: sorted, so input order cannot change it. */
function batchDigest(holdIds: readonly string[]): string {
  return createHash("sha256")
    .update([...holdIds].sort().join(","))
    .digest("hex")
    .slice(0, BATCH_DIGEST_HEX);
}

export function buildIdempotencyKey(
  intent: Pick<
    BookingHoldNotificationIntent,
    "holdId" | "kind" | "audience" | "position" | "respondBy" | "holdIds"
  >,
  humanId: string,
): string {
  // A digest covers MANY holds, so keying on `holdId` alone would let two
  // different batches that happen to start on the same hold collide (and a
  // retry of the same batch is only safe because the digest is over the whole
  // set). Hash the sorted hold ids.
  if (intent.kind === "hold.placed_batch") {
    const digest = batchDigest(
      intent.holdIds && intent.holdIds.length > 0
        ? intent.holdIds
        : [intent.holdId],
    );
    return `${BATCH_KEY_PREFIX}:${digest}:${intent.kind}:${intent.audience}:${humanId}`;
  }
  // Audience is part of the key: one human can be BOTH the act owner and the
  // venue assignee (a self-booking room), and the two copies must not collide.
  const base = `booking-hold:${intent.holdId}:${intent.kind}:${intent.audience}:${humanId}`;
  if (intent.kind === "hold.position_changed") {
    return `${base}:${intent.position ?? 0}`;
  }
  if (RECURRING_KINDS.has(intent.kind) && intent.respondBy) {
    return `${base}:${intent.respondBy.getTime()}`;
  }
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The act side: the human directly (`/account/settings/booking-requests`,
 * the sent-request view) or the act org's edit members
 * (`/admin/{orgSlug}/bookings`). Anonymous senders have no reachable identity
 * yet (info-logged, not reported — an expected state for unclaimed inquiries).
 */
async function resolveActRecipients(
  deps: DispatchBookingHoldIntentsDeps,
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  baseUrl: string,
): Promise<Recipient[]> {
  // CLAIM STATE, not just the sender narrowing: since booking-inquirer-outreach
  // an unclaimed inquiry the venue replied to carries a SHADOW owner pair, and
  // routing hold notifications at it would file in-app rows against a Human
  // nobody can sign in as (its email leg is refused as unverified anyway).
  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous" || isUnclaimedBookingInquiry(request)) {
    logger?.info("booking_holds.notify.anonymous_act_skipped", {
      bookingRequestId: request.id,
    });
    return [];
  }
  if (sender.performerOwnerType === "human") {
    return [
      {
        humanId: sender.performerOwnerId,
        targetUrl: `${baseUrl}/account/settings/booking-requests`,
      },
    ];
  }
  const org = await deps.repos.organizations.getById(sender.performerOwnerId);
  const slug = encodeURIComponent(org?.slug || sender.performerOwnerId);
  const targetUrl = `${baseUrl}/admin/${slug}/bookings`;
  return (await listOrgEditMembers(deps, sender.performerOwnerId)).map(
    (humanId) => ({
      humanId,
      targetUrl,
    }),
  );
}

/**
 * Everyone who MAY be a staff recipient for this venue, with their inbox URL:
 * the owning org's edit members, or a directly human-owned venue's owners.
 */
type StaffPool = {
  /** Eligible humans → inbox URL. Membership check for assignee/placedBy. */
  eligible: Map<string, string>;
};

async function resolveStaffPool(
  deps: DispatchBookingHoldIntentsDeps,
  hint: BookingHoldStaffRecipientHint,
  place: PlaceRecord | null,
  baseUrl: string,
): Promise<StaffPool> {
  const eligible = new Map<string, string>();
  const inboxUrl = (adminSlug: string) =>
    `${baseUrl}/admin/${adminSlug}/places/${hint.placeId}/bookings`;

  if (hint.orgId) {
    const org = await deps.repos.organizations.getById(hint.orgId);
    const url = inboxUrl(encodeURIComponent(org?.slug || hint.orgId));
    for (const humanId of await listOrgEditMembers(deps, hint.orgId)) {
      eligible.set(humanId, url);
    }
    return { eligible };
  }

  for (const humanId of place?.humanIdsWithAccess ?? []) {
    if (eligible.has(humanId)) continue;
    eligible.set(humanId, inboxUrl(await resolveHumanAdminSlug(deps, humanId)));
  }
  return { eligible };
}

/**
 * FR-016: assignee → placedBy → everyone. Both named candidates must still be
 * in the eligible pool (an assignee who left the org is not a recipient).
 */
function pickStaffRecipients(
  pool: StaffPool,
  staff: NonNullable<BookingHoldNotificationIntent["staff"]>,
): Recipient[] {
  for (const candidate of [staff.assigneeHumanId, staff.placedByHumanId]) {
    if (!candidate) continue;
    const url = pool.eligible.get(candidate);
    if (url) return [{ humanId: candidate, targetUrl: url }];
  }
  return [...pool.eligible.entries()].map(([humanId, targetUrl]) => ({
    humanId,
    targetUrl,
  }));
}

/**
 * Paged edit-role member walk (mirrors notify-booking-request-message).
 * Exported for the venue-confirmation dispatcher, which routes to an
 * org-owned event's edit members the same way.
 */
export async function listOrgEditMembers(
  deps: { repos: Pick<Repos, "organizations"> },
  orgId: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const members: string[] = [];
  const limit = 100;
  let offset = 0;
  let total = 0;
  do {
    const page = await deps.repos.organizations.listMembers({
      orgId,
      limit,
      offset,
    });
    total = page.total;
    for (const member of page.items) {
      if (!NOTIFY_ORG_ROLES.has(member.role)) continue;
      if (seen.has(member.humanId)) continue;
      seen.add(member.humanId);
      members.push(member.humanId);
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return members;
}

/**
 * Human admin slug — mirrors notify-booking-request-message (web
 * `toHumanAdminSlug`). Exported for the venue-confirmation dispatcher.
 */
export async function resolveHumanAdminSlug(
  deps: { repos: Pick<Repos, "humans" | "entityPages"> },
  humanId: string,
): Promise<string> {
  const withIdentity = await deps.repos.humans.getByIdWithIdentity(humanId);
  const username = withIdentity?.identity.username ?? null;
  if (username) return `@${encodeURIComponent(username)}`;

  const page = await deps.repos.entityPages.getByOwner("HUMAN", humanId);
  if (page?.slug) return `@${encodeURIComponent(page.slug)}`;

  return `@${humanId}`;
}

/**
 * The act's name for STAFF copy only: the pitch's actName, else the shared
 * performer-name resolution (booking defaults → entity page → record name →
 * constant). Anonymous senders fall back to their contact name.
 */
async function resolveActNameForStaff(
  deps: DispatchBookingHoldIntentsDeps,
  request: BookingRequestRecord,
): Promise<string> {
  const fromPitch = clipName(request.actName);
  if (fromPitch) return fromPitch;
  // Same claim-state guard as `resolveActRecipients`: a shadow-owned inquiry
  // has no performer profile to resolve, so staff copy keeps using the name
  // the inquirer actually submitted.
  if (isUnclaimedBookingInquiry(request) && request.contactName) {
    return clipName(request.contactName) ?? "The act";
  }
  const sender = getBookingRequestSender(request);
  if (sender.kind === "anonymous") {
    return clipName(sender.contactName) ?? "The act";
  }
  const resolved = await resolvePerformerActName(deps.repos, {
    ownerType: sender.performerOwnerType,
    ownerId: sender.performerOwnerId,
  });
  return clipName(resolved) ?? "The act";
}

function clipName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().slice(0, PLACE_NAME_MAX).trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
