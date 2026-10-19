"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { EventPageData } from "@/server/event-page-data";
import type { EventViewerState } from "@/server/event-viewer-state";
import type { CommunityEventDate } from "@/server/events";

import { EventBreadcrumbJsonLd } from "@/components/seo/EventBreadcrumbJsonLd";
import { authClient } from "@/lib/auth/auth-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { EventDetail } from "./EventDetail";
import { EventJsonLd } from "./EventJsonLd";
import { HeroBackdrop } from "./HeroBackdrop";
import { ResaleListingsSection } from "./ResaleListingsSection";
import { VolunteerSection } from "./VolunteerSection";

/** The session identity of a signed-out viewer (see useEventViewerState). */
const ANONYMOUS_VIEWER = "anonymous";

/**
 * The public event page below the gate.
 *
 * Deliberately a CLIENT component even though the route renders it from an RSC:
 * the identical tree has to be mountable on the client, because a gated event's
 * document is edge-cached and therefore always ships the gate wall. A viewer
 * who turns out to be unlocked gets this tree swapped in after first paint
 * (`GatedEventShell`), fed by the same {@link EventPageData} the server would
 * have produced.
 *
 * Every child was already `"use client"` except the two JSON-LD emitters; they
 * still land in the SSR HTML for the ungated path, because Next server-renders
 * client components on the first load.
 *
 * ── The viewer half ─────────────────────────────────────────────────────────
 *
 * {@link EventPageData} is the same bytes for everybody (that is the whole
 * point — the route is edge-cached with no `Cookie` in its `Vary`). Anything
 * that depends on who is looking is fetched HERE, after first paint, from
 * `POST /api/events/[eventId]/viewer-state`, and merged in:
 *
 *   - an OBSCURED venue's exact address, for a ticket holder past the reveal
 *     date;
 *   - the "Edit Event" affordance and its `/admin/...` href;
 *   - the viewer's own RSVP state, whole-event and per-date;
 *   - arrival areas beyond the anonymous list (holders after the reveal,
 *     acts on the bill, the place's managers).
 *
 * Until it lands (and forever, if it fails) the page shows the redacted,
 * signed-out view. There is no state in which a failure reveals more.
 */
