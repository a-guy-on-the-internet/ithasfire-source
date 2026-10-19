// Keyboard navigation for the EmbedsView page tablist (roving tabindex).
//
// Deliberately local rather than shared: the shape is three lines of
// arithmetic, and coupling this page to another feature's tab union would make
// either one un-renameable. (The volunteers equivalent this was modelled on is
// gone — those tabs became routes.) Contract:
// given the currently-focused tab and a keydown, resolve which tab should
// receive focus + selection next per the ARIA tabs pattern (Left/Right wrap
// around; Home/End jump to the ends), or `null` for non-navigation keys.

/**
 * One tab per PRODUCT: the events widget, the place-scoped "Request to book"
 * button, and the membership-tiers widget. (The old "Tickets" and "Calendar"
 * tabs were the same embed rendered two ways, so they collapsed into "Events"
 * with a view control. `?tab=calendar` still deep-links in — EmbedsView maps
 * it to events + view=calendar — it is just no longer a tab identity.)
 */
export type EmbedsPageTab = "events" | "booking" | "memberships";

export interface EmbedsTabEntry {
  key: EmbedsPageTab;
  /** DOM id of the tab's button, used to move focus. */
  id: string;
}

export function nextTabForKey(
  current: EmbedsPageTab,
  key: string,
  tabOrder: EmbedsTabEntry[],
): EmbedsTabEntry | null {
  if (tabOrder.length === 0) return null;
  const idx = tabOrder.findIndex((entry) => entry.key === current);
  if (idx === -1) return null;

  switch (key) {
    case "ArrowRight":
      return tabOrder[(idx + 1) % tabOrder.length];
    case "ArrowLeft":
      return tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length];
    case "Home":
      return tabOrder[0];
    case "End":
      return tabOrder[tabOrder.length - 1];
    default:
      return null;
  }
}
