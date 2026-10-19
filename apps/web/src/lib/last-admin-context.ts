"use client";

const STORAGE_KEY = "th:last_admin_slug";

/**
 * Get the last-used admin workspace slug from localStorage.
 * Returns null if nothing stored or unavailable (SSR, private browsing, etc.).
 */
export const getLastAdminSlug = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * Persist the admin workspace slug the user is currently viewing.
 * Called by the AdminShell whenever it mounts with a valid slug.
 */
export const setLastAdminSlug = (slug: string) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    // ignore — storage full, private browsing, etc.
  }
};

/**
 * Clear the persisted admin slug (e.g. on sign-out).
 */
export const clearLastAdminSlug = () => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};
