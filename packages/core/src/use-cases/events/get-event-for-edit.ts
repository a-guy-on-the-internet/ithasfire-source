import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  PlaceStatus,
  PlaceVerificationStatus,
  Repos,
} from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { projectEventLocationAtPlace } from "../../lib/location/place-event-location";
import {
  placeWithholdsAddress,
  redactPlaceLocation,
} from "../../lib/location/redact-place-location";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { COMMUNITY_MODERATION_ROLES } from "../community/_shared/suggestion-validation";
import { countEventTicketsSold } from "../ticket-types/_shared/ticket-sales-lock";
import { eventStewardshipSchema } from "@th/schema";
import { fail } from "@th/errors";
import { categoryNames, type CategoryNames } from "@th/types";
import { categoryNamesSchema } from "../categories/_shared/category-output";

const PLACE_STATUS_VALUES = [
  "ACTIVE",
  "SUSPENDED",
  "ARCHIVED",
] as const satisfies readonly PlaceStatus[];
const PLACE_VERIFICATION_STATUS_VALUES = [
  "UNVERIFIED",
  "VERIFIED",
  "PENDING",
  "REJECTED",
] as const satisfies readonly PlaceVerificationStatus[];

export const getEventForEditInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const getEventForEditOutputSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid().nullable(),
    humanId: z.string().uuid().nullable(),
    title: z.string(),
    /**
     * OWNED vs COMMUNITY. On the wire because the editor BRANCHES on it: the
     * builder's community mode (no tickets, no seating, no payout, no access
     * gate — an ownerless listing has none of those) is selected from this
     * field, not from a route prop, so a deep link straight to `/edit` picks
     * the right surface instead of rendering an owned-event form whose saves
     * would 4xx.
     *
     * Inferring it client-side from `orgId === null && humanId === null` was
     * the alternative and is wrong: that is also true of an ORPHANED `OWNED`
     * row (a deleted human), which must NOT get the community editor. The
     * column exists; ship the column.
     */
    stewardship: eventStewardshipSchema,
    status: z.enum([
      "DRAFT",
      "PUBLISHED",
      "ARCHIVED",
      "CANCELLED",
      "COMPLETED",
    ]),
    visibility: z.enum(["PUBLIC", "PRIVATE"]),
    gateType: z.enum(["NONE", "APPLICATION", "PASSWORD"]),
    startsAt: z.date(),
    endsAt: z.date().nullable(),
    placeId: z.string().uuid().nullable(),
    /** Lightweight place summary, present when `placeId` is set. */
    place: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        formattedAddress: z.string().nullable(),
        city: z.string().nullable(),
        region: z.string().nullable(),
        lat: z.number().nullable(),
        lng: z.number().nullable(),
        status: z.enum(PLACE_STATUS_VALUES),
        verificationStatus: z.enum(PLACE_VERIFICATION_STATUS_VALUES),
      })
      .nullable(),
    addressText: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    locality: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().nullable(),
    postalCode: z.string().nullable(),
    heroImageUrl: z.string().nullable(),
    /** Raw event body content (EventBody JSON). Null if never set. */
    content: z.unknown().nullable(),
    slug: z.string().nullable(),
    shortId: z.string().nullable(),
    publishedAt: z.date().nullable(),
    locationMode: z.enum(["EXACT", "OBSCURED"]),
    /** Obfuscation radius under OBSCURED; null = fully hidden (no public map). */
    locationRadiusMeters: z.number().int().nullable(),
    locationLabel: z.string().nullable(),
    addressRevealAt: z.date().nullable(),
    addressRevealPreset: z
      .enum([
        "IMMEDIATELY",
        "ONE_HOUR_BEFORE",
        "DAY_BEFORE",
        "WEEK_BEFORE",
        "CUSTOM",
        // "Never reveal, to anyone." Pairs with a NULL `addressRevealAt`,
        // deliberately — see `AddressRevealPreset`.
        "NEVER",
      ])
      .nullable(),
    timezone: z.string(),
    /** Total tickets sold across all ticket types. Used to lock the ticket editor. */
    ticketsSold: z.number().int(),
    /** Place layout UUID when the event has an assigned seating layout. */
    placeLayoutId: z.string().uuid().nullable(),
    /**
     * Venue-hierarchy placement as STORED on the event row (FR-005/FR-011):
     * the named Calendar (programming stream) the event shows on and the
     * physical Space it blocks. Required-nullable, never derived: the editor
     * must hydrate the persisted placement so a re-save round-trips it
     * instead of rewriting `spaceId` to null from a computed default.
     */
    calendarId: z.string().uuid().nullable(),
    spaceId: z.string().uuid().nullable(),
    /** ISO 4217 currency code stamped at publish time from the organizer's Stripe Connect account. */
    currency: z.string().nullable(),
    /** Category UUID assigned to the event. Null if no category set yet. */
    categoryId: z.string().uuid().nullable(),
    /**
     * Category summary joined via `categoryId`. Resolved with an
     * includes-inactive lookup so the editor can still display the current
     * selection when its category has since been deactivated (the public
     * `categories.list` endpoint only returns active rows). Null when no
     * category is set or the row was hard-deleted. `names` carries every
     * language, like every other category output, so the editor shows an
     * inactive category in the organiser's language too.
     */
    category: z
      .object({
        id: z.string().uuid(),
        slug: z.string(),
        name: z.string(),
        names: categoryNamesSchema,
        active: z.boolean(),
      })
      .nullable(),
    /** Deadline for self-serve refund requests. Null defaults to event start. */
    refundCutoffAt: z.date().nullable(),
    /** Payout schedule for this event. Null if payout terms not yet configured. */
    payoutSchedule: z
      .enum([
        "ASAP",
        "WEEK_OF_EVENT",
        "ONE_WEEK_AFTER",
        "TWO_WEEKS_AFTER",
        "FOUR_WEEKS_AFTER",
      ])
      .nullable(),
    /** Waiver template UUID assigned to this event. Null if no waiver required. */
    waiverTemplateId: z.string().uuid().nullable(),
    /** Whether volunteering is enabled for this event. */
    volunteeringEnabled: z.boolean(),
    /** Event-level default for auto-approve of volunteer signups. */
    volunteerAutoApprove: z.boolean(),
    /** Whether volunteer signups require accepting the event's waiver. */
    volunteerWaiverRequired: z.boolean(),
    /** Optional intro text shown on the volunteer signup page. */
    volunteerIntroText: z.string().nullable(),
    /**
     * Organizer self-attestation that admission is for instruction only
     * (classes / lessons / courses / workshops). Drives the Tennessee
     * instruction-only admission-tax exemption. Read-only here; toggled via
     * events.updateSettings.
     */
    instructionalAdmission: z.boolean(),
    /** Series UUID when this event is an occurrence in a recurring series. Null for standalone events. */
    seriesId: z.string().uuid().nullable(),
    /** RRULE string from the series schedule (e.g. "FREQ=WEEKLY;BYDAY=MO,WE"). Null for non-series events. */
    seriesRrule: z.string().nullable(),
    /** ISO datetime marking the series end boundary. Null for non-series events. */
    seriesUntil: z.string().nullable(),
    /**
     * PAYOUT ROUTING — splits, fee mode, payout schedule — is owner-only on a
     * human-owned event (owner ruling 2026-09-28; `ensurePayoutRoutingActor`).
     * An edit-role delegate hydrates the builder but must not be offered
     * those controls. Org events: true (their org arm is the edit bar the
     * builder already required). COMMUNITY listings carry no payouts: false.
     */
    viewerCanManagePayouts: z.boolean(),
  })
  .strict();

