import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  effectiveBookingStandardsByIntentWireSchema,
  toEffectiveBookingStandardsByIntentWire,
} from "../booking-standards/effective-booking-standards-schemas";
import {
  calendarRequestIntents,
  loadEffectiveBookingStandards,
} from "../booking-standards/load-effective-booking-standards";
import { classifyBuilderVenueTrust } from "../events/_shared/builder-venue-trust";
import { actorManagesPlace } from "../events/_shared/venue-manager-stamp";
import type { PlaceAccessOwner } from "../events/_shared/place-access";
import { isClaimedPlace } from "./_shared/claim-eligibility";

// ─────────────────────────────────────────────────────────────────────────────
// What the place-page request dialog needs to build itself (venue-
// confirmation-and-booking-intents spec, docs/specs/2026-08-27 "UI / Flow:
// Place page"): which calendars exist, which intents each accepts, the rooms
// each calendar schedules into, the rental rate where the venue chose to show
// it, and whether the place is claimed. An UNCLAIMED place offers nothing
// (amendment 2026-09-25, venue-booking-standards FR-004 v1.1 / V8): no
// calendars, no standards, `acceptsBookingRequests: false`.
//
// PUBLIC READ (an authenticated viewer only adds `viewer`), and every field
// is chosen against the same rule as the availability read next door: it
// may state what the venue CONFIGURED for the public form, and nothing else.
//   · rentalRateCents / rentalRateCurrency → ONLY when `rentalRateVisible`;
//     otherwise both null (the flag is still returned so the dialog can say
//     "rate on request").
//   · rentalMode → NOT returned. INSTANT is reserved; what the dialog needs
//     is "can I send a RENT request here", which is folded into
//     `acceptsRent` below (INSTANT is mutually exclusive with rental
//     requests — same rule `createBookingRequest` enforces).
//   · spaces → ACTIVE only, id + name. A retired room is not on offer.
//   · isClaimed → `isClaimedPlace`, the exact predicate every request path
//     refuses on (PLACE_NOT_TAKING_REQUESTS). No owner identity leaves.
//   · calendars → ONLY those accepting at least one intent; a "do not book"
//     calendar's name and rooms are not enumerable publicly.
//   · acceptsBookingRequests → the CLAIMED venue's opt-out, so the dialog can
//     hide itself; always false when unclaimed.
//   · viewer.authority → the ONE viewer-dependent field (owner ruling
//     2026-09-08): the builder shows the intent / calendar / space controls
//     ("Play here / Rent a space / Use a space") ONLY to a true third party.
//     Owners and grant-holders see nothing new — their events are confirmed
//     by construction. The answer is computed for the OWNER the builder will
//     save under (see `owner` below) through the same classification the
//     save applies (`classifyBuilderVenueTrust`), so the read and the save
//     cannot disagree about who is a third party. "none" for an anonymous
//     viewer; nothing about the place's owner list leaves either way.
//   · standards → per calendar, per intent that calendar takes, the EFFECTIVE
//     booking standards + example pitches (venue-booking-standards spec,
//     FR-004), resolved server-side by the one loader the create gate uses.
//     Venue text is what the venue wrote FOR the public form. Never fails
//     the read: a storage failure degrades to the platform defaults
//     (reported).
//   · placeStandards → the same, resolved with NO calendar (place rows →
//     platform): what a request that routes to no calendar is held to, so
//     the dialog never shows less than the server enforces. Same single read.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who the event would be saved under. The BUILDER MUST PASS THE OWNER IT
 * WILL SAVE UNDER: `viewer.authority` is a statement about that owner, not
 * about the human. An org edit-role member asking as `{ kind: "org" }` at a
 * place that org owns is an owner; the same human asking as `{ kind: "human" }`
 * (creating the event as themselves) is a third party, exactly as the save
 * would classify each. Defaults to the acting human.
 */
export const placeBookingOptionsOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }).strict(),
  z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
]);

export const getPlaceBookingOptionsInputSchema = z
  .object({
    placeId: z.uuid(),
    /** The viewer. Absent = anonymous, and `viewer.authority` is "none". */
    actorHumanId: z.uuid().optional(),
    owner: placeBookingOptionsOwnerSchema.optional(),
  })
  .strict();

export type GetPlaceBookingOptionsInput = z.infer<
  typeof getPlaceBookingOptionsInputSchema
>;

export const placeBookingOptionCalendarSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    isDefault: z.boolean(),
    acceptsPerform: z.boolean(),
    /** `Calendar.acceptsRent` AND `rentalMode === "REQUEST"`. */
    acceptsRent: z.boolean(),
    acceptsUse: z.boolean(),
    /** Null unless the venue made the rate public. */
    rentalRateCents: z.number().int().nullable(),
    rentalRateCurrency: z.string().nullable(),
    rentalRateVisible: z.boolean(),
    spaces: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
    /**
     * FR-004: the effective standards + examples, keyed by the intents this
     * calendar takes (the folded flags above). Additive — a caller that
     * ignores it sees the pre-standards shape unchanged.
     */
    standards: effectiveBookingStandardsByIntentWireSchema,
  })
  .strict();

export const getPlaceBookingOptionsOutputSchema = z
  .object({
    placeId: z.uuid(),
    isClaimed: z.boolean(),
    /**
     * A CLAIMED venue's opt-out (`Place.acceptsBookingRequests`). Always
     * false for an unclaimed place: it takes no requests (amendment
     * 2026-09-25).
     */
    acceptsBookingRequests: z.boolean(),
    /** Default first, then name — the calendars repo's own order. */
    calendars: z.array(placeBookingOptionCalendarSchema),
    /**
     * FR-004 / FR-006, every intent: the effective standards resolved with NO
     * calendar — the place default (claimed venues only), else the platform
     * list. What the create gate holds a request to when it routes to no
     * calendar (a place without a default calendar, or an embed whose default
     * no longer takes PERFORM), and the venue-wide default a calendar with no
     * rows of its own inherits. EMPTY for an unclaimed place (it offers no
     * intent). Additive.
     */
    placeStandards: effectiveBookingStandardsByIntentWireSchema,
    viewer: z
      .object({
        /**
         * What the SAVE would make of an event this viewer creates at this
         * place under the given `owner`:
         *   · "owner" — the owner is one of the place's owners (a direct
         *     human owner, or an org the viewer holds an edit role in).
         *     Confirmed by construction.
         *   · "grant" — the owner (the viewer, or an org the viewer holds
         *     an edit role in) is the grantee of an active
         *     `PlaceBookingGrant` for the whole place. Confirmed by
         *     construction (stamped on save). `grant` reflects WHOLE-PLACE
         *     grants only (this read classifies with
         *     `calendarId: null`, before the builder has picked a calendar);
         *     a grantee scoped to one calendar reads as `none` here and sees
         *     the third-party controls, while the save classifies on the
         *     event's calendar and will honour the grant. Safe direction —
         *     this read never says `grant` where the save says third party.
         *     Calendar-aware scoping is deferred to the booking-agent identity spec (not yet written — see docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md, "Out of Scope").
         *   · "none"  — a third party (or anonymous). The builder shows the
         *     intent / calendar / space controls for exactly this case.
         */
        authority: z.enum(["owner", "grant", "none"]),
      })
      .strict(),
  })
  .strict();

export type GetPlaceBookingOptionsOutput = z.infer<
  typeof getPlaceBookingOptionsOutputSchema
>;

