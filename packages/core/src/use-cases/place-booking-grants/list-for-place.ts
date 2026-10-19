import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { PlaceBookingGrantRecord } from "@th/ports/repos/place-booking-grants";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES } from "../../lib/rbac";
import { requirePlaceBookingAuthority } from "../booking-requests/_shared/place-access";
import {
  placeBookingGrantOutputSchema,
  requireGrantPlace,
  toPlaceBookingGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";

// ─────────────────────────────────────────────────────────────────────────────
// listPlaceBookingGrantsForPlace (holds-without-a-request FR-003, H23: the
// "Outside bookers" section in place settings and the place's tab).
//
// WHO READS: place staff, the STAFF gate (`requirePlaceBookingAuthority`:
// direct owner or an owning-org edit-role member). Editors see who the
// outside bookers are (their holds already sit on the calendar editors work
// from), but only managers act: `canManage` (direct owner or OWNER / ADMIN,
// H4) tells the page whether to show give / edit / revoke, and the write
// use cases refuse editors themselves. A grantee is not staff and is
// refused (NOT_RESOURCE_OWNER).
//
// Each row carries the grantee's public name and page slug (for the link)
// and the calendar's name. A grantee's name comes from its entity page,
// falling back to the org's name; a person with no public page has no name
// here (`name: null`), so the list never reveals a name the person has not
// published. `slug` is set only for a PUBLIC page.
// ─────────────────────────────────────────────────────────────────────────────

export const listPlaceBookingGrantsForPlaceInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    placeId: z.uuid(),
    /** Include revoked and declined grants (history). Default false. */
    includeEnded: z.boolean().optional(),
  })
  .strict();

export const grantPartyOutputSchema = z
  .object({
    kind: z.enum(["org", "person"]),
    id: z.uuid(),
    name: z.string().nullable(),
    /** The public page's slug, when the page is PUBLIC. */
    slug: z.string().nullable(),
  })
  .strict();

export const listPlaceBookingGrantsForPlaceOutputSchema = z
  .object({
    /** Direct owner or owning-org OWNER / ADMIN: may give, edit, revoke (H4). */
    canManage: z.boolean(),
    grants: z.array(
      z
        .object({
          grant: placeBookingGrantOutputSchema,
          grantee: grantPartyOutputSchema,
          calendarName: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListPlaceBookingGrantsForPlaceInput = z.infer<
  typeof listPlaceBookingGrantsForPlaceInputSchema
>;
export type ListPlaceBookingGrantsForPlaceOutput = z.infer<
  typeof listPlaceBookingGrantsForPlaceOutputSchema
>;
export type GrantPartyOutput = z.infer<typeof grantPartyOutputSchema>;
export type ListPlaceBookingGrantsForPlaceDeps = PlaceBookingGrantDeps;

/**
 * The public face of each grantee: page display name (else the org's name),
 * and the slug of a PUBLIC page. Two page reads and one org read, batched.
 */
export async function resolveGrantParties(
  repos: Pick<Repos, "entityPages" | "organizations">,
  grantees: readonly PlaceBookingGrantRecord["grantee"][],
): Promise<(grantee: PlaceBookingGrantRecord["grantee"]) => GrantPartyOutput> {
  const orgIds = [
    ...new Set(grantees.flatMap((g) => (g.kind === "org" ? [g.orgId] : []))),
  ];
  const humanIds = [
    ...new Set(grantees.flatMap((g) => (g.kind === "person" ? [g.humanId] : []))),
  ];
  const [orgPages, humanPages, orgs] = await Promise.all([
    orgIds.length > 0
      ? repos.entityPages.getByOwners("ORGANIZATION", orgIds)
      : Promise.resolve([]),
    humanIds.length > 0
      ? repos.entityPages.getByOwners("HUMAN", humanIds)
      : Promise.resolve([]),
    orgIds.length > 0 ? repos.organizations.getByIds(orgIds) : Promise.resolve([]),
  ]);
  const orgPage = new Map(orgPages.map((p) => [p.ownerId, p]));
  const humanPage = new Map(humanPages.map((p) => [p.ownerId, p]));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  return (grantee) => {
    if (grantee.kind === "org") {
      const page = orgPage.get(grantee.orgId);
      return {
        kind: "org",
        id: grantee.orgId,
        // A PRIVATE page's name is not published: fall back to the org's.
        name:
          (page && page.visibility !== "PRIVATE" ? page.displayName : null) ??
          orgName.get(grantee.orgId) ??
          null,
        slug: page?.visibility === "PUBLIC" ? page.slug : null,
      };
    }
    const page = humanPage.get(grantee.humanId);
    const published = page !== undefined && page.visibility !== "PRIVATE";
    return {
      kind: "person",
      id: grantee.humanId,
      name: published ? (page.displayName ?? null) : null,
      slug: page?.visibility === "PUBLIC" ? page.slug : null,
    };
  };
}

export async function listPlaceBookingGrantsForPlace(
  deps: ListPlaceBookingGrantsForPlaceDeps,
  rawInput: unknown,
): Promise<ListPlaceBookingGrantsForPlaceOutput> {
  const input = parseInput(listPlaceBookingGrantsForPlaceInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  const place = await requireGrantPlace(repos, input.placeId);
  const staff = await requirePlaceBookingAuthority(
    repos,
    place,
    input.actorHumanId,
  );
  const canManage =
    staff.via === "human" ||
    (staff.orgRole !== null && ORG_ADMIN_ROLES.includes(staff.orgRole)) ||
    // The staff gate answers with the FIRST edit-role membership; an actor
    // who is EDITOR of one owning org and ADMIN of another still manages.
    (
      await repos.authz.getOrgMemberships({
        orgIds: [...place.orgIdsWithAccess],
        humanId: input.actorHumanId,
      })
    ).some((m) => ORG_ADMIN_ROLES.includes(m.role));

  const [grants, calendars] = await Promise.all([
    repos.placeBookingGrants.listForPlace({
      placeId: place.id,
      includeEnded: input.includeEnded ?? false,
    }),
    repos.calendars.listByPlace(place.id),
  ]);
  const partyOf = await resolveGrantParties(
    repos,
    grants.map((g) => g.grantee),
  );
  const calendarName = new Map(calendars.map((c) => [c.id, c.name]));

  return listPlaceBookingGrantsForPlaceOutputSchema.parse({
    canManage,
    grants: grants
      .filter((g) => g.placeId === place.id)
      .map((g) => ({
        grant: toPlaceBookingGrantOutput(g, now),
        grantee: partyOf(g.grantee),
        calendarName:
          g.calendarId === null ? null : (calendarName.get(g.calendarId) ?? null),
      })),
  });
}
