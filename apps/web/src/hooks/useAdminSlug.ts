import { useMemo } from "react";

/**
 * Admin slugs are route params. They must be raw path segments.
 *
 * Important:
 * - `@` is decorative UI only.
 * - Never URL-encode slugs for use in a pathname segment.
 */
export type UseAdminSlugResult = {
  /**
   * Normalizes admin input into a canonical *raw* slug
   * (no URL encoding; ensures `@` is present only as a literal character).
   */
  normalizeAdminSlug: (slug: string) => string;
  /**
   * Convenience helper to build `/admin/{slug}` hrefs.
   */
  toAdminHref: (slug: string) => string;
  /**
   * The base path for the current slug (e.g. `/admin/me`).
   */
  adminBasePath: string;
};

export const normalizeAdminSlug = (slug: string) => {
  const trimmed = (slug ?? "").trim();
  if (!trimmed) return "";

  // Accept encoded input (e.g. "%40alice") by decoding once.
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }

  // Canonicalize leading @:
  // - If caller passed "%40alice" or "@alice" we want "@alice".
  // - If caller passed "alice" we want "alice".
  // - If caller passed "@@alice" we want "@alice".
  if (decoded.startsWith("@")) {
    return `@${decoded.replace(/^@+/, "")}`;
  }

  return decoded;
};

export const formatAdminSlugDisplay = (slug: string) => {
  const normalized = normalizeAdminSlug(slug);
  if (!normalized) return "";
  return normalized.startsWith("@") ? normalized : `@${normalized}`;
};

export const useAdminSlug = (slug: string): UseAdminSlugResult => {
  return useMemo(() => {
    const normalized = normalizeAdminSlug(slug);
    return {
      normalizeAdminSlug,
      toAdminHref: (nextSlug: string) =>
        `/admin/${normalizeAdminSlug(nextSlug)}`,
      adminBasePath: `/admin/${normalized}`,
    };
  }, [slug]);
};
