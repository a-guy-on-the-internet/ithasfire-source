// ─────────────────────────────────────────────────────────────────────────────
// Public-URL → storage-key derivation.
//
// R2/S3 public URLs are constructed as `${publicBaseUrl}/${key}` (see the
// file-storage adapters' getObjectUrl), so the URL pathname minus its leading
// slash IS the object key. Shared by the avatar/banner upload flows (replacing
// their old private duplicates) and by account deletion, which must derive the
// keys to enqueue for R2 cleanup from the EntityPage's stored URLs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives the object-storage key from a public object URL. Returns null for
 * null/empty/unparseable input — callers treat that as "nothing to clean up".
 */
export function extractStorageKeyFromUrl(url: string | null): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const key = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * The name of a METADATA-STRIPPED COPY below its prefix: the upload's day
 * directory, then 32 hex chars (`strippedImageKey` in
 * `storage/strip-uploaded-image.ts`). An upload key has a UUID there
 * instead (dashes), so the two never match each other.
 */
const STRIPPED_COPY_NAME = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/;

/** Whether `key` is a stripped copy directly under `prefix`. */
export function isStrippedCopyKey(key: string, prefix: string): boolean {
  return key.startsWith(prefix) && STRIPPED_COPY_NAME.test(key.slice(prefix.length));
}

/**
 * The key of the stripped copy a public URL names under one of `prefixes`,
 * or null. Found by searching the path for `/<prefix>` rather than by
 * {@link extractStorageKeyFromUrl}, because a public base URL may carry a
 * path of its own (local MinIO serves `http://localhost:9000/th-dev/<key>`).
 *
 * The key alone proves nothing about the URL's origin: a caller storing the
 * URL must also check it is exactly what the storage adapter's
 * `getObjectUrl({ key, options: { public: true } })` returns.
 */
export function strippedCopyKeyFromUrl(
  url: string,
  prefixes: readonly string[],
): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  for (const prefix of prefixes) {
    const at = pathname.indexOf(`/${prefix}`);
    if (at < 0) continue;
    const key = pathname.slice(at + 1);
    if (isStrippedCopyKey(key, prefix)) return key;
  }
  return null;
}

/**
 * Every key of a human's profile avatar/banner uploads (and their stripped
 * copies) starts with this. One definition for the requests and finalizes
 * (`request-avatar-upload.ts`, `set-avatar-from-upload.ts` and the banner
 * pair). `updatePage` never accepts a NEW URL under these: replacing such an
 * image credits quota, so only the finalizes may set one.
 */
export const PROFILE_IMAGE_KEY_PREFIX = {
  avatarUrl: (humanId: string) => `avatars/human/${humanId}/`,
  bannerUrl: (humanId: string) => `banners/human/${humanId}/`,
} as const;
