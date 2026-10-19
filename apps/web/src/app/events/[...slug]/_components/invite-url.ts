import {
  ANALYTICS_URL_SCRUBBED_EVENT,
  INVITE_STASH_PREFIX,
} from "@/components/analytics/analytics-url-guard";

/**
 * Taking a gated-event invite token (`?invite=<token>`) out of the address
 * bar without breaking the App Router. Shared by the gated shell
 * (`useInviteLink`, which keeps the token) and `InviteParamScrubber` (every
 * other event-page branch, which drops it).
 *
 * Two steps, because of where Next installs its history patch
 * (next 16.3.0-preview.8, `dist/client/components/app-router.js`):
 *
 *  1. `stripInviteParam` runs in a LAYOUT effect, before any fetch. On the
 *     first commit that is before AppRouter's PASSIVE effect (~line 233) has
 *     patched `history.replaceState`, so this may call the browser's own
 *     method. It therefore passes the CURRENT `history.state` through: that
 *     state was written by `HistoryUpdater` in an insertion effect (~line 39,
 *     `__NA` + `__PRIVATE_NEXTJS_INTERNALS_TREE`), and without it `onPopState`
 *     ignores the entry (`!event.state`, ~line 285) and Back stops working.
 *     With `__NA` present, the patch (when it is installed) passes the call
 *     straight through (~line 271) — the router is NOT told.
 *
 *  2. `syncRouterToCleanUrl`, called from a PASSIVE effect, schedules one
 *     macrotask. All passive effects of a commit run in one synchronous flush,
 *     and AppRouter (an ancestor) commits no later than this component, so by
 *     the time the task runs the patch is installed. It calls
 *     `replaceState(null, …)` on purpose: a state without `__NA` takes the
 *     patch's other branch, which copies `__NA` and the tree onto it
 *     (`copyNextJsInternalHistoryState`, ~line 84) and dispatches
 *     `ACTION_RESTORE` with the clean URL (~line 238). That moves the
 *     router's `canonicalUrl` off `?invite=`, so the next `HistoryUpdater`
 *     run (a refresh, a server action) cannot write the token back.
 */

const INVITE_PARAM = "invite";

function cleanHref(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Strips `?invite=` (or another bearer param: `/invites/stop` passes
 * `token`) from the address bar, keeping the path, every other
 * parameter, the hash and the history state. `stripped`: the param was there
 * (even empty) and is gone, so the router needs the sync below. `token`: its
 * value, or null when empty. Idempotent: a second call finds nothing.
 *
 * ACCEPTED RESIDUAL: the token leaves the visible URL and the entry's URL but
 * stays inside `history.state`. Next keys the page segment by its search
 * params (`__PAGE__?{"invite":…}`) in the tree it stores there, and that
 * state is deliberately kept (step 1 above). It is local to this browser and
 * never sent over the network. The gated shell ALSO keeps it in
 * sessionStorage (`stashInviteToken`) so a reload before the tap does not lose
 * the invite: no new exposure, since history.state already holds it for this
 * tab, and sessionStorage is likewise same-tab, same-origin and never sent to
 * the server.
 */
export function stripInviteParam(param: string = INVITE_PARAM): {
  stripped: boolean;
  token: string | null;
} {
  const none = { stripped: false, token: null };
  if (typeof window === "undefined") return none;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return none;
  }
  if (!url.searchParams.has(param)) return none;
  const token = url.searchParams.get(param);
  url.searchParams.delete(param);
  try {
    window.history.replaceState(window.history.state, "", cleanHref(url));
  } catch {
    // A sandboxed frame can refuse; the token is still only used in a body.
  }
  try {
    // The analytics guard re-checks the URL (it otherwise waits for a
    // pathname change, and a strip does not change the pathname).
    window.dispatchEvent(new Event(ANALYTICS_URL_SCRUBBED_EVENT));
  } catch {
    // No listener is required for correctness.
  }
  return { stripped: true, token: token?.trim() ? token : null };
}

/**
 * Tells the App Router the URL is clean (step 2 above). Call from a passive
 * effect after `stripInviteParam` reported `stripped`; returns a cancel.
 */
export function syncRouterToCleanUrl(
  param: string = INVITE_PARAM,
): () => void {
  const id = window.setTimeout(() => {
    try {
      const url = new URL(window.location.href);
      // Someone navigated (or put it back) in between: not ours to touch.
      if (url.searchParams.has(param)) return;
      const prev: unknown = window.history.state;
      window.history.replaceState(null, "", cleanHref(url));
      // Belt: had the patch somehow not been installed, the browser's own
      // method just dropped Next's state. Put it back (Back keeps working;
      // only the router sync is lost, as before this call).
      const hadNa = (prev as { __NA?: unknown } | null)?.__NA;
      const hasNa = (window.history.state as { __NA?: unknown } | null)?.__NA;
      if (hadNa && !hasNa) {
        window.history.replaceState(prev, "", cleanHref(url));
      }
    } catch {
      // Best effort; the address bar is already clean.
    }
  }, 0);
  return () => window.clearTimeout(id);
}

// ── Surviving a reload ────────────────────────────────────────────────────
//
// Once stripped, the token would live only in a ref, so a refresh before the
// guest taps "Open the event" would land on the plain gate. The shell stashes
// it per event in sessionStorage and reads it back on a mount whose URL is
// clean. Every helper swallows storage errors (privacy modes throw): without
// storage the landing behaves as it did before, ref only.

const stashKey = (eventId: string) => `${INVITE_STASH_PREFIX}${eventId}`;

export function stashInviteToken(eventId: string, token: string): void {
  try {
    window.sessionStorage.setItem(stashKey(eventId), token);
  } catch {
    // No storage: a reload loses the invite, as before.
  }
}

export function readStashedInviteToken(eventId: string): string | null {
  try {
    const token = window.sessionStorage.getItem(stashKey(eventId));
    return token?.trim() ? token : null;
  } catch {
    return null;
  }
}

/** Drops the stash; the analytics guard is told so it can re-check. */
export function clearStashedInviteToken(eventId: string): void {
  try {
    window.sessionStorage.removeItem(stashKey(eventId));
  } catch {
    return;
  }
  try {
    window.dispatchEvent(new Event(ANALYTICS_URL_SCRUBBED_EVENT));
  } catch {
    // No listener is required for correctness.
  }
}
