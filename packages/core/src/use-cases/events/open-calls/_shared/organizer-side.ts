import { fail } from "@th/errors";
import type { TxRepos } from "@th/ports/repos";
import type { OpenCallFormRecord, OpenCallSubmissionRecord } from "@th/ports/repos/events";

import {
  actorHoldsEventEditRole,
  type EventEditRightsAuthz,
} from "../../../../lib/event-edit-rights";
import { ORG_EDIT_ROLES } from "../../../../lib/rbac";
import { loadOpenCallAnchor, type OpenCallAnchorContext } from "./open-call-anchor";

/**
 * WHO IS ON THE ORGANIZER SIDE of an open call (spec FR-014) — the one
 * implementation, and THE SINGLE SWAP POINT for the sides model (memory
 * project_event_two_sides_model: organizer / act / place as RBAC scopes).
 * When sides land, replace this body; every review use case (queue, open,
 * vote, note, thread) asks only this.
 *
 * Interim rule, owner ruling 2026-10-06 (FR-014 as amended, Q43): reviewing
 * applications needs event EDIT rights. This overrides the earlier "members
 * of the event's organisation (any role)" wording.
 *   - org-owned event / org series → an OrgMember of that org whose role is
 *     in ORG_EDIT_ROLES (OWNER / ADMIN / EDITOR). SCANNER, VIEWER and
 *     FINANCE members are out.
 *   - personal event / personal series → the owner, or a HumanDelegate of
 *     the owner whose role is in ORG_EDIT_ROLES. Other delegates are out.
 *   - ownerless (community listing) → nobody. Such an event cannot hold a
 *     call anyway: posting needs event edit rights, which ownerless rows
 *     never grant.
 *
 * Reuses `actorHoldsEventEditRole` (lib/event-edit-rights.ts), the house
 * owner-or-member-or-delegate check, with ORG_EDIT_ROLES passed explicitly;
 * it does not invent a delegate concept. A series call maps the series'
 * (ownerScope, ownerId) onto the same owner shape. It answers a boolean and
 * never reveals why, so the resolvers below can refuse with a not-found code.
 *
 * REVIEWING AND PICKING NOW SHARE THE SAME PEOPLE, BUT STAY TWO HELPERS.
 * Pick and "not this time" go through `resolveDecidableSubmission`, which
 * runs this check first and then `ensureActorCanEditOpenCallAnchor`
 * (`ensureActorCanEditEvent` / `ensureActorCanEditSeries`). The role sets
 * match; the differences are:
 *   - errors: this side refuses with OPEN_CALL_NOT_FOUND /
 *     OPEN_CALL_APPLICATION_NOT_FOUND (no existence leak); the edit guards
 *     throw INSUFFICIENT_ROLE (event, org series) or NOT_RESOURCE_OWNER
 *     (person's series), plus EVENT_NOT_FOUND / SERIES_NOT_FOUND /
 *     ORGANIZATION_NOT_FOUND / HUMAN_NOT_FOUND for missing rows;
 *   - the event guard names a COMMUNITY-stewardship event and the series
 *     guard a missing owner row explicitly; this check refuses both too
 *     (ownerless → nobody; no owner row → no membership).
 * So for pick/decline the second step is now defence in depth. Keep them
 * separate: when the sides model lands, reviewing may widen again while
 * picking stays an edit right.
 */
export async function isOnOrganizerSide(
  authz: EventEditRightsAuthz,
  anchor: OpenCallAnchorContext,
  humanId: string,
): Promise<boolean> {
  const owner =
    anchor.kind === "event"
      ? { orgId: anchor.event.orgId ?? null, humanId: anchor.event.humanId ?? null }
      : anchor.series.ownerScope === "ORGANIZATION"
        ? { orgId: anchor.series.ownerId, humanId: null }
        : anchor.series.ownerScope === "HUMAN"
          ? { orgId: null, humanId: anchor.series.ownerId }
          : { orgId: null, humanId: null }; // unknown scope: fail closed
  return actorHoldsEventEditRole(authz, owner, humanId, ORG_EDIT_ROLES);
}

type OrganizerRepos = Pick<TxRepos, "eventApplications" | "events" | "series" | "authz">;

export interface OrganizerCall {
  form: OpenCallFormRecord;
  anchor: OpenCallAnchorContext;
}

/**
 * The call, for someone on its organizer side. A missing call, a missing
 * anchor and a non-member all answer OPEN_CALL_NOT_FOUND, so a stranger
 * cannot tell a draft call (or any call's review queue) exists. The anchor
 * is resolved from the FORM, never from a client-supplied org or event id.
 */
export async function resolveOrganizerCall(
  repos: OrganizerRepos,
  formId: string,
  actorHumanId: string,
): Promise<OrganizerCall> {
  const form = await repos.eventApplications.getOpenCallById(formId);
  if (!form) throw fail("OPEN_CALL_NOT_FOUND");
  const anchor = await loadOpenCallAnchor(repos, form);
  if (!(await isOnOrganizerSide(repos.authz, anchor, actorHumanId))) {
    throw fail("OPEN_CALL_NOT_FOUND");
  }
  return { form, anchor };
}

export interface OrganizerSubmission extends OrganizerCall {
  submission: OpenCallSubmissionRecord;
}

/**
 * One application, for someone on its call's organizer side. Every refusal
 * is OPEN_CALL_APPLICATION_NOT_FOUND: unknown call, not on its organizer
 * side, unknown submission, or a submission of ANOTHER call (cross-call
 * isolation: call Y's organizers can't reach call X's application by
 * pairing Y's form id with X's submission id). The organizer check runs
 * before the submission is read, so a stranger learns nothing about ids.
 */
export async function resolveOrganizerSubmission(
  repos: OrganizerRepos,
  input: { formId: string; submissionId: string; actorHumanId: string },
): Promise<OrganizerSubmission> {
  let call: OrganizerCall;
  try {
    call = await resolveOrganizerCall(repos, input.formId, input.actorHumanId);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "OPEN_CALL_NOT_FOUND") {
      throw fail("OPEN_CALL_APPLICATION_NOT_FOUND", { cause: error });
    }
    throw error;
  }
  const submission = await repos.eventApplications.getOpenCallSubmissionById(
    input.submissionId,
  );
  if (!submission || submission.formId !== call.form.id) {
    throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
  }
  return { ...call, submission };
}
