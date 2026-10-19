/**
 * Who may open and change an entity page, in ONE place (moderator place page
 * spec docs/specs/2026-10-14/moderator-place-page.spec.yaml, FR-001..FR-004).
 *
 *  - HUMAN: the human themself. ORGANIZATION: ORG_EDIT_ROLES. Unchanged.
 *  - PLACE: whoever `authz.canManagePlace` allows (the OWNER path). When it
 *    refuses, a community moderator or platform ADMIN
 *    (`COMMUNITY_MODERATION_ROLES`) passes on a place NOBODY OWNS (owner
 *    ruling R2, 2026-10-14: "full super power over all editor features ...
 *    till they become owned by the real person"):
 *      - the place exists (PLACE_NOT_FOUND);
 *      - `findOwnerlessWriteBlock` is null or "OWNED_EVENTS_AT_PLACE"
 *        (decision D3: page content reaches no ticket email, so an
 *        organiser's live event does not freeze the page). "OWNED" and
 *        "CLAIM_PENDING" refuse with PLACE_HAS_OWNER and `meta.reason`;
 *      - the place is ACTIVE (PLACE_ARCHIVED / PLACE_NOT_ACTIVE, the codes
 *        `updateCommunityPlace` uses).
 *    Anyone else gets NOT_RESOURCE_OWNER exactly as before.
 *
 * {@link resolveEntityPageEditor} is the advisory check every page use case
 * runs first; it says which kind of editor passed. A moderator's WRITE then
 * runs {@link recheckCommunityPageEditor} inside the transaction that writes
 * (decision D4: `lockPlaceForClaim`, which claim submit and review take too,
 * then the same rules), and logs {@link ENTITY_PAGE_COMMUNITY_UPDATED_ACTION}
 * in that transaction ({@link logCommunityPageUpdate}, decision D5). The
 * owner path takes no lock and writes no audit row (as before; follow-up F1).
 *
 * Every PLACE page use case runs this module, nothing else: the live editor
 * (getMyPage and its template seed, updatePage, managePageBlocks,
 * updatePageTheme, requestPageImageUpload, finalizePageImageUpload) and the
 * draft editor (getPageDraft, savePageDraft, discardPageDraft,
 * publishPageDraft; owner ruling 2026-10-15: moderators get the same access
 * there). Reads (getMyPage without a seed, getPageDraft,
 * requestPageImageUpload, which writes no page data) run the advisory check
 * only. The recheck's `lockPlaceForClaim` is the FIRST lock of the writing
 * transaction (before a draft row lock), the order claim submit and review
 * use. Place FACTS are not page content (D3): a moderator's draft may not
 * set a `place.*` path (`place_fact_not_for_moderator`); they change through
 * `updateCommunityPlace` and its rules.
 */

import { createHash } from "node:crypto";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { PlaceRecord, Repos, TxRepos } from "@th/ports/repos";
import type { PageOwnerType } from "@th/types/repos/entity-pages";
import { fail, isAppError } from "@th/errors";

import { ORG_EDIT_ROLES, requirePlatformStaff } from "../../lib/rbac";
import { findOwnerlessWriteBlock } from "../places/_shared/ownerless-write-guard";
import { COMMUNITY_MODERATION_ROLES } from "../community/_shared/suggestion-validation";

/**
 * The audit action of every community moderator page write (decision D5).
 * One row per write, in the writing transaction. The row shape (the owner's
 * handover notice, D6, reads it; keep it stable):
 *
 *   entity   "entity_page"            entityId  the page id
 *   at       the write's clock time
 *   data     {
 *     actorHumanId  the moderator
 *     placeId       the place the page belongs to
 *     pageId        the page
 *     op            what ran: "updatePage", "managePageBlocks.<action>",
 *                   "updatePageTheme", "seedTemplate",
 *                   "finalizePageImageUpload", "savePageDraft",
 *                   "discardPageDraft", "publishPageDraft"
 *     fields        WHICH things changed, as stable names: page fields
 *                   ("bio"), theme keys ("theme.colorPrimary"), blocks
 *                   ("blocks.<id>", "blocks.order"), draft paths
 *                   ("page.bio", "blocks.<id>.data.text", "place.phone"),
 *                   "pageImage". Sorted, de-duplicated.
 *     from, to      the values before and after, BOUNDED by
 *                   {@link boundAuditValue}: evidence, not a backup. A
 *                   discard records paths only (no values).
 *   }
 */
