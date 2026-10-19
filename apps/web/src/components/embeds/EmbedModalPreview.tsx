"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { EmbedScope } from "@/lib/embed-scope";
import { DEFAULT_EMBED_SCOPE } from "@/lib/embed-scope";
import type { EmbedThemeEntries } from "@/lib/embed-snippets";
import type { EmbedView } from "@/lib/embed-view";
import { DEFAULT_EMBED_VIEW } from "@/lib/embed-view";

/**
 * Live preview of a MODAL embed — the LITERAL trigger button a visitor sees.
 *
 * Serves both modal widgets: the venue booking button (`widget: "booking"`,
 * "Request to book") and the tickets modal ("Get Tickets"). Rather than iframe
 * the widget inline, this mounts the REAL embed SDK (`/embed/hf-embed.js`) with
 * the SAME options the copyable snippet emits — so the button + themed modal
 * chrome can never drift from what the organiser pastes. The SDK renders its
 * branded button (honouring `theme.brandColor`); clicking it opens the same
 * full-screen modal (lazy-loaded, themed by the same params) that ships on the
 * organiser's own site.
 *
 * The widget iframe loads from our own origin, which `assertEmbedOriginAllowed`
 * always allowlists — so the preview renders regardless of which domains the
 * organiser has added.
 */

type HfWidgetHandle = { destroy: () => void };
type HfSdk = {
  version?: string;
  createWidget: (options: Record<string, unknown>) => HfWidgetHandle;
};

declare global {
  interface Window {
    HF?: HfSdk & { _q?: unknown[] };
  }
}

let sdkPromise: Promise<HfSdk> | null = null;

/**
 * Load `hf-embed.js` once per page and resolve with the real (queue-drained)
 * SDK global. We wait for the script to finish so `createWidget` returns a
 * destroyable handle — the pre-load stub only queues and can't hand one back.
 */
function loadHfSdk(siteUrl: string): Promise<HfSdk> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("HF SDK unavailable during SSR"));
  }
  if (window.HF?.version) return Promise.resolve(window.HF);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<HfSdk>((resolve, reject) => {
    const settle = () => {
      if (window.HF?.version) resolve(window.HF);
      else reject(new Error("HF SDK loaded but did not initialise"));
    };
    // On failure, drop BOTH the cached promise and the dead <script> node.
    // A script that has already fired `error` never fires again, so leaving
    // it in the DOM would make the next retry re-attach to a corpse and hang
    // forever — remove it so the retry appends a fresh, live script.
    const fail = (script: HTMLScriptElement) => () => {
      sdkPromise = null;
      script.remove();
      reject(new Error("HF SDK failed to load"));
    };

    // Reuse an in-flight script (concurrent first mounts) but never a settled
    // one: a successful load short-circuits at the `window.HF?.version` guard
    // above before we get here, and a failed load removed its node, so any
    // element still present is genuinely mid-load.
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-hf-embed-sdk]",
    );
    if (existing) {
      existing.addEventListener("load", settle);
      existing.addEventListener("error", fail(existing));
      return;
    }

    const script = document.createElement("script");
    script.src = `${siteUrl}/embed/hf-embed.js`;
    script.async = true;
    script.dataset.hfEmbedSdk = "true";
    script.addEventListener("load", settle);
    script.addEventListener("error", fail(script));
    document.head.appendChild(script);
  });

  return sdkPromise;
}

export type EmbedModalWidget = "booking" | "tickets";

const DEFAULT_TRIGGER_TEXT: Record<EmbedModalWidget, string> = {
  booking: "Request to book",
  tickets: "Get Tickets",
};

