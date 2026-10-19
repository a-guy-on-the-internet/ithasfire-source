import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { OPEN_BOOKING_REQUEST_STATUSES } from "@th/ports/repos/booking-requests";
import type { HumanRecord } from "@th/ports/repos/humans";
import type {
  PerformerOwnerType,
  PerformerProfileRecord,
} from "@th/ports/repos/performer-profiles";

import { parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getMyWorkSummaryInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

const countSchema = z.number().int().nonnegative();

/**
 * SCOPE: this summary describes the signed-in HUMAN, never the groups they
 * administer. Both of the following follow from that and are load-bearing.
 *
 * 1. `adminOrgCount` is gone. It shipped in the first cut and never acquired a
 *    consumer — the "you also administer groups" hint in `PerformerSection`
 *    derives from `performers.getMyStatus.orgs`, not from here. It is not
 *    re-added on request: account settings must never widen on org
 *    administration (org performer mode, org booking defaults and the org inbox
 *    all live in `/admin/[slug]/settings`), and the surest way to keep a field
 *    from gating something it must not gate is not to ship it.
 *
 * 2. The booking counts are HUMAN-ONLY. They used to union the actor with every
 *    group they administer, which was wrong for both of its readers:
 *      - the settings nav gates the personal "Your work" scope on request
 *        history, and a unioned count let an org-only admin in through the back
 *        door — exactly the rule (1) exists to protect;
 *      - `pendingReceivedBookingRequestCount` is the badge on the account
 *        settings "Booking requests" row, whose list is
 *        `owner={{ownerType:"human"}}`. A unioned badge counted org requests
 *        that row never shows, so it could never be cleared.
 *    Dropping the union also removed the `authz` membership read entirely.
 */
export const getMyWorkSummaryOutputSchema = z
  .object({
    /**
     * Human performer mode is ON — the single performer predicate
     * (`isPerformerEnabled`), never inferred from `jobs[]`.
     */
    performerEnabled: z.boolean(),
    /**
     * Raw stored organizer-booking-request acceptance gate. Mirrors
     * `performers.getMyStatus.human.acceptsBookingRequests`: it is the STORED
     * value, so the effective receive gate is
     * `performerEnabled && acceptsBookingRequests`.
     */
    acceptsBookingRequests: z.boolean(),
    /** The human picked at least one industry job (`Human.jobs[]`). */
    hasWorkRoles: z.boolean(),
    /**
     * At least one sub-read below failed and was substituted with its zero
     * value. **Consumers must not make destructive decisions on a zero when
     * this is set** — a `0` here is "we don't know", not "you have none".
     *
     * This field exists because the settings nav redirects a user away from a
     * section it believes they are not entitled to. Without it, a transient
     * repo outage silently reads as "you have no venue claims" and bounces
     * someone off their own claims page. The failing part names go to the log
     * and to Sentry (see `readOrDegrade`); the client only needs the boolean.
     */
    degraded: z.boolean(),
    /**
     * TO_VENUE pitches SENT by the human AS THEMSELVES, all statuses.
     *
     * HUMAN-SCOPED, deliberately — see the note below the schema.
     */
    sentBookingRequestCount: countSchema,
    /**
     * TO_PERFORMER requests RECEIVED by the human AS THEMSELVES, all statuses.
     * Matches exactly what `ReceivedBookingRequestsList owner={{ownerType:
     * "human"}}` renders in account settings.
     */
    receivedBookingRequestCount: countSchema,
    /**
     * Subset of `receivedBookingRequestCount` still awaiting a response
     * (PENDING | VIEWED). This is the nav BADGE number; the field above is
     * the show/hide signal. Kept separate on purpose: a user whose requests
     * are all answered still needs the section to exist.
     */
    pendingReceivedBookingRequestCount: countSchema,
    /** Venue ownership claims + disputes this human filed, all statuses. */
    placeClaimCount: countSchema,
    /** Event edit suggestions this human submitted, all statuses. */
    editSuggestionCount: countSchema,
  })
  .strict();

export type GetMyWorkSummaryInput = z.infer<typeof getMyWorkSummaryInputSchema>;
export type GetMyWorkSummaryOutput = z.infer<
  typeof getMyWorkSummaryOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetMyWorkSummaryDeps = {
  repos: Pick<
    Repos,
    | "humans"
    | "performerProfiles"
    | "bookingRequests"
    | "placeVerificationRequests"
    | "eventEditSuggestions"
  >;
  logger?: LoggerPort;
  /**
   * Best-effort error reporter (CLAUDE.md deliberate-swallow convention).
   * Every sub-read below degrades to its zero value rather than failing the
   * whole nav, so WITHOUT this a broken repo would silently render the
   * settings page as "you do no work here" forever. Never affects output —
   * a throwing reporter changes nothing.
   */
  reportError?: ReporterPort;
};

type OwnerRef = { ownerType: PerformerOwnerType; ownerId: string };

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one sub-read, degrading to `fallback` on failure.
 *
 * The nav must render even when one repo is unhappy: an outage in, say, the
 * edit-suggestion count should hide that one row, not 500 the whole settings
 * page. The swallow is therefore paired with `logger.error` + `reportError`
 * (never `warn` — warn is not captured by Sentry's pino integration).
 */
async function readOrDegrade<T>(
  deps: Pick<GetMyWorkSummaryDeps, "logger" | "reportError">,
  degradedParts: string[],
  part: string,
  actorHumanId: string,
  fallback: T,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    degradedParts.push(part);
    deps.logger?.error("humans.get_my_work_summary.part_failed", {
      part,
      actorHumanId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "getMyWorkSummary", part },
        extra: { actorHumanId },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful degraded value into a thrown error.
    }
    return fallback;
  }
}

/**
 * One-round-trip feeder for the account-settings "Your work" nav scope.
 *
 * Everything here is derived from the SIGNED-IN human (`actorHumanId` is
 * injected from the session at the transport, never client-supplied), so there
 * is no authz branch beyond "you only ever see your own footprint" — and the
 * footprint is the HUMAN's alone, never their groups'. See the scope note above
 * the output schema for why the booking counts no longer union administered
 * orgs.
 *
 * Returns COUNTS, never entities: the consumer only needs "is this > 0" plus
 * the pending-received number for a badge, and shipping rows here would
 * duplicate five paginated queries that already exist.
 *
 * Failure posture: DEGRADE, don't throw. Each sub-read falls back to its zero
 * value, is reported via `reportError`, and flips `degraded` so the consumer
 * can tell "you have none" apart from "we couldn't find out".
 */
export async function getMyWorkSummary(
  deps: GetMyWorkSummaryDeps,
  rawInput: unknown,
): Promise<GetMyWorkSummaryOutput> {
  const input = parseInput(getMyWorkSummaryInputSchema, rawInput);
  const actorHumanId = input.actorHumanId;

  // Collected by `readOrDegrade`; only its emptiness is exported. Part names
  // already reach the log and Sentry, and shipping them to the client would be
  // internal topology for no consumer benefit.
  const degradedParts: string[] = [];

  // The actor, and only the actor. Administered orgs are deliberately NOT
  // unioned in — see the scope note above the output schema.
  const owners: OwnerRef[] = [{ ownerType: "human", ownerId: actorHumanId }];

  const [
    human,
    performerProfile,
    placeClaimCount,
    editSuggestionCount,
    sentBookingRequestCount,
    receivedBookingRequestCount,
    pendingReceivedBookingRequestCount,
  ] = await Promise.all([
    readOrDegrade<HumanRecord | null>(
      deps,
      degradedParts,
      "human",
      actorHumanId,
      null,
      () => deps.repos.humans.getById(actorHumanId),
    ),
    readOrDegrade<PerformerProfileRecord | null>(
      deps,
      degradedParts,
      "performerProfile",
      actorHumanId,
      null,
      () =>
        deps.repos.performerProfiles.getByOwner({
          ownerType: "human",
          ownerId: actorHumanId,
        }),
    ),
    readOrDegrade(deps, degradedParts, "placeClaims", actorHumanId, 0, () =>
      deps.repos.placeVerificationRequests.countByClaimant(actorHumanId),
    ),
    readOrDegrade(deps, degradedParts, "editSuggestions", actorHumanId, 0, () =>
      deps.repos.eventEditSuggestions.countBySubmitter(actorHumanId),
    ),
    readOrDegrade(
      deps,
      degradedParts,
      "sentBookingRequests",
      actorHumanId,
      0,
      () => deps.repos.bookingRequests.countForPerformer({ owners }),
    ),
    readOrDegrade(
      deps,
      degradedParts,
      "receivedBookingRequests",
      actorHumanId,
      0,
      () => deps.repos.bookingRequests.countForPerformerInbox({ owners }),
    ),
    readOrDegrade(
      deps,
      degradedParts,
      "pendingReceivedBookingRequests",
      actorHumanId,
      0,
      () =>
        deps.repos.bookingRequests.countForPerformerInbox({
          owners,
          statuses: [...OPEN_BOOKING_REQUEST_STATUSES],
        }),
    ),
  ]);

  return getMyWorkSummaryOutputSchema.parse({
    performerEnabled: isPerformerEnabled(performerProfile),
    acceptsBookingRequests: performerProfile?.acceptsBookingRequests ?? false,
    hasWorkRoles: (human?.jobs.length ?? 0) > 0,
    degraded: degradedParts.length > 0,
    sentBookingRequestCount,
    receivedBookingRequestCount,
    pendingReceivedBookingRequestCount,
    placeClaimCount,
    editSuggestionCount,
  });
}
