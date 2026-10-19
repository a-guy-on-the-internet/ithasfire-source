/**
 * WAI-ARIA tabs wiring for the notification panel's two tab rows (the
 * panel's Inbox / Activity and the inbox's Unread / All).
 *
 * packages/ui has no Tabs primitive, and Tamagui's `Tabs` brings its own frame
 * and styling, so this only adds the behaviour to the existing styled tabs:
 * real `<button>`s, a roving tabindex (the selected tab is the one tab stop),
 * Left/Right/Home/End move AND activate (automatic activation, which suits two
 * cheap views), and `aria-controls` → the tabpanel.
 *
 * All of that is DOM-only, so every entry point takes `isWeb` as a PARAMETER
 * rather than reading `Platform.OS` here. `AlertsSidebar` renders a different
 * markup branch per platform and that branch can be forced
 * (`platformOverride`, which the stories use), so the only source of truth for
 * "is this web markup" is the caller's own branch decision. Reading
 * `Platform.OS` at module level disagreed with it in both directions: a forced
 * native sheet carried `type` / `tabIndex` / `onKeyDown`, and forced web markup
 * on a real device got no tab wiring at all.
 */

type KeyEventLike = { key: string; preventDefault: () => void };

/** The tabpanel's props, labelled by whichever tab is selected. */
export function tabPanelProps({
  isWeb,
  panelId,
  labelledBy,
}: {
  isWeb: boolean;
  panelId: string;
  labelledBy: string;
}) {
  return isWeb
    ? {
        role: "tabpanel" as const,
        id: panelId,
        "aria-labelledby": labelledBy,
        // APG: a tabpanel needs its own tab stop for when its content holds
        // nothing focusable (the empty state, the loading skeleton) — without
        // it, Tabbing off the selected tab skips the panel's content entirely.
        tabIndex: 0,
      }
    : {};
}

/**
 * Per-tab web props. `order` is the visual order of the keys; `idFor` must
 * return the same id the tab is rendered with, because the arrow keys move
 * focus by id.
 */
export function tabProps<K extends string>({
  isWeb,
  tab,
  selected,
  order,
  idFor,
  panelId,
  onSelect,
}: {
  isWeb: boolean;
  tab: K;
  selected: K;
  order: readonly K[];
  idFor: (key: K) => string;
  panelId: string;
  onSelect: (key: K) => void;
}) {
  if (!isWeb) return {};
  return {
    type: "button" as const,
    id: idFor(tab),
    "aria-controls": panelId,
    tabIndex: tab === selected ? 0 : -1,
    onKeyDown: (e: KeyEventLike) => {
      const from = order.indexOf(tab);
      let next: K | undefined;
      switch (e.key) {
        case "ArrowRight":
          next = order[(from + 1) % order.length];
          break;
        case "ArrowLeft":
          next = order[(from - 1 + order.length) % order.length];
          break;
        case "Home":
          next = order[0];
          break;
        case "End":
          next = order[order.length - 1];
          break;
        default:
          return;
      }
      if (next === undefined) return;
      e.preventDefault();
      if (next !== selected) onSelect(next);
      document.getElementById(idFor(next))?.focus();
    },
  };
}