export type GetPlaceBookingOptionsDeps = {
  repos: Pick<
    Repos,
    "places" | "calendars" | "placeBookingGrants" | "authz" | "bookingStandards"
  >;
  /** Only consulted for an authenticated viewer (grant expiry). */
  now: () => Date;
  logger?: LoggerPort;
  /**
   * The standards read's degrade branch (ReporterPort convention): a failed
   * read serves the platform defaults instead of failing the dialog.
   */
  reportError?: ReporterPort;
  /**
   * `canManagePlace` — REQUIRED: the save stamps the venue confirmation for
   * a saver who MANAGES the place (place-address-withholding W1), so this
   * read must call that viewer the venue too, or the builder would show the
   * third-party controls for a save that asks nobody. Wire from `ctx.authz`.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
};

export async function getPlaceBookingOptions(
  deps: GetPlaceBookingOptionsDeps,
  rawInput: unknown,
): Promise<GetPlaceBookingOptionsOutput> {
  const input = parseInput(getPlaceBookingOptionsInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // Public gating mirrors `getPlacePublic`: an archived place has no page,
  // so it has no request dialog either.
  if (place.status === "ARCHIVED") {
    throw fail("PLACE_ARCHIVED");
  }

  // The one predicate every request path refuses on, so the dialog and the
  // gates cannot disagree. Unclaimed → nothing on offer (see the header).
  const isClaimed = isClaimedPlace(place);

  const calendars = await deps.repos.calendars.listByPlace(place.id);

  const authority = await resolveViewerAuthority(deps, place, input);

  const offered = calendars
    .map((calendar) => ({
      calendar,
      acceptsPerform: calendar.acceptsPerform,
      // Folded: INSTANT excludes rental REQUESTS (the create gate's rule).
      acceptsRent: calendar.acceptsRent && calendar.rentalMode === "REQUEST",
      acceptsUse: calendar.acceptsUse,
    }))
    // A calendar that accepts NO intent is not on offer, so neither its
    // name nor its rooms are enumerable from this public read. Nothing is
    // on offer at an unclaimed place.
    .filter(
      (c) => isClaimed && (c.acceptsPerform || c.acceptsRent || c.acceptsUse),
    );

  // FR-004: ONE storage read for the place + every offered calendar, then
  // resolved per (calendar, intent) — target 0 is the no-calendar
  // resolution (`placeStandards`). Never throws for storage — see the
  // loader's degrade contract.
  const standards = await loadEffectiveBookingStandards(
    {
      repos: deps.repos,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      place,
      targets: [
        {
          calendarId: null,
          intents: isClaimed ? ["PERFORM", "RENT", "USE"] : [],
        },
        ...offered.map((c) => ({
          calendarId: c.calendar.id,
          // The same folded rule as the flags above (one definition).
          intents: calendarRequestIntents(c.calendar),
        })),
      ],
    },
  );

  return getPlaceBookingOptionsOutputSchema.parse({
    placeId: place.id,
    isClaimed,
    acceptsBookingRequests: isClaimed && place.acceptsBookingRequests,
    viewer: { authority },
    placeStandards: toEffectiveBookingStandardsByIntentWire(
      standards.targets[0]!.byIntent,
    ),
    calendars: offered
      .map(({ calendar, acceptsPerform, acceptsRent, acceptsUse }, index) => ({
        id: calendar.id,
        name: calendar.name,
        isDefault: calendar.isDefault,
        acceptsPerform,
        acceptsRent,
        acceptsUse,
        // A rate is quoted only while the calendar actually takes rental
        // REQUESTS (the folded flag): a venue that turned Rent off, or moved
        // to INSTANT, keeps its stored rate (diff-not-put on the editor) but
        // must not keep advertising it here.
        rentalRateCents:
          calendar.rentalRateVisible && acceptsRent
            ? calendar.rentalRateCents
            : null,
        rentalRateCurrency:
          calendar.rentalRateVisible && acceptsRent
            ? calendar.rentalRateCurrency
            : null,
        rentalRateVisible: calendar.rentalRateVisible && acceptsRent,
        spaces: calendar.spaces
          .filter((space) => space.status === "ACTIVE")
          .map((space) => ({ id: space.id, name: space.name })),
        standards: toEffectiveBookingStandardsByIntentWire(
          // +1: target 0 is `placeStandards`.
          standards.targets[index + 1]!.byIntent,
        ),
      })),
  });
}

/**
 * `viewer.authority` — the save's own classification
 * (`classifyBuilderVenueTrust`, the rule behind `resolveBuilderVenueTrust`
 * in `save-event-shared.ts`) run for the owner the builder will save under.
 *
 * The org case carries the one gate the classifier deliberately leaves to
 * its caller: the save's org wrapper (`saveEventForOrg`) requires an
 * `ORG_EDIT_ROLES` membership before the trust rule runs, so a viewer who
 * could not save under the org at all is "none" here rather than borrowing
 * the org's ownership. A place-level question (calendar scope null): a
 * calendar-scoped grant does not make the viewer a grant-holder for the
 * place, and the builder picks its calendar after this read.
 */
async function resolveViewerAuthority(
  deps: GetPlaceBookingOptionsDeps,
  place: NonNullable<Awaited<ReturnType<Repos["places"]["getById"]>>>,
  input: GetPlaceBookingOptionsInput,
): Promise<GetPlaceBookingOptionsOutput["viewer"]["authority"]> {
  if (!input.actorHumanId) return "none";

  let owner: PlaceAccessOwner;
  if (input.owner?.kind === "org") {
    const membership = await deps.repos.authz.getOrgMembership({
      orgId: input.owner.orgId,
      humanId: input.actorHumanId,
    });
    if (!membership || !ORG_EDIT_ROLES.includes(membership.role)) {
      return "none";
    }
    owner = { kind: "org", orgId: input.owner.orgId };
  } else {
    owner = { kind: "human", humanId: input.actorHumanId };
  }

  const { trust } = await classifyBuilderVenueTrust(deps.repos, {
    place,
    owner,
    calendarId: null,
    now: deps.now(),
  });
  switch (trust) {
    case "venue_owned":
      return "owner";
    case "grant":
      return "grant";
    default:
      // W1: a viewer who MANAGES the place is the venue whatever owner they
      // save under — the save stamps the confirmation and asks nobody
      // (`save-event-shared` → `venue-manager-stamp`), so the builder must not
      // offer the third-party controls either.
      return (await actorManagesPlace(deps.authz, {
        actorHumanId: input.actorHumanId,
        placeId: place.id,
      }))
        ? "owner"
        : "none";
  }
}
