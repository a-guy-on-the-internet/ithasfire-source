/**
 * Origin of the page hosting the embed widget, threaded into every
 * `embeds.*` tRPC call so the server can enforce the embed's per-domain
 * allowlist (see `assertEmbedOriginAllowed` in @th/core).
 *
 * Resolution:
 * - Not framed (`window.self === window.top`): the widget itself is the
 *   top-level document (direct viewing / admin preview) → our own origin.
 * - Framed, Chromium/WebKit: `location.ancestorOrigins[0]` — the immediate
 *   parent's origin, unspoofable by the host page.
 * - Framed, Firefox (no `ancestorOrigins`): the origin of
 *   `document.referrer`, which our SDK guarantees is sent by stamping
 *   `referrerpolicy="strict-origin"` on the iframes it creates.
 * - Anything else (suppressed referrer, opaque/sandboxed parent, SSR):
 *   `null` — the server fails closed.
 */
/**
 * Buyer-facing copy for an origin-allowlist rejection (tRPC `FORBIDDEN` /
 * `EMBED_ORIGIN_NOT_ALLOWED`). Inline string on purpose — the embed surface
 * doesn't use the locale catalogs. Shared by EmbedErrorScreen, the calendar
 * embed's error state, and the checkout error banner so a blocked domain
 * never surfaces a raw error code.
 */
export const EMBED_ORIGIN_BLOCKED_MESSAGE =
  "This widget isn't available on this domain. If you're the organizer, check your embed settings.";

export function getEmbedHostOrigin(): string | null {
  if (typeof window === "undefined") return null;

  // Top-level document — the widget is being viewed directly.
  if (window.self === window.top) return window.location.origin;

  // Chromium / WebKit: ancestorOrigins is authoritative. A sandboxed or
  // opaque parent serializes as the string "null" — treat it as unknown.
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor && ancestor !== "null") return ancestor;

  // Firefox fallback: derive the parent origin from the referrer.
  if (document.referrer) {
    try {
      const origin = new URL(document.referrer).origin;
      return origin && origin !== "null" ? origin : null;
    } catch {
      return null;
    }
  }

  return null;
}
