/**
 * Augment Tamagui's Stack/View types to accept standard HTML attributes
 * that are valid on web but not included in React Native's type definitions.
 *
 * tabIndex, role, aria-*, onKeyDown, etc. all work at runtime because
 * Tamagui renders <div> on web, but the RN-derived types don't include them.
 */
import type { HTMLAttributes } from "react";

declare module "@tamagui/core" {
  interface TamaguiComponentPropsBaseBase {
    tabIndex?: HTMLAttributes<HTMLElement>["tabIndex"];
    hidden?: boolean;
    onKeyDown?: HTMLAttributes<HTMLElement>["onKeyDown"];
  }
}

declare module "@tamagui/web" {
  interface TamaguiComponentPropsBaseBase {
    tabIndex?: HTMLAttributes<HTMLElement>["tabIndex"];
    hidden?: boolean;
    onKeyDown?: HTMLAttributes<HTMLElement>["onKeyDown"];
  }
}
