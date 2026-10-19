import type { AuthZRepo, OrgRole } from "@th/ports/repos/authz";
import type { CalendarsRepo } from "@th/ports/repos/calendars";
import type { HumanDelegatesRepo } from "@th/ports/repos/human-delegates";
import type {
  PlaceBookingGrantee,
  PlaceBookingGrantRecord,
  PlaceBookingGrantsRepo,
} from "@th/ports/repos/place-booking-grants";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { ORG_EDIT_ROLES } from "../../../lib/rbac";

export type PlaceOwnershipResult = {
  /** How the actor got access. */
  via: "human" | "org";
  /** The owning org granting access (first matching membership), if `via === "org"`. */
  orgId: string | null;
  /** The actor's role in that org, if `via === "org"`. */
  orgRole: OrgRole | null;
};

export type RequirePlaceOwnershipOptions = {
  /**
   * When access comes via an owning-org membership, require one of these
   * roles. Omit for membership-any (inbox viewing / VIEWED stamping).
   * Money-adjacent actions (respond → Agreement + cloned PayoutTerms) must
   * pass `ORG_EDIT_ROLES`. Direct human owners are never role-gated.
   */
  requiredOrgRoles?: readonly OrgRole[];
};

/**
 * The owner/staff resolution both gates below share, WITHOUT throwing: a
 * direct human owner (never role-gated) → an owning-org member holding one
 * of `requiredOrgRoles` (any role when omitted) → else which denial applies.
 *
 * `insufficient_role` means the actor IS a member of an owning org but holds
 * none of the required roles; `not_owner` means no access at all. The two
 * are kept apart because the error code a caller sees must not change
 * depending on which gate it went through.
 */
async function resolvePlaceOwnership(
  repos: { authz: Pick<AuthZRepo, "getOrgMemberships"> },
  place: Pick<PlaceRecord, "humanIdsWithAccess" | "orgIdsWithAccess">,
  actorHumanId: string,
  options: RequirePlaceOwnershipOptions,
): Promise<
  | { ok: true; result: PlaceOwnershipResult }
  | { ok: false; denial: "insufficient_role" | "not_owner" }
> {
  if (place.humanIdsWithAccess.includes(actorHumanId)) {
    return { ok: true, result: { via: "human", orgId: null, orgRole: null } };
  }

  if (place.orgIdsWithAccess.length > 0) {
    const memberships = await repos.authz.getOrgMemberships({
      orgIds: place.orgIdsWithAccess,
      humanId: actorHumanId,
    });
    if (memberships.length > 0) {
      const allowed = options.requiredOrgRoles
        ? memberships.find((m) => options.requiredOrgRoles!.includes(m.role))
        : memberships[0];
      if (!allowed) {
        return { ok: false, denial: "insufficient_role" };
      }
      return {
        ok: true,
        result: { via: "org", orgId: allowed.orgId, orgRole: allowed.role },
      };
    }
  }

  return { ok: false, denial: "not_owner" };
}

function throwDenial(denial: "insufficient_role" | "not_owner"): never {
  if (denial === "insufficient_role") {
    throw fail("INSUFFICIENT_ROLE");
  }
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
}

/**
 * Venue-owner check shared by the booking-request inbox use cases. Mirrors
 * `set-place-booking-acceptance`: the actor must be a direct human owner or a
 * member of an owning org. Deliberately does NOT gate on verification —
 * owners may always see/manage their inbox; only *receiving new* requests
 * requires a VERIFIED, opted-in place.
 *
 * STAFF ONLY. A booking-grant holder is NOT staff: this gate never consults
 * grants. Hold / confirm / withdraw sites use
 * {@link requirePlaceBookingAuthority} (edit roles, also staff-only).
 *
 * @throws `{ code: "NOT_RESOURCE_OWNER" }` when the actor has no access at all.
 * @throws `{ code: "INSUFFICIENT_ROLE" }` when the actor is an org member but
 *   lacks every role in `requiredOrgRoles`.
 */
