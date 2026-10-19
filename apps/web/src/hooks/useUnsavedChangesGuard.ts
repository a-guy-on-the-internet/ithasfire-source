"use client";

import { useRouter } from "@bprogress/next/app";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { registerNavigationGuard } from "./navigation-guard";

// useLayoutEffect on the client; a no-op useEffect during SSR, which warns
// about useLayoutEffect (the same split as `use-stable-handler.ts`).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * The slice of a click + its anchor that decides whether an in-app link click
 * leaves the page. Plain values, so the decision is unit-testable without a DOM.
 */
export type GuardedClick = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The anchor's resolved `href`, or null when the click was not on a link. */
  href: string | null;
  target: string | null;
  download: boolean;
};

/**
 * The same-origin path (`pathname + search + hash`) a click would navigate
 * to, or null when the click stays on this page or opens somewhere the
 * current page survives (new tab, download, another origin, modified click).
 * Other origins are left to `beforeunload`.
 *
 * "This page" is the PATHNAME. A link that only changes the query or the hash
 * (the event rail's `?section=` anchors, which scroll in place) keeps the
 * same component tree and the edits in it, so it is not leaving.
 */
export function guardedLinkTarget(
  click: GuardedClick,
  currentHref: string,
): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) {
    return null;
  }
  if (!click.href || click.download) return null;
  if (click.target && click.target !== "_self") return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(currentHref);
    to = new URL(click.href, currentHref);
  } catch {
    return null;
  }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname) return null;
  return `${to.pathname}${to.search}${to.hash}`;
}

/** Where a held navigation goes once the user chooses to discard. */
type PendingLeave = { href: string } | { run: () => void };

/**
 * Key this hook writes into `history.state`, beside Next's own `__NA` /
 * `__PRIVATE_NEXTJS_INTERNALS_TREE`, which every write here keeps. "base"
 * marks the page's own entry, "sentinel" the same-URL entry pushed on top
 * of it while there are unsaved edits. `first` (sentinel only) records that
 * the base is the tab's first entry, so Back from it has nowhere to go.
 */
const HISTORY_MARK = "__thLeaveGuard";
/** How long a Leave waits for its extra `back()` to land before giving up. */
const STUCK_LEAVE_MS = 300;
type HistoryMark = { kind: "base" | "sentinel"; first?: boolean };

function historyMark(state: unknown): HistoryMark | null {
  if (state === null || typeof state !== "object") return null;
  const mark = (state as Record<string, unknown>)[HISTORY_MARK];
  if (mark === null || typeof mark !== "object") return null;
  const kind = (mark as Record<string, unknown>).kind;
  if (kind !== "base" && kind !== "sentinel") return null;
  return { kind, first: (mark as Record<string, unknown>).first === true };
}

function withHistoryMark(
  state: unknown,
  mark: HistoryMark,
): Record<string, unknown> {
  const base =
    state !== null && typeof state === "object"
      ? (state as Record<string, unknown>)
      : {};
  return { ...base, [HISTORY_MARK]: mark };
}

/**
 * The current entry's Navigation API index, where the API exists. Only used
 * to compare two entries of this page (one contiguous same-origin run, so
 * the indexes agree); never to ask whether the page is the tab's first.
 */
function navigationIndex(): number | null {
  const nav = (
    window as { navigation?: { currentEntry?: { index: number } | null } }
  ).navigation;
  const index = nav?.currentEntry?.index;
  return typeof index === "number" && index >= 0 ? index : null;
}

export type UnsavedChangesGuardOptions = {
  /**
   * True for a URL of this page whose history entry the page pushed itself
   * and pops on its own (the event builder's `?view=preview`). The Back
   * sentinel is not based on such an entry, since the page's own pop off it
   * would then read as leaving; it arms once a pop lands elsewhere on the
   * page. Read when arming, not reactively.
   */
  deferBackGuardOn?: (url: URL) => boolean;
};

