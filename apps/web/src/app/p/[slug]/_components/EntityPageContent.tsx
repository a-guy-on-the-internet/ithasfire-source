"use client";

import type { VisibleArrivalArea } from "@th/core/use-cases/arrival-areas";
import type { PublicPageData } from "@th/types/repos/entity-pages";
import { placeAcceptsBookingRequests } from "@th/types/repos/entity-pages";
import {
  getDefaultBlockSpan,
  normalizeEntityPageLayoutKey,
  resolveDefaultEntityPageLayoutKey,
  type EntityPageLayoutKey,
  type GetPublicPageOutput,
} from "@th/core/use-cases/entity-pages";

import { EditPageButton } from "./EditPageButton";
import {
  buildEntityPageThemeVars,
  resolveEntityPageFontKey,
  resolveEntityPageSurfaceTone,
} from "./entity-page-theme-vars";
import { resolveEntityDisplayName } from "./resolve-entity-display-name";
import { PlaceHeroActions } from "./PlaceHeroActions";
import { HeroClaimPlaceButton } from "./headers/HeroClaimPlaceButton";
import { EntityHeroActions } from "./EntityHeroActions";
import {
  CommunityListingNotice,
  placeClaimableFrom,
} from "@/components/community/CommunityListingNotice";

import { BlockRenderer } from "./blocks";
import { BlockPageOwnerProvider } from "./blocks/block-page-owner-context";
import { HumanPageHeader, OrgPageHeader, PlacePageHeader } from "./headers";
import { PlaceEntityLayout } from "./PlaceEntityLayout";
import { HumanEntityLayout } from "./HumanEntityLayout";
import { OrgEntityLayout } from "./OrgEntityLayout";
import styles from "./entity-page-shell.module.css";

export type EntityPageContentData = Pick<
  PublicPageData,
  "page" | "blocks" | "theme" | "entity"
> & {
  /** PLACE only: set while moderators' writes await the owner (D6). */
  communityAttribution?: GetPublicPageOutput["communityAttribution"];
  /** PLACE only: the anonymous arrival areas (see EntityPageShell). */
  arrivalAreas?: VisibleArrivalArea[];
  /**
   * The page editor's canvas and preview: never probe for the viewer's own
   * arrival areas, so the editor shows the list a stranger sees.
   */
  publicPreview?: boolean;
};

function getBlockColumnSpan(
  block: EntityPageContentData["blocks"][number],
): 1 | 2 {
  const data = block.data;
  const columnSpan =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).columnSpan
      : undefined;
  return columnSpan === 1 || columnSpan === 2
    ? columnSpan
    : getDefaultBlockSpan(block.kind);
}

/**
 * The `entity-page` query container wraps every layout this component renders
 * (PLACE / HUMAN / ORG templates and the freeform canvas), so the page's
 * layout `@container entity-page (...)` rules measure the width the page is
 * GIVEN, not the browser window. On the public route that is the AppShell
 * content column; in the page editor it is the editing canvas, which can be
 * narrower than the window (a phone-width preview) and must lay out exactly
 * as a phone would. It lives here, not on a layout root, because the shared
 * blocks render under all four branches and a container cannot query itself.
 */
export function EntityPageContent({ data }: { data: EntityPageContentData }) {
  return (
    <div className={styles.pageContainer}>
      <EntityPageLayout data={data} />
    </div>
  );
}

