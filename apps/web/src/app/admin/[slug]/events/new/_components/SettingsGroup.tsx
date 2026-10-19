"use client";

import {
  useCallback,
  useId,
  useImperativeHandle,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";

import { Text } from "@th/ui";

/**
 * Breakpoint-agnostic settings accordion group for the event builder,
 * generalized from the old mobile-only `MobileAdvancedSection`. Used for the
 * four named settings groups (Scheduling, Access & privacy, Money &
 * compliance, Sharing) on BOTH desktop and mobile, and for the Revenue-splits
 * collapsed disclosure when the event has no lineup entries (decision D1).
 *
 * Strict Swiss: radius 0, 2px bottom border, uppercase bold label on the
 * left, optional mono muted state summary on the right, chevron affordance.
 *
 * Accessibility: WAI-ARIA disclosure pattern — the header is a real <button>
 * with `aria-expanded` + `aria-controls` pointing at the region it reveals;
 * keyboard focus keeps the accent focus-visible ring. Expansion is a plain
 * conditional render (no height animation), so there is nothing to suppress
 * under prefers-reduced-motion.
 *
 * Open state is ALWAYS owned here (uncontrolled — `defaultOpen` seeds it), so a
 * header click re-renders this group and nothing else. Deep links that must
 * force a group open (the Essentials "Hide the address?" link,
 * `?section=scheduling`, the readiness rail's splits anchor, the save-time
 * CUSTOM-reveal validation error) go through the imperative handle:
 *
 * ```tsx
 * const groupRef = useRef<SettingsGroupHandle>(null);
 * <SettingsGroup ref={groupRef} … />
 * groupRef.current?.open();
 * ```
 *
 * There is deliberately no `open`/`onOpenChange` pair: a parent-controlled
 * accordion made every toggle re-render the whole ~4.6k-line EventBuilder.
 */
const SettingsGroupHeader = styled(XStack, {
  tag: "button",
  width: "100%",
  alignItems: "center",
  gap: 10,
  paddingVertical: 16,
  paddingHorizontal: 32,
  minHeight: 52,
  cursor: "pointer",
  userSelect: "none",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  pressStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
  $xs: { paddingHorizontal: 16 },
});

/**
 * Imperative escape hatch for deep links that need a collapsed group expanded
 * before scrolling to it. `open()` is idempotent — calling it on an
 * already-open group is a no-op re-render-wise (React bails on the identical
 * state value).
 */
export type SettingsGroupHandle = {
  open: () => void;
};

export type SettingsGroupProps = {
  /** Group label — rendered as an uppercase bold header. */
  label: string;
  /** Leading 16px lucide icon (object/context), already colored by caller. */
  icon?: ReactNode;
  /**
   * Live state summary shown muted + mono on the right of the header (e.g.
   * "public · exact address"). Derived from already-loaded state only.
   */
  summary?: string;
  children: ReactNode;
  /** data-testid applied to the header button. */
  testId?: string;
  /** DOM id for the header button (focus target for external deep-links). */
  headerId?: string;
  /** Initial open state. Defaults to collapsed. */
  defaultOpen?: boolean;
  /** Imperative handle — see {@link SettingsGroupHandle}. */
  ref?: Ref<SettingsGroupHandle>;
};

export function SettingsGroup({
  label,
  icon,
  summary,
  children,
  testId,
  headerId,
  defaultOpen = false,
  ref,
}: SettingsGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

  const handleToggle = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  return (
    <YStack>
      <SettingsGroupHeader
        id={headerId}
        onPress={handleToggle}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid={testId}
      >
        {icon}
        <Text
          variant="bodySmall"
          weight="bold"
          fontSize={12}
          letterSpacing={1.2}
          textTransform="uppercase"
          style={{ flex: 1, textAlign: "left", minWidth: 0 }}
        >
          {label}
        </Text>
        {summary ? (
          <Text
            variant="caption"
            tone="muted"
            fontFamily="$mono"
            truncate
            style={{ flexShrink: 1, minWidth: 0, maxWidth: "55%" }}
          >
            {summary}
          </Text>
        ) : null}
        {open ? (
          <ChevronDown size={18} aria-hidden style={{ flexShrink: 0 }} />
        ) : (
          <ChevronRight size={18} aria-hidden style={{ flexShrink: 0 }} />
        )}
      </SettingsGroupHeader>
      {open && (
        <YStack id={regionId} role="region" aria-label={label}>
          {children}
        </YStack>
      )}
    </YStack>
  );
}

SettingsGroup.displayName = "SettingsGroup";
