import { getEmbedHostOrigin } from "@/lib/embed-host-origin";

// The host page's origin, remembered across a redirect payment.
//
// Every `embeds.*` call sends the origin of the page hosting the iframe, and
// the server checks it against the embed's allowed domains. Chromium and
// WebKit read it from `location.ancestorOrigins`, which the host page cannot
// spoof and a redirect does not change. Firefox has none, and falls back to
// `document.referrer`, which after host page -> payment page -> back names
// the payment provider (or nothing). The server would then refuse the
// confirm of a payment that went through. So the origin is saved before a
// payment that can redirect, and used on the return where the browser has
// nothing better.
//
// It is not a secret: it is the address of the page the buyer is on. The
// server still decides whether that origin may host the embed.

const savedHostOriginKey = (embedId: string) =>
  `hf:embed:host-origin:${embedId}`;

/**
 * Whether `computed` (what `getEmbedHostOrigin` returned) is an origin the
 * browser vouches for: `ancestorOrigins` names the parent, or the widget is
 * the top-level page and the origin is its own. Otherwise it came from
 * `document.referrer`, or is null.
 */
function isAuthoritative(computed: string | null): boolean {
  if (!computed) return false;
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor && ancestor !== "null") return true;
  return computed === window.location.origin;
}

/** A saved value is used only if it is exactly an http(s) origin. */
function asOrigin(saved: string | null): string | null {
  if (!saved) return null;
  try {
    const url = new URL(saved);
    const web = url.protocol === "https:" || url.protocol === "http:";
    return web && url.origin === saved ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Before `stripe.confirmPayment`: remember the origin the widget sees now.
 *
 * Not on a load that is itself a redirect return when the origin came from
 * the referrer: there the referrer is the payment page, not the host.
 */
export function saveEmbedHostOrigin(
  embedId: string,
  { loadIsRedirectReturn }: { loadIsRedirectReturn: boolean },
): void {
  const origin = getEmbedHostOrigin();
  if (!origin) return;
  if (loadIsRedirectReturn && !isAuthoritative(origin)) return;
  try {
    window.sessionStorage.setItem(savedHostOriginKey(embedId), origin);
  } catch {
    // Storage blocked (a third-party iframe in a strict browser): the
    // return computes the origin as before.
  }
}

/**
 * The host origin for a redirect return's own asks. What the browser
 * vouches for always wins. Only when it has nothing better than the
 * referrer (or nothing at all) is the origin saved before the payment used.
 */
export function embedHostOriginOnRedirectReturn(embedId: string): string | null {
  const computed = getEmbedHostOrigin();
  if (isAuthoritative(computed)) return computed;
  let saved: string | null = null;
  try {
    saved = asOrigin(window.sessionStorage.getItem(savedHostOriginKey(embedId)));
  } catch {
    // Storage blocked: nothing was saved either.
  }
  return saved ?? computed;
}

/** The return is confirmed: the saved origin has done its work. */
export function forgetEmbedHostOrigin(embedId: string): void {
  try {
    window.sessionStorage.removeItem(savedHostOriginKey(embedId));
  } catch {
    // Storage blocked: nothing was written either.
  }
}
