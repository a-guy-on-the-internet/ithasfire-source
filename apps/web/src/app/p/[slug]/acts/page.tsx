import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { DEFAULT_VENUE_TIMEZONE } from "@th/core/lib/venue-local-time";
import { loadEntityPageBySlug } from "@/server/entity-pages";
import { loadPlaceLineupHistory } from "@/server/places";
import { getFeatureGatesServer } from "@/server/feature-gates";
import { resolveEntityDisplayName } from "@/app/p/[slug]/_components/resolve-entity-display-name";
import {
  buildEntityPageThemeVars,
  resolveEntityPageFontKey,
} from "@/app/p/[slug]/_components/entity-page-theme-vars";
import shell from "@/app/p/[slug]/_components/entity-page-shell.module.css";
import { ActsRoster } from "./_components/ActsRoster";
import {
  readTrackRecordSummary,
  type RosterAct,
} from "./_components/roster-helpers";
import s from "./_components/ActsRoster.module.css";

/* ── /p/[slug]/acts — who has played this venue ─────────────────────────────
 *
 * venue-track-record-and-review-switch FR-016, ruling R9 "Roster". The page
 * the venue page's "All N acts →" opens. Public, server-rendered, NOINDEX
 * (the venue page is the canonical, indexable surface; this is its long
 * tail), not a template block, not owner-editable, and wrapped in the venue's
 * own theme so it reads as the same page one level down.
 *
 * The slug is the ENTITY PAGE slug — the same one `/p/[slug]` resolves, via
 * the same loader — never `Place.slug`, which is a directory key and not a
 * URL. A HUMAN or ORG page at this slug has no acts and 404s.
 */

// Declared to mirror the sibling `/p/[slug]/page.tsx`; equally inert there
// (the shared loader reads `headers()`, so the route renders per request).
export const revalidate = 60;

const getPage = cache(async (slug: string) => loadEntityPageBySlug(slug));

type PageParams = {
  params: Promise<{ slug: string }>;
};

const NOT_FOUND_METADATA: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPage(slug);

  if (result?.data.entity.type !== "PLACE") {
    return NOT_FOUND_METADATA;
  }

  const name = resolveEntityDisplayName(result.data.page, result.data.entity);
  return {
    // Metadata is built outside the translator (as on the sibling route), so
    // the title is the English line; the on-page copy is in the catalog.
    title: `Who's played ${name}`,
    // FR-016: noindex. `follow` stays on so the act links (when the profile
    // gate is open) and the way back to the venue page are still crawlable.
    robots: { index: false, follow: true },
  };
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export default async function PlaceActsPage({ params }: PageParams) {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    notFound();
  }

  // Historical slug: send the reader to the acts page of the CURRENT slug,
  // as the sibling route redirects to the current venue page.
  if (result.redirect) {
    redirect(`/p/${result.data.page.slug}/acts`);
  }

  const { data } = result;
  const entity = data.entity;
  if (entity.type !== "PLACE") {
    notFound();
  }

  const [lineup, gates] = await Promise.all([
    loadPlaceLineupHistory(entity.id),
    getFeatureGatesServer(),
  ]);
  if (!lineup) {
    notFound();
  }

  const summary = readTrackRecordSummary(data.blocks);
  const acts: RosterAct[] = lineup.all.map((act) => ({
    key: act.key,
    name: act.name,
    profileUrl: act.profileUrl,
    timesPlayed: act.timesPlayed,
    lastPlayedAt: toIso(act.lastPlayedAt),
  }));

  return (
    // `.content` (the shell's 48rem column + theme pair + font presets) and
    // the roster's own `.page` hook — the same wrapper the freeform entity
    // canvas renders in, so this reads as the venue page one level down.
    <div
      className={`${shell.content} ${s.page}`}
      style={buildEntityPageThemeVars(data.theme)}
      data-font={resolveEntityPageFontKey(data.theme?.fontKey)}
    >
      <ActsRoster
        venueName={resolveEntityDisplayName(data.page, entity)}
        venueHref={`/p/${data.page.slug}`}
        acts={acts}
        summary={summary}
        linkProfiles={gates.humanProfilesPublic}
        // The venue's zone, carried by the track_record block (spec FU-001),
        // so this page and the venue block print the same calendar day for
        // the same show. The platform default is only for a block from before
        // the field existed. Chosen here, on the server, so SSR and hydration
        // format identically.
        timeZone={summary.timeZone ?? DEFAULT_VENUE_TIMEZONE}
        nowIso={new Date().toISOString()}
      />
    </div>
  );
}