/**
 * While `dirty`, warns before the page is lost: the browser's native prompt
 * for tab close / reload / full-page navigation (`beforeunload`), and an
 * in-page prompt for in-app links (Next `<Link>` navigations never fire
 * `beforeunload`) and for the browser Back button.
 * `dirty` must be DERIVED by the caller; this holds no dirtiness of its own,
 * only the navigation the user tried to make.
 *
 * `requestNavigation` is the funnel for navigations the page starts itself
 * (Escape, a Cancel button): a path is pushed, a function is called. While
 * dirty it is held behind the same prompt as a link. It is also registered
 * as the page's `navigation-guard` while mounted, so the shell's
 * button-driven navigations (`guardedNavigate`) reach the same prompt.
 *
 * Browser Back. The App Router cannot cancel a traversal, so the first time
 * the page goes dirty the hook marks the current entry "base" and pushes a
 * same-URL "sentinel" entry on top: `[prev, page(base), page(sentinel)]`.
 * Back from the sentinel lands on the base, which is the same route, so
 * nothing unmounts; the hook then pushes the sentinel again and opens the
 * prompt. Leave goes back two entries, to `prev`, and keeps stepping back
 * past any further entries of this same page. A Back that jumps straight to
 * another page (the long-press history menu) is stopped before Next's
 * router sees it: the sentinel is restored, a synthetic `popstate` tells the
 * page's own listeners where it is, and Leave goes one entry back.
 * Entries above the sentinel on the same pathname (the builder's
 * `?view=preview`, a `?section=` or hash move) are the page's own and pass.
 * A tab whose only entry is this page has no Back to guard and is not armed.
 * A base that is otherwise first (Forward entries were cut) takes one Back
 * without a prompt and stays there, where the browser's Back is disabled
 * again; Forward returns to the sentinel and `beforeunload` still covers a
 * close. A Leave that cannot get off the page (the page's own entries reach
 * the start of the tab) gives up after a moment: the user stays, the prompt
 * is closed, and the guard arms again.
 *
 * The sentinel stays for the life of the page once pushed, so a form that
 * flips dirty and clean as the user types and undoes does not churn
 * history. While clean, Back from the sentinel lands on the base and the
 * hook steps back once more, so Back still leaves in one press. A page that
 * never goes dirty touches no history at all.
 */