export function EventPageBody({ data }: { data: EventPageData }) {
  const viewer = useEventViewerState(data.eventId);

  const publicEvent = data.event;

  /**
   * The event as THIS viewer may see it.
   *
   * Only `location` is ever replaced, and only with a payload the API already
   * ruled revealed (active ticket + `addressRevealAt` passed — the endpoint
   * keys on the API's own `isExact` verdict rather than re-deriving the rule).
   * `null` leaves the server's obscured location in place, which is what every
   * failure path produces.
   */
  const viewerEvent = useMemo(
    () =>
      viewer?.location
        ? { ...publicEvent, location: viewer.location }
        : publicEvent,
    [publicEvent, viewer?.location],
  );

  const revealed = viewerEvent !== publicEvent;

  // Arrival areas: the viewer's own list (holder, act, staff, passed gate)
  // when the probe returned one, else the anonymous list the cached payload
  // carries. A failed probe leaves `null`, so the cached list stands.
  const arrivalAreas = viewer?.viewerArrivalAreas ?? data.arrivalAreas;

  // One-shot settle for the reveal (see the wrapper's note). Starts settled so
  // the server render, the hydration render and every non-revealing viewer are
  // all plain `opacity: 1` — the animation only exists for the frame after the
  // location actually changes.
  const [settled, setSettled] = useState(true);
  useEffect(() => {
    if (!revealed) return;
    setSettled(false);
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [revealed]);

  const communityDates: CommunityEventDate[] = useMemo(
    () =>
      data.communityDates.map((d) => ({
        ...d,
        viewerRsvped: viewer?.dateRsvps[d.eventDateId] ?? false,
      })),
    [data.communityDates, viewer?.dateRsvps],
  );

  const heroImageUrl = publicEvent.images?.[0];
  const isRsvpEvent = publicEvent.attendanceMode === "RSVP";

  /*
   * A community listing runs a TWO-TRACK body (prose + a sticky fact rail), and
   * 48rem is a ONE-column measure. Splitting it 7fr/5fr left the prose column
   * 401px at a 1440px viewport — MEASURED: ~45 characters a line against the
   * ~65 the design system asks for, prose images rendered 401x268 on a desktop
   * screen, and the audio player's waveform collided with its own time readout
   * because the control had nowhere to go. 62rem gives the prose ~560px (~65
   * characters) and the rail ~360px, which is what the address needs to stop
   * wrapping to four lines.
   *
   * Every other event keeps 48rem exactly.
   */
  const usesCommunityBody =
    publicEvent.stewardship === "COMMUNITY" && isRsvpEvent;

  /*
   * A POSTER event runs a two-column hero wide — the poster in a 440px rail,
   * everything the reader decides on beside it (`.event-page-split` in
   * event-content.css). MEASURED at 1440x900 before that: a 2:3 gig flyer
   * rendered 768x1152 in this column, so the title, date, venue, price and CTA
   * were all a full viewport below the fold.
   *
   * 68rem (1088px) is what the split needs at full size: a 24px inset, a 440px
   * rail, the canvas's 56px gutter, and 544px left for the decision column.
   *
   * THIS MAX-WIDTH IS HALF OF A PAIR. It cannot carry a media query — it is an
   * inline style — so the moment it lets the column past 48rem, the poster
   * frame gets wider, and a portrait poster that gets wider gets TALLER. The
   * split's threshold is therefore pinned to the same 768px that 48rem is, and
   * `EventContent.test.tsx` fails if the two ever drift. MEASURED when they
   * did: columns at 900 against a page open from 768 put the <h1> 1325px down
   * an 880px-wide window, worse than the one-column page being replaced.
   *
   * THE PROSE DOES NOT WIDEN WITH THE PAGE. Everything below the hero flows
   * in the decision column beside the rail (`.event-page-split__content`),
   * which is 544px at this cap — the ~65-character measure. That is the
   * whole lesson of the paragraph above: 48rem is a ONE-column measure, and
   * the prose keeps a one-column measure by living in one column.
   *
   * Community keeps 62rem (its own two-track body, out of scope here) and a
   * posterless event keeps 48rem: its Date Stub is a fixed 16:9 plate, 432px
   * tall in this column, which was never a wall.
   */
  const usesSplitHero = !usesCommunityBody && Boolean(heroImageUrl);

  return (
    <>
      <HeroBackdrop imageUrl={heroImageUrl} />
      <div
        data-testid="event-page-column"
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: usesCommunityBody
            ? "62rem"
            : usesSplitHero
              ? "68rem"
              : "48rem",
          width: "100%",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/*
          JSON-LD and the page <head> are emitted from the PUBLIC event and can
          never be corrected client-side — `generateMetadata` runs on the
          server for the same shared document, and a crawler reads neither our
          fetch nor our state.

          That is the CORRECT outcome, not a limitation to fix later: an
          OBSCURED venue's street address, postcode and coordinates have no
          business in `event:location:*` meta or in a schema.org `Event` on a
          page that is `index: true`. Structured data describes the event as it
          is published to the public; the reveal is a private grant to ticket
          holders. Do not "improve" this by feeding `viewerEvent` in here.
        */}
        <EventJsonLd
          event={publicEvent}
          enrichment={data.jsonLdEnrichment}
        />
        <EventBreadcrumbJsonLd eventName={publicEvent.name} />
        <div
          // The reveal necessarily lands a beat after paint, and it moves real
          // layout: an address line and a pin map replace an area label and a
          // radius circle. Rather than snap, the block settles back up over
          // 220ms the one time the location changes — the same "this just
          // updated" gesture the gate shell uses for its dim-and-restore.
          // `revealed` only ever goes false → true, so it runs at most once.
          style={{
            opacity: settled ? 1 : 0.72,
            transition: "opacity 220ms ease-out",
          }}
          data-address-revealed={revealed ? "1" : undefined}
        >
          <EventDetail
            event={viewerEvent}
            organizerName={publicEvent.organizerName}
            organizerHref={publicEvent.organizerHref}
            refundCutoffAt={publicEvent.refundCutoffAt}
            venueConfirmed={publicEvent.venueConfirmed}
            heroImageSize={publicEvent.heroImageSize ?? null}
            bodyContent={data.bodyContent}
            imageMap={data.imageMap}
            audioItems={data.audioItems}
            ticketTypes={data.ticketTypes}
            eventHumans={data.eventHumans}
            feeRates={data.feeRates ?? undefined}
            tags={data.tags}
            backHref="/"
            // Immersive light-on-dark hero only when there's a poster backing
            // it (HeroBackdrop renders nothing without an image, so a dark
            // scrim over plain cream would look wrong).
            immersiveHero={Boolean(heroImageUrl)}
            editHref={viewer?.editHref ?? undefined}
            hideTicketCta={data.hideTicketCta}
            holderView={data.holderView}
            sellabilityReason={data.sellabilityReason}
            eventId={data.eventId}
            waitlistOpen={data.waitlistOpen}
            waitlistDescription={data.waitlistDescription}
            seriesDates={data.seriesDates}
            showSaveAction
            attendanceMode={publicEvent.attendanceMode}
            stewardship={publicEvent.stewardship}
            viewerRsvped={viewer?.viewerRsvped ?? undefined}
            communityDates={communityDates}
            // Event-intrinsic, so these ride the cached payload untouched — no
            // viewer merge to wait for.
            communityRecurrence={data.communityRecurrence}
            communityDatesTruncated={data.communityDatesTruncated}
            communityNextScheduledDateId={data.communityNextScheduledDateId}
            communityHasRecurrenceRule={data.communityHasRecurrenceRule}
            suggestEditHref={data.suggestEditHref ?? undefined}
            eventStatus={publicEvent.status}
            arrivalAreas={arrivalAreas}
            // Rendered INSIDE the event page rather than beside it: on the
            // poster-first layout they take row 5 of the page grid, in the
            // decision column with everything else. As siblings of the
            // article they were a 48rem block centred under the whole grid —
            // a third left edge, aligned with neither the rail nor the h1.
            belowContent={
              <>
                <VolunteerSection
                  key={data.eventId}
                  eventId={data.eventId}
                  eventStatus={publicEvent.status}
                  eventEndsAt={publicEvent.endsAt ?? null}
                />
                {/* RSVP events have no tickets, so a resale market can't
                    exist. The `resale` feature gate additionally darkens the
                    section (and its listing queries) platform-wide until
                    resale is vetted — fail-closed: a failed gate fetch (null)
                    hides it too. */}
                {!isRsvpEvent && data.resaleEnabled && (
                  <ResaleListingsSection
                    eventId={data.eventId}
                    currency={publicEvent.pricing?.currency ?? "USD"}
                  />
                )}
              </>
            }
          />
        </div>
      </div>
    </>
  );
}

