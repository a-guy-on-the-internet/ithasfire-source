import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import type { NotifyInput, NotifyOutput } from "../comms/notify";

// ─────────────────────────────────────────────────────────────────────────────
// Availability-onboarding FR-003 (docs/specs/2026-08-31/
// availability-onboarding.spec.yaml): ONE in-app notification to the acting
// staff human when a place is about to be publicly uncontactable — either
// because booking acceptance just turned ON while the place has zero
// CalendarAvailability rows, or because a Calendar was just created for such
// a place. Both moments are the same mistake from different doors.
//
// Channel: in-app ONLY (spec-locked). The renderer emits no email/push
// payload, and the channel overrides below disable them belt-and-braces —
// this is a setup nudge, not a transactional event.
//
// Fired POST-COMMIT by the trigger use cases through the same optional-hook
// pattern as `notifyBookingRequestReceived`: composed at the transport layer,
// swallowed (+ reported) by the caller so a broken notifier never fails the
// committed mutation.
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer variant (registered in comms/renderers.ts). */
export const AVAILABILITY_SETUP_NEEDED_VARIANT =
  "place.availability-setup-needed";

/**
 * Durable once-per-place dedupe key. Deliberately NOT per-episode: the inline
 * warning (FR-001) and the workspace banner (FR-004) are the persistent
 * signals; this notification is just a path back for someone who closed the
 * tab. One per place — ever, within {@link DEDUPE_KEEP_SECONDS} — is the
 * simplest honest scheme, and a second OFF→ON re-toggle can never spam.
 */
export function availabilitySetupIdempotencyKey(placeId: string): string {
  return `availability-setup:${placeId}`;
}

/** Claim TTL while one send is in flight (matches notify()'s own posture). */
const CLAIM_TTL_SECONDS = 60;

/**
 * Committed-record retention: one year. On the Prisma idempotency backend
 * (prod since 2026-07-30) this is a durable row; on a Redis backend the key
 * expires after a year, so an eternally-unconfigured place could be nudged
 * again annually — acceptable for a setup nudge, and strictly better than
 * inventing new storage for it.
 */
const DEDUPE_KEEP_SECONDS = 60 * 60 * 24 * 365;

// ── Deps / args ──────────────────────────────────────────────────────────────

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type NotifyAvailabilitySetupNeededDeps = {
  repos: Pick<
    Repos,
    "places" | "calendars" | "authz" | "humans" | "organizations" | "entityPages"
  >;
  notify: NotifyFn;
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  /** ReporterPort convention — a throwing reporter never changes behaviour. */
  reportError?: ReporterPort;
  /**
   * Base URL of the web app (e.g. https://ithasfire.com) used to build the
   * absolute calendars-page deep link. Required — without it there is no
   * valid action href and the whole step throws (the CALLER's swallow
   * reports it), same posture as `notifyBookingRequestReceived`.
   */
  publicAppUrl?: string | null;
};

export type NotifyAvailabilitySetupNeededArgs = {
  placeId: string;
  /** The staff human who flipped the toggle / created the calendar. */
  actorHumanId: string;
};

/**
 * Shape of the caller-facing hook injected into `setPlaceBookingAcceptance` /
 * `createCalendar` — composed at the transport layer so the trigger use cases
 * stay decoupled from the notify pipeline's deps.
 */
export type NotifyAvailabilitySetupNeededFn = (
  args: NotifyAvailabilitySetupNeededArgs,
) => Promise<void>;

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Send the FR-003 setup nudge, if it is due.
 *
 * Owns BOTH guards so a trigger can call it unconditionally:
 * - SUPPRESSION: a configured place (≥1 CalendarAvailability row) returns
 *   without sending — the condition this nudges about does not exist.
 * - IDEMPOTENCY: the durable `availability-setup:{placeId}` claim means at
 *   most one notification per place, however many times the triggers fire.
 *
 * On failure after the claim, the key is `fail()`ed (short retention) so a
 * later trigger can retry the send.
 */
