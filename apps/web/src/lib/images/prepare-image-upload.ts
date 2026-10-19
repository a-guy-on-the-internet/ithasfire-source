// Browser-side HEIC/HEIF → JPEG conversion before image uploads.
//
// Why this exists: every image uploader in the web app presigns a direct-to-R2
// PUT and stores the ORIGINAL bytes — there is no server-side transcode anywhere
// in the pipeline. The server's content-type schemas only accept
// image/(jpeg|png|gif|webp) and stay strict on purpose, so HEIC/HEIF (the
// default format for iPhone photos) is rejected with `invalid_content_type`.
// Even if it were accepted, image/heic does not render in Chrome/Firefox/Edge.
//
// So we convert HEIC/HEIF to JPEG in the browser BEFORE upload, leaving the
// server contract untouched. Non-HEIC files are returned untouched with zero
// overhead (no dynamic import, no re-allocation) — the happy path is free.

/** MIME types that indicate a HEIC/HEIF image. */
const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** Filename extensions that indicate a HEIC/HEIF image. */
const HEIC_EXTENSIONS = [".heic", ".heif"];

/**
 * Some browsers report an empty `file.type` for HEIC, so we detect by BOTH
 * mime and filename extension (case-insensitive).
 */
function isHeic(file: File): boolean {
  if (HEIC_MIME_TYPES.has(file.type.toLowerCase())) return true;
  const lowerName = file.name.toLowerCase();
  return HEIC_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

/** Replace the file's extension with `.jpg` (append if there is none). */
function toJpegName(name: string): string {
  if (/\.[^/.]+$/.test(name)) return name.replace(/\.[^/.]+$/, ".jpg");
  return `${name}.jpg`;
}

/**
 * Returns an upload-ready `File`.
 *
 * - Non-HEIC input is returned unchanged (no dynamic import, no allocation).
 * - HEIC/HEIF input is converted to a JPEG `File` (quality 0.9) with a `.jpg`
 *   name and `type: "image/jpeg"`.
 *
 * Throws `Error("heic_conversion_failed")` if conversion fails; callers should
 * surface this through their existing onError/toast path.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (!isHeic(file)) return file;

  try {
    // Dynamic import keeps this SSR-safe (heic-to is browser-only) and only
    // pulls the library + libheif wasm in when a HEIC is actually picked.
    // Default export runs on the main thread; our CSP sets no script-src, so
    // the standard build works. (If CSP later adds script-src, switch to
    // `heic-to/csp`; for worker offload under Next, `heic-to/next`.)
    const { heicTo } = await import("heic-to");

    // For type "image/jpeg" heicTo resolves to a single Blob.
    const blob = await heicTo({
      blob: file,
      type: "image/jpeg",
      quality: 0.9,
    });

    return new File([blob], toJpegName(file.name), { type: "image/jpeg" });
  } catch (cause) {
    // Surface the real failure: heic-to/libheif errors (e.g. unsupported HEIC
    // variants) are otherwise invisible. Log here so there's always a
    // breadcrumb even if a caller's catch is terse, and attach `cause` so it
    // propagates to anyone who inspects it.
    console.error("[prepare-image-upload] HEIC→JPEG conversion failed", {
      name: file.name,
      type: file.type,
      sizeBytes: file.size,
      cause,
    });
    throw new Error("heic_conversion_failed", { cause });
  }
}
