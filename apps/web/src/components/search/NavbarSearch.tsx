"use client";

import { useCallback, forwardRef, useMemo } from "react";
import { Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { XStack, styled } from "tamagui";
import { Text, useTranslations } from "@th/ui";
import {
  openSpotlight,
  detectSearchContext,
  useContextQuery,
} from "@/components/search/spotlight-store";

// ---------------------------------------------------------------------------
// Navbar search trigger — visual placeholder that opens the Spotlight overlay.
// All actual search logic lives in SpotlightSearch.tsx; this is just the
// affordance sitting in the navbar so users know where to click / press ⌘K.
// ---------------------------------------------------------------------------

const TriggerContainer = styled(XStack, {
  name: "NavbarSearchTrigger",
  flex: 1,
  alignItems: "center",
  gap: "$2",
  minWidth: 0,
  maxWidth: 600,
  height: 44,
  paddingHorizontal: "$3",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  cursor: "pointer",
  hoverStyle: {
    borderColor: "$accent",
    backgroundColor: "$surfaceMuted",
  },
  pressStyle: {
    borderColor: "$accent",
    scale: 0.99,
  },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

const KbdHint = styled(Text, {
  name: "NavbarSearchKbdHint",
  fontFamily: "$mono",
  fontSize: 11,
  color: "$colorMuted",
  borderWidth: 1,
  borderColor: "$borderColor",
  paddingHorizontal: 6,
  paddingVertical: 2,
  backgroundColor: "$surfaceMuted",
  letterSpacing: 0.5,
  lineHeight: 16,
  userSelect: "none",
});

export interface NavbarSearchProps {
  testIdBase?: string;
  /**
   * Cap for the trigger once the navbar row has slack to give it. The default
   * is the historical 600 so the admin and platform shells are unaffected; the
   * consumer navbar passes the shared `SearchSlot` cap (820) because its row
   * widened to the shell's 1440 grid and the trigger, left-aligned in a
   * `flex: 1` slot, stopped short and left a hole before the trailing controls.
   */
  maxWidth?: number;
}

export const NavbarSearch = forwardRef<HTMLDivElement, NavbarSearchProps>(
  ({ testIdBase = "navbar-search", maxWidth = 600 }, ref) => {
    const t = useTranslations();
    // Derived from the pathname rather than passed by the shell so this can
    // never disagree with the overlay, which derives its own context the same
    // way. Reading the shared `lastQuery` instead made every navbar echo
    // whatever was typed last ANYWHERE: an admin order lookup ("ORD-4F2A
    // refund") showed up in the public navbar after the switcher's
    // client-side exit to the attendee view.
    const pathname = usePathname();
    const context = detectSearchContext(pathname ?? "");
    const contextQuery = useContextQuery(context);

    // One static string, not a cycling reel. The trigger is a wide field in
    // the chrome now, so text swapping on a 2.2s loop is a large moving
    // target beside the work; the overlay still cycles its own placeholder,
    // where the user is actually looking. Admin names orders explicitly —
    // the same reason `spotlight.adminPlaceholder` does.
    const placeholder = String(
      context === "admin"
        ? t("spotlight.adminPlaceholder")
        : t("search.placeholderAll"),
    );
    // Accessible name: the placeholder without its trailing ellipsis, which
    // a screen reader would otherwise read as a pause. `placeholderAllLabel`
    // is the hand-written version for the consumer copy; admin has no such
    // key and locale files are off-limits here, so it is trimmed instead.
    const label = useMemo(
      () =>
        context === "admin"
          ? placeholder.replace(/\u2026$/, "")
          : String(t("search.placeholderAllLabel")),
      [context, placeholder, t],
    );

    const handlePress = useCallback(() => {
      openSpotlight();
    }, []);

    return (
      <TriggerContainer
        ref={ref as any}
        maxWidth={maxWidth}
        onPress={handlePress}
        role="button"
        aria-label={label}
        data-testid={`${testIdBase}-trigger`}
        tabIndex={0}
        {...({
          onKeyDown: (e: any) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openSpotlight();
            }
          },
        } as any)}
      >
        <Search size={16} color="var(--colorMuted)" strokeWidth={2} />
        {/* The trigger's accessible name lives on the container's stable
            aria-label, so the visible string stays decorative to AT. */}
        <Text
          variant="body"
          color="$colorMuted"
          flex={1}
          fontSize={14}
          aria-hidden
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {contextQuery || placeholder}
        </Text>
        <KbdHint aria-hidden>⌘K</KbdHint>
      </TriggerContainer>
    );
  },
);

NavbarSearch.displayName = "NavbarSearch";
