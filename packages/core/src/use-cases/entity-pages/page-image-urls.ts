/**
 * Which image URLs a page's draft may hold, and which storage keys they name
 * (page editor spec docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml,
 * FR-004, FR-018).
 *
 * Uploaded page images live at `${publicBaseUrl}/${key}` (the file-storage
 * adapters join the two), with `key` under the page owner's prefix
 * (`getEntityPageImageKeyPrefix`). savePageDraft accepts an avatar / banner
 * URL only when it names an object under that prefix, so a draft can never
 * point at someone else's object, and discardPageDraft can work out which
 * keys the draft alone referenced.
 *
 * Every check is on the PARSED URL (exact origin, then the pathname), never a
 * `startsWith` on the raw string, and anything that can make a prefix check
 * pass for an object outside the prefix is refused outright: `..`, any
 * percent-escape (`%2e`, `%2f`), a backslash, userinfo (`user:pass@`), a
 * query or fragment, whitespace or control characters. The URL must also be
 * CANONICAL: its parsed `href` must equal the input exactly. WHATWG parsing
 * drops `/./` segments, resolves `..`, removes a default port and lowercases
 * scheme and host, so a non-canonical URL would be stored as typed while the
 * key derived from it (and discard's live-reference scan) used another
 * spelling. With stored == canonical, a key is one string everywhere.
 *
 * Pure: no I/O.
 */

/** Characters a key segment may hold (request-page-image-upload mints `<day>/<uuid>.<ext>`). */
const KEY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Characters refused anywhere in the raw URL before it is parsed: `%` (no
 * key needs an escape, and an escaped dot or slash is how a prefix check is
 * fooled), a backslash (WHATWG parsing turns it into `/`), `?` and `#`, and
 * whitespace / control characters (stripped or escaped by the parser).
 */
// eslint-disable-next-line no-control-regex
const REFUSED_RAW = /[%\\?#\s\u0000-\u001f\u007f]/;

export type PageImageUrlScope = {
  /**
   * The storage's public base URL (S3_PUBLIC_BASE_URL); null when the
   * deployment has none, in which case no URL is owned.
   */
  publicBaseUrl: string | null;
  /** The page owner's key prefix, `getEntityPageImageKeyPrefix(...)`. */
  keyPrefix: string;
};

/**
 * The storage key an uploaded page image URL names, or null when the URL is
 * not an object under `scope.keyPrefix` at the storage's public origin.
 */
export function ownedPageImageKeyFromUrl(
  url: unknown,
  scope: PageImageUrlScope,
): string | null {
  if (typeof url !== "string" || scope.publicBaseUrl === null) return null;
  if (url.length === 0 || url.length > 2_048) return null;
  if (REFUSED_RAW.test(url) || url.includes("..")) return null;

  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(scope.publicBaseUrl);
  } catch {
    return null;
  }
  if (parsed.href !== url) return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.origin !== base.origin) return null;

  const basePath = base.pathname.replace(/\/+$/, "");
  const pathname = parsed.pathname;
  if (!pathname.startsWith(`${basePath}/`)) return null;
  const key = pathname.slice(basePath.length + 1);

  if (!key.startsWith(scope.keyPrefix) || key.length <= scope.keyPrefix.length)
    return null;
  // A canonical pathname holds no `.` or `..` segment (the parser removes
  // them, and the href check above refused any input that had one).
  if (!key.split("/").every((segment) => KEY_SEGMENT.test(segment))) {
    return null;
  }
  return key;
}

/**
 * The extensions page image keys are minted with, exactly
 * (`entityPageImageContentTypeToExtension` in page-image-upload-helpers.ts;
 * a test keeps the two equal). Spelled out here so this module stays pure.
 */
export const PAGE_IMAGE_KEY_EXTENSIONS = ["jpg", "png", "gif", "webp"] as const;
const EXTENSION_PATTERN = `(?:${PAGE_IMAGE_KEY_EXTENSIONS.join("|")})`;

// MIRRORS: `STRIPPED_COPY_NAME` and `MINTED_KEY_TAIL` restate the shapes
// minted by `strippedImageKey` (use-cases/storage/strip-uploaded-image.ts)
// and `request-page-image-upload.ts`, as `isStrippedCopyKey` in
// profiles/storage-url.ts does. Switch to `isStrippedCopyKey` once the
// image-strip session lands it; they are local today so this module depends
// only on committed code.

