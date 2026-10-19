/**
 * Image-reference extraction for the storage GC.
 *
 * This module answers ONE question: "which image ids does this event body
 * mention?" — and it is consumed by `sweepOrphanedUploads` to decide whether a
 * blob may be deleted from object storage. That makes its failure modes
 * asymmetric:
 *
 *  - **Over-collecting is free.** A false reference means we keep a blob that
 *    nobody uses. Cost: a few KB in R2.
 *  - **Under-collecting is destructive and unrecoverable.** A missed reference
 *    means the sweep deletes an image that a live event is still rendering,
 *    and the blob is gone for good.
 *
 * So this walker is deliberately schema-AGNOSTIC. It does not know or care
 * about the `sections -> layout.columns -> blocks` shape, `richText` docs, or
 * `imageBlock` nodes. It walks every object and array in the tree and collects
 * every string value sitting under a key that names an image reference. A body
 * shape we have never seen — a future block type, a migration mid-flight, a
 * hand-edited row — still yields its references instead of silently yielding
 * none.
 *
 * Contrast `extractImageAssetIds` in `get-public-event-body.ts`, which IS
 * shape-aware. That is correct there: it drives rendering, so a shape it does
 * not understand should render nothing. The opposite bias is correct here.
 * Do not "unify" the two — they want different answers to the same question.
 */

/**
 * Keys whose string values are treated as image references.
 *
 * Matches `imageId`, `assetId`, `heroImageId`, `posterImageId`, `mediaId`,
 * their PLURAL forms (`imageIds`), bare collection names (`images`, `media`),
 * and `snake_case` forms (`hero_image_id`). A plural key's value is usually an
 * array, so array elements are collected too — a
 * `{ type: "gallery", imageIds: [...] }` block is the most likely next
 * image-bearing shape, and under a singular-only pattern it would have yielded
 * the empty set with `truncated: false`, i.e. positive proof of non-reference,
 * and every image in the gallery would have died.
 *
 * The pattern is deliberately loose, and matching too much is free: a spurious
 * id simply fails to match any real image row. A key we fail to anticipate, by
 * contrast, is a MISSED reference that deletes live media. A new block type
 * should not have to remember to update this file in order to keep its images.
 */
const IMAGE_REFERENCE_KEY_PATTERN = /(image|asset|media)_?(id)?s?$/i;

/** Depth cap: guards against a pathological/cyclic body pinning the sweep. */
const MAX_DEPTH = 64;

export interface ReferencedImageIds {
  ids: Set<string>;
  /**
   * True when the walk hit the depth cap and therefore may have missed
   * references deeper in the tree. Callers making a DELETION decision MUST
   * treat this as "could not read" and keep the blob — a partial answer is
   * indistinguishable from "no references" and would authorize a delete.
   */
  truncated: boolean;
}

/**
 * Collect every image id referenced anywhere in an event body (or edit
 * suggestion `fields`) JSON blob.
 *
 * An empty set with `truncated: false` means "definitively mentions nothing".
 * An empty set with `truncated: true` means "do not conclude anything".
 */
export function collectReferencedImageIds(body: unknown): ReferencedImageIds {
  const ids = new Set<string>();
  const state = { truncated: false };
  walk(body, ids, 0, new Set(), state);
  return { ids, truncated: state.truncated };
}

function walk(
  node: unknown,
  ids: Set<string>,
  depth: number,
  seen: Set<object>,
  state: { truncated: boolean },
): void {
  if (!node || typeof node !== "object") return;
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }

  // Prisma hands us plain JSON, but a cycle here would hang the sweep job.
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) walk(child, ids, depth + 1, seen, state);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (IMAGE_REFERENCE_KEY_PATTERN.test(key)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) ids.add(trimmed);
        continue;
      }
      if (Array.isArray(value)) {
        // MIXED arrays are the trap: `[ "img-a", { assetId: "img-b" } ]`. Take
        // the strings AND recurse into everything else — bailing out of the
        // descent because one element happened to be a string would return
        // `img-b` as positively unreferenced and delete it.
        for (const element of value) {
          if (typeof element === "string") {
            const trimmed = element.trim();
            if (trimmed.length > 0) ids.add(trimmed);
          } else {
            walk(element, ids, depth + 1, seen, state);
          }
        }
        continue;
      }
      // A reference key whose value is neither a string nor an array is a shape
      // we do not understand; fall through to the recursive walk below rather
      // than concluding it references nothing.
    }
    walk(value, ids, depth + 1, seen, state);
  }
}
