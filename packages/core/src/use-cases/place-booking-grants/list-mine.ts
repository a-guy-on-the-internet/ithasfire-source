import { z } from "zod";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES, ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  granteeGrantOutputSchema,
  toGranteeGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";
import { grantPartyOutputSchema, resolveGrantParties } from "./list-for-place";

// ─────────────────────────────────────────────────────────────────────────────
// listMyPlaceBookingGrants (holds-without-a-request FR-014, H23: the booker's
// nav item appears only with a grant, pending included so it can accept).
//
// The actor's grants AS GRANTEE, pending or active (not declined, revoked or
// expired; the repo's `listForGrantee`):
//   - grants to the actor as a person;
//   - grants to every org where the actor holds an EDIT role (H2: an org's
//     edit-role members act under its grant). VIEWER / SCANNER members see
//     nothing.
// Not a principal's grants through a delegation: a delegate acts under the
// person's grant at the place (the booker gate), but the list of a person's
// invitations is the person's own.
//
// `canRespond` says whether the actor may accept or decline a PENDING grant
// (respond.ts): the person for their own grant, an OWNER / ADMIN for an
// org's. An org EDITOR sees the org's pending grant but cannot answer it.
//
// Each row names the place (name + page slug) and the calendar the grant is
// scoped to, if any. Nothing about the place's other grants or holds.
// ─────────────────────────────────────────────────────────────────────────────

export const listMyPlaceBookingGrantsInputSchema = z
  .object({ actorHumanId: z.uuid() })
  .strict();

export const listMyPlaceBookingGrantsOutputSchema = z
  .object({
    grants: z.array(
      z
        .object({
          grant: granteeGrantOutputSchema,
          grantee: grantPartyOutputSchema,
          place: z
            .object({
              id: z.uuid(),
              name: z.string(),
              /** The place's page slug, when it has a PUBLIC page. */
              slug: z.string().nullable(),
            })
            .strict(),
          calendarName: z.string().nullable(),
          /** The actor may accept / decline this (pending) grant. */
          canRespond: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type ListMyPlaceBookingGrantsInput = z.infer<
  typeof listMyPlaceBookingGrantsInputSchema
>;
export type ListMyPlaceBookingGrantsOutput = z.infer<
  typeof listMyPlaceBookingGrantsOutputSchema
>;
export type ListMyPlaceBookingGrantsDeps = PlaceBookingGrantDeps;

export async function listMyPlaceBookingGrants(
  deps: ListMyPlaceBookingGrantsDeps,
  rawInput: unknown,
): Promise<ListMyPlaceBookingGrantsOutput> {
  const input = parseInput(listMyPlaceBookingGrantsInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  const memberships = (
    await repos.authz.listOrgMembershipsByHumanId({
      humanId: input.actorHumanId,
      roles: [...ORG_EDIT_ROLES],
    })
  ).filter((m) => ORG_EDIT_ROLES.includes(m.role));
  const adminOrgIds = new Set(
    memberships.filter((m) => ORG_ADMIN_ROLES.includes(m.role)).map((m) => m.orgId),
  );
  const editOrgIds = [...new Set(memberships.map((m) => m.orgId))];

  const grants = await repos.placeBookingGrants.listForGrantee({
    humanIds: [input.actorHumanId],
    orgIds: editOrgIds,
    now,
  });
  // The repo matches the sets; the use case re-checks so a wider read can
  // never leak another party's grant into this list.
  const mine = grants.filter((g) =>
    g.grantee.kind === "person"
      ? g.grantee.humanId === input.actorHumanId
      : editOrgIds.includes(g.grantee.orgId),
  );
  if (mine.length === 0) {
    return listMyPlaceBookingGrantsOutputSchema.parse({ grants: [] });
  }

  const placeIds = [...new Set(mine.map((g) => g.placeId))];
  const calendarIds = [
    ...new Set(mine.flatMap((g) => (g.calendarId ? [g.calendarId] : []))),
  ];
  const [places, placePages, calendars, partyOf] = await Promise.all([
    repos.places.getByIds(placeIds),
    repos.entityPages.getByOwners("PLACE", placeIds),
    Promise.all(calendarIds.map((id) => repos.calendars.findById(id))),
    resolveGrantParties(
      repos,
      mine.map((g) => g.grantee),
    ),
  ]);
  const placePage = new Map(placePages.map((p) => [p.ownerId, p]));
  const calendarName = new Map(
    calendars.flatMap((c) => (c ? [[c.id, c.name] as const] : [])),
  );

  return listMyPlaceBookingGrantsOutputSchema.parse({
    grants: mine.flatMap((g) => {
      const place = places.get(g.placeId);
      if (!place) return [];
      const output = toGranteeGrantOutput(g, now);
      const page = placePage.get(place.id);
      return [
        {
          grant: output,
          grantee: partyOf(g.grantee),
          place: {
            id: place.id,
            name: place.name,
            slug: page?.visibility === "PUBLIC" ? page.slug : null,
          },
          calendarName:
            g.calendarId === null ? null : (calendarName.get(g.calendarId) ?? null),
          canRespond:
            output.status === "pending" &&
            (g.grantee.kind === "person" || adminOrgIds.has(g.grantee.orgId)),
        },
      ];
    }),
  });
}
