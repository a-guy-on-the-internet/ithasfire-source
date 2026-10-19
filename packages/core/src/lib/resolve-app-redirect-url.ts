import { fail } from "@th/errors";

/**
 * Resolve a caller-supplied redirect target against our own web app.
 *
 * Accepts a same-origin absolute URL or a root-relative path (`/admin/x`),
 * and returns an absolute URL on `publicAppUrl`'s origin. Anything else —
 * another origin, protocol-relative `//host`, the `/\host` form URL parsers
 * normalise to `//host`, `javascript:` — is refused, so a redirect handed to
 * a third party (Stripe, an OAuth provider) can only bring the user back to
 * us. Fails closed when `publicAppUrl` isn't configured.
 */
export function resolveAppRedirectUrl(
  raw: string,
  publicAppUrl: string | null | undefined,
): string {
  if (!publicAppUrl) {
    throw fail("SERVICE_UNAVAILABLE", {
      message: "public_app_url_not_configured",
    });
  }
  let base: URL;
  try {
    base = new URL(publicAppUrl);
  } catch {
    throw fail("SERVICE_UNAVAILABLE", {
      message: "public_app_url_not_configured",
    });
  }

  const value = raw.trim();
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  const hasControl = /[\u0000-\u001f\u007f]/.test(value);
  const isRootRelative =
    value.startsWith("/") && value[1] !== "/" && value[1] !== "\\";

  let resolved: URL | null = null;
  if (!hasControl) {
    try {
      resolved = isRootRelative ? new URL(value, base) : new URL(value);
    } catch {
      resolved = null;
    }
  }

  if (
    !resolved ||
    (resolved.protocol !== "https:" && resolved.protocol !== "http:") ||
    // Origin comparison ignores userinfo; refuse credentials outright.
    resolved.username !== "" ||
    resolved.password !== "" ||
    resolved.origin !== base.origin
  ) {
    throw fail("INVALID_INPUT", {
      message: "redirect_url_not_allowed",
      meta: { reason: "redirect_url_not_allowed" },
    });
  }
  return resolved.toString();
}
