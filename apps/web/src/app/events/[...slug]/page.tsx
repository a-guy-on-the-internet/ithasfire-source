import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { buildEventMetadata } from "@th/types/seo/buildEventMetadata";

import { buildCanonicalUrl, getSiteName } from "@/config/site";
import {
  forwardSearchParams,
  type PageSearchParams,
} from "@/lib/forward-search-params";
import { loadPublicEventPageData } from "@/server/event-page-data";
import {
  fetchEventGatedPreview,
  fetchPublicApplicationFormSeed,
  isEventGateActive,
  loadPublicEventGate,
  loadPublicEventSeo,
  resolvePublicEventSlug,
} from "@/server/events";
import {
  eventOgImageInputFor,
  withGeneratedEventOgImage,
} from "@/server/og/event-og-image";
import { SuggestEditPage } from "./_components/suggest/SuggestEditPage";
import { EventPageBody } from "./_components/EventPageBody";
import { GatedEventShell } from "./_components/GatedEventShell";
import { InviteParamScrubber } from "./_components/InviteParamScrubber";

export const revalidate = 60;

/**
 * The event as resolved for NOBODY IN PARTICULAR.
 *
 * `loadPublicEventSeo` (not `loadEventSeo`) because BOTH consumers of this —
 * `generateMetadata` and the page render — produce the one edge-cached
 * document. `loadEventSeo` asks the API with the viewer's bearer token, and for
 * an OBSCURED event that hands a ticket holder the exact street address,
 * postcode and coordinates, which then land in `event:location:*` meta, the
 * JSON-LD and the body of a page served to everyone behind that colo.
 */
const getEvent = async (slug: string) => loadPublicEventSeo(slug);

type EventPageParams = {
  params: Promise<{
    slug: string[];
  }>;
  searchParams?: Promise<
    {
      token?: string;
      ref?: string;
    } & PageSearchParams
  >;
};

/**
 * /events/<slug>/suggest rides THIS catch-all: Next.js can't nest a static
 * segment under `[...slug]`, so a trailing "suggest" segment whose remaining
 * segments resolve to an event selects the public propose-mode surface
 * (community-managed-event-listings spec FR-006). Callers only invoke this
 * AFTER the full slug failed to resolve, so an event whose own slug genuinely
 * ends in "/suggest" keeps winning its URL.
 */
async function resolveSuggestBranch(
  slugSegments: string[],
): Promise<{ currentSlug: string; redirect: boolean } | null> {
  if (slugSegments.length < 2 || slugSegments.at(-1) !== "suggest") {
    return null;
  }
  const baseSlug = slugSegments.slice(0, -1).join("/");
  const resolution = await resolvePublicEventSlug(baseSlug);
  if (!resolution) return null;
  return {
    currentSlug: resolution.currentSlug,
    redirect: resolution.redirect ?? false,
  };
}

