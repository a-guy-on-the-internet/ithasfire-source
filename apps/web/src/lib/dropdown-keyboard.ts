import type { KeyboardEvent } from "react";

/**
 * Keyboard model shared by the admin dropdown pickers (`PlacePicker`,
 * `EventPicker`).
 *
 * WHY these are divs with roles rather than `tag="button"`: both triggers
 * CONTAIN a nested clear button, and a `<button>` inside a `<button>` is
 * invalid HTML that breaks click behaviour in real browsers. The rows could be
 * real buttons, but `PlacePicker` has four other consumers and `<button>` UA
 * styles (buttonface background, centred text, non-inherited font) would need
 * per-property resets to avoid a visual regression in all of them. So: one
 * uniform `role` + `tabIndex` + `onKeyDown` treatment, zero visual risk.
 *
 * Pair every one of these with `focusVisibleStyle` on the styled component —
 * a tabIndex on an element with no focus ring is an invisible focus trap.
 *
 * NOTE: the returned objects are spread via a cast at the call site. Tamagui's
 * view types are RN-first and omit the DOM `onKeyDown`; this is the
 * established pattern here (see `SegmentedControl`).
 */

const isActivateKey = (key: string) => key === "Enter" || key === " ";

/**
 * Trigger for a disclosure dropdown: Enter/Space toggle, ArrowDown opens
 * (never closes — arrowing into an open list is the WAI-ARIA expectation),
 * Escape closes.
 */
export function dropdownTriggerKeyProps(args: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}): object {
  return {
    onKeyDown: (event: KeyboardEvent) => {
      if (isActivateKey(event.key)) {
        event.preventDefault();
        if (args.open) args.onClose();
        else args.onOpen();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!args.open) args.onOpen();
        return;
      }
      if (event.key === "Escape" && args.open) {
        event.preventDefault();
        args.onClose();
      }
    },
  };
}

/** Any activatable non-button element (list options, footer links). */
export function activateKeyProps(onActivate: () => void): object {
  return {
    onKeyDown: (event: KeyboardEvent) => {
      if (!isActivateKey(event.key)) return;
      event.preventDefault();
      onActivate();
    },
  };
}

/**
 * Escape anywhere inside the open panel dismisses it and returns focus to the
 * trigger — otherwise a keyboard user who tabs into the search input has no
 * way out but Tab-through-everything.
 */
export function dismissKeyProps(onDismiss: () => void): object {
  return {
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    },
  };
}

/** Focus ring for the picker surfaces. Matches `SegmentedControl`. */
export const PICKER_FOCUS_VISIBLE_STYLE = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$focus",
  outlineOffset: 2,
};
