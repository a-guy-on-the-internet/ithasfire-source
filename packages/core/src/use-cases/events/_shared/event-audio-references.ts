/**
 * Which audio uploads does an event body actually reference?
 *
 * There is NO "remove this audio" use case — the only way an organizer takes a
 * track off an event is deleting its `audioBlock` from the body. The
 * `audio_uploads` row survives that, so "is this still on the page?" can only
 * be answered by reading the body.
 *
 * ## Do NOT use `AudioUpload.attached` for this
 *
 * It looks like exactly the flag for the job and it is not: nothing in the
 * codebase ever sets it true (`audioUploads.attach()` has no callers), so
 * filtering on it returns the empty set for every event. Trusting that same
 * flag on the image side is what made the storage sweep delete a customer's
 * live media. The flag is vestigial; the body is the truth.
 *
 * ## Bias
 *
 * This drives a SERVE decision, not a delete decision, so the asymmetry is the
 * reverse of `event-image-references.ts`: missing a reference hides audio that
 * should play, while an over-broad match can only surface another upload
 * belonging to THIS SAME event, which the organizer put there. Under-matching
 * is the worse error, so the key match is deliberately a little loose — but it
 * is not the anything-goes walk the GC uses, because here over-matching does
 * have a cost.
 */

/** Keys whose string values name an audio upload (`audioUploadId`, `audioId`). */
const AUDIO_REFERENCE_KEY_PATTERN = /(^|[^a-z])audio(upload)?_?ids?$/i;

/** Depth cap — guards a pathological/cyclic body. */
const MAX_DEPTH = 64;

/**
 * Collect every audio-upload id referenced anywhere in an event body.
 *
 * Shape-agnostic on purpose: the canonical form today is a ProseMirror
 * `audioBlock` with `attrs.audioUploadId`, but a body that nests it differently
 * must not silently stop playing.
 */
export function collectReferencedAudioUploadIds(body: unknown): Set<string> {
  const ids = new Set<string>();
  walk(body, ids, 0, new Set());
  return ids;
}

function walk(
  node: unknown,
  ids: Set<string>,
  depth: number,
  seen: Set<object>,
): void {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) walk(child, ids, depth + 1, seen);
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (AUDIO_REFERENCE_KEY_PATTERN.test(key)) {
      const candidates = Array.isArray(value) ? value : [value];
      let handled = false;
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed.length > 0) ids.add(trimmed);
        handled = true;
      }
      if (handled) continue;
      // Unrecognised value shape under a matching key: fall through and walk
      // it rather than concluding it references nothing.
    }
    walk(value, ids, depth + 1, seen);
  }
}
