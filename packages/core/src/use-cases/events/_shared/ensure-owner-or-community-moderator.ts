import type { AuthZPort } from "@th/ports/authz";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import {
  ensureActorHoldsHumanEventRole,
  type EventEditRightsAuthz,
} from "../../../lib/event-edit-rights";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../../lib/rbac";
import { COMMUNITY_MODERATION_ROLES } from "../../community/_shared/suggestion-validation";

/**
 * Only the fields the guard reads. Narrow on purpose so a caller holding a
 * partial row (or a tx-scoped projection) can still use it.
 */
export type EventOwnershipFacts = Pick<
  EventRecord,
  "orgId" | "humanId" | "stewardship"
>;

export type OwnerOrCommunityModeratorDeps = {
  /**
   * Org-membership lookup handle. Pass the full `Repos` from a read use case
   * and the `TxRepos` from inside a `repos.tx(...)`, exactly as
   * `requireOrgMembership` has always been called.
   */
  repos: { authz: EventEditRightsAuthz };
  /**
   * REQUIRED, not optional, and that is the point — it is the only thing
   * standing between a community moderator and the builder's lineup/tags
   * editors. An optional dep would be an authz decision made by omission: a
   * composition root that forgot to wire it would silently lock every
   * moderator out with no signal. Same reasoning, and same wording, as
   * `getEventForEdit`.
   */
  authz: Pick<AuthZPort, "hasStaffRole">;
};

/**
 * The event-editor gate for the builder surfaces that a COMMUNITY listing
 * shares with a ticketed one: LINEUP (`event-humans/*`) and TAGS
 * (`tags/set-event-tags`).
 *
 * Three arms, in the order they are evaluated:
 *
 *  1. COMMUNITY  → platform staff holding {@link COMMUNITY_MODERATION_ROLES}.
 *  2. org-owned  → an {@link ORG_EDIT_ROLES} member of the owning org.
 *  3. human-owned→ the owner, or an OWNER/ADMIN/EDITOR delegate of the owner
 *                  (`ensureActorHoldsHumanEventRole`; owner ruling 2026-09-28).
 *
 * Arms 2 and 3 are lifted VERBATIM from the five copies of
 * `ensureEventAccessible` this replaces, so the owned-event path — including
 * which error it throws and in what order — is unchanged. The whole point of
 * hoisting them into one function is that the community arm cannot drift
 * between the five call sites.
 *
 * ## Why the COMMUNITY arm exists
 *
 * Community listings are ownerless by DB constraint (`orgId` AND `humanId`
 * both null), so arms 2 and 3 can never hold for one and this used to be a
 * flat `NOT_RESOURCE_OWNER`. Those listings are now authored in the SAME
 * `EventBuilder` as ticketed events, so a moderator adding a lineup or tagging
 * a listing was hitting a refusal the builder had to hide the controls to
 * avoid. That is the same reasoning — and the same role constant, imported
 * rather than re-listed so the set can never fork — behind the branches in
 * `getEventForEdit` (hydration), `resolveEventAudio`,
 * `requestEventImageUpload` and `requestEventAudioUpload`.
 *
 * ## Why it is NOT status-gated
 *
 * Every status a moderator can reach the builder for is allowed. The
 * DRAFT-only rule on `community.updateListing` exists because a LIVE listing's
 * own fields are edited through the moderated suggestion queue instead — but
 * lineup and tags are not in `SUGGESTION_EDITABLE_FIELDS`, so a DRAFT-only
 * gate here would leave them permanently unchangeable the moment a listing
 * publishes, which is the opposite of parity. Callers that DO have a status
 * rule keep enforcing it themselves and for every actor alike:
 * `setEventTags` still refuses ARCHIVED / CANCELLED / COMPLETED via
 * `ensureEventAllowsTagMutation`, moderator or not.
 *
 * ## Why not widen `canEditEvent`
 *
 * `db-authz-adapter.canEditEvent` fronts a dozen owned-event write surfaces
 * (settings, access gates, application forms, payout terms) that an ownerless
 * RSVP listing has no business carrying. Same call `getEventForEdit` and
 * `resolveEventAudio` made, for the same reason: branch at the use case.
 *
 * ## Existence-oracle discipline
 *
 * A non-moderator gets `NOT_RESOURCE_OWNER` with `meta.entity = "event"` —
 * byte-identical to the refusal they got before this arm existed, so the
 * branch itself is not a signal. It is deliberately NOT collapsed to
 * `EVENT_NOT_FOUND`: these use cases have always answered `EVENT_NOT_FOUND`
 * for a missing id and `NOT_RESOURCE_OWNER` for an event you cannot touch, on
 * OWNED rows just as much as community ones, so the two outcomes were already
 * distinguishable and this change neither widens nor narrows that. Equalising
 * round-trips (the `requestEventImageUpload` / `resolveEventAudio` treatment)
 * only buys something where the two outcomes are OBSERVABLY IDENTICAL and
 * timing is the last remaining tell; here they are not, so a probe on the
 * missing-event path would cost every 404 an extra query and hide nothing.
 *
 * @throws `NOT_RESOURCE_OWNER` — community non-moderator, or human-owned
 *   event whose owner the actor is neither, nor an edit-role delegate of.
 * @throws `INSUFFICIENT_ROLE` — org-owned event, actor lacks an edit role.
 */
export async function ensureOwnerOrCommunityModerator(
  deps: OwnerOrCommunityModeratorDeps,
  event: EventOwnershipFacts,
  actorHumanId: string,
): Promise<void> {
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

  await ensureActorHoldsHumanEventRole(
    deps.repos.authz,
    event.humanId,
    actorHumanId,
  );
}
