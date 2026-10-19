/**
 * Ithas Fire Embed JS SDK v1.7.1
 * Lightweight widget loader for third-party sites.
 *
 * Usage (async-safe — correct no matter whether the SDK, the DOM, or the
 * inline init finishes first):
 *   <script>window.HF=window.HF||{_q:[],createWidget:function(o){this._q.push(["createWidget",o])}};</script>
 *   <script src="https://your-domain.com/embed/hf-embed.js" async></script>
 *   <div id="hf-widget"></div>
 *   <script>HF.createWidget({ embedId: "UUID", container: "#hf-widget" });</script>
 *
 * The first line installs a stub that QUEUES createWidget calls made before
 * this (async) script loads; on load the SDK drains the queue and replaces
 * the stub. Calls that were queued (or made while the document is still
 * parsing) render at DOMContentLoaded; their return value is a live handle
 * whose destroy() works before and after creation.
 *
 * v1.7.1: the height ceiling for hf:resize rose from 2000px to 50000px, so a
 * long events list (a phone-width list of 8+ events) is no longer cut off.
 * v1.7.0: view: "list" | "calendar" — which browse view the events widget
 * opens on, appended as ?view= (omitted for "list", the server-side default).
 * This is what gives the calendar the SDK + modal distribution it lacked:
 * `HF.createWidget({ embedId, container, view: "calendar", mode: "modal" })`.
 * Additive and ignored for widget: "booking" (a booking form has no views).
 * Omitting it keeps the embed's configured default view — i.e. exactly the
 * behavior every already-pasted snippet has today.
 * v1.6.1: panel scrolls when content exceeds the viewport cap — host pages
 * running hf-resize.js stretch the modal iframe to full content height, which
 * made the overflow (Turnstile, submit) unreachable behind overflow:hidden.
 * v1.6.0: modal panel height tracks the iframe's content (hf:resize) on
 * desktop — min(content, viewport - 48px), min 320px — re-applied on window
 * resize while open; mobile stays full-screen. Iframes that never post keep
 * the old full-height panel.
 * v1.5.0: modal trigger button label (BOTH the booking "Request to book" and
 * the tickets "Get Tickets" triggers — shared buildModalWidget path) honours
 * theme.fontColor when set, overriding the contrast-aware default so "Text"
 * themes the button label as well as the form. Omitting theme.fontColor keeps
 * the v1.4.0 auto-contrast (branded fill) / brand-coloured (outline) label
 * unchanged, so every already-pasted snippet without fontColor is unaffected.
 * v1.4.0: modal trigger button honours theme.brandColor (branded fill /
 * outline stroke) with a contrast-aware label colour, so a themed embed
 * styles the BUTTON as well as the form. Omitting theme.brandColor keeps the
 * original #FF5721 brand orange every already-pasted snippet has today.
 * v1.3.0: scope: "own" | "venues" | "all" — which events an organization /
 * human widget renders ("venues" = published events at places you own,
 * whoever booked them). Additive: omitting it keeps the "own" behavior every
 * already-pasted snippet has today.
 * v1.2.0: async-safe command queue + DOM-safe createWidget (fixes the
 * DOMContentLoaded-before-async-SDK race: "HF is not defined").
 * v1.1.0: widget: "booking" — renders the place's "Request to book" form
 * (default modal trigger text "Request to book"). Omitting `widget` keeps
 * the original tickets behavior.
 *
 * @see https://docs.ithasfire.events/embed
 * @license MIT
 */