export async function generateMetadata({
  params,
  searchParams,
}: EventPageParams): Promise<Metadata> {
  const { slug: slugSegments } = await params;
  const slug = slugSegments.join("/");

  // Ensure metadata and content render against the canonical slug.
  const resolution = await resolvePublicEventSlug(slug);

  if (!resolution) {
    const suggest = await resolveSuggestBranch(slugSegments);
    if (suggest) {
      // Propose-mode surface — never indexed (it's a form over public data).
      return {
        title: "Suggest an edit",
        robots: { index: false, follow: false },
      } satisfies Metadata;
    }
  }

  const canonicalSlug = resolution?.currentSlug ?? slug;

  if (resolution) {
    // A gated event gets the "requires access" head for EVERY viewer, because
    // <head> is part of the same edge-cached document as <body>. This used to
    // branch on the viewer's bypass/unlock, which put a privileged viewer's
    // real title, description and `index: true` into a document served to
    // strangers. Anonymous crawlers already saw exactly this branch, so the
    // indexing story is unchanged: gated pages stay noindex with a preview-only
    // title.
    const gate = await loadPublicEventGate(resolution.eventId);
    if (isEventGateActive(gate)) {
      const preview = await fetchEventGatedPreview(resolution.eventId);
      const title = preview?.title ?? "Protected event";
      return {
        title,
        description: "This event requires access before details are available.",
        alternates: { canonical: buildCanonicalUrl(`/events/${canonicalSlug}`) },
        openGraph: {
          title,
          description: "This event requires access before details are available.",
          url: buildCanonicalUrl(`/events/${canonicalSlug}`),
          // DELIBERATELY NOT the generated Date Stub. The gate may show the
          // title, the hero and the date, never WHERE, and the stub renders the
          // venue into a publicly cached PNG. `preview.heroImageUrl` stays
          // because it is an asset the gate itself already chooses to expose.
          ...(preview?.heroImageUrl ? { images: [preview.heroImageUrl] } : {}),
        },
        robots: {
          index: false,
          follow: false,
        },
      } satisfies Metadata;
    }
  }

  const event = await getEvent(canonicalSlug);
  if (!event) {
    return {
      title: "Event not found",
      description: "The requested event could not be located.",
      robots: {
        index: false,
        follow: false,
      },
    } satisfies Metadata;
  }

  // Only index publicly accessible/canonical event pages.
  // (We intentionally keep this logic in the route so the future "event page renderer"
  // can evolve independently of the SEO payload contract.)
  const shouldIndex = event.status === "PUBLISHED";

  // Resolve performer name from ?ref= param for personalised OG description
  const resolvedSearchParams = await searchParams;
  const ref = resolvedSearchParams?.ref;
  let refPerformerName: string | undefined;
  if (ref && event.performers.length > 0) {
    const matched = event.performers.find((p) => p.eventHumanId === ref);
    if (matched) {
      refPerformerName = matched.name;
    }
  }

  // If we hit an old slug, Next will follow the redirect in the page render,
  // but metadata should still reflect the canonical URL.
  //
  // `withGeneratedEventOgImage` is the last step on purpose: an event WITH a
  // hero keeps the images `buildEventMetadata` already derived, and only an
  // event with none gets the generated Date Stub
  // (`/og/event/<slug>?v=<signature>`) so a share never lands on an empty slot.
  return {
    ...withGeneratedEventOgImage(
      buildEventMetadata({
        event: {
          ...event,
          slug: canonicalSlug,
        },
        siteName: getSiteName(),
        refPerformerName,
      }),
      // Shared with the JSON-LD `image` fallback (`buildEventJsonLdEnrichment`),
      // so both name the same stub.
      eventOgImageInputFor(event, canonicalSlug),
    ),
    robots: {
      index: shouldIndex,
      follow: shouldIndex,
    },
  } satisfies Metadata;
}

/** `?invite=` present with a non-blank value (any of them, if repeated). */
function hasNonEmptyInviteParam(raw: string | string[] | undefined): boolean {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values.some((v) => v.trim() !== "");
}