export function useUnsavedChangesGuard(
  dirty: boolean,
  { deferBackGuardOn }: UnsavedChangesGuardOptions = {},
) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingLeave | null>(null);
  /**
   * Set by "Leave and discard" so the navigation the user just confirmed does
   * not raise the browser's own prompt as well (a push that falls back to a
   * full page load fires `beforeunload`). It covers that one navigation:
   * consumed by the first `beforeunload` it lets through, and cleared when
   * the form goes clean or a new prompt opens.
   */
  const bypassRef = useRef(false);

  useEffect(() => {
    if (!dirty) {
      bypassRef.current = false;
      setPending(null);
      return;
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (bypassRef.current) {
        bypassRef.current = false;
        return;
      }
      e.preventDefault();
      // Legacy browsers need a returnValue; modern ones ignore the text.
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      // A link inside the description editor is text being edited, not a
      // way out; the editor decides what a click there does.
      if (el?.closest('[contenteditable]:not([contenteditable="false"])')) {
        return;
      }
      const anchor = el?.closest("a[href]") ?? null;
      const href = guardedLinkTarget(
        {
          defaultPrevented: e.defaultPrevented,
          button: e.button,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          href: anchor ? (anchor as HTMLAnchorElement).href : null,
          target: anchor?.getAttribute("target") ?? null,
          download: anchor?.hasAttribute("download") ?? false,
        },
        window.location.href,
      );
      if (!href) return;
      // Capture phase on document: runs before Next's Link handler.
      e.preventDefault();
      e.stopPropagation();
      bypassRef.current = false;
      setPending({ href });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  // ── Browser Back (see the JSDoc for the history layout) ──────────────────
  /** `dirty` for the `popstate` listener, which outlives any one render. */
  const dirtyRef = useRef(dirty);
  useIsomorphicLayoutEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  /** A sentinel sits at or below the current entry. Refs survive StrictMode's
   * effect replay, so the sentinel is pushed once per page. */
  const armedRef = useRef(false);
  /** The sentinel to restore; its mark says whether the base is first. */
  const sentinelRef = useRef<{ state: unknown; href: string } | null>(null);
  /**
   * Whether the current entry is the sentinel or above it. A pop landing on
   * the base came down from the sentinel (Back) only when this was true;
   * from below it is a Forward, which is never stopped or bounced.
   */
  const aboveBaseRef = useRef(false);
  /** The sentinel's Navigation API index, to place a plain entry of the
   * page above or below it after a long-press jump. */
  const sentinelIndexRef = useRef<number | null>(null);
  /** Records that the current entry is the sentinel. */
  const onSentinelNow = useCallback(() => {
    aboveBaseRef.current = true;
    sentinelIndexRef.current = navigationIndex();
  }, []);

  const deferOnRef = useRef(deferBackGuardOn);
  useIsomorphicLayoutEffect(() => {
    deferOnRef.current = deferBackGuardOn;
  }, [deferBackGuardOn]);

  // Mark the current entry as the base and push the sentinel: on the first
  // dirty render, or on a later pop back onto the page if it was deferred.
  // URL arguments are omitted so the entries keep the current URL and
  // Next's patched history methods dispatch nothing. Refs only, so stable.
  const armBackGuard = useCallback(() => {
    if (!dirtyRef.current || armedRef.current) return;
    const state: unknown = window.history.state;
    if (historyMark(state)?.kind === "sentinel") {
      armedRef.current = true;
      sentinelRef.current = { state, href: window.location.href };
      onSentinelNow();
      return;
    }
    if (deferOnRef.current?.(new URL(window.location.href))) return;
    // The tab's only entry: Back is disabled, nothing to guard.
    if (window.history.length <= 1) return;
    armedRef.current = true;
    window.history.replaceState(withHistoryMark(state, { kind: "base" }), "");
    window.history.pushState(withHistoryMark(state, { kind: "sentinel" }), "");
    // Pushing cut any Forward entries, so a length of 2 means the base is
    // the first entry. Counted across origins, unlike Navigation API indexes.
    // (Navigations inside iframes add to the length too, which can only make
    // a first base read as not first: Leave then gives up, see below.)
    const sentinel = withHistoryMark(state, {
      kind: "sentinel",
      first: window.history.length === 2,
    });
    window.history.replaceState(sentinel, "");
    sentinelRef.current = { state: sentinel, href: window.location.href };
    onSentinelNow();
  }, [onSentinelNow]);

  // Listens for the life of the page, not just while dirty: a page that went
  // clean still needs its Back stepped past the base entry.
  useEffect(() => {
    const pagePath = window.location.pathname;
    const adoptIfOnSentinel = () => {
      if (window.location.pathname !== pagePath) return false;
      if (historyMark(window.history.state)?.kind !== "sentinel") return false;
      armedRef.current = true;
      sentinelRef.current = {
        state: window.history.state,
        href: window.location.href,
      };
      onSentinelNow();
      return true;
    };
    // Remounted onto a sentinel (reload, Forward, Back from a link it left
    // by): adopt it rather than stacking another.
    adoptIfOnSentinel();
    const baseIsFirst = () =>
      historyMark(sentinelRef.current?.state)?.first === true;
    const pushSentinel = () => {
      const sentinel = sentinelRef.current;
      if (!sentinel) return;
      window.history.pushState(sentinel.state, "", sentinel.href);
      onSentinelNow();
    };
    /** Pending check that a Leave's extra `back()` actually moved. */
    let stuckLeaveTimer: ReturnType<typeof setTimeout> | undefined;
    const onPopState = (e: PopStateEvent) => {
      clearTimeout(stuckLeaveTimer);
      const samePage = window.location.pathname === pagePath;
      if (bypassRef.current) {
        // The user chose Leave. A pop that still lands on this page (an
        // older entry of it below the base) keeps going until it is off.
        if (!samePage) return;
        window.history.back();
        // At the start of the tab's history that back() does nothing and no
        // pop follows. The user cannot leave this way: they stay, with the
        // unload warning and the Back guard on again.
        stuckLeaveTimer = setTimeout(() => {
          bypassRef.current = false;
          armedRef.current = false;
          armBackGuard();
        }, STUCK_LEAVE_MS);
        return;
      }
      if (adoptIfOnSentinel()) return;
      if (!armedRef.current) {
        // Back on a plain entry of the page (off the builder's preview):
        // a deferred sentinel can arm now.
        if (samePage) armBackGuard();
        return;
      }
      const onBase =
        samePage && historyMark(window.history.state)?.kind === "base";
      // Same pathname, not the base: one of the page's own entries (preview,
      // a query or hash move). Nothing is lost. Where the Navigation API can
      // tell, note which side of the sentinel it is, so a later Forward onto
      // the base is not taken for a Back.
      if (samePage && !onBase) {
        const index = navigationIndex();
        const sentinelIndex = sentinelIndexRef.current;
        // Without the API, assume below: any way back above the base passes
        // through the sentinel, which sets this again.
        aboveBaseRef.current =
          index !== null && sentinelIndex !== null && index >= sentinelIndex;
        return;
      }
      const cameDown = aboveBaseRef.current;
      aboveBaseRef.current = false;
      if (onBase) {
        // A Forward from below the base: let it be.
        if (!cameDown) return;
        if (!dirtyRef.current) {
          // Clean: the base duplicates the page Back was pressed on, so
          // take the one more step meant. A first base has no step to take.
          if (!baseIsFirst()) window.history.back();
          return;
        }
        // A first base: the Back is spent here and the browser's Back is
        // disabled again. No prompt, since there is nowhere to leave to.
        if (baseIsFirst()) return;
        // Same route, so Next keeps this page mounted. Put the sentinel back.
        pushSentinel();
        bypassRef.current = false;
        setPending({ run: () => window.history.go(-2) });
        return;
      }
      // Jumped off the page (history menu, or a browser that skipped the
      // base).
      if (!dirtyRef.current) return;
      // Capture phase on window runs before Next's own listener, so stopping
      // here keeps the router on this page.
      e.stopImmediatePropagation();
      pushSentinel();
      // The page may have been on an entry of its own above the sentinel
      // (the builder's preview). Its listeners learn where it is now.
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
      bypassRef.current = false;
      setPending({ run: () => window.history.go(-1) });
    };
    window.addEventListener("popstate", onPopState, true);
    return () => {
      window.removeEventListener("popstate", onPopState, true);
      clearTimeout(stuckLeaveTimer);
      bypassRef.current = false;
    };
  }, [armBackGuard, onSentinelNow]);

  // Every commit, not just on `dirty`: a deferred arm also waits on the URL,
  // which a page can rewrite with `replaceState` (no `popstate`; the
  // builder's exit from a deep-linked preview) and then re-render. Cheap:
  // returns at once unless dirty and not yet armed.
  useEffect(() => {
    armBackGuard();
  });

  const go = useCallback(
    (to: PendingLeave) => {
      if ("href" in to) router.push(to.href);
      else to.run();
    },
    [router],
  );

  const requestNavigation = useCallback(
    (to: string | (() => void)) => {
      const target: PendingLeave =
        typeof to === "string" ? { href: to } : { run: to };
      if (!dirty) {
        go(target);
        return;
      }
      bypassRef.current = false;
      setPending(target);
    },
    [dirty, go],
  );

  // The shell's button navigations come through here. Registered once, and
  // read through a ref so the registration does not churn with `dirty`.
  // Layout effect, so the ref is current before the browser paints: a
  // non-discrete change (a save resolving, the venue clamp) must not leave
  // the shell reading last frame's `dirty`.
  const requestNavigationRef = useRef(requestNavigation);
  useIsomorphicLayoutEffect(() => {
    requestNavigationRef.current = requestNavigation;
  }, [requestNavigation]);
  useEffect(
    () => registerNavigationGuard((go) => requestNavigationRef.current(go)),
    [],
  );

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    if (!pending) return;
    bypassRef.current = true;
    setPending(null);
    go(pending);
  }, [pending, go]);

  return {
    /** The leave prompt is open. */
    prompting: pending !== null,
    /** The held link's path, or null (also null for a held `run`). */
    pendingHref: pending && "href" in pending ? pending.href : null,
    stay,
    leave,
    requestNavigation,
  };
}
