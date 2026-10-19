// ─────────────────────────────────────────────────────────────────────────────
// image-crop — pure geometry for the client-side crop step.
//
// Kept OUT of the component so the maths is unit-testable without jsdom, a
// canvas polyfill or pointer simulation. `ImageCropDialog` owns the DOM and
// the gestures; everything here is arithmetic.
//
// Model: a fixed-aspect crop BOX (the viewport the user frames through) and an
// image drawn behind it at `coverScale(box) * zoom`, offset by `(x, y)` in box
// pixels. The offset is always clamped so the image fully covers the box —
// there is never a transparent gutter inside the crop, at any zoom.
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/** Image types we hand to the crop UI unchanged (see `shouldSkipCrop`). */
const SKIP_CROP_TYPES = new Set(["image/gif"]);

/**
 * Animated GIFs cannot survive a canvas round-trip — `drawImage` captures a
 * single frame — so a GIF is uploaded as picked, exactly as it was before crop
 * existed. Everything else goes through the crop step.
 *
 * Only `PageFieldsEditor` calls this. The account-settings avatar
 * (`ProfileSection`) deliberately does not, because `useAvatarUpload` does not
 * accept `image/gif` in the first place — see the note there.
 */
export function shouldSkipCrop(file: { type: string }): boolean {
  return SKIP_CROP_TYPES.has(file.type.toLowerCase());
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Scale at which the natural image exactly COVERS the box (the larger of the
 * two axis ratios). Zoom multiplies this, so zoom=1 is always "as zoomed out
 * as the crop allows".
 */
export function coverScale(
  boxW: number,
  boxH: number,
  naturalW: number,
  naturalH: number,
): number {
  if (naturalW <= 0 || naturalH <= 0) return 1;
  return Math.max(boxW / naturalW, boxH / naturalH);
}

/**
 * Clamp one axis of the offset so the displayed image still covers the box.
 * Valid range is `[boxSize - displaySize, 0]`; when the image is (marginally)
 * smaller than the box — only reachable through float error — it is centred.
 */
export function clampAxis(
  offset: number,
  boxSize: number,
  displaySize: number,
): number {
  if (displaySize <= boxSize) return (boxSize - displaySize) / 2;
  return Math.min(0, Math.max(boxSize - displaySize, offset));
}

export interface CropView {
  zoom: number;
  x: number;
  y: number;
}

export interface CropBox {
  boxW: number;
  boxH: number;
  naturalW: number;
  naturalH: number;
}

/** Clamp a whole view (zoom first, then both offset axes against it). */
export function clampView(view: CropView, box: CropBox): CropView {
  const zoom = clampZoom(view.zoom);
  const scale = coverScale(box.boxW, box.boxH, box.naturalW, box.naturalH) * zoom;
  return {
    zoom,
    x: clampAxis(view.x, box.boxW, box.naturalW * scale),
    y: clampAxis(view.y, box.boxH, box.naturalH * scale),
  };
}

/** The view that centres the image in the box at `zoom`. */
export function centeredView(box: CropBox, zoom = MIN_ZOOM): CropView {
  const z = clampZoom(zoom);
  const scale = coverScale(box.boxW, box.boxH, box.naturalW, box.naturalH) * z;
  return clampView(
    {
      zoom: z,
      x: (box.boxW - box.naturalW * scale) / 2,
      y: (box.boxH - box.naturalH * scale) / 2,
    },
    box,
  );
}

/**
 * Change zoom while keeping whatever the user has centred in the crop box
 * centred. Without this, zooming drifts the subject out of frame — the single
 * most common complaint about naive crop UIs.
 */
export function zoomAnchored(
  view: CropView,
  box: CropBox,
  nextZoom: number,
): CropView {
  const base = coverScale(box.boxW, box.boxH, box.naturalW, box.naturalH);
  const zoom = clampZoom(nextZoom);
  const oldScale = base * view.zoom;
  const newScale = base * zoom;
  if (oldScale <= 0) return clampView({ ...view, zoom }, box);
  // Natural-image coordinate currently under the centre of the crop box.
  const cx = (box.boxW / 2 - view.x) / oldScale;
  const cy = (box.boxH / 2 - view.y) / oldScale;
  return clampView(
    {
      zoom,
      x: box.boxW / 2 - cx * newScale,
      y: box.boxH / 2 - cy * newScale,
    },
    box,
  );
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The rectangle of the NATURAL image that the crop box is showing — the
 * source args for `ctx.drawImage`. Clamped into the image bounds so float
 * drift can never ask the canvas for pixels that don't exist (which some
 * browsers render as transparent edges).
 */
export function sourceRect(view: CropView, box: CropBox): SourceRect {
  const scale = coverScale(box.boxW, box.boxH, box.naturalW, box.naturalH) * view.zoom;
  if (scale <= 0) {
    return { sx: 0, sy: 0, sw: box.naturalW, sh: box.naturalH };
  }
  const rawW = box.boxW / scale;
  const rawH = box.boxH / scale;
  const sw = Math.min(rawW, box.naturalW);
  const sh = Math.min(rawH, box.naturalH);
  const sx = Math.min(Math.max(0, -view.x / scale), box.naturalW - sw);
  const sy = Math.min(Math.max(0, -view.y / scale), box.naturalH - sh);
  return { sx, sy, sw, sh };
}

/**
 * Output pixel size: the true cropped resolution, capped at `maxWidth` so a
 * 48-megapixel phone photo doesn't produce a 20MB avatar. Height is derived
 * from the aspect so the file matches the frame the user saw exactly.
 */
export function outputSize(
  rect: SourceRect,
  aspect: number,
  maxWidth: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.min(maxWidth, Math.round(rect.sw)));
  const height = Math.max(1, Math.round(width / aspect));
  return { width, height };
}

/**
 * Encoding for the cropped output. PNG and WebP are preserved so a logo with
 * transparency does not gain a black background; everything else (including
 * the JPEG that HEIC input has already become) encodes as JPEG.
 */
export function outputContentType(inputType: string): string {
  const normalized = inputType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/webp") return "image/webp";
  return "image/jpeg";
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};

/** `photo.HEIC` + `image/jpeg` → `photo-cropped.jpg`. */
export function croppedFileName(originalName: string, contentType: string): string {
  const ext = EXTENSION_BY_TYPE[contentType.toLowerCase()] ?? "jpg";
  const stem = originalName.replace(/\.[^/.]+$/, "") || "image";
  return `${stem}-cropped.${ext}`;
}
