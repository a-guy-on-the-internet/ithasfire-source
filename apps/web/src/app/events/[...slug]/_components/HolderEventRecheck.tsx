"use client";

import { useEffect, useState, type ReactNode } from "react";
import nextDynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import superjson from "superjson";

import { getSiteName } from "@/config/site";
import type { EventPageData } from "@/server/event-page-data";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

// Loaded only when a holder is let in: every other 404 visitor never
// downloads the event page.
const EventPageBody = nextDynamic(
  () => import("./EventPageBody").then((m) => m.EventPageBody),
  { ssr: false },
);

type HolderViewResponse =
  | { access: "none" }
  | { access: "holder"; data: ReturnType<typeof superjson.serialize> };

/** `/events/<slug...>` → `<slug...>`; null for anything else. */
export function eventSlugFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = /^\/events\/(.+?)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * The event route's 404, with ONE chance for a ticket holder (owner ruling,
 * ban-that-sticks 2026-09-29).
 *
 * The event page is edge-cached and rendered for nobody in particular, so an
 * event whose owner is banned 404s for everyone. This renders the ordinary 404
 * (`children`) IMMEDIATELY — anonymous visitors and non-holders see exactly
 * that, with no veil, no spinner and no swap. Only for a SIGNED-IN viewer does
 * it make one uncached, same-origin re-check (`POST /api/events/holder-view`)
 * after first paint, and only if the API says "this viewer holds a ticket and
 * the owner ban is the only reason the page is hidden" does it swap in the
 * event page. Nothing viewer-specific is in the SSR bytes, so nothing
 * viewer-specific can land in the shared cache.
 *
 * Hydration: the first client render equals the server's (`children`); the
 * probe runs in an effect.
 */
export function HolderEventRecheck({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const slug = eventSlugFromPathname(pathname);
  const { verdict } = useSessionVerdict();
  const [revealed, setRevealed] = useState<{
    slug: string;
    data: EventPageData;
  } | null>(null);

  useEffect(() => {
    if (verdict !== "signedIn" || !slug) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/events/holder-view", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as HolderViewResponse;
        if (cancelled || body.access !== "holder") return;
        setRevealed({
          slug,
          data: superjson.deserialize(body.data) as EventPageData,
        });
      } catch (err) {
        // The 404 stands; visible in traces only.
        traceIgnoredError("event.holderView.probe")(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verdict, slug]);

  // The 404's <title> ("Event not found") outlives the swap, so set the one
  // the event route would have: `<event name> • <site>` (layout title template
  // + generateMetadata's `title: event.name`). Restored when the reveal ends.
  const revealedName =
    revealed && revealed.slug === slug ? revealed.data.event?.name : null;
  useEffect(() => {
    if (!revealedName) return;
    const previous = document.title;
    const ours = `${revealedName} • ${getSiteName()}`;
    document.title = ours;
    return () => {
      // On a soft navigation the next route's <title> commits before this
      // cleanup runs; only restore if the title is still the one we set.
      if (document.title === ours) document.title = previous;
    };
  }, [revealedName]);

  // Tagged with the slug it was fetched for, so a soft navigation to another
  // 404 can never show the previous event's page.
  if (revealed && revealed.slug === slug) {
    return <EventPageBody data={revealed.data} />;
  }
  return <>{children}</>;
}
