"use client";

import { useEffect, useRef, useState } from "react";

import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";
import { authClient } from "@/lib/auth/auth-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

/**
 * The query the page editor's mobile preview adds to `/p/<slug>` so the page
 * shows the public view, never the manager's own areas.
 */
export const PUBLIC_PREVIEW_QUERY = "preview=public";

/**
 * True when this page was opened as the editor's public preview.
 *
 * Read in the browser, never on the server: `/p/[slug]` is ISR, and reading
 * `searchParams` there would make every view a dynamic render. The server HTML
 * is the same anonymous render for every URL, so an edge-cached copy of the
 * `?preview=public` URL holds nothing a stranger does not already get; the
 * query only switches OFF the per-viewer probe that runs after hydration.
 * Reading it during render is hydration-safe because the probe's answer is
 * `null` on the first render either way.
 */
export function isPublicPreviewLocation(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("preview") === "public";
}

/**
 * The viewer's arrival areas for this place, fetched after hydration from
 * `POST /api/places/[placeId]/arrival-areas` (no-store). `null` until it
 * lands and forever on a failure, so the server's anonymous list stands:
 * nothing here can widen the page on an error. NFR-002: never logs a shape
 * or a point.
 *
 * The stored answer is tagged with BOTH the signed-in user and the place it
 * was fetched for, and is returned only while both still match. A soft
 * navigation never shows one place's areas on another's page, and a sign-out
 * followed by someone else signing in through the in-page overlay never shows
 * the first person's list (load-in, a withheld place's areas) to the second,
 * even when the second person's probe fails.
 *
 * Only a signed-in viewer is probed: on a place page the areas beyond the
 * anonymous list go only to the place's managers, so a stranger's probe
 * could never add anything and would cost every page view a round trip.
 * The session read is the one `PlaceHeroActions` already makes.
 *
 * `enabled: false` (the editor's public-page preview) never probes, so the
 * preview shows exactly the anonymous list a stranger sees. The editor's
 * MOBILE preview loads the real page in an iframe with the manager's cookies,
 * so it asks for the same through `?preview=public` (see
 * {@link isPublicPreviewLocation}).
 */
export function useViewerPlaceArrivalAreas(
  placeId: string,
  enabled: boolean,
): VisibleArrivalArea[] | null {
  const session = authClient.useSession();
  const probe = enabled && !isPublicPreviewLocation();
  const userId = probe ? (session.data?.user?.id ?? null) : null;
  const [stateFor, setStateFor] = useState<{
    userId: string;
    placeId: string;
    areas: VisibleArrivalArea[] | null;
  } | null>(null);
  // One probe per (user, place), StrictMode-safe (see EventPageBody's
  // viewer-state).
  const probedFor = useRef<string | null>(null);
  // The (user, place) the page shows right now; an answer for any other key
  // landed after the viewer changed and is dropped.
  const currentKey = useRef<string | null>(null);

  useEffect(() => {
    currentKey.current = userId ? `${userId}:${placeId}` : null;
    // Any change of viewer or place drops the stored answer first, so a
    // failed probe can never leave the previous viewer's list standing.
    setStateFor((prev) =>
      prev?.userId === userId && prev.placeId === placeId ? prev : null,
    );
    if (!userId) {
      // Signed out (or never in): re-probe if anyone signs in again.
      probedFor.current = null;
      return;
    }
    const key = `${userId}:${placeId}`;
    if (probedFor.current === key) return;
    probedFor.current = key;
    void (async () => {
      try {
        const res = await fetch(`/api/places/${placeId}/arrival-areas`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
        });
        if (!res.ok) {
          traceIgnoredError("place.arrivalAreas.probe")(
            new Error(`arrival-areas responded ${res.status}`),
          );
          return;
        }
        const body = (await res.json()) as {
          areas?: VisibleArrivalArea[] | null;
        };
        // The viewer changed while this was in flight: the answer belongs to
        // someone else's session, so it is dropped.
        if (currentKey.current !== key) return;
        setStateFor({
          userId,
          placeId,
          areas: Array.isArray(body.areas) ? body.areas : null,
        });
      } catch (err) {
        traceIgnoredError("place.arrivalAreas.probe")(err);
      }
    })();
  }, [placeId, userId]);

  return userId &&
    stateFor?.userId === userId &&
    stateFor.placeId === placeId
    ? stateFor.areas
    : null;
}