export type GetEventForEditInput = z.infer<typeof getEventForEditInputSchema>;
export type GetEventForEditOutput = z.infer<typeof getEventForEditOutputSchema>;

export type GetEventForEditDeps = {
  repos: Repos;
  /**
   * REQUIRED, not optional, and that is the point: it is the only thing
   * standing between a community moderator and the builder, so a composition
   * root that forgot to wire it would silently lock every moderator out of
   * the authoring flow (or, read the other way, an optional dep is an authz
   * decision made by omission). One caller today — the tRPC procedure.
   */
  authz: Pick<AuthZPort, "hasStaffRole" | "canManagePlace">;
  logger?: LoggerPort;
};

export async function getEventForEdit(
  deps: GetEventForEditDeps,
  rawInput: unknown,
): Promise<GetEventForEditOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getEventForEdit" });

  const execute = async (): Promise<GetEventForEditOutput> => {
    const input = parseInput(getEventForEditInputSchema, rawInput);

    const event = await deps.repos.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    await ensureActorCanEdit(deps, event, input.actorHumanId);

    // Fetch structured body content separately (it's stored as JSONB and
    // the repo exposes a dedicated accessor).
    const body = await deps.repos.events.getContent({ eventId: event.id });

    // Resolve linked place (if any) so the EventBuilder can restore the
    // "My Places" selection in edit mode.
    let placeSummary: {
      id: string;
      name: string;
      formattedAddress: string | null;
      city: string | null;
      region: string | null;
      lat: number | null;
      lng: number | null;
      status: PlaceStatus;
      verificationStatus: PlaceVerificationStatus;
    } | null = null;
    // The event's OWN location columns, as they go on the wire. Replaced
    // below with the venue's public projection when the viewer may not see a
    // withheld venue's address.
    let eventLocation = {
      addressText: event.addressText,
      lat: event.lat ?? null,
      lng: event.lng ?? null,
      locality: event.locality ?? null,
      region: event.region ?? null,
      countryCode: event.countryCode ?? null,
      postalCode: event.postalCode ?? null,
    };

    if (event.placeId) {
      const place = await deps.repos.places.getById(event.placeId);
      if (place) {
        // ADDRESS PRIVACY. Editing an event AT a venue does not entitle the
        // organizer to that venue's address — a performer booked into
        // somebody's house is exactly the person this feature is hiding it
        // from, and the builder is a surface they legitimately reach.
        //
        // The bar is `canManagePlace` (D5): a verified direct owner, or
        // OWNER/ADMIN/EDITOR in an owning org. NOT any membership — a door
        // SCANNER of the venue's org cleared the old check. Everyone else gets
        // the same public projection the venue page shows, which is all the
        // builder needs: it restores the "My Places" SELECTION, keyed on `id`.
        // Probed only for a withheld place; an EXACT one is public anyway.
        const withheld = placeWithholdsAddress(place);
        const viewerCanManagePlace =
          withheld &&
          (
            await deps.authz.canManagePlace({
              actorHumanId: input.actorHumanId,
              placeId: place.id,
            })
          ).allowed;

        const location = redactPlaceLocation(place, {
          viewerCanSeeExact: viewerCanManagePlace,
        });

        // B3: the EVENT's own columns too. Since D1 an event at a withheld
        // venue already STORES only the public projection, so for a correctly
        // written row this is a no-op — it is re-derived here anyway so a row
        // written before the D1 backfill (or by a writer that bypassed the
        // adapter) still cannot hand a non-manager the street through the
        // builder. Same function the write path uses, so the two agree.
        if (withheld && !viewerCanManagePlace) {
          const projected = projectEventLocationAtPlace(place, {
            locationMode: event.locationMode,
            locationRadiusMeters: event.locationRadiusMeters ?? null,
          });
          eventLocation = {
            addressText: projected.columns.addressText,
            lat: projected.columns.lat,
            lng: projected.columns.lng,
            locality: projected.columns.locality,
            region: projected.columns.region,
            countryCode: projected.columns.countryCode,
            postalCode: projected.columns.postalCode,
          };
        }

        placeSummary = {
          id: place.id,
          name: place.name,
          formattedAddress: location.formattedAddress,
          city: location.city,
          region: location.region,
          lat: location.lat,
          lng: location.lng,
          status: place.status,
          verificationStatus: place.verificationStatus,
        };
      }
    }

    // Fetch ticket-sold count so the UI can lock the ticket editor when
    // tickets have already been purchased. Same count the server-side lock in
    // upsertTicketType / updateTicketType reads — see ticket-sales-lock.
    const ticketsSold = await countEventTicketsSold(deps.repos, event.id);

    // Resolve the assigned category (if any). Uses getById — which does NOT
    // filter on `active` — so a deactivated category still resolves and the
    // editor can show the current selection instead of a blank field.
    let categorySummary: {
      id: string;
      slug: string;
      name: string;
      names: CategoryNames;
      active: boolean;
    } | null = null;
    if (event.categoryId) {
      const category = await deps.repos.categories.getById(event.categoryId);
      if (category) {
        categorySummary = {
          id: category.id,
          slug: category.slug,
          name: category.name,
          names: categoryNames(category),
          active: category.active,
        };
      }
    }

    // Resolve payout schedule from linked PayoutTerms (if any)
    let payoutSchedule: string | null = null;
    if (event.payoutTermsId && deps.repos.payoutTerms) {
      const terms = await deps.repos.payoutTerms.getById(event.payoutTermsId);
      if (terms) {
        payoutSchedule = terms.payoutSchedule;
      }
    }

    // Resolve series membership — check whether this event is an occurrence
    // in a recurring series so the EventBuilder can show the recurrence editor.
    let seriesId: string | null = null;
    let seriesRrule: string | null = null;
    let seriesUntil: string | null = null;

    const calendarInfos =
      await deps.repos.seriesOccurrences.getCalendarInfoForEventIds([event.id]);
    const seriesCalendarInfo = calendarInfos[0];
    if (seriesCalendarInfo) {
      seriesId = seriesCalendarInfo.seriesId;
      const series = await deps.repos.series.getById(
        seriesCalendarInfo.seriesId,
      );
      if (series) {
        const schedule = series.schedule as {
          kind: string;
          rrule?: string;
          until?: string;
        } | null;
        seriesRrule = schedule?.rrule ?? null;
        seriesUntil = schedule?.until ?? null;
      }
    }

    return getEventForEditOutputSchema.parse({
      id: event.id,
      orgId: event.orgId ?? null,
      humanId: event.humanId ?? null,
      title: event.title,
      stewardship: event.stewardship,
      status: event.status,
      visibility: event.visibility,
      gateType: event.gateType,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      placeId: event.placeId ?? null,
      place: placeSummary,
      ...eventLocation,
      heroImageUrl: event.heroImageUrl ?? null,
      content: body ?? null,
      slug: event.slug,
      shortId: event.shortId,
      publishedAt: event.publishedAt,
      locationMode: event.locationMode,
      locationRadiusMeters: event.locationRadiusMeters ?? null,
      locationLabel: event.locationLabel ?? null,
      addressRevealAt: event.addressRevealAt ?? null,
      addressRevealPreset: event.addressRevealPreset ?? null,
      timezone: event.timezone ?? "America/Chicago",
      ticketsSold,
      placeLayoutId: event.placeLayoutId ?? null,
      calendarId: event.calendarId ?? null,
      spaceId: event.spaceId ?? null,
      currency: event.currency ?? null,
      categoryId: event.categoryId ?? null,
      category: categorySummary,
      refundCutoffAt: event.refundCutoffAt ?? null,
      payoutSchedule,
      waiverTemplateId: event.waiverTemplateId ?? null,
      volunteeringEnabled: event.volunteeringEnabled ?? false,
      volunteerAutoApprove: event.volunteerAutoApprove ?? false,
      volunteerWaiverRequired: event.volunteerWaiverRequired ?? false,
      volunteerIntroText: event.volunteerIntroText ?? null,
      instructionalAdmission: event.instructionalAdmission ?? false,
      seriesId,
      seriesRrule,
      seriesUntil,
      viewerCanManagePayouts:
        event.stewardship !== "COMMUNITY" &&
        (Boolean(event.orgId) || event.humanId === input.actorHumanId),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getEventForEdit", execute);
  }

  return execute();
}

async function ensureActorCanEdit(
  deps: GetEventForEditDeps,
  event: EventRecord,
  actorHumanId: string,
): Promise<void> {
  // COMMUNITY listings are ownerless, so the owner arms below can never hold
  // for one and this used to be a flat refusal. It is now a MODERATOR branch:
  // community listings are authored in this same builder, and the builder
  // hydrates through here.
  //
  // The gate is the same one `community.createListing` / `publishListing` /
  // `updateListing` use — COMMUNITY_MODERATION_ROLES, imported rather than
  // re-listed so the four can never drift apart. `requirePlatformStaff`'s
  // probe is inlined instead of called only so the refusal for everyone else
  // stays BYTE-IDENTICAL to what it has always been (`NOT_RESOURCE_OWNER`
  // with `meta.entity`, not `STAFF_ONLY`): an org member or a signed-in
  // stranger must not be able to tell that this branch was added.
  //
  // READ ONLY. The WRITE side deliberately did NOT open with it:
  // `_shared/ensure-actor-can-edit-event.ts` still refuses every COMMUNITY
  // row, because it gates a dozen owned-event surfaces (settings, access
  // controls, application forms, listing priority, provenance) that an
  // ownerless RSVP listing has no business carrying. Community field saves go
  // through `community.updateListing`, which is whitelist-bound and
  // DRAFT-only. Hydration is a read; do not read this branch as permission to
  // widen that one.
  if (event.stewardship === "COMMUNITY") {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    if (!staff.allowed) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
    }
    return;
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }

  // Human-owned: the owner or an OWNER/ADMIN/EDITOR delegate — delegates get
  // the builder (owner ruling 2026-09-28; see `lib/event-edit-rights.ts`).
  await ensureActorHoldsHumanEventRole(
    deps.repos.authz,
    event.humanId,
    actorHumanId,
  );
}
