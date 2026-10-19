import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { eventStewardshipSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import {
  requireOrgMembership,
  ORG_ADMIN_ROLES,
  ORG_ANY_ROLE,
  ORG_EDIT_ROLES,
} from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  actorHoldsEventEditRole,
  ensureActorHoldsHumanEventRole,
} from "../../lib/event-edit-rights";
import { COMMUNITY_MODERATION_ROLES } from "../community/_shared/suggestion-validation";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getEventTitleInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
  })
  .strict();

export const getEventTitleOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    title: z.string().nullable(),
    /**
     * Lifecycle status — same value `getEventForEdit` returns. Lets header /
     * rail surfaces (event-builder regroup FR-202) show the status chip
     * without fetching the full edit payload.
     */
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED", "CANCELLED", "COMPLETED"]),
    /**
     * Public slug, or null while the event has never been assigned one. Lets
     * the admin rail offer "View event" (`/events/{slug}`) without pulling the
     * whole `getEventForEdit` payload. Null is the normal pre-publish state,
     * not an error.
     */
    slug: z.string().nullable(),
    /**
     * `Event.stewardship` — OWNED (a human or org) or COMMUNITY (an ownerless
     * listing). Lets the admin rail drop surfaces a COMMUNITY listing does not
     * have (comp tickets, the order-backed door list, volunteers, private
     * feedback) on every event route, not only on `/edit`, where the builder
     * publishes it from `getEventForEdit`.
     */
    stewardship: eventStewardshipSchema,
    /**
     * The EVENT's owner — not the admin URL's. The event admin shell compares
     * it with the workspace in the URL: a delegate managing the principal's
     * personal event (owner ruling 2026-09-28) must get the principal's
     * pickers and a "Managing <name>'s event" banner. `ownerHumanName` is
     * only resolved when the viewer is NOT the human owner (a delegate); it
     * is null otherwise and for org events. All three are null for an
     * ownerless COMMUNITY listing.
     */
    ownerOrgId: z.string().nullable(),
    ownerHumanId: z.string().nullable(),
    ownerHumanName: z.string().nullable(),
    /**
     * The server's answer to "may this viewer edit the event?" — the same bar
     * as the builder's write paths (org ORG_EDIT_ROLES / owner or edit-role
     * delegate). The shell gates the edit UI on this, never on the URL.
     * A COMMUNITY listing: true for a community moderator, who authors it
     * through `community.updateListing` in the same builder.
     */
    viewerCanEdit: z.boolean(),
    /**
     * May this viewer take ADMIN-LEVEL actions — unpublish, cancel, regenerate
     * a PUBLISHED event's slug? ORG_ADMIN_ROLES on an org event; the owner or
     * an OWNER/ADMIN delegate on a personal one. The same bar as
     * `unpublish-event`, `cancel-event` and `regenerate-event-slug`, so the
     * builder never offers an action the server refuses (an EDITOR, org
     * member or delegate, can edit and publish but not take the event down).
     * Always false on a COMMUNITY listing: `unpublish-event` and
     * `regenerate-event-slug` refuse an ownerless row outright, and
     * `cancel-event` admits only a platform ADMIN as an FR-014 moderation
     * takedown, which the builder never offers.
     */
    viewerCanManage: z.boolean(),
    /**
     * PAYOUT ROUTING (splits, fee mode, payout schedule) — owner-only on a
     * human-owned event (`ensurePayoutRoutingActor`); an org event keeps its
     * org arm (edit roles). Always false on a COMMUNITY listing: it carries
     * no payouts.
     */
    viewerCanManagePayouts: z.boolean(),
  })
  .strict();

