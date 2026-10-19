/**
 * chip-keyboard — Enter/Space activation for interactive `Chip`s on /search.
 *
 * WHY THIS EXISTS. `@th/ui`'s `Chip` sets `role="button"` when it is
 * interactive, and Tamagui's `getSplitStyles` turns any `role="button"` into a
 * tab stop (`tabIndex="0"`). But Tamagui's `onPress` on web is a click
 * handler — nothing maps Enter or Space onto it. So an interactive chip is
 * focusable and not activatable, which is strictly worse than not being
 * focusable at all: the keyboard reader can land on it and then has no way to
 * press it.
 *
 * This is a design-system-wide gap, not a /search one — the right fix is
 * inside `Chip` itself, and that is filed as a follow-up. This helper closes
 * it for the chips this page owns without changing behaviour for the hundreds
 * of `Chip` call sites elsewhere in the app.
 *
 * Spread it, don't assign it: Tamagui's view props are React-Native-first and
 * omit the DOM `onKeyDown`, so it has to arrive through a cast. That is the
 * established pattern here (see `SegmentedControl` in `@th/ui`).
 *
 *   <Chip interactive onPress={doThing} {...chipActivation(doThing)}>…</Chip>
 */

/**
 * Props to spread onto an interactive `Chip` so Enter and Space fire `onPress`.
 *
 * Space is `preventDefault`ed because its default action on a focused element
 * is to scroll the page — activating a filter and scrolling past the results
 * at the same time is not what anyone meant.
 */
export const chipActivation = (onPress: () => void): object =>
  ({
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onPress();
    },
  }) as object;