export const ENTITY_PAGE_COMMUNITY_UPDATED_ACTION =
  "entity_page.community_updated";

/** The audit entity of {@link ENTITY_PAGE_COMMUNITY_UPDATED_ACTION}. */
export const ENTITY_PAGE_AUDIT_ENTITY = "entity_page";

export type EntityPageOwnerInput = {
  actorHumanId: string;
  ownerType: PageOwnerType;
  ownerId: string;
};

/** Which kind of editor passed the access check. */
export type EntityPageEditor =
  | { kind: "owner" }
  | { kind: "community_moderator"; placeId: string };

export type EntityPageEditorAccessDeps = {
  authz: Pick<AuthZPort, "requireOrgRole" | "canManagePlace" | "hasStaffRole">;
  repos: Pick<Repos, "places" | "events">;
  clock: ClockPort;
};

function placeNotOwned() {
  return fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
}

/**
 * The owner check. Throws for HUMAN / ORGANIZATION / unknown types as it
 * always has; for PLACE answers whether `canManagePlace` allowed.
 */
async function ownerAccess(
  deps: Pick<EntityPageEditorAccessDeps, "authz">,
  input: EntityPageOwnerInput,
): Promise<"allowed" | "place_refused"> {
  switch (input.ownerType) {
    case "HUMAN":
      if (input.ownerId !== input.actorHumanId) {
        throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "page" } });
      }
      return "allowed";
    case "ORGANIZATION":
      await deps.authz.requireOrgRole({
        actorHumanId: input.actorHumanId,
        orgId: input.ownerId,
        requiredRoles: [...ORG_EDIT_ROLES],
      });
      return "allowed";
    case "PLACE": {
      const placeAccess = await deps.authz.canManagePlace({
        actorHumanId: input.actorHumanId,
        placeId: input.ownerId,
      });
      return placeAccess.allowed ? "allowed" : "place_refused";
    }
    default:
      throw fail("UNKNOWN_OWNER_TYPE");
  }
}

/**
 * The page access check every editor use case runs first. Advisory for a
 * moderator: it reads without the claim lock, so a write re-checks under it
 * ({@link recheckCommunityPageEditor}).
 */
export async function resolveEntityPageEditor(
  deps: EntityPageEditorAccessDeps,
  input: EntityPageOwnerInput,
): Promise<EntityPageEditor> {
  if ((await ownerAccess(deps, input)) === "allowed") {
    return { kind: "owner" };
  }
  // A PLACE whose owner check refused: a moderator, or nobody.
  try {
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });
  } catch (err) {
    // Not staff: refused exactly as before. Anything else (a role holder
    // with no second factor, a transient authz error) propagates.
    if (isAppError(err) && err.code === "STAFF_ONLY") throw placeNotOwned();
    throw err;
  }
  await assertCommunityMayEditPlacePage(
    deps.repos,
    input.ownerId,
    deps.clock.now(),
  );
  return { kind: "community_moderator", placeId: input.ownerId };
}

/**
 * The moderator rules (D3) against the place as `repos` reads it: outside a
 * transaction in the advisory check, under `lockPlaceForClaim` in the write.
 */
export async function assertCommunityMayEditPlacePage(
  repos: Pick<TxRepos, "places" | "events">,
  placeId: string,
  now: Date,
): Promise<PlaceRecord> {
  const place = await repos.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND", { meta: { placeId } });
  }
  const block = await findOwnerlessWriteBlock(repos, place, now);
  // Same shape as assertOwnerlessWriteAllowed; OWNED_EVENTS_AT_PLACE does
  // not refuse a page write (D3).
  if (block === "OWNED" || block === "CLAIM_PENDING") {
    throw fail("PLACE_HAS_OWNER", {
      message:
        block === "OWNED"
          ? "this place has an owner; only its owner can change it"
          : "this place has a claim in review",
      meta: { placeId: place.id, reason: block },
    });
  }
  if (place.status === "ARCHIVED") {
    throw fail("PLACE_ARCHIVED", { meta: { placeId } });
  }
  if (place.status !== "ACTIVE") {
    throw fail("PLACE_NOT_ACTIVE", { meta: { placeId, status: place.status } });
  }
  return place;
}