export type GetEventTitleInput = z.infer<typeof getEventTitleInputSchema>;
export type GetEventTitleOutput = z.infer<typeof getEventTitleOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetEventTitleDeps = {
  repos: Pick<Repos, "events" | "authz" | "humans">;
  /**
   * REQUIRED, not optional: it is the only thing that lets a community
   * moderator read an ownerless COMMUNITY listing's meta (and so open the
   * builder, whose shell always runs this query). An optional dep would be
   * an authz decision made by omission. Same reasoning as `getEventForEdit`.
   */
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight single-event title + status + public-slug fetch, with an
 * ownership check. An ownerless COMMUNITY listing is readable by platform
 * staff holding COMMUNITY_MODERATION_ROLES — the same arm as
 * `getEventForEdit` and `_shared/ensure-owner-or-community-moderator.ts`.
 *
 * Use this instead of `listMyEvents` when you only need one event's title
 * (e.g. page headers on attendees / applications pages), or `getEventForEdit`
 * when only the status is needed alongside it (admin rail chip/gating).
 */
export async function getEventTitle(
  deps: GetEventTitleDeps,
  rawInput: unknown,
): Promise<GetEventTitleOutput> {
  const input = parseInput(getEventTitleInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // COMMUNITY listings are ownerless (orgId AND humanId null by DB
  // constraint), so the owner arms below can never hold for one. The
  // moderator arm mirrors `getEventForEdit` / `ensureOwnerOrCommunityModerator`:
  // same role constant, same refusal for everyone else — `NOT_RESOURCE_OWNER`
  // with `meta.entity`, byte-identical to what a non-moderator got before
  // this arm existed. READ ONLY: it does not widen `canEditEvent` /
  // `ensureActorCanEditEvent`, which front owned-event write surfaces.
  if (event.stewardship === "COMMUNITY") {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId: input.actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    if (!staff.allowed) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
    }
    return getEventTitleOutputSchema.parse({
      eventId: event.id,
      title: event.title ?? null,
      status: event.status,
      slug: event.slug ?? null,
      stewardship: event.stewardship,
      ownerOrgId: null,
      ownerHumanId: null,
      ownerHumanName: null,
      // Moderators author community listings (`community.updateListing`).
      viewerCanEdit: true,
      // Least privilege: no unpublish / cancel / slug-regenerate from the
      // builder. See the output schema.
      viewerCanManage: false,
      viewerCanManagePayouts: false,
    });
  }

  // Ownership / membership check
  let viewerCanEdit: boolean;
  let viewerCanManage: boolean;
  let viewerCanManagePayouts: boolean;
  let ownerHumanName: string | null = null;
  if (event.orgId) {
    const membership = await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
      errorCode: "INSUFFICIENT_ROLE",
    });
    viewerCanEdit = ORG_EDIT_ROLES.includes(membership.role);
    viewerCanManage = ORG_ADMIN_ROLES.includes(membership.role);
    viewerCanManagePayouts = viewerCanEdit;
  } else {
    // Same role set as the org arm above (any role): a delegate gets exactly
    // what an org member with that role would.
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      input.actorHumanId,
      ORG_ANY_ROLE,
    );
    const isOwner = event.humanId === input.actorHumanId;
    viewerCanEdit =
      isOwner ||
      (await actorHoldsEventEditRole(
        deps.repos.authz,
        { orgId: null, humanId: event.humanId },
        input.actorHumanId,
      ));
    // The narrower role set the takedown use cases pass to the same helper.
    viewerCanManage =
      isOwner ||
      (await actorHoldsEventEditRole(
        deps.repos.authz,
        { orgId: null, humanId: event.humanId },
        input.actorHumanId,
        ORG_ADMIN_ROLES,
      ));
    viewerCanManagePayouts = isOwner;
    if (!isOwner && event.humanId) {
      const owner = await deps.repos.humans.getById(event.humanId);
      ownerHumanName = owner?.name ?? null;
    }
  }

  return getEventTitleOutputSchema.parse({
    eventId: event.id,
    title: event.title ?? null,
    status: event.status,
    slug: event.slug ?? null,
    stewardship: event.stewardship,
    ownerOrgId: event.orgId ?? null,
    ownerHumanId: event.orgId ? null : (event.humanId ?? null),
    ownerHumanName,
    viewerCanEdit,
    viewerCanManage,
    viewerCanManagePayouts,
  });
}
