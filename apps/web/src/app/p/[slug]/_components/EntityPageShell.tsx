import { Suspense } from "react";

import type { GetPublicPageOutput } from "@th/core/use-cases/entity-pages";
import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";
import { normalizeBlockSection } from "@th/core/use-cases/entity-pages";
import { placeAcceptsBookingRequests } from "@th/types/repos/entity-pages";

import type { PublicMembershipTier } from "@/server/membership-tiers";
import { EntityPageContent } from "./EntityPageContent";
import { resolveEntityDisplayName } from "./resolve-entity-display-name";
import { EntityPageTabs } from "./memberships/EntityPageTabs";
import { MembershipsPanel } from "./memberships/MembershipsPanel";
import styles from "./entity-page-shell.module.css";

type Props = {
  data: GetPublicPageOutput & {
    /**
     * PLACE only: the anonymous, cache-safe arrival areas (arrival-areas
     * FR-006, NFR-001), from `loadPublicPlaceArrivalAreas`. A viewer's own
     * areas are fetched after hydration and never ride this payload.
     */
    arrivalAreas?: VisibleArrivalArea[];
  };
  /** Public ACTIVE tiers for the owner; non-empty ⇒ the Membership tab renders. */
  membershipTiers?: PublicMembershipTier[];
};

/**
 * Renders a public entity page inside the standard app chrome (AppShell
 * navbar + GlobalOverlays via AppChrome — same treatment as /events).
 * The shell itself only lays out the content column; it owns no page actions.
 * Those live one level down, and WHERE depends on the layout:
 *   · standard templates → the hero's action row (`PlaceHero` / `HumanHero` /
 *     `OrgHero`)
 *   · freeform "stack" / "grid" → `EntityPageContent`'s `.pageActions` row,
 *     because no hero renders on that branch
 * Share / copy link / claim / request transfer / report travel to both via
 * `PlaceHeroActions` / `EntityHeroActions`. The owner-only "Edit page" jump
 * (`EditPageButton`) is PLACE-only in both — it takes a `placeId` and calls
 * the place-scoped `places.getPlaceForEdit`, so HUMAN and ORG pages have no
 * equivalent affordance today.
 */
export function EntityPageShell({ data, membershipTiers = [] }: Props) {
  // `request_to_play` is an interactive opt-in CTA. On the public page it is
  // only shown for verified venues that are actively accepting booking
  // requests; otherwise it is dropped entirely.
  const entity = data.entity;
  const placeAcceptsRequests = placeAcceptsBookingRequests(entity);

  // Membership-section blocks NEVER render in the main page body. The public
  // loader (getPublicPage) already drops non-"main" sections — member-only
  // content must not enter this server payload at all, because props passed
  // to client components are serialised into the anonymously-cached RSC
  // flight/HTML. This filter is defense in depth against a loader regression;
  // the member-gated content itself is fetched client-side by
  // MembershipsPanel via the authed `memberships.memberBlocks` procedure.
  const mainBlocks = data.blocks.filter(
    (block) =>
      normalizeBlockSection(block.section) !== "memberships" &&
      (placeAcceptsRequests || block.kind !== "request_to_play"),
  );

  const gatedData = { ...data, blocks: mainBlocks };

  const entityName = resolveEntityDisplayName(data.page, entity);

  const showMembershipTab =
    membershipTiers.length > 0 &&
    (entity.type === "HUMAN" || entity.type === "ORGANIZATION");

  const overview = <EntityPageContent data={gatedData} />;

  return (
    // AppShell's MainContent already provides the `main` landmark, so this is
    // a plain div (a nested <main> would duplicate the landmark).
    <div className={styles.shell}>
      {showMembershipTab ? (
        // `useSearchParams` inside EntityPageTabs opts the client subtree out
        // of the static shell; the Suspense fallback (the overview, i.e. the
        // default tab) is what the static HTML carries.
        <Suspense fallback={overview}>
          <EntityPageTabs
            overview={overview}
            memberships={
              <MembershipsPanel
                entityName={entityName}
                ownerType={entity.type as "HUMAN" | "ORGANIZATION"}
                ownerId={entity.id}
                tiers={membershipTiers}
              />
            }
          />
        </Suspense>
      ) : (
        overview
      )}
    </div>
  );
}
