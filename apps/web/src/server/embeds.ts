import "server-only";

import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import { TRPCClientError } from "@trpc/client";

import { getSiteUrl } from "@/config/site";
import { parseEmbedView, type EmbedView } from "@/lib/embed-view";
import { getServerTrpcClient } from "@/server/trpc-client";

/**
 * The embed's stored browse-view default, resolved on the SERVER so the widget
 * knows which view it is rendering on render 0.
 *
 * WHY THIS EXISTS: `defaultView` only reaches the client inside a widget
 * payload, and the widget must pick WHICH payload to fetch before it has one.
 * Resolving that client-side means a bare `/embed/<id>` on a calendar-default
 * row fetches the grid first just to read the flag, then fetches the calendar
 * — two requests and a discarded events payload on the exact URL shape that is
 * already pasted across the internet (a bare `/embed/<id>` is what every
 * pre-feature snippet emitted, and retargeting it is the whole point of a
 * config-time default — D-002). Resolving here makes the initial load fire
 * exactly ONE of getForWidget / getCalendarEvents (NFR-002).
 *
 * COST: the only door onto the flag is `getForWidget`, which also does the
 * subject's events query — so this is not free. It is bounded by the route's
 * `export const revalidate` (see `app/embed/[embedId]/page.tsx`): the page
 * holds no per-viewer state, so its HTML is cached per embedId and this call
 * amortizes to roughly one query per revalidation window per embed, no matter
 * how much traffic the host page gets. The trade-off is that a Default view
 * change reaches bare URLs within that window rather than instantly — the same
 * freshness contract every other public page in this app ships with, and the
 * admin's own preview pins `?view=` so it never lags.
 *
 * SECURITY: `hostOrigin` is OUR OWN origin, which `assertEmbedOriginAllowed`
 * allowlists for admin preview / direct viewing. Only the two view flags are
 * returned — never the events payload — so this can NOT be used to smuggle an
 * embed's data onto a non-allowlisted host page. The browser still makes its
 * own origin-checked request for anything it renders.
 *
 * Failure degrades, never breaks: `null` puts the widget back on the
 * client-side probe path, which resolves the same view one round trip later.
 */
export const getEmbedViewDefault = cache(
  async (embedId: string): Promise<EmbedView | null> => {
    try {
      const result = await getServerTrpcClient().embeds.getForWidget.query({
        embedId,
        hostOrigin: getSiteUrl(),
      });
      return parseEmbedView(result.embed.defaultView);
    } catch (err) {
      // A revoked / unknown / mistyped embedId is a NORMAL public-URL outcome
      // (anyone can request /embed/<garbage>), so those codes are not worth
      // reporting — the client request fails the same way and shows the error
      // screen. Anything else is a genuine degradation and must not be
      // swallowed silently: without this the widget would quietly fall back to
      // double-fetching with no signal anywhere.
      const code =
        err instanceof TRPCClientError
          ? (err.data as { code?: string } | undefined)?.code
          : undefined;
      if (code !== "NOT_FOUND" && code !== "FORBIDDEN") {
        Sentry.captureException(err, {
          tags: { area: "embed-ssr", check: "view-default" },
          extra: { embedId },
        });
      }
      return null;
    }
  },
);