export async function requirePlaceOwnership(
  repos: { authz: Pick<AuthZRepo, "getOrgMemberships"> },
  place: Pick<PlaceRecord, "humanIdsWithAccess" | "orgIdsWithAccess">,
  actorHumanId: string,
  options: RequirePlaceOwnershipOptions = {},
): Promise<PlaceOwnershipResult> {
  const resolved = await resolvePlaceOwnership(
    repos,
    place,
    actorHumanId,
    options,
  );
  if (!resolved.ok) throwDenial(resolved.denial);
  return resolved.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking authority, split in two (holds-without-a-request FR-002):
//   - the STAFF gate, `requirePlaceBookingAuthority`: owner / edit-role
//     member. Reorder, extend, release another's hold, confirm a request
//     hold, settle, cancel a booking, the agreement and accept mints, the
//     place's confirmation of someone else's event. A grantee never passes.
//   - the BOOKER gate, `requirePlaceBookerAuthority` / `findPlaceBookerGrant`:
//     an active PlaceBookingGrant, resolved through its grantee. Only the
//     booker actions the spec names (place / release / book its own holds,
//     challenge, its own event confirmed by construction) call it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The staff gate's result: the owner/edit-role resolution. There is no grant
 * arm (FR-002): a grantee is not staff.
 */
export type PlaceBookingAuthorityResult = PlaceOwnershipResult;

/**
 * The STAFF authority for booking actions on a place: the place's direct
 * human owner, or an owning-org member with an EDIT role
 * (`ORG_EDIT_ROLES`). Booking grants are NOT consulted: before FR-002 a
 * grant arm here let a grantee reorder, extend, release others' holds,
 * confirm, settle, cancel bookings and mint from agreements at the whole
 * place. Booker actions use {@link requirePlaceBookerAuthority}.
 *
 * @throws `{ code: "INSUFFICIENT_ROLE" }` for an owning-org member below
 *   edit level.
 * @throws `{ code: "NOT_RESOURCE_OWNER" }` for anyone else.
 */
export async function requirePlaceBookingAuthority(
  repos: { authz: Pick<AuthZRepo, "getOrgMemberships"> },
  place: Pick<PlaceRecord, "humanIdsWithAccess" | "orgIdsWithAccess">,
  actorHumanId: string,
): Promise<PlaceBookingAuthorityResult> {
  return requirePlaceOwnership(repos, place, actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });
}

/**
 * {@link requirePlaceBookingAuthority} without the throw: the staff
 * resolution, or null. For a gate that admits staff OR another party (the
 * challenge: staff or a booker, FR-006), so neither refusal is thrown before
 * the other arm is tried.
 */
export async function findPlaceBookingAuthority(
  repos: { authz: Pick<AuthZRepo, "getOrgMemberships"> },
  place: Pick<PlaceRecord, "humanIdsWithAccess" | "orgIdsWithAccess">,
  actorHumanId: string,
): Promise<PlaceBookingAuthorityResult | null> {
  const resolved = await resolvePlaceOwnership(repos, place, actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });
  return resolved.ok ? resolved.result : null;
}

/**
 * The booker gate's result: the active grant the actor acts under, and the
 * party the actor acts FOR (the grant's grantee: the org, or the person whose
 * delegate or self the actor is). Step 6 stamps a BOOKER hold's holder from
 * `holder`.
 */
export type PlaceBookerAuthorityResult = {
  via: "grant";
  grant: PlaceBookingGrantRecord;
  holder: PlaceBookingGrantee;
};

export type PlaceBookerAuthorityRepos = {
  authz: Pick<AuthZRepo, "listOrgMembershipsByHumanId">;
  humanDelegates: Pick<HumanDelegatesRepo, "listPrincipalsForDelegate">;
  placeBookingGrants: Pick<
    PlaceBookingGrantsRepo,
    "findActiveForActor" | "listActiveForActor"
  >;
  calendars: Pick<CalendarsRepo, "findById">;
};