/**
 * Fetches {@link EventViewerState} once per (event, viewer), after first paint.
 *
 * TAGGED with the event and the viewer generation it was fetched for and never
 * read without checking the tag — the same hazard `GatedEventShell` documents:
 * App Router does not key a segment by its dynamic params, so a soft nav from
 * one event to another reconciles this tree in place. An untagged `state`
 * would hold event A's revealed address under event B's URL until the refetch
 * landed.
 *
 * The viewer half of the tag: a sign-out (AppNavbar) or a sign-in through the
 * in-page overlay changes who is reading without a navigation. Each time the
 * known session identity (a user id, or anonymous) changes, the generation
 * bumps during render, so the previous viewer's revealed address, Edit link
 * and arrival areas (load-in included) are gone from that same render, and
 * the page probes again. A change TO anonymous re-probes too rather than just
 * hiding: an anonymous viewer can still hold a gate cookie (password,
 * application, invite) that the endpoint honours.
 *
 * Hydration: returns `null` on the first client render so it matches the
 * server's, which never has viewer state.
 */
function useEventViewerState(eventId: string): EventViewerState | null {
  const session = authClient.useSession();
  // `null` while the session read is in flight: not yet a known identity.
  const identity = session.isPending
    ? null
    : (session.data?.user?.id ?? ANONYMOUS_VIEWER);
  const [viewer, setViewer] = useState<{
    identity: string | null;
    generation: number;
  }>({ identity: null, generation: 0 });
  if (identity !== null && identity !== viewer.identity) {
    // The first known identity is the one the first probe already ran under
    // (the endpoint reads the request's cookies, not this hook), so it keeps
    // generation 0; every later change is a new viewer.
    setViewer({
      identity,
      generation:
        viewer.identity === null ? viewer.generation : viewer.generation + 1,
    });
  }
  const probeKey = `${eventId}:${viewer.generation}`;

  const [stateFor, setStateFor] = useState<{
    key: string;
    state: EventViewerState;
  } | null>(null);
  // StrictMode double-invokes effects in dev; one probe per key is enough.
  //
  // NOTE there is deliberately NO cleanup that cancels the in-flight probe.
  // The obvious version — a `cancelled` flag flipped on unmount — is broken
  // under StrictMode and was caught here by driving the page: the first
  // invocation starts the fetch, the immediate cleanup cancels it, and the
  // second invocation short-circuits on this same ref, so the result is thrown
  // away and NO probe ever lands. A ticket holder silently never got their
  // address. The render-time tag below is what makes a late response safe, so
  // cancellation buys nothing.
  const probedFor = useRef<string | null>(null);

  useEffect(() => {
    if (probedFor.current === probeKey) return;
    probedFor.current = probeKey;
    setStateFor(null);

    void (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/viewer-state`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
        });
        if (!res.ok) {
          // The endpoint answers 4xx with the empty (safe) state, so there is
          // nothing to apply — but a systematically failing probe silently
          // strips every editor's Edit button and every holder's address, and
          // from the outside that reads as "the reveal stopped working".
          traceIgnoredError("event.page.viewerStateProbe")(
            new Error(`viewer-state responded ${res.status}`),
          );
          return;
        }
        const state = (await res.json()) as EventViewerState;
        // A newer probe (another event or another viewer) owns the slot: a
        // late answer must not overwrite its state.
        if (probedFor.current !== probeKey) return;
        // Tagged with the key it was fetched for; the render-time check
        // below drops it if the segment has since moved to another event or
        // another viewer.
        setStateFor({ key: probeKey, state });
      } catch (err) {
        // Network/parse failure — fail closed, the redacted page stands.
        traceIgnoredError("event.page.viewerStateProbe")(err);
      }
    })();
  }, [eventId, probeKey]);

  return stateFor?.key === probeKey ? stateFor.state : null;
}
