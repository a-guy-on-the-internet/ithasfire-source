/**
 * Marker `<Button asChild>` puts on its slotted child (it lands on the DOM
 * node). NextLinkAnchor reads it to drop its inline `color: inherit` / display
 * defaults, which would otherwise shadow the variant's class-based colour and
 * responsive display.
 *
 * Deliberately dependency-free, like `button-variants.ts`: `Button.tsx` pulls
 * in `react-native`, and NextLinkAnchor must not.
 */
export const BUTTON_SLOT_ATTRIBUTE = "data-th-button";