export type PlaceBookerAuthorityOptions = {
  /**
   * The calendar being acted on. A whole-place grant covers every calendar;
   * a calendar-scoped grant covers only its own. Null / omitted = a
   * place-level action, which only a whole-place grant matches. A calendar
   * that is not the place's (or does not exist) matches nothing.
   */
  calendarId?: string | null;
  /** Grant activity is evaluated at this instant (the caller's clock). */
  now: Date;
  /**
   * The party the actor acts FOR. An actor can be covered by several
   * grants at one place (its own person grant, a principal's as delegate,
   * an org's as editor); without `as` the gate answers with the repo's
   * first match (whole-place, then oldest), which is not a choice of party.
   * A caller that stamps or compares a holder passes it: only grants whose
   * grantee IS `as` are considered, and an `as` the actor cannot act for
   * (not itself, not a principal that made it an edit-role delegate, not an
   * org where it holds an edit role) matches nothing.
   */
  as?: PlaceBookingGrantee;
};

/**
 * The grantee sets the actor may act for at `place` (H2), narrowed to
 * `options.as` when given; null when nothing can match (a foreign calendar,
 * or an `as` the actor cannot act for). Who acts under a grant:
 *  - a person grant: the person, and the person's delegates holding an edit
 *    role (`ORG_EDIT_ROLES`, the delegate bar `resolve-ask-ownership` uses);
 *  - an org grant: the org's members holding an edit role.
 * Two reads at most (memberships, the reverse delegation read), plus the
 * calendar when one is named; no scan of the place's grants.
 */
async function resolveBookerParties(
  repos: PlaceBookerAuthorityRepos,
  place: Pick<PlaceRecord, "id">,
  actorHumanId: string,
  options: PlaceBookerAuthorityOptions,
): Promise<{ humanIds: string[]; orgIds: string[] } | null> {
  if (options.calendarId) {
    const calendar = await repos.calendars.findById(options.calendarId);
    if (!calendar || calendar.placeId !== place.id) return null;
  }

  const editOrgIds = async (): Promise<string[]> => {
    const memberships = await repos.authz.listOrgMembershipsByHumanId({
      humanId: actorHumanId,
      roles: [...ORG_EDIT_ROLES],
    });
    return [
      ...new Set(
        memberships
          .filter((m) => ORG_EDIT_ROLES.includes(m.role))
          .map((m) => m.orgId),
      ),
    ];
  };
  const principalIds = (candidates?: readonly string[]) =>
    repos.humanDelegates.listPrincipalsForDelegate({
      delegateId: actorHumanId,
      roles: ORG_EDIT_ROLES,
      ...(candidates ? { principalIds: candidates } : {}),
    });

  const as = options.as;
  if (as) {
    if (!(await actorActsForParty(repos, actorHumanId, as))) return null;
    return as.kind === "org"
      ? { humanIds: [], orgIds: [as.orgId] }
      : { humanIds: [as.humanId], orgIds: [] };
  }

  const [orgIds, principals] = await Promise.all([editOrgIds(), principalIds()]);
  return {
    humanIds: [
      actorHumanId,
      ...new Set(principals.filter((id) => id !== actorHumanId)),
    ],
    orgIds,
  };
}

/**
 * May the actor act FOR this party (H2's rule, with no grant involved)?
 *  - a person: the person, or one of their delegates holding an edit role
 *    (`ORG_EDIT_ROLES`, the delegate bar `resolve-ask-ownership` uses);
 *  - an org: a member holding an edit role.
 * The booker gate's `as` narrowing reads it, and so does the named party of
 * a place hold (FR-007: the person, their delegates, or an edit-role member
 * of the named org may pass). One read at most.
 */
