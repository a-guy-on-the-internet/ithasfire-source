import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// Read-time visibility gate (FR-005)
//
// The SINGLE choke point every PUBLIC read path routes through to decide whether
// a moderated object (keyed by its R2 storage key) may be shown. Keeping the
// policy here — not sprinkled at each render site and not baked into the images
// adapter — means the "APPROVED-only, absent = legacy-visible" rule lives in one
// tested place, and each public surface only has to supply the storage keys it
// is about to expose.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A storage key is PUBLICLY VISIBLE when:
 *   - it has NO moderation record (legacy / pre-moderation object) — treated as
 *     APPROVED so nothing already-live disappears (fail-OPEN for legacy only), OR
 *   - its record status is exactly "APPROVED".
 *
 * Anything else (PENDING / FLAGGED / REJECTED / ORPHANED) is HIDDEN.
 *
 * The ALLOWLIST form is load-bearing and must stay that way: a blacklist of
 * known-bad statuses fails OPEN for every status added later. ORPHANED (added
 * 2026-09) needed no change here precisely because of that — it is not
 * "APPROVED", so it is hidden, and a future status will be too.
 */
function isRecordVisible(
  record: { status: string } | undefined,
): boolean {
  return !record || record.status === "APPROVED";
}

/**
 * Batch read-time gate: given a set of R2 storage keys, resolve the subset that
 * is publicly visible. Exactly ONE `resolveByKeys` round-trip regardless of key
 * count (deduped + empties dropped first), so this stays cheap on card lists.
 *
 * Callers pass the keys of the images they are about to surface and keep only
 * the urls whose key is in the returned set.
 */
export async function resolveVisibleImageKeys(
  repos: Pick<Repos, "imageModerationRecords">,
  storageKeys: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(storageKeys.filter((k) => k.length > 0))];
  if (unique.length === 0) return new Set();
  const records = await repos.imageModerationRecords.resolveByKeys(unique);
  const visible = new Set<string>();
  for (const key of unique) {
    if (isRecordVisible(records.get(key))) visible.add(key);
  }
  return visible;
}

/**
 * Single-key convenience for the event-detail hero read. A null/empty key means
 * "no image to gate" and is reported visible (there is nothing to hide).
 */
export async function isImageKeyVisible(
  repos: Pick<Repos, "imageModerationRecords">,
  storageKey: string | null | undefined,
): Promise<boolean> {
  if (!storageKey) return true;
  const visible = await resolveVisibleImageKeys(repos, [storageKey]);
  return visible.has(storageKey);
}

/**
 * Batch convenience for event card/list reads: resolve the visible-key set from
 * a list of records that carry a `heroImageKey` (e.g. `EventRecord`). One
 * `resolveByKeys` round-trip for the whole list. Pass the result to
 * {@link gateHeroUrl} per record when building each card summary.
 */
export async function resolveVisibleHeroKeys(
  repos: Pick<Repos, "imageModerationRecords">,
  records: readonly { heroImageKey?: string | null }[],
): Promise<Set<string>> {
  return resolveVisibleImageKeys(
    repos,
    records
      .map((r) => r.heroImageKey)
      .filter((k): k is string => typeof k === "string" && k.length > 0),
  );
}

/**
 * Per-card hero gate: returns the hero url only when it is publicly visible.
 *   - no url                     → null (nothing to show)
 *   - url but no key (legacy)    → url (nothing to gate against)
 *   - url + key visible/APPROVED → url
 *   - url + key hidden           → null (pending/flagged/rejected)
 *
 * `visibleKeys` is the set from {@link resolveVisibleHeroKeys} /
 * {@link resolveVisibleImageKeys} for the batch.
 */
export function gateHeroUrl(
  hero: { heroImageUrl?: string | null; heroImageKey?: string | null },
  visibleKeys: ReadonlySet<string>,
): string | null {
  if (!hero.heroImageUrl) return null;
  if (!hero.heroImageKey) return hero.heroImageUrl;
  return visibleKeys.has(hero.heroImageKey) ? hero.heroImageUrl : null;
}
