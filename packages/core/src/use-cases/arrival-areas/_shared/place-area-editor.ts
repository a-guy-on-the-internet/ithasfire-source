import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { Repos, TxRepos } from "@th/ports/repos";
import { isAppError } from "@th/errors";

import type { ArrivalAreaPin } from "../../../lib/arrival-areas/geometry";
import {
  placeWithholdsAddress,
  type PlaceLocationSource,
} from "../../../lib/location/redact-place-location";
import {
  recheckCommunityPageEditor,
  resolveEntityPageEditor,
  type EntityPageEditor,
} from "../../entity-pages/entity-page-access";
import { ensurePlaceOwnerAccess } from "../../places/_shared/ensure-place-owner-access";
import { finitePin } from "./event-area-access";

// ─────────────────────────────────────────────────────────────────────────────
// Who may draw a PLACE's arrival areas (arrival-areas FR-002):
//   · the place's managing org / verified owner (`ensurePlaceOwnerAccess`,
//     the gate every place-management use case runs);
//   · for a place NOBODY owns, a community moderator or platform ADMIN,
//     through the SAME check the moderator place page uses
//     (`resolveEntityPageEditor` with ownerType PLACE, the check behind
//     get-place-page-edit-access). Its rules are not copied here: an owned
//     place, a claim in review, an archived or suspended place all refuse a
//     moderator exactly as they refuse a page write.
// Nobody else. In particular an event's editor never draws its place's
// areas; they hide them per event (set-event-arrival-area-hidden).
//
// The check is ADVISORY for a moderator; a write re-runs it under the
// place's claim lock inside its transaction ({@link recheckPlaceAreaEditor}),
// so a claim that lands in between refuses the write.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaceAreaEditorDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  clock: ClockPort;
};

/**
 * Resolves which kind of editor may draw this place's areas, or throws:
 * PLACE_NOT_FOUND, NOT_RESOURCE_OWNER (not a manager, not a moderator),
 * PLACE_HAS_OWNER / PLACE_ARCHIVED / PLACE_NOT_ACTIVE (a moderator on a place
 * they may not edit), SECOND_FACTOR_REQUIRED.
 */
export async function resolvePlaceAreaEditor(
  deps: PlaceAreaEditorDeps,
  placeId: string,
  actorHumanId: string,
): Promise<EntityPageEditor> {
  try {
    await ensurePlaceOwnerAccess(deps.repos, placeId, actorHumanId);
    return { kind: "owner" };
  } catch (err) {
    // Not the place's manager: maybe a moderator on an unowned place.
    // PLACE_NOT_FOUND and anything unexpected propagate.
    if (!(isAppError(err) && err.code === "NOT_RESOURCE_OWNER")) throw err;
  }
  return resolveEntityPageEditor(
    { authz: deps.authz, repos: deps.repos, clock: deps.clock },
    { actorHumanId, ownerType: "PLACE", ownerId: placeId },
  );
}

/**
 * Inside the writing transaction, BEFORE `arrivalAreas.lockParent`: for a
 * moderator, the place's claim lock and the moderator rules again (the
 * order claim submit and review take the claim lock in: first). No-op for a
 * manager.
 */
export async function recheckPlaceAreaEditor(
  tx: TxRepos,
  editor: EntityPageEditor,
  now: Date,
): Promise<void> {
  await recheckCommunityPageEditor(tx, editor, now);
}

// ─────────────────────────────────────────────────────────────────────────────
// What a place-area editor sees of the place's location (FR-008: areas never
// leak a withheld address). A community moderator on an unowned place is not
// `canManagePlace`, and every other moderator surface shows them only the
// public location (`places.getPlacePublic` redacts). So at a place that
// WITHHOLDS its address they get what an event editor who cannot see a
// withheld address gets (security F1, option A): no pin (a new or moved
// shape answers NO_PIN, never OUTSIDE_ENVELOPE, so there is no distance
// oracle on the house), rows without geometry / note / price text
// (`geometryWithheld`), nothing measured. They can still rename, reorder and
// remove a row. Owners always see the true pin; at a place that publishes
// its address the pin is public and a moderator sees it too.
// A platform ADMIN reaches this as `community_moderator` and is withheld
// too, deliberately (fail closed; owner question pending).
//
// ONE rule for the mutation path (manage-arrival-areas, read on the locked
// Place row) and the read path (list-arrival-areas-for-editor).
// ─────────────────────────────────────────────────────────────────────────────

/** Fail closed: only an owner, or any editor at an EXACT place, sees the address. */
export function placeAreaEditorSeesAddress(
  editor: EntityPageEditor,
  place: PlaceLocationSource,
): boolean {
  return editor.kind === "owner" || !placeWithholdsAddress(place);
}

export type PlaceAreaEditorView = {
  /** The pin this editor's shapes are measured against; null = NO_PIN. */
  pin: ArrivalAreaPin | null;
  /** Whether rows go out with their geometry, note and price text. */
  addressVisible: boolean;
};

export function placeAreaEditorView(
  editor: EntityPageEditor,
  place: PlaceLocationSource,
): PlaceAreaEditorView {
  const addressVisible = placeAreaEditorSeesAddress(editor, place);
  return {
    pin: addressVisible ? finitePin(place.lat, place.lng) : null,
    addressVisible,
  };
}