export default async function EventPage({
  params,
  searchParams,
}: EventPageParams) {
  const { slug: slugSegments } = await params;
  const slug = slugSegments.join("/");
  const query = (await searchParams) ?? {};

  // Resolved for NOBODY IN PARTICULAR, like everything else in this document:
  // the 308s below are edge-cached with the page's `public, s-maxage` (header
  // rules ride out on redirects — see next.config.ts), so a redirect issued
  // because THIS viewer can edit a draft would hand that draft's new slug to
  // everyone behind the colo. The public answer is: an old slug (or the id) of
  // an event that is not publicly readable — a DRAFT, or cancelled / archived
  // without ever going live — is a plain 404, same as an unknown slug (N3,
  // `resolveEventBySlug`). Its editors lose nothing: the canonical page of such
  // an event is a public 404 for them too. A gated PUBLISHED event still
  // redirects — its slug is public, and the gate applies on the canonical URL.
  const resolution = await resolvePublicEventSlug(slug);
  if (!resolution) {
    const suggest = await resolveSuggestBranch(slugSegments);
    if (suggest) {
      if (suggest.redirect) {
        // Slug-history hit: permanent, like the page redirect below, and
        // gated the same way (`resolveSuggestBranch` asks the public
        // resolver, so a non-public event's old slug never gets here).
        permanentRedirect(
          `/events/${suggest.currentSlug}/suggest${forwardSearchParams(query)}`,
        );
      }
      return (
        <>
          <InviteParamScrubber />
          <SuggestEditPage slug={suggest.currentSlug} />
        </>
      );
    }
    notFound();
  }

  if (resolution.redirect) {
    // An old slug (from `EventSlugHistory`) → the canonical one. PERMANENT
    // (308), so crawlers drop the old URL: a person-owned event's old slug
    // carried the owner's real name. Every query param rides along (`token`,
    // `ref`, UTM tags) — dropping them here would break magic links and
    // attribution.
    permanentRedirect(
      `/events/${resolution.currentSlug}${forwardSearchParams(query)}`,
    );
  }

  // ── The only gate question this render may ask ──────────────────────────────
  //
  // `loadPublicEventGate` returns the EVENT's gate, never the VIEWER's standing
  // against it: `viewerCanBypass` / `viewerIsUnlocked` (and the
  // `passwordRequired` / `applicationRequired` pair that folds them in) are
  // dropped at that boundary. This route is served
  // `public, s-maxage=120, stale-while-revalidate=300` with no `Cookie` in its
  // `Vary`, so any branch on those three inputs stored ONE viewer's document at
  // a colo and served it to everyone behind it for up to seven minutes — an
  // organizer's privileged view of a gated event, or an unlocked attendee's.
  //
  // So: gated ⇒ the wall, for everybody, and NONE of the event's real data is
  // loaded (let alone rendered). Whether THIS viewer is through the gate is
  // settled after first paint by `GatedEventShell`, against an uncacheable
  // same-origin POST. Same shape as the home page's "near you" content and the
  // `cf-ipcountry` removal in d264790c.
  const gate = await loadPublicEventGate(resolution.eventId);

  if (isEventGateActive(gate)) {
    // An application gate's first paint is its form, so the form DEFINITION
    // rides the HTML (in parallel with the preview). It is the one addition
    // this edge-cached, identity-free document allows: an event-level read
    // through the no-identity client, the same for every visitor. Null on any
    // failure; the gate then fetches it after paint, as before.
    const [preview, applicationFormSeed] = await Promise.all([
      fetchEventGatedPreview(resolution.eventId),
      gate.gateType === "APPLICATION"
        ? fetchPublicApplicationFormSeed(resolution.eventId)
        : Promise.resolve(null),
    ]);
    if (!preview) {
      notFound();
    }

    return (
      <GatedEventShell
        // App Router does not key a segment by its dynamic params, so a soft nav
        // from one gated event to another would reconcile the shell in place and
        // carry the previous event's revealed body across. Force a remount.
        key={resolution.eventId}
        eventId={resolution.eventId}
        slug={resolution.currentSlug}
        title={preview.title}
        heroImageUrl={preview.heroImageUrl}
        // The event's local day, `YYYY-MM-DD`, resolved on the server. No
        // instant and no zone ride this edge-cached, identity-free document:
        // the zone ("America/Boise") would name a place.
        gateDate={preview.gateDate}
        gateType={gate.gateType}
        waitlistOpen={gate.waitlistOpen}
        waitlistDescription={gate.waitlistDescription}
        // Presence of a non-empty `?invite=` only: the VALUE is never read,
        // passed or rendered here (the client strips and keeps it). That
        // variant is `private, no-store` (next.config.ts), so the boolean
        // never lands in a shared cache.
        inviteParamPresent={hasNonEmptyInviteParam(query.invite)}
        applicationFormSeed={applicationFormSeed}
      />
    );
  }

  // Ungated (`gateType: "NONE"`) — the overwhelmingly common case, and the one
  // whose SSR shape and cacheability must not change.
  //
  // `loadPublicEventPageData` reads the event with NO viewer identity, so the
  // document it produces is the same bytes for a stranger, a ticket holder and
  // the organizer. The three things that used to differ — an OBSCURED venue's
  // exact address, the `editHref` "Edit Event" affordance, and the viewer's own
  // RSVP state — are re-asked after first paint by `EventPageBody` against
  // `POST /api/events/[eventId]/viewer-state`, which is uncacheable and fails
  // closed (redacted / no edit / not going) on every path.
  const data = await loadPublicEventPageData(
    resolution.eventId,
    resolution.currentSlug,
  );
  if (!data) {
    notFound();
  }

  return (
    <>
      {/* An invite link to an event whose gate was since removed: drop the
          token from the URL (the gated branch's shell owns it otherwise). */}
      <InviteParamScrubber />
      <EventPageBody data={data} />
    </>
  );
}
