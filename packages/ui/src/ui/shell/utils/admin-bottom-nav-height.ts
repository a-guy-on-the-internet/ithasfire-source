import { useEffect } from "react";
import { Platform } from "react-native";

/**
 * CSS custom property (set on `<html>`) carrying the height in px of the admin
 * shell's fixed bottom nav. It is set only while that nav is on screen, so
 * `var(--admin-bottom-nav-height, 0px)` is the desktop truth.
 *
 * The nav is `position: fixed` and its height depends on the device (it pads
 * for the home indicator), so a page that docks a bar at the bottom of the
 * viewport reads this instead of guessing a number or looking the nav up by
 * test id. The consumer shell publishes the same thing as
 * `--consumer-bottom-nav-height`.
 */
export const ADMIN_BOTTOM_NAV_HEIGHT_VAR = "--admin-bottom-nav-height";

/**
 * Publishes {@link ADMIN_BOTTOM_NAV_HEIGHT_VAR} while the bottom nav is shown.
 * `navTestId` is the test id the SHELL gives its own nav, so the lookup never
 * leaves the component that named the element. Web only; a no-op elsewhere.
 */
export function usePublishAdminBottomNavHeight(
  visible: boolean,
  navTestId: string,
): void {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const root = document.documentElement;
    const clear = () => root.style.removeProperty(ADMIN_BOTTOM_NAV_HEIGHT_VAR);
    if (!visible) {
      clear();
      return;
    }
    const nav = document.querySelector(`[data-testid="${navTestId}"]`);
    if (!nav) {
      clear();
      return;
    }
    const apply = () =>
      root.style.setProperty(
        ADMIN_BOTTOM_NAV_HEIGHT_VAR,
        `${Math.round(nav.getBoundingClientRect().height)}px`,
      );
    apply();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(nav);
    return () => {
      observer?.disconnect();
      clear();
    };
  }, [visible, navTestId]);
}
