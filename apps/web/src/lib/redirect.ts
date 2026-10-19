import type { ReadonlyURLSearchParams } from "next/navigation";
import { isUnderPath } from "@/middleware/path-match";

export const DEFAULT_REDIRECT_PATH = "/";

const candidateKeys = ["redirect_url", "redirectUrl", "redirect"] as const;

// Sentinel origin used to resolve candidate redirects. Any candidate that
// escapes this origin once parsed is off-site and must be rejected.
const SENTINEL_ORIGIN = "https://redirect.invalid";

/**
 * Destinations that point back at the sign-in surface itself.
 *
 * NOT a security control — `//evil.com`, `/\evil.com` and `javascript:` are
 * already rejected by the sentinel-origin check below. This is a wedge guard:
 * `/sign-in?redirect_url=%2Fsign-in` makes a signed-in user
 * `router.replace("/sign-in")` onto the SAME route segment, which doesn't
 * unmount the page, so `redirecting` stays latched and they get ~9s of blank
 * screen followed by a sign-in form they don't need. Falling back to `/` is
 * both safe and the obviously-intended destination.
 *
 * Matches the path itself and anything beneath it, since `/sign-in` is a
 * catch-all route (`[[...index]]`).
 */
const SIGN_IN_PATH = "/sign-in";

const isSignInDestination = (pathname: string): boolean =>
  isUnderPath(pathname, SIGN_IN_PATH);

export const sanitizeRedirectPath = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  try {
    // Resolve against a sentinel origin and let the spec-compliant URL parser
    // normalize backslashes / control chars / protocol-relative forms exactly
    // as the browser will. A same-origin result === a safe relative path, so
    // "//evil.com", "/\evil.com", "/%09//evil.com", "javascript:…" (opaque
    // origin) are all rejected, while "/safe/path?x=1#y" is preserved.
    const url = new URL(value, SENTINEL_ORIGIN);
    if (url.origin !== SENTINEL_ORIGIN) {
      return null;
    }
    if (isSignInDestination(url.pathname)) {
      return null;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
};

export const readRedirectParam = (
  params: ReadonlyURLSearchParams | null,
): string | null => {
  if (!params) {
    return null;
  }

  for (const key of candidateKeys) {
    const sanitized = sanitizeRedirectPath(params.get(key));
    if (sanitized) {
      return sanitized;
    }
  }

  return null;
};

export const appendRedirectParam = (
  targetUrl: string,
  destination: string | null,
): string => {
  if (!destination) {
    return targetUrl;
  }

  const separator = targetUrl.includes("?") ? "&" : "?";
  return `${targetUrl}${separator}redirect_url=${encodeURIComponent(destination)}`;
};