export async function actorActsForParty(
  repos: Pick<PlaceBookerAuthorityRepos, "authz" | "humanDelegates">,
  actorHumanId: string,
  party: PlaceBookingGrantee,
): Promise<boolean> {
  if (party.kind === "org") {
    const memberships = await repos.authz.listOrgMembershipsByHumanId({
      humanId: actorHumanId,
      roles: [...ORG_EDIT_ROLES],
    });
    return memberships.some(
      (m) => m.orgId === party.orgId && ORG_EDIT_ROLES.includes(m.role),
    );
  }
  if (party.humanId === actorHumanId) return true;
  const principals = await repos.humanDelegates.listPrincipalsForDelegate({
    delegateId: actorHumanId,
    roles: ORG_EDIT_ROLES,
    principalIds: [party.humanId],
  });
  return principals.includes(party.humanId);
}

/**
 * {@link requirePlaceBookerAuthority} without the throw: the active grant at
 * the place, in scope for `calendarId`, under which the actor may act (for
 * `options.as` when given), or null. Who acts under a grant: see
 * {@link resolveBookerParties}. Active (accepted, not declined, not
 * revoked, not expired) and scope are the repo's match, never re-derived
 * here.
 *
 * Staff do NOT pass by being staff: this reads grants only. A staff member
 * who is also covered by a grant passes as that grantee.
 */
export async function findPlaceBookerGrant(
  repos: PlaceBookerAuthorityRepos,
  place: Pick<PlaceRecord, "id">,
  actorHumanId: string,
  options: PlaceBookerAuthorityOptions,
): Promise<PlaceBookerAuthorityResult | null> {
  const parties = await resolveBookerParties(repos, place, actorHumanId, options);
  if (!parties) return null;
  const grant = await repos.placeBookingGrants.findActiveForActor({
    placeId: place.id,
    calendarId: options.calendarId ?? null,
    ...parties,
    now: options.now,
  });
  if (!grant || grant.placeId !== place.id) return null;
  return { via: "grant", grant, holder: grant.grantee };
}

/**
 * EVERY active grant at the place, in scope for `calendarId`, under which
 * the actor may act (narrowed to `options.as` when given), in the repo's
 * order (whole-place first, then oldest). One entry per grant, so a grantee
 * with a whole-place and a calendar grant appears twice; `holder` names the
 * party each one acts for. For a caller that must match a hold's holder or
 * offer the actor a choice of party; [] when nothing covers the actor.
 */
export async function listPlaceBookerGrants(
  repos: PlaceBookerAuthorityRepos,
  place: Pick<PlaceRecord, "id">,
  actorHumanId: string,
  options: PlaceBookerAuthorityOptions,
): Promise<PlaceBookerAuthorityResult[]> {
  const parties = await resolveBookerParties(repos, place, actorHumanId, options);
  if (!parties) return [];
  const grants = await repos.placeBookingGrants.listActiveForActor({
    placeId: place.id,
    calendarId: options.calendarId ?? null,
    ...parties,
    now: options.now,
  });
  return grants
    .filter((grant) => grant.placeId === place.id)
    .map(
      (grant): PlaceBookerAuthorityResult => ({
        via: "grant",
        grant,
        holder: grant.grantee,
      }),
    );
}

/**
 * The BOOKER gate (FR-002): an active booking grant at the place covering
 * `calendarId`, resolved through its grantee (see
 * {@link findPlaceBookerGrant}). Only the booker actions call it: place,
 * release and book its OWN holds, challenge, and its own event confirmed by
 * construction. Never a stand-in for {@link requirePlaceBookingAuthority}.
 *
 * @throws `{ code: "NOT_RESOURCE_OWNER" }` when no active grant covers the
 *   actor (pending, declined, revoked, expired, another calendar's, another
 *   place's, a calendar of another place, an org member below edit role,
 *   or an `as` the actor cannot act for).
 */
export async function requirePlaceBookerAuthority(
  repos: PlaceBookerAuthorityRepos,
  place: Pick<PlaceRecord, "id">,
  actorHumanId: string,
  options: PlaceBookerAuthorityOptions,
): Promise<PlaceBookerAuthorityResult> {
  const found = await findPlaceBookerGrant(repos, place, actorHumanId, options);
  if (!found) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }
  return found;
}
