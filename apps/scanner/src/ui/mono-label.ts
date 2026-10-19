import { Platform, type TextStyle } from "react-native";

/**
 * The design system's mono label idiom (DS v2: `labelIdioms.label` in
 * `packages/ui/src/ui/tamagui/tokens/typography.ts`: 11px, 2px tracking,
 * 600, uppercase) for raw React Native text. Size and tracking travel
 * together; use the whole bag, never half of it.
 *
 * The scanner doesn't bundle IBM Plex Mono, so the face is the platform
 * monospace, which DS v2 names as the native fallback until the mobile font
 * pass lands. When it does, only `fontFamily` here changes.
 */
export const monoLabel: TextStyle = {
  fontFamily: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  }),
  fontSize: 11,
  letterSpacing: 2,
  fontWeight: "600",
  textTransform: "uppercase",
};
