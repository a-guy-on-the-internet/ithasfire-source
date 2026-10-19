/**
 * Which ADMIN-LEVEL actions the event builder offers: Unpublish and Cancel
 * event (header `⋯` menu), Take down listing (the `⋯` menu
 * of a community listing, platform ADMIN only) and Regenerate slug (Settings
 * → Sharing).
 *
 * Each gate mirrors the use case that would refuse it, so the builder never
 * offers a button that fails for the viewer. Pure, so the table test pins it
 * (`__tests__/builder-admin-action-gates.test.ts`).
 *
 * Inputs:
 *  - `canEdit` — the builder's effective edit right (`canEditEvent` minus a
 *    locked community listing).
 *  - `canManageEvent` — ORG_ADMIN_ROLES on an org event; the owner or an
 *    OWNER/ADMIN delegate on a personal one (`EventAdminPageShell`).
 *    Narrower than edit: an EDITOR, org member or delegate, edits and
 *    publishes but does not take the event down.
 *  - `isCommunity` — an ownerless COMMUNITY listing.
 *  - `isPlatformAdmin` — the viewer holds the platform ADMIN role
 *    (`platform.checkStaffAccess`). Only meaningful with `isCommunity`: it is
 *    the one role `cancelEvent` admits on an ownerless row
 *    (a COMMUNITY_MODERATOR gets STAFF_ONLY).
 *  - `eventStatus` — `Event.status`.
 */
export type BuilderAdminActionGateInput = {
  canEdit: boolean;
  canManageEvent: boolean;
  isCommunity: boolean;
  isPlatformAdmin: boolean;
  eventStatus: string;
};

export type BuilderAdminActionGates = {
  showUnpublish: boolean;
  showCancel: boolean;
  /** Community listing, platform ADMIN, DRAFT or PUBLISHED. */
  showTakeDownListing: boolean;
  canRegenerateSlug: boolean;
};

export function builderAdminActionGates({
  canEdit,
  canManageEvent,
  isCommunity,
  isPlatformAdmin,
  eventStatus,
}: BuilderAdminActionGateInput): BuilderAdminActionGates {
  // `unpublishEvent` asks ORG_ADMIN_ROLES on an org event, and the owner or
  // an OWNER/ADMIN delegate on a personal one — so an EDITOR is not offered
  // it. It refuses an ownerless listing outright; a listing is taken down
  // with Take down listing instead.
  const showUnpublish =
    canEdit && canManageEvent && !isCommunity && eventStatus === "PUBLISHED";

  // `cancelEvent` asks the same admin bar (org ORG_ADMIN_ROLES; owner or
  // OWNER/ADMIN delegate) and only cancels a DRAFT or PUBLISHED event — the
  // status arm `BuilderHeaderBar` also applies. It admits an ownerless
  // COMMUNITY row only for a platform ADMIN (FR-014) — a COMMUNITY_MODERATOR
  // gets STAFF_ONLY. This owned-event item stays off for a listing; the
  // platform-ADMIN path is `showTakeDownListing` below.
  const showCancel =
    canEdit &&
    canManageEvent &&
    !isCommunity &&
    (eventStatus === "DRAFT" || eventStatus === "PUBLISHED");

  // Taking a community listing down (owner ruling 2026-10-16): one action,
  // `cancelEvent` — every remaining night off, savers and RSVPers told, out
  // of search and lists. No Archive step. It does not depend on `canEdit` or
  // `canManageEvent`; the server decides on the platform ADMIN role alone.
  // `cancelEvent` takes a DRAFT or PUBLISHED event only.
  const showTakeDownListing =
    isCommunity &&
    isPlatformAdmin &&
    (eventStatus === "DRAFT" || eventStatus === "PUBLISHED");

  // `regenerateEventSlug` only runs on a DRAFT or PUBLISHED event; it asks
  // edit roles on a draft and the admin bar (`canManageEvent`) once the
  // event is PUBLISHED. It refuses an ownerless row outright, so never on a
  // community listing (whose builder renders no Sharing group anyway).
  const canRegenerateSlug =
    canEdit &&
    !isCommunity &&
    (eventStatus === "DRAFT" || (eventStatus === "PUBLISHED" && canManageEvent));

  return {
    showUnpublish,
    showCancel,
    showTakeDownListing,
    canRegenerateSlug,
  };
}