/**
 * The last path segment of a METADATA-STRIPPED copy: 32 lowercase hex chars
 * and a minted extension (`strippedImageKey`). A raw upload key has a UUID
 * there instead (`request-page-image-upload.ts`) and still holds the
 * original bytes, EXIF/GPS included, so it never matches.
 */
const STRIPPED_COPY_NAME = new RegExp(`^[0-9a-f]{32}\\.${EXTENSION_PATTERN}$`);

/**
 * Like {@link ownedPageImageKeyFromUrl}, and the key must also name a
 * metadata-STRIPPED copy (owner ruling: strip EXIF/GPS before an image is
 * shown). The rule for accepting a NEW image URL into a draft or a page
 * (savePageDraft, publishPageDraft). The delete side keeps using
 * {@link ownedPageImageKeysIn}: a raw upload key a draft named is draft-only
 * junk too, and must still be queued for deletion.
 */
export function ownedStrippedPageImageKeyFromUrl(
  url: unknown,
  scope: PageImageUrlScope,
): string | null {
  const key = ownedPageImageKeyFromUrl(url, scope);
  if (key === null) return null;
  const name = key.slice(key.lastIndexOf("/") + 1);
  return STRIPPED_COPY_NAME.test(name) ? key : null;
}

/**
 * The key SHAPES the server mints under a page prefix, after the prefix:
 * `<YYYY-MM-DD>/<name>.<ext>`, where name is a raw upload's UUID
 * (`request-page-image-upload.ts`) or a stripped copy's 32 hex chars
 * (`strippedImageKey`). Matching only these shapes keeps the scan linear:
 * the old "any key characters, plus every shorter candidate" form turned a
 * 64 KB dotted run into tens of thousands of keys.
 */
const MINTED_KEY_TAIL = `\\d{4}-\\d{2}-\\d{2}/(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.${EXTENSION_PATTERN}`;

/**
 * Keys per `cancelPending` call: callers split the (uncapped) result of
 * `pageImageKeysMentionedIn` into chunks of this size, so every key is
 * cancelled and no single IN list grows with the draft. Keys are at most
 * ~110 chars and a 1 MB draft holds at most ~9k of them.
 */
export const PAGE_IMAGE_CANCEL_CHUNK_SIZE = 500;

/** `keys` in chunks of `PAGE_IMAGE_CANCEL_CHUNK_SIZE`, in order. */
export function chunkPageImageKeys(keys: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += PAGE_IMAGE_CANCEL_CHUNK_SIZE) {
    chunks.push(keys.slice(i, i + PAGE_IMAGE_CANCEL_CHUNK_SIZE));
  }
  return chunks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every storage key under `keyPrefix` that any string inside `values`
 * MENTIONS, at any depth, wherever it sits (a URL with a query string or on
 * another host, an attribute in HTML, plain text, the end of a sentence).
 * Only the key shapes the server mints match (`MINTED_KEY_TAIL`), so the
 * cost is linear in the input. NOT capped: a missed key deletes a live
 * image. Callers bound each `cancelPending` with `chunkPageImageKeys`.
 *
 * GENEROUS about WHERE a key appears, for withdrawing delete intents
 * (savePageDraft's / publishPageDraft's cancelPending): a key that does not
 * exist costs nothing, a missed one deletes a live image. Never use it to
 * decide what a draft owns; that side stays strict (ownedPageImageKeysIn).
 */
export function pageImageKeysMentionedIn(
  values: readonly unknown[],
  keyPrefix: string,
): string[] {
  const keys = new Set<string>();
  const pattern = new RegExp(
    `${escapeRegExp(keyPrefix)}${MINTED_KEY_TAIL}`,
    "g",
  );
  for (const value of collectStrings(values)) {
    for (const match of value.matchAll(pattern)) {
      keys.add(match[0]);
    }
  }
  return [...keys];
}

/** Every string anywhere inside `value` (objects, arrays, nested). */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === "object") {
    if (value instanceof Date) return into;
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
}

/**
 * Storage keys of the owned page images referenced anywhere in `values`
 * (any depth, any field: R19, a later block or theme field that holds an
 * image needs no change here). Deduplicated, in first-seen order.
 */
export function ownedPageImageKeysIn(
  values: readonly unknown[],
  scope: PageImageUrlScope,
): string[] {
  const keys = new Set<string>();
  for (const candidate of collectStrings(values)) {
    const key = ownedPageImageKeyFromUrl(candidate, scope);
    if (key !== null) keys.add(key);
  }
  return [...keys];
}
