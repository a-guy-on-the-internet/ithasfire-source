import type { CSSProperties } from "react";

import { ADMIN_BOTTOM_NAV_HEIGHT_VAR } from "@th/ui";

import { STRUCTURAL } from "@/lib/design-tokens";

/**
 * The phone selection bar ("N seats selected · Set price"). Sticky to the
 * bottom of the viewport, ABOVE the admin shell's fixed bottom nav: the shell
 * publishes that nav's measured height on `<html>` while it shows it, and the
 * var falls back to 0 where there is no nav. Inline on a plain element:
 * Tamagui's react-native-web layer strips `position: sticky` from stacks.
 */
export const selectionBarStyle: CSSProperties = {
  position: "sticky",
  bottom: `var(${ADMIN_BOTTOM_NAV_HEIGHT_VAR}, 0px)`,
  zIndex: 50,
  borderTop: `2px solid ${STRUCTURAL}`,
};
