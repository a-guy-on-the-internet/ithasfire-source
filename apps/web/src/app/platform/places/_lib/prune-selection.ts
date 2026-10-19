/**
 * Drop selected keys whose rows are no longer loaded.
 *
 * A row can leave the current page without the admin touching the selection:
 * approve/reject moves it out of the "pending" filter, unlisting moves it out
 * of "directory", another admin's change lands on refetch. A key left behind
 * is invisible but still counted by the bulk bar, and bulk archive/delete
 * would act on it.
 *
 * Returns the SAME Set instance when every selected key is still loaded, so a
 * `setState(prev => pruneSelection(prev, keys))` updater bails out instead of
 * re-rendering.
 */
export function pruneSelection(
  selected: Set<string>,
  loadedKeys: Iterable<string>,
): Set<string> {
  if (selected.size === 0) return selected;
  const loaded = new Set(loadedKeys);
  let allLoaded = true;
  for (const key of selected) {
    if (!loaded.has(key)) {
      allLoaded = false;
      break;
    }
  }
  if (allLoaded) return selected;
  const next = new Set<string>();
  for (const key of selected) {
    if (loaded.has(key)) next.add(key);
  }
  return next;
}