(function () {
  "use strict";

  // Ceiling on the height a widget may ask for. Kept as a guard against a
  // resize feedback loop; set above the widget's tallest list (50 poster
  // cards in one column are ~36,200px) so no real list is clipped.
  var MAX_HEIGHT = 50000;

  // ── Origin derivation ────────────────────────────────────────────────────
  var scriptEl = document.currentScript;
  if (!scriptEl) {
    var scripts = document.querySelectorAll('script[src*="hf-embed"]');
    if (scripts.length) scriptEl = scripts[0];
  }

  var sdkOrigin = "";
  if (scriptEl && scriptEl.src) {
    try {
      var parsed = new URL(scriptEl.src);
      sdkOrigin = parsed.origin;
    } catch (_e) {
      /* ignore */
    }
  }

  if (!sdkOrigin) {
    console.warn(
      "HF SDK: could not derive origin from script src — postMessage callbacks will not fire"
    );
  }

  // ── Hex colour validator ─────────────────────────────────────────────────
  var hexRe = /^[0-9a-fA-F]{6}$/;

  function isValidHex(v) {
    return typeof v === "string" && hexRe.test(v);
  }

  // ── Brand colour + contrast-aware label ──────────────────────────────────
  var BRAND_ORANGE = "#FF5721";

  // The button fill (branded) / stroke (outline). A valid theme.brandColor
  // overrides the default; anything else keeps the brand orange.
  function resolveBrandColor(theme) {
    if (theme && isValidHex(theme.brandColor)) return "#" + theme.brandColor;
    return BRAND_ORANGE;
  }

  // The trigger label colour. A valid theme.fontColor wins (the "Text" knob
  // themes the button label as well as the form); otherwise the caller's
  // computed default (contrast-aware for a fill, brand-coloured for an
  // outline) is kept, so every already-pasted snippet is unchanged.
  function resolveLabelColor(theme, fallback) {
    if (theme && isValidHex(theme.fontColor)) return "#" + theme.fontColor;
    return fallback;
  }

  var INK = "#181818"; // near-black label, matches the app's foreground ink

  // WCAG relative luminance of a `#rrggbb` (or bare 6-char) colour.
  function relativeLuminance(hex) {
    var h = hex.charAt(0) === "#" ? hex.slice(1) : hex;
    var channels = [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
    var linear = channels.map(function (c) {
      var s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function contrastRatio(lumA, lumB) {
    var lighter = Math.max(lumA, lumB);
    var darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // White vs ink for text on a solid `#rrggbb` fill — pick whichever WINS on
  // WCAG contrast (not a single luminance threshold), so a mid-tone custom
  // brandColor still gets the more legible label.
  function readableTextColor(hex) {
    var h = hex.charAt(0) === "#" ? hex.slice(1) : hex;
    if (h.length !== 6) return "#fff";
    var fill = relativeLuminance(hex);
    var whiteContrast = contrastRatio(fill, 1.0);
    var inkContrast = contrastRatio(fill, relativeLuminance(INK));
    return whiteContrast >= inkContrast ? "#fff" : INK;
  }

  // ── Scope validator ──────────────────────────────────────────────────────
  // Mirrors `embedScopeSchema` in @th/core (own | venues | all).
  var SCOPES = ["own", "venues", "all"];

  function isValidScope(v) {
    return typeof v === "string" && SCOPES.indexOf(v) !== -1;
  }

  // ── View validator ───────────────────────────────────────────────────────
  // Mirrors EMBED_VIEWS in @th/core (list | calendar). "list" is the stored
  // default, so it is never emitted — same rule as scope: "own".
  var VIEWS = ["list", "calendar"];

  function isValidView(v) {
    return typeof v === "string" && VIEWS.indexOf(v) !== -1;
  }

  // ── noop helper ──────────────────────────────────────────────────────────
  function noop() {}

  // ── Widget builders ──────────────────────────────────────────────────────

  function buildInlineWidget(
    options,
    container,
    src,
    autoResize,
    initialHeight,
    callbacks
  ) {
    var onReady = callbacks.onReady;
    var onNavigate = callbacks.onNavigate;
    var onOrderComplete = callbacks.onOrderComplete;
    var onCartUpdate = callbacks.onCartUpdate;

    var iframe = document.createElement("iframe");
    iframe.src = src;
    iframe.width = "100%";
    iframe.style.height = initialHeight + "px";
    iframe.style.border = "none";
    iframe.style.overflow = "hidden";
    iframe.loading = "lazy";
    iframe.allow = "payment";
    iframe.title = options.widget === "booking" ? "Booking request" : "Events";
    // Always send the host page's ORIGIN (never the full URL) to the widget,
    // even under a restrictive site-wide referrer policy — the widget uses it
    // as a Firefox fallback for the server-side domain-allowlist check.
    iframe.referrerPolicy = "strict-origin";

    container.appendChild(iframe);

    function onMessage(event) {
      if (!sdkOrigin || event.origin !== sdkOrigin) return;
      var data = event.data;
      if (
        !data ||
        typeof data.type !== "string" ||
        data.type.indexOf("hf:") !== 0
      )
        return;
      if (event.source !== iframe.contentWindow) return;

      switch (data.type) {
        case "hf:ready":
          onReady({ embedId: data.embedId });
          break;

        case "hf:resize":
          if (
            autoResize &&
            typeof data.height === "number" &&
            data.height > 0 &&
            isFinite(data.height)
          ) {
            iframe.style.height = Math.min(data.height, MAX_HEIGHT) + "px";
          }
          break;

        case "hf:navigate":
          onNavigate({ screen: data.screen });
          break;

        case "hf:orderComplete":
          onOrderComplete({
            orderId: data.orderId,
            totalCents: data.totalCents,
            currency: data.currency,
          });
          break;

        case "hf:cartUpdate":
          onCartUpdate({ items: data.items });
          break;
      }
    }

    window.addEventListener("message", onMessage);

    var destroyed = false;

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("message", onMessage);
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }

    return { destroy: destroy };
  }

  function buildModalWidget(options, container, src, callbacks) {
    var onReady = callbacks.onReady;
    var onNavigate = callbacks.onNavigate;
    var onOrderComplete = callbacks.onOrderComplete;
    var onCartUpdate = callbacks.onCartUpdate;

    var isBooking = options.widget === "booking";
    var triggerText =
      options.triggerText || (isBooking ? "Request to book" : "Get Tickets");
    var triggerStyle = options.triggerStyle || "branded";
    var dialogLabel = isBooking ? "Booking request" : "Ticket purchase";
    var cartActive = false;
    var iframeLoaded = false;
    var isOpen = false;
    var closeTimer = null;

    // ── Trigger button ────────────────────────────────────────────────────
    var triggerEl = null;
    var triggerRendered = false;
    if (options.modalTriggerElementId) {
      triggerEl = document.getElementById(options.modalTriggerElementId);
    }
    if (!triggerEl) {
      triggerEl = document.createElement("button");
      triggerEl.type = "button";
      triggerEl.textContent = triggerText;
      // A custom brandColor gets a contrast-aware label; the DEFAULT orange
      // keeps its original white label (unchanged for every already-pasted
      // snippet — brand-consistent with the app's primary button). A
      // theme.fontColor, when set, overrides the label for either variant.
      var hasCustomBrand =
        options.theme && isValidHex(options.theme.brandColor);
      var brandColor = resolveBrandColor(options.theme);
      var brandedTextColor = hasCustomBrand
        ? readableTextColor(brandColor)
        : "#fff";
      if (triggerStyle === "branded") {
        var fillLabel = resolveLabelColor(options.theme, brandedTextColor);
        triggerEl.style.cssText =
          "background:" +
          brandColor +
          ";color:" +
          fillLabel +
          ";padding:12px 24px;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit";
      } else if (triggerStyle === "outline") {
        var outlineLabel = resolveLabelColor(options.theme, brandColor);
        triggerEl.style.cssText =
          "background:transparent;color:" +
          outlineLabel +
          ";padding:12px 24px;border:2px solid " +
          brandColor +
          ";border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit";
      }
      container.appendChild(triggerEl);
      triggerRendered = true;
    }

    // ── Overlay DOM (appended/removed per open/close) ─────────────────────
    var backdrop = document.createElement("div");
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", dialogLabel);
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center";

    var panel = document.createElement("div");
    panel.style.cssText = "position:relative;background:#fff;overflow:hidden";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "\u2715";
    closeBtn.style.cssText =
      "position:absolute;top:12px;right:12px;z-index:1;cursor:pointer;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:32px;height:32px;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center";

    var iframe = document.createElement("iframe");
    iframe.style.cssText = "width:100%;height:100%;border:none";
    iframe.allow = "payment";
    iframe.title = dialogLabel;
    iframe.tabIndex = 0;
    // See buildInlineWidget: guarantees the origin reaches the widget for the
    // server-side domain-allowlist check (Firefox referrer fallback).
    iframe.referrerPolicy = "strict-origin";

    panel.appendChild(closeBtn);
    panel.appendChild(iframe);
    backdrop.appendChild(panel);

    // Last content height posted by the widget (hf:resize). 0 = none yet;
    // the desktop panel then keeps the legacy full-height sizing so iframes
    // that never post are unaffected.
    var contentHeight = 0;

    function applyPanelSize() {
      var isMobile = window.matchMedia("(max-width:639px)").matches;
      if (isMobile) {
        panel.style.maxWidth = "";
        panel.style.width = "100%";
        panel.style.height = "100vh";
        panel.style.minHeight = "";
        panel.style.borderRadius = "0";
      } else {
        panel.style.maxWidth = "520px";
        panel.style.width = "100%";
        if (contentHeight > 0) {
          // Track the iframe's content, capped to the viewport (48px matches
          // the legacy calc(100vh - 48px) breathing room).
          panel.style.height =
            Math.min(contentHeight, window.innerHeight - 48) + "px";
        } else {
          panel.style.height = "calc(100vh - 48px)";
        }
        // Keep the dialog (and its absolutely-positioned close button) usable
        // even when the widget reports a tiny/empty content height.
        panel.style.minHeight = "320px";
        panel.style.borderRadius = "12px";
      }
      // When content exceeds the cap the panel must scroll or the tail of the
      // form is unreachable — a host page running hf-resize.js stretches THIS
      // iframe to full content height too (it matches iframe[src*="/embed/"]),
      // so the overflow cannot be scrolled from inside the frame.
      panel.style.overflowY =
        contentHeight > 0 && contentHeight > panel.clientHeight
          ? "auto"
          : "hidden";
    }

    function onWindowResize() {
      applyPanelSize();
    }

    function open() {
      if (isOpen) return;
      isOpen = true;

      if (!iframeLoaded) {
        iframe.src = src;
        iframeLoaded = true;
      }

      applyPanelSize();
      window.addEventListener("resize", onWindowResize);

      backdrop.style.transition = "opacity 0.18s ease";
      backdrop.style.opacity = "0";
      panel.style.transition = "transform 0.18s ease, opacity 0.18s ease";
      panel.style.transform = "scale(0.97)";
      panel.style.opacity = "0";

      document.body.appendChild(backdrop);
      document.body.style.overflow = "hidden";

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          backdrop.style.opacity = "1";
          panel.style.transform = "scale(1)";
          panel.style.opacity = "1";
        });
      });

      setTimeout(function () {
        closeBtn.focus();
      }, 50);
    }

    function close() {
      if (!isOpen) return;
      if (cartActive) {
        if (
          !window.confirm("Your cart will be cleared if you close. Continue?")
        ) {
          return;
        }
      }
      isOpen = false;
      window.removeEventListener("resize", onWindowResize);
      backdrop.style.opacity = "0";
      panel.style.transform = "scale(0.97)";
      panel.style.opacity = "0";
      closeTimer = setTimeout(function () {
        if (backdrop.parentNode) {
          backdrop.parentNode.removeChild(backdrop);
        }
        document.body.style.overflow = "";
        if (!destroyed && triggerEl) triggerEl.focus();
      }, 200);
    }

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });

    closeBtn.addEventListener("click", close);

    backdrop.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab") {
        if (e.shiftKey && document.activeElement === closeBtn) {
          e.preventDefault();
          iframe.focus();
        } else if (!e.shiftKey && document.activeElement === iframe) {
          e.preventDefault();
          closeBtn.focus();
        }
      }
    });

    function onMessage(event) {
      if (!sdkOrigin || event.origin !== sdkOrigin) return;
      var data = event.data;
      if (
        !data ||
        typeof data.type !== "string" ||
        data.type.indexOf("hf:") !== 0
      )
        return;
      if (event.source !== iframe.contentWindow) return;

      switch (data.type) {
        case "hf:ready":
          onReady({ embedId: data.embedId });
          break;

        case "hf:resize":
          if (
            typeof data.height === "number" &&
            data.height > 0 &&
            isFinite(data.height)
          ) {
            contentHeight = Math.min(data.height, MAX_HEIGHT);
            applyPanelSize();
          }
          break;

        case "hf:navigate":
          onNavigate({ screen: data.screen });
          break;

        case "hf:orderComplete":
          cartActive = false;
          onOrderComplete({
            orderId: data.orderId,
            totalCents: data.totalCents,
            currency: data.currency,
          });
          setTimeout(close, 1500);
          break;

        case "hf:cartUpdate":
          cartActive = Array.isArray(data.items) && data.items.length > 0;
          onCartUpdate({ items: data.items });
          break;
      }
    }

    window.addEventListener("message", onMessage);
    triggerEl.addEventListener("click", open);

    // Hash-based auto-open (deep link support)
    if (window.location.hash === "#hf-checkout") {
      setTimeout(function () {
        open();
        history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search
        );
      }, 100);
    }

    var destroyed = false;

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (closeTimer) clearTimeout(closeTimer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onWindowResize);
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
      document.body.style.overflow = "";
      if (triggerRendered && triggerEl && triggerEl.parentNode === container) {
        container.removeChild(triggerEl);
      }
    }

    return { destroy: destroy };
  }

  // ── Public API ───────────────────────────────────────────────────────────
  // DOM-safe wrapper: while the document is still parsing, defer widget
  // creation to DOMContentLoaded (the snippet's container <div> may not be in
  // the DOM yet). Returns a handle whose destroy() is valid immediately —
  // destroying before DOMContentLoaded simply cancels the deferred creation.
  function createWidget(options) {
    if (document.readyState === "loading") {
      var deferredHandle = null;
      var deferredDestroyed = false;
      document.addEventListener("DOMContentLoaded", function () {
        if (!deferredDestroyed) deferredHandle = createWidgetNow(options);
      });
      return {
        destroy: function () {
          deferredDestroyed = true;
          if (deferredHandle) deferredHandle.destroy();
        },
      };
    }
    return createWidgetNow(options);
  }

  function createWidgetNow(options) {
    if (!options || typeof options.embedId !== "string" || !options.embedId) {
      var err = new Error("HF.createWidget: embedId is required");
      if (options && typeof options.onError === "function")
        options.onError(err);
      return { destroy: noop };
    }

    // Resolve container
    var container;
    if (typeof options.container === "string") {
      container = document.querySelector(options.container);
    } else if (options.container && options.container.nodeType === 1) {
      container = options.container;
    }

    if (!container) {
      var err2 = new Error("HF.createWidget: container not found");
      if (typeof options.onError === "function") options.onError(err2);
      return { destroy: noop };
    }

    var mode = options.mode || "inline";

    // Build src URL. widget: "booking" points at the "Request to book" form;
    // anything else keeps the original tickets widget (backward compatible).
    var basePath = options.widget === "booking" ? "/embed/book/" : "/embed/";
    var src = sdkOrigin + basePath + encodeURIComponent(options.embedId);
    var params = [];

    // Theme params
    if (options.theme && typeof options.theme === "object") {
      var themeKeys = ["brandColor", "bg", "fontColor", "accentColor"];
      for (var i = 0; i < themeKeys.length; i++) {
        var key = themeKeys[i];
        var val = options.theme[key];
        if (isValidHex(val)) {
          params.push(encodeURIComponent(key) + "=" + encodeURIComponent(val));
        }
      }
    }

    // Promo code
    if (options.promoCode && typeof options.promoCode === "string") {
      params.push("promo=" + encodeURIComponent(options.promoCode));
    }

    // Scope — which events an organization/human widget renders. Validated
    // against the known set so a typo becomes "no param" (the server then
    // applies its own "own" default) rather than a rejected request. Omitted
    // when "own": that IS the default, so sending it is noise. Meaningless
    // for event/place subjects — the server ignores it there.
    if (isValidScope(options.scope) && options.scope !== "own") {
      params.push("scope=" + encodeURIComponent(options.scope));
    }

    // View — which browse view the events widget opens on. Same discipline as
    // scope: a typo becomes "no param" (the widget then follows the embed's
    // configured defaultView) rather than a broken URL, and "list" is omitted
    // because it IS the default. Never sent for the booking form, which has
    // no views at all.
    if (
      options.widget !== "booking" &&
      isValidView(options.view) &&
      options.view !== "list"
    ) {
      params.push("view=" + encodeURIComponent(options.view));
    }

    if (params.length) {
      src += "?" + params.join("&");
    }

    var callbacks = {
      onReady: typeof options.onReady === "function" ? options.onReady : noop,
      onNavigate:
        typeof options.onNavigate === "function" ? options.onNavigate : noop,
      onOrderComplete:
        typeof options.onOrderComplete === "function"
          ? options.onOrderComplete
          : noop,
      onCartUpdate:
        typeof options.onCartUpdate === "function"
          ? options.onCartUpdate
          : noop,
    };

    if (mode === "modal") {
      return buildModalWidget(options, container, src, callbacks);
    }

    // Inline mode
    var autoResize =
      options.height === "auto" ||
      options.height === undefined ||
      options.height === null;
    var initialHeight = autoResize
      ? 600
      : typeof options.height === "number" && options.height > 0
        ? options.height
        : 600;

    return buildInlineWidget(
      options,
      container,
      src,
      autoResize,
      initialHeight,
      callbacks
    );
  }

  // ── Expose global (draining any pre-load command queue) ─────────────────
  // The paste snippet installs a stub `window.HF = { _q: [], createWidget }`
  // whose createWidget only queues, so inline init calls made BEFORE this
  // async script executes are captured instead of throwing "HF is not
  // defined". Replay them through the real (DOM-safe) createWidget, then
  // install the real API. Queued calls can't receive a handle — the stub
  // already returned — which matches the paste-snippet usage (no handle use).
  var stub = window.HF;
  window.HF = {
    version: "1.7.1",
    createWidget: createWidget,
  };
  if (stub && Array.isArray(stub._q)) {
    for (var qi = 0; qi < stub._q.length; qi++) {
      var queued = stub._q[qi];
      if (queued && queued[0] === "createWidget") {
        createWidget(queued[1]);
      }
    }
  }
})();