export async function notifyAvailabilitySetupNeeded(
  deps: NotifyAvailabilitySetupNeededDeps,
  args: NotifyAvailabilitySetupNeededArgs,
): Promise<void> {
  const logger = deps.logger?.child({
    useCase: "notifyAvailabilitySetupNeeded",
  });

  // Suppression: never emitted when the detector already says configured.
  const availabilityRowCount =
    await deps.repos.calendars.countAvailabilityForPlace(args.placeId);
  if (availabilityRowCount > 0) {
    return;
  }

  const key = availabilitySetupIdempotencyKey(args.placeId);
  const claimed = await deps.idempotency.begin(key, CLAIM_TTL_SECONDS);
  if (!claimed) {
    // Already sent (committed record) or a concurrent send is in flight —
    // either way this trigger owes nothing further.
    return;
  }

  try {
    const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
    if (!baseUrl) {
      // No base URL → no valid absolute action href → the renderer parse
      // would fail anyway. Fail once, loudly; the caller's swallow reports.
      throw new Error(
        "notifyAvailabilitySetupNeeded: publicAppUrl is required to build the calendars link",
      );
    }

    const place = await deps.repos.places.getById(args.placeId);
    if (!place) {
      throw new Error(
        `notifyAvailabilitySetupNeeded: place ${args.placeId} not found`,
      );
    }

    const adminSlug = await resolveActorAdminSlug(
      deps.repos,
      place,
      args.actorHumanId,
    );
    const calendarsUrl = `${baseUrl}/admin/${adminSlug}/places/${place.id}/calendars`;

    await deps.notify({
      humanId: args.actorHumanId,
      variant: AVAILABILITY_SETUP_NEEDED_VARIANT,
      idempotencyKey: key,
      payload: {
        placeId: place.id,
        placeName: place.name,
        calendarsUrl,
      },
      // In-app ONLY (spec-locked). The renderer emits no email/push/sms
      // payload; the overrides are belt-and-braces so a future renderer edit
      // cannot silently widen the channels.
      channels: {
        email: { enabled: false },
        push: { enabled: false },
        sms: { enabled: false },
      },
    });

    await deps.idempotency.commit(
      key,
      { placeId: place.id, notifiedHumanId: args.actorHumanId },
      DEDUPE_KEEP_SECONDS,
    );

    logger?.info("places.availability_setup_notified", {
      placeId: place.id,
      humanId: args.actorHumanId,
    });
  } catch (error) {
    // Free the claim for a later retry (short retention), then let the
    // trigger's swallow log + report it.
    try {
      await deps.idempotency.fail(key, describeFailure(error));
    } catch (failError) {
      logger?.error("places.availability_setup_idempotency_fail_failed", {
        placeId: args.placeId,
        err: failError,
      });
      try {
        deps.reportError?.(failError, {
          tags: { useCase: "notifyAvailabilitySetupNeeded" },
          extra: { placeId: args.placeId, stage: "idempotency_fail" },
        });
      } catch {
        // Reporting is best-effort.
      }
    }
    throw error;
  }
}

/** Trim trailing slashes so URL joins never emit `//admin/…`. */
function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Admin slug for the acting human, matching how THEY own the place — the same
 * rules as `notifyBookingRequestReceived`'s recipient resolution:
 * - direct human owner → `@{username | pageSlug | humanId}`
 * - owning-org member  → `{orgSlug | orgId}`
 * - fallback (cannot happen for a gated caller) → `@{humanId}`
 */
async function resolveActorAdminSlug(
  repos: NotifyAvailabilitySetupNeededDeps["repos"],
  place: { humanIdsWithAccess: string[]; orgIdsWithAccess: string[] },
  actorHumanId: string,
): Promise<string> {
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    const withIdentity = await repos.humans.getByIdWithIdentity(actorHumanId);
    const username = withIdentity?.identity.username ?? null;
    if (username) return `@${encodeURIComponent(username)}`;

    const page = await repos.entityPages.getByOwner("HUMAN", actorHumanId);
    if (page?.slug) return `@${encodeURIComponent(page.slug)}`;

    return `@${actorHumanId}`;
  }

  if (place.orgIdsWithAccess.length > 0) {
    const memberships = await repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: actorHumanId,
    });
    const orgId = memberships[0]?.orgId;
    if (orgId) {
      const org = await repos.organizations.getById(orgId);
      return encodeURIComponent(org?.slug || orgId);
    }
  }

  return `@${actorHumanId}`;
}
