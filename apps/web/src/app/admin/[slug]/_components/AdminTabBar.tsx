"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { XStack, styled } from "tamagui";
import { Text } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminTab<T extends string = string> {
  /** Unique tab value used as the active-tab key. */
  value: T;
  /** Visible label. */
  label: string;
  /** Optional leading icon (e.g. a lucide-react component). */
  icon?: ReactNode;
}

export interface AdminTabBarProps<T extends string = string> {
  tabs: AdminTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

const Bar = styled(XStack, {
  name: "AdminTabBar",
  position: "relative",
  gap: 0,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  marginBottom: 16,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reusable admin tab bar with a smooth sliding underline indicator.
 *
 * The active-tab underline animates its position and width via an absolutely
 * positioned `<div>` that tracks the active tab's DOM measurements.
 */
export function AdminTabBar<T extends string = string>({
  tabs,
  activeTab,
  onTabChange,
}: AdminTabBarProps<T>) {
  const barRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<T, HTMLDivElement>>(new Map());

  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);

  const measure = useCallback(() => {
    const barEl = barRef.current;
    const tabEl = tabRefs.current.get(activeTab);
    if (!barEl || !tabEl) return;

    const barRect = barEl.getBoundingClientRect();
    const tabRect = tabEl.getBoundingClientRect();

    setIndicator({
      left: tabRect.left - barRect.left,
      width: tabRect.width,
    });
  }, [activeTab]);

  useEffect(() => {
    measure();
  }, [measure]);

  // Re-measure on resize in case tab widths change.
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  return (
    <Bar ref={barRef as any}>
      {tabs.map((tab) => {
        const isActive = tab.value === activeTab;
        return (
          <div
            key={tab.value}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.value, el);
            }}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onTabChange(tab.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onTabChange(tab.value);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingLeft: 16,
              paddingRight: 16,
              paddingTop: 10,
              paddingBottom: 10,
              cursor: "pointer",
              userSelect: "none",
              transition: "background-color 150ms ease",
              borderRadius: "0px 0px 0 0",
            }}
            onMouseEnter={(e) => {
              if (!isActive)
                (e.currentTarget as HTMLDivElement).style.backgroundColor =
                  "var(--surfaceMuted)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor =
                "transparent";
            }}
          >
            {tab.icon}
            <Text
              variant="body"
              weight={isActive ? "semibold" : "regular"}
              color={isActive ? "$color" : "$colorMuted"}
            >
              {tab.label}
            </Text>
          </div>
        );
      })}

      {/* Animated underline indicator */}
      {indicator && (
        <div
          style={{
            position: "absolute",
            bottom: -1,
            left: indicator.left,
            width: indicator.width,
            height: 2,
            backgroundColor: "var(--accent)",
            borderRadius: 0,
            transition:
              "left 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1)",
            zIndex: 1,
          }}
        />
      )}
    </Bar>
  );
}

AdminTabBar.displayName = "AdminTabBar";
