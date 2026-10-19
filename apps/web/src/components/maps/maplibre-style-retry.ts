import type maplibregl from "maplibre-gl";

import { transformLocalMapLibreRequest } from "./maplibre-missing-image";

export const STYLE_RETRY_DELAY_MS = 1500;

type MapErrorEventLike = {
  error?: unknown;
  tile?: unknown;
  sourceId?: unknown;
};

type AjaxErrorLike = { status: number; url: string };

const withoutQueryOrHash = (url: string): string => url.split(/[?#]/, 1)[0];

// MapLibre's AJAXError (src/util/ajax.ts) carries a numeric `status` (0 for a
// network-level failure, else the HTTP status) and the requested `url`. Its
// `name` stays "Error". Any status gets the retry: a cold start can also 503.
const isAjaxErrorLike = (err: unknown): err is AjaxErrorLike =>
  typeof err === "object" &&
  err !== null &&
  typeof (err as { status?: unknown }).status === "number" &&
  typeof (err as { url?: unknown }).url === "string";

const isStyleUrl = (requestedUrl: string, styleUrl: string): boolean => {
  const requested = withoutQueryOrHash(requestedUrl);
  // MapLibre reports the URL after `transformRequest`, so accept both forms.
  const candidates = [styleUrl, transformLocalMapLibreRequest(styleUrl)?.url];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate !== "" &&
      withoutQueryOrHash(candidate) === requested,
  );
};

/**
 * True when a map `error` event is the whole style document failing to load
 * (not a tile, not a source).
 */
export function isStyleLoadFailure(
  event: MapErrorEventLike | undefined,
  styleUrl: string,
): boolean {
  if (!event || event.tile != null || event.sourceId != null) return false;
  const err = event.error;
  return isAjaxErrorLike(err) && isStyleUrl(err.url, styleUrl);
}

/**
 * Retries the style once when it fails to load. A cold-starting tileserver
 * can drop the first style request and answer seconds later, so one failed
 * fetch is not a dead map.
 *
 * Returns a function for the map's `error` handler: it returns true when it
 * absorbed the error by scheduling the retry, and the caller then skips its
 * failure path. The pending retry is cancelled when the map is removed.
 */
export function installStyleLoadRetry(
  map: maplibregl.Map,
  styleUrl: string,
  delayMs: number = STYLE_RETRY_DELAY_MS,
): (event: MapErrorEventLike | undefined) => boolean {
  let retried = false;
  let removed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  map.on("remove", () => {
    removed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  });

  return (event) => {
    if (retried || removed || !isStyleLoadFailure(event, styleUrl)) {
      return false;
    }
    retried = true;
    timer = setTimeout(() => {
      timer = null;
      if (removed) return;
      try {
        // diff: false rebuilds the style from the URL; a diff needs a loaded
        // style to compare against, and this one never loaded.
        map.setStyle(styleUrl, { diff: false });
      } catch {
        // The map may have been removed between the error and the retry.
      }
    }, delayMs);
    return true;
  };
}
