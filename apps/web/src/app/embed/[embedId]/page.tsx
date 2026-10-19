import { Suspense } from "react";

import { getEmbedViewDefault } from "@/server/embeds";

import { EmbedWidget } from "./_components/EmbedWidget";
import { EmbedWidgetFallback } from "./_components/EmbedWidgetFallback";

// ─────────────────────────────────────────────────────────────────────────────
// Ticket widget route — the CANONICAL embed URL and the full in-iframe
// purchase flow. The whole state machine lives in EmbedWidget.
//
// This route pins NOTHING: the widget resolves its own browse view as
// `?view=list|calendar` > the embed's stored `defaultView` > "list" (FR-003),
// which keeps a bare /embed/[embedId] on an untouched row rendering exactly
// today's grid while letting an organiser retarget the canonical URL from the
// admin page. The legacy alias at /embed/calendar/[embedId] pins "calendar".
//
// A SERVER COMPONENT purely so `defaultView` is known before first paint:
// resolving it from a payload would mean fetching the grid just to discover
// the row wants a calendar, i.e. two requests on the bare URL shape that is
// already pasted across the internet. `initialDefaultView` collapses that to
// one (NFR-002). `?view=` is deliberately NOT read here — it is a client
// concern (EmbedWidget reads it, and it outranks this value anyway).
// ─────────────────────────────────────────────────────────────────────────────

// No per-viewer state in this shell, and the URL params stay a client concern
// so they cannot vary a cache. `revalidate` is inert: the route is dynamic
// (the root layout awaits `headers()`/`cookies()`), so each request runs the
// view lookup above. The `/embed/:path*` rule in next.config.ts sets only
// framing headers, so the page has no edge cache.
export const revalidate = 60;

export default async function EmbedWidgetPage({
  params,
}: {
  params: Promise<{ embedId: string }>;
}) {
  const { embedId } = await params;
  const initialDefaultView = await getEmbedViewDefault(embedId);

  return (
    // EmbedWidget reads `?view=` / `?scope=` / theme params via
    // useSearchParams, which suspends during a static render — the boundary is
    // what lets this shell stay cacheable. The fallback is the widget's own
    // loading state, so the framed height never collapses to zero.
    <Suspense fallback={<EmbedWidgetFallback />}>
      <EmbedWidget initialDefaultView={initialDefaultView} />
    </Suspense>
  );
}