export interface EmbedModalPreviewProps {
  siteUrl: string;
  embedId: string;
  /** Which modal widget to mount. Defaults to the booking button. */
  widget?: EmbedModalWidget;
  /** Overrides the default trigger label for the chosen widget. */
  triggerText?: string;
  /**
   * Theme overrides as `[key, hex]` pairs (6-char hex, no `#`), exactly the
   * shape the snippet builders emit. `brandColor` themes the button; all four
   * params theme the widget. Omit for the default (orange) button.
   */
  themeEntries?: EmbedThemeEntries;
  /**
   * Which events an owner tickets widget renders. Ignored for booking (the
   * SDK/server drop it for a place subject). Omit / `own` = the default.
   */
  scope?: EmbedScope | null;
  /**
   * Which browse view the modal opens on. Ignored for booking (no views).
   * Omit / `list` = the embed's configured default, so nothing is sent.
   */
  view?: EmbedView | null;
}

export function EmbedModalPreview({
  siteUrl,
  embedId,
  widget = "booking",
  triggerText,
  themeEntries,
  scope,
  view,
}: EmbedModalPreviewProps) {
  // Plain DOM node: the SDK appends its raw <button> here and manages its own
  // overlay, so we hand it an element it fully owns rather than a Tamagui view.
  const containerRef = useRef<HTMLDivElement>(null);

  // Stable theme object + a primitive key so the effect only re-mounts the
  // widget when the theme actually changes (not on every parent render).
  const theme = useMemo<Record<string, string>>(
    () => Object.fromEntries(themeEntries ?? []),
    [themeEntries],
  );
  const themeKey = useMemo(
    () =>
      (themeEntries ?? []).map(([key, value]) => `${key}:${value}`).join(","),
    [themeEntries],
  );

  // Everything baked into the widget at createWidget time — a change to any of
  // these needs a remount. `scope` only matters for the tickets widget.
  const configKey = `${widget}|${triggerText ?? ""}|${scope ?? ""}|${view ?? ""}|${themeKey}`;

  // Rebuilding the widget bakes the theme into the button + the modal iframe
  // src, so a live re-theme genuinely needs a remount. But a native
  // `<input type="color">` fires continuously while dragged — debounce so the
  // preview settles on the chosen colour instead of flickering per tick. The
  // first mount is immediate (initial state === current key).
  const [appliedConfigKey, setAppliedConfigKey] = useState(configKey);
  useEffect(() => {
    const timer = setTimeout(() => setAppliedConfigKey(configKey), 120);
    return () => clearTimeout(timer);
  }, [configKey]);

  useEffect(() => {
    if (!containerRef.current) return;

    let handle: HfWidgetHandle | null = null;
    let cancelled = false;

    void loadHfSdk(siteUrl)
      .then((HF) => {
        if (cancelled || !containerRef.current) return;
        handle = HF.createWidget({
          embedId,
          container: containerRef.current,
          mode: "modal",
          triggerText: triggerText ?? DEFAULT_TRIGGER_TEXT[widget],
          // The SDK defaults to the tickets widget when `widget` is omitted.
          ...(widget === "booking" ? { widget: "booking" } : {}),
          ...(Object.keys(theme).length > 0 ? { theme } : {}),
          // Booking ignores scope; only send a non-default scope for tickets.
          ...(widget === "tickets" && scope && scope !== DEFAULT_EMBED_SCOPE
            ? { scope }
            : {}),
          // Same rule for the browse view: booking has none, and "list" is
          // the default the SDK omits — so the preview URL matches the
          // snippet the organiser copies, param for param.
          ...(widget === "tickets" && view && view !== DEFAULT_EMBED_VIEW
            ? { view }
            : {}),
        });
      })
      .catch(() => {
        // Preview is best-effort — the copyable snippet and "Open" link still
        // work if the SDK can't load. Swallow so a preview failure never
        // breaks the settings page.
      });

    return () => {
      cancelled = true;
      handle?.destroy();
    };
    // All createWidget inputs are folded into `appliedConfigKey` (debounced);
    // keying the effect on the primitive avoids a per-tick remount while a
    // colour is dragged and never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteUrl, embedId, appliedConfigKey]);

  return <div ref={containerRef} />;
}