// Theme vars + font preset live in `entity-page-theme-vars.ts` (no client
// directive) so the server-rendered acts page can wrap its roster in the same
// owner theme. Import them from there.
function EntityPageLayout({ data }: { data: EntityPageContentData }) {
  const { page, blocks, theme, entity } = data;
  const themeVars = buildEntityPageThemeVars(theme);
  const fontKey = resolveEntityPageFontKey(theme?.fontKey);

  // Resolve the effective layout: an explicit, valid stored `layoutKey` wins;
  // otherwise fall back to the per-owner-type default (every owner type now
  // defaults to "standard"). Unlike `normalizeLayoutKey`, the core normalizer
  // returns null when unset/invalid so we can distinguish "no choice" from a
  // real selection before applying the owner-type default.
  const effectiveLayout: EntityPageLayoutKey =
    normalizeEntityPageLayoutKey(theme?.layoutKey) ??
    resolveDefaultEntityPageLayoutKey(entity.type);

  // Owner-type-specific "standard" templates: the polished, app-controlled
  // profiles. A "stack"/"grid" choice falls through to the freeform,
  // owner-controlled block canvas below (with the matching type header).
  if (entity.type === "PLACE" && effectiveLayout === "standard") {
    return (
      <PlaceEntityLayout
        data={{ ...data, entity }}
        themeVars={themeVars}
        fontKey={fontKey}
      />
    );
  }

  if (entity.type === "HUMAN" && effectiveLayout === "standard") {
    return (
      <HumanEntityLayout
        data={{ ...data, entity }}
        themeVars={themeVars}
        fontKey={fontKey}
      />
    );
  }

  if (entity.type === "ORGANIZATION" && effectiveLayout === "standard") {
    return (
      <OrgEntityLayout
        data={{ ...data, entity }}
        themeVars={themeVars}
        fontKey={fontKey}
      />
    );
  }

  // Freeform canvas. Every owner type's "standard" case returned above, so this
  // path only handles the owner-controlled "stack" / "grid" layouts. The
  // `.blocks` grid special-cases "grid"; "stack" (and any other value) stacks.
  const blocksLayout = effectiveLayout;
  const blockOwner =
    entity.type === "PLACE"
      ? {
          place: {
            id: entity.id,
            name: entity.name,
            acceptsRequests: placeAcceptsBookingRequests(entity),
            pageSlug: page.slug,
            arrivalAreas: data.arrivalAreas,
            publicPreview: data.publicPreview,
          },
        }
      : { place: null };

  return (
    <div
      className={styles.content}
      style={themeVars}
      data-font={fontKey}
      data-layout={blocksLayout}
      // Transparent without an owner background, so only an owner's own
      // light background marks the surface (see PlaceEntityLayout).
      data-surface={resolveEntityPageSurfaceTone(theme, false) ?? undefined}
    >
      {entity.type === "HUMAN" && (
        <HumanPageHeader page={page} entity={entity} />
      )}
      {entity.type === "ORGANIZATION" && (
        <OrgPageHeader page={page} entity={entity} />
      )}
      {entity.type === "PLACE" && (
        <PlacePageHeader page={page} entity={entity} />
      )}

      {/* Page actions — Claim (while claimable), Edit page (owners), and the
          `⋯` overflow with Share / Copy link / Request transfer / Report.
          These mount from the HERO's action row on the standard templates,
          and the heroes do not render here — so without this the freeform
          layouts silently lose reporting, claiming, and an owner's only link
          back to the editor. Same components, same gates, same chips, same
          order: the `⋯` overflow stays last. */}
      <div className={styles.pageActions}>
        {entity.type === "PLACE" ? (
          <>
            <HeroClaimPlaceButton
              placeId={entity.id}
              placeName={resolveEntityDisplayName(page, entity)}
              initiallyClaimable={entity.claimable === true}
            />
            <EditPageButton placeId={entity.id} />
            <PlaceHeroActions
              placeId={entity.id}
              placeName={resolveEntityDisplayName(page, entity)}
              shareTitle={resolveEntityDisplayName(page, entity)}
            />
          </>
        ) : (
          <EntityHeroActions
            subjectType={entity.type as "HUMAN" | "ORGANIZATION"}
            subjectId={entity.id}
            subjectName={page.displayName ?? entity.name ?? page.slug ?? ""}
          />
        )}
      </div>

      {entity.type === "PLACE" && data.communityAttribution ? (
        <CommunityListingNotice
          subject="place"
          lastChangedAt={data.communityAttribution.lastUpdatedAt}
          placeClaimable={placeClaimableFrom(entity)}
        />
      ) : null}

      {blocks.length > 0 && (
        <BlockPageOwnerProvider owner={blockOwner}>
          <section className={styles.blocks} data-layout={blocksLayout}>
            {blocks.map((block) => (
              <div
                key={block.id}
                className={styles.blockItem}
                data-span={getBlockColumnSpan(block)}
              >
                <BlockRenderer block={block} />
              </div>
            ))}
          </section>
        </BlockPageOwnerProvider>
      )}
    </div>
  );
}
