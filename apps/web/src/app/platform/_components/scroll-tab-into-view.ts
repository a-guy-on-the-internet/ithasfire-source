/**
 * `onFocus` for a tab in a sideways-scrolling tab bar. A keyboard user tabbing
 * to a tab that is half off the bar's edge (orders and quotas at 320) gets it
 * scrolled fully into the bar.
 *
 * Only the bar scrolls. `Element.scrollIntoView` would also scroll the page,
 * and focus fires again when the window regains focus, so the page would jump
 * back up to the tab bar each time.
 */
export function scrollTabIntoView(event: { currentTarget: unknown }): void {
  const tab = event.currentTarget;
  if (!(tab instanceof HTMLElement)) return;
  const bar = tab.parentElement;
  if (!bar) return;

  const barRect = bar.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  // The tab's span in the bar's scroll coordinates.
  const start = tabRect.left - barRect.left - bar.clientLeft + bar.scrollLeft;
  const end = start + tabRect.width;
  const visibleEnd = bar.scrollLeft + bar.clientWidth;

  if (start < bar.scrollLeft) {
    bar.scrollLeft = start;
  } else if (end > visibleEnd) {
    bar.scrollLeft = end - bar.clientWidth;
  }
}
