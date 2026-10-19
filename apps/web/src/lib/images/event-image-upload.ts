// Client-side mirror of the EVENT image pipeline's content-type allowlist.
//
// The server allowlist lives in
// `packages/core/src/use-cases/events/request-event-image-upload.ts`
// (`eventImageContentTypeToExtension` — jpeg/png/gif/webp) and stays strict on
// purpose. Keep this module in sync with it.
//
// RASTER ONLY — no SVG, for every surface. Azure AI Content Safety cannot
// analyze SVG, so an SVG hero failed closed to a FLAGGED moderation record
// that nothing could ever clear. See the server module for the full rationale.
// This collapsed the old EVENT (raster + SVG) / RASTER (raster) split into one
// allowlist; the community/suggestion surfaces that used the raster-only pair
// now share these constants.
//
// HEIC/HEIF never reaches the server: `prepareImageForUpload` converts it to
// JPEG in the browser first, so the OS picker `accept` string below includes
// HEIC even though the validation set does not.

/** Content types the event image pipeline accepts (mirrors the server). */
export const EVENT_IMAGE_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Accept string mirrors the style of PAGE_IMAGE_UPLOAD_ACCEPT in
// `@/components/entity-pages/use-page-image-upload`. HEIC/HEIF (and their
// extensions — some browsers report an empty MIME for HEIC) are selectable
// because they convert to JPEG before validation/upload.

/** `accept` for image inputs riding the event pipeline: raster + HEIC. */
export const EVENT_IMAGE_UPLOAD_ACCEPT =
  "image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif";

export type ImageUploadTypeValidation =
  | { ok: true }
  | { ok: false; error: "invalid_image_type" };

/**
 * Validates an upload-ready file's MIME type against an allowlist.
 *
 * Run this AFTER `prepareImageForUpload` so HEIC input has already become
 * JPEG. The returned `error` is the snake_case code surfaced through the
 * existing onError/toast paths (`errors.invalidImageType` i18n key).
 */
export function validateImageUploadType(
  file: File,
  allowed: ReadonlySet<string> = EVENT_IMAGE_UPLOAD_TYPES,
): ImageUploadTypeValidation {
  if (allowed.has(file.type.toLowerCase())) return { ok: true };
  return { ok: false, error: "invalid_image_type" };
}