/**
 * Inside the writing transaction: for a moderator, take the place's claim
 * lock and re-run the rules, so a claim landing after the advisory check
 * refuses the write (D4). No-op for an owner.
 */
export async function recheckCommunityPageEditor(
  tx: Pick<TxRepos, "places" | "events">,
  editor: EntityPageEditor,
  now: Date,
): Promise<void> {
  if (editor.kind !== "community_moderator") return;
  await tx.places.lockPlaceForClaim(editor.placeId);
  await assertCommunityMayEditPlacePage(tx, editor.placeId, now);
}

/** What one moderator page write changed (D5). */
export type CommunityPageUpdate = {
  actorHumanId: string;
  pageId: string;
  /** The use case / operation, e.g. "updatePage", "managePageBlocks.edit". */
  op: string;
  /** Which things changed (see the row shape above). */
  fields: readonly string[];
  /** Bounded on write ({@link boundAuditValue}). */
  from: unknown;
  to: unknown;
};

/** Longest string an audit value keeps verbatim. */
export const COMMUNITY_AUDIT_MAX_STRING = 500;
/** Largest serialised `from` / `to` kept as a structure (else one digest). */
export const COMMUNITY_AUDIT_MAX_JSON = 4_000;
/** Most array items kept (the rest are counted, not stored). */
export const COMMUNITY_AUDIT_MAX_ITEMS = 50;

/** What a value too large for the audit row becomes. */
export type TruncatedAuditValue = {
  truncated: true;
  /** Characters (a string) or serialised characters (anything else). */
  length: number;
  sha256: string;
};

function truncated(serialised: string): TruncatedAuditValue {
  return {
    truncated: true,
    length: serialised.length,
    sha256: createHash("sha256").update(serialised).digest("hex"),
  };
}

function boundInner(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length <= COMMUNITY_AUDIT_MAX_STRING ? value : truncated(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return truncated(JSON.stringify(value) ?? "");
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, COMMUNITY_AUDIT_MAX_ITEMS)
      .map((item) => boundInner(item, depth + 1));
    return value.length > COMMUNITY_AUDIT_MAX_ITEMS
      ? [...kept, { omittedItems: value.length - COMMUNITY_AUDIT_MAX_ITEMS }]
      : kept;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      boundInner(item, depth + 1),
    ]),
  );
}

/**
 * Bounds a value for an `entity_page.community_updated` row (data
 * minimisation, and a row size cap): strings over
 * {@link COMMUNITY_AUDIT_MAX_STRING} become `{ truncated, length, sha256 }`,
 * arrays keep {@link COMMUNITY_AUDIT_MAX_ITEMS} items, and a result still
 * over {@link COMMUNITY_AUDIT_MAX_JSON} serialised characters becomes one
 * digest. The digest proves what was there without storing it.
 */
export function boundAuditValue(value: unknown): unknown {
  const bounded = boundInner(value, 0);
  const serialised = JSON.stringify(bounded) ?? "";
  return serialised.length <= COMMUNITY_AUDIT_MAX_JSON
    ? bounded
    : truncated(JSON.stringify(value) ?? "");
}

/**
 * Logs {@link ENTITY_PAGE_COMMUNITY_UPDATED_ACTION} for a moderator write,
 * in the caller's transaction. No-op for an owner.
 */
export async function logCommunityPageUpdate(
  tx: Pick<TxRepos, "audit">,
  editor: EntityPageEditor,
  update: CommunityPageUpdate,
  at: Date,
): Promise<void> {
  if (editor.kind !== "community_moderator") return;
  await tx.audit.log({
    entity: ENTITY_PAGE_AUDIT_ENTITY,
    entityId: update.pageId,
    action: ENTITY_PAGE_COMMUNITY_UPDATED_ACTION,
    data: {
      actorHumanId: update.actorHumanId,
      placeId: editor.placeId,
      pageId: update.pageId,
      op: update.op,
      fields: [...new Set(update.fields)].sort(),
      from: boundAuditValue(update.from),
      to: boundAuditValue(update.to),
    },
    at,
  });
}

/**
 * The refusals {@link recheckCommunityPageEditor} throws: a moderator who
 * lost access between the advisory check and the write.
 */
export const COMMUNITY_PAGE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "PLACE_HAS_OWNER",
  "PLACE_ARCHIVED",
  "PLACE_NOT_ACTIVE",
  "PLACE_NOT_FOUND",
]);
