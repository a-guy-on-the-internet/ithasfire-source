"use client";

import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Platform } from "react-native";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  X,
} from "lucide-react";
import { Stack, XStack, YStack, styled } from "tamagui";

import { Text } from "../typography/Text";
import { mergeDefinedLabels } from "./merge-labels";

// ─── Types ──────────────────────────────────────────────────────────────────

export type NotificationKind = "INFO" | "SUCCESS" | "WARNING" | "ERROR";

export interface NotificationItemAction {
  label: string;
  href?: string | null;
}

export interface NotificationItemData {
  id: string;
  title: string | null;
  body: string;
  kind: NotificationKind;
  readAt: Date | null;
  action: NotificationItemAction | null;
  createdAt: Date;
}

/**
 * The row's own words, for a host with a catalog. Any entry left out (or
 * passed `undefined`) keeps its English default. The `…Named` entries build a
 * control's accessible name from the row's subject, so each row's controls
 * stay distinguishable to a screen reader.
 */
export interface NotificationItemLabels {
  showMore: string;
  showLess: string;
  showMoreNamed: (subject: string) => string;
  showLessNamed: (subject: string) => string;
  dismissNamed: (subject: string) => string;
  /** Stands in for a blank title and body in those names. */
  genericSubject: string;
}

export const DEFAULT_NOTIFICATION_ITEM_LABELS: NotificationItemLabels = {
  showMore: "Show more",
  showLess: "Show less",
  showMoreNamed: (subject) => `Show more: ${subject}`,
  showLessNamed: (subject) => `Show less: ${subject}`,
  dismissNamed: (subject) => `Dismiss: ${subject}`,
  genericSubject: "Notification",
};

export interface NotificationItemProps {
  notification: NotificationItemData;
  onMarkRead?: (id: string) => void;
  onAction?: (href: string) => void;
  onDismiss?: (id: string) => void;
  /** Translated row labels; see `NotificationItemLabels`. Pass a stable
   * (memoised) object — the row is `memo`ised. */
  labels?: Partial<NotificationItemLabels>;
  /**
   * BCP 47 locale for the relative timestamp ("hace 6 d"). Without it the
   * timestamp keeps the compact English form ("6d ago").
   */
  locale?: string;
}

// ─── Styled ─────────────────────────────────────────────────────────────────

const ItemContainer = styled(XStack, {
  name: "NotificationItem",
  paddingVertical: "$3",
  paddingHorizontal: "$3",
  gap: "$3",
  borderRadius: 0,
  alignItems: "flex-start",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  pressStyle: {
    backgroundColor: "$surfaceMuted",
    opacity: 0.85,
  },
  variants: {
    unread: {
      true: {
        backgroundColor: "$surface",
        borderLeftWidth: 3,
        borderLeftColor: "$brandSecondary",
      },
      false: {
        opacity: 0.7,
        borderLeftWidth: 3,
        borderLeftColor: "transparent",
      },
    },
  } as const,
});

const IconBox = styled(Stack, {
  name: "NotificationItemIcon",
  width: 32,
  height: 32,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

// Shared by the row's three controls: a visible ring when reached by keyboard
// (mirrors Modal's close button).
const CONTROL_FOCUS_RING = {
  outlineColor: "$outlineColor",
  outlineStyle: "solid",
  outlineWidth: 2,
  outlineOffset: 2,
} as const;

// A real <button> on web (`tag`), so Tab reaches it and Enter/Space activate
// it natively; the reset strips the UA button chrome. The glyph box stays 24px
// on a fine pointer. On a coarse pointer or a phone-width viewport the hit area
// grows to the 44px floor, and the -10px margin hands the extra 20px back so
// the row's layout does not move.
const DismissButton = styled(Stack, {
  name: "NotificationItemDismiss",
  tag: "button",
  width: 24,
  height: 24,
  padding: 0,
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: "transparent",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  cursor: "pointer",
  opacity: 0.65,
  hoverStyle: {
    opacity: 1,
    backgroundColor: "$surfaceMuted",
  },
  pressStyle: {
    opacity: 0.8,
  },
  focusVisibleStyle: {
    ...CONTROL_FOCUS_RING,
    opacity: 1,
  },
  $sm: {
    width: 44,
    height: 44,
    margin: -10,
  },
  $pointerCoarse: {
    width: 44,
    height: 44,
    margin: -10,
  },
});

// The label is 12px — small text, so the 4.5:1 floor applies and the resting
// fill cannot be `$accent`: nothing clears AA on #E2481D at this size (v2 §3).
// `$accentHard` is the deep accent (#B93312 on Stub) and pairs with
// `$onStructure` at 5.68 / 9.46 / 9.46 across stub / swiss / ember. Hover keeps
// the original "darken" direction by going to `$structure` (16.2 / 7.0 / 7.0),
// which stays AA — the label colour never has to move.
//
// On web this renders as a real `<a href>` (the `tag: "a"` branch below), so
// native focus, Enter, middle-click and open-in-new-tab all come from the
// browser. 36px is the design system's `sm`
// control height; on a coarse pointer or a phone-width viewport it grows to the
// 44px touch floor.
const ActionButton = styled(XStack, {
  name: "NotificationItemActionButton",
  alignItems: "center",
  justifyContent: "center",
  gap: "$1.5",
  marginTop: "$2",
  minHeight: 36,
  paddingVertical: "$1.5",
  paddingHorizontal: "$3",
  backgroundColor: "$accentHard",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  cursor: "pointer",
  alignSelf: "flex-start",
  hoverStyle: {
    backgroundColor: "$structure",
  },
  pressStyle: {
    opacity: 0.85,
  },
  focusVisibleStyle: CONTROL_FOCUS_RING,
  $sm: {
    minHeight: 44,
  },
  $pointerCoarse: {
    minHeight: 44,
  },
});

// A real <button> on web, like Dismiss. Grows to the 44px floor on a coarse
// pointer or a phone-width viewport.
const ExpandToggle = styled(XStack, {
  name: "NotificationItemExpandToggle",
  tag: "button",
  alignItems: "center",
  gap: "$1",
  padding: 0,
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: "transparent",
  cursor: "pointer",
  alignSelf: "flex-start",
  hoverStyle: {
    opacity: 1,
  },
  pressStyle: {
    opacity: 0.7,
  },
  focusVisibleStyle: {
    ...CONTROL_FOCUS_RING,
    opacity: 1,
  },
  $sm: {
    minHeight: 44,
  },
  $pointerCoarse: {
    minHeight: 44,
  },
});

const isWeb = Platform.OS === "web";

/** Approximate char limit for the collapsed body. */
const BODY_TRUNCATE_CHARS = 100;

/** Name of last resort for a row whose title and body are both blank. */
const GENERIC_SUBJECT = DEFAULT_NOTIFICATION_ITEM_LABELS.genericSubject;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The subject each of the row's controls carries in its accessible name, so a
 * list of ten rows does not announce ten identical "Dismiss" buttons.
 *
 * Applied to the title AND the body, because the titled path — the common one
 * — is not bounded either: `Notification.title` is a `String?` column with no
 * length cap (`packages/db/prisma/notification.prisma`) and nothing in
 * `packages/core` or `packages/types` validates its length. Today's producers
 * pass short constants; nothing makes them.
 *
 * Three rules, all of them about what a screen reader ends up saying:
 * - cut to the display truncation length, so the name does not diverge from
 *   the text on screen and a 600-character paragraph is not read out three
 *   times per row;
 * - never cut between a surrogate pair — `slice` counts UTF-16 code units, so
 *   an emoji straddling the limit would leave a lone surrogate at the end of
 *   three names;
 * - never return empty. A whitespace-only subject yielded the name
 *   "Dismiss: " on every such row, re-creating the exact cross-row collision
 *   the per-row name exists to prevent.
 *
 * No ellipsis: this string is spoken, not shown.
 *
 * Platform-neutral on purpose — native builds the same names.
 */
export function truncateForName(
  raw: string,
  genericSubject: string = GENERIC_SUBJECT,
): string {
  const trimmed = raw.trim();
  let end = Math.min(trimmed.length, BODY_TRUNCATE_CHARS);
  if (end < trimmed.length) {
    const code = trimmed.charCodeAt(end);
    // A low surrogate at the cut index means its high half is the last kept
    // code unit; drop both rather than keep half a character.
    if (code >= 0xdc00 && code <= 0xdfff) end -= 1;
  }
  const name = trimmed.slice(0, end).trimEnd();
  return name.length > 0 ? name : genericSubject;
}

const kindToIcon = (kind: NotificationKind) => {
  const color = kindToColor(kind);
  switch (kind) {
    case "SUCCESS":
      return <CheckCircle2 size={16} color={color} />;
    case "WARNING":
      return <AlertTriangle size={16} color={color} />;
    case "ERROR":
      return <AlertCircle size={16} color={color} />;
    case "INFO":
    default:
      return <Info size={16} color={color} />;
  }
};

// lucide-react writes `color` straight into the SVG's `stroke`. A Tamagui
// token string ("$info") is not a paint, so the browser drew NOTHING: the kind
// icon, the Show-more chevron, the CTA arrow and the Dismiss X were all blank
// boxes (`stroke="$info"` measured in the DOM). v2's rule for lucide `color=`:
// a CSS var with the Stub value as the first-paint fallback.
const ICON_COLOR = {
  success: "var(--success, #166534)",
  warning: "var(--warning, #92400E)",
  danger: "var(--danger, #B91C1C)",
  info: "var(--info, #211C16)",
  ink: "var(--color, #211C16)",
  muted: "var(--colorMuted, #5C544A)",
  onStructure: "var(--onStructure, #FDFAF3)",
} as const;

const kindToColor = (kind: NotificationKind): string => {
  switch (kind) {
    case "SUCCESS":
      return ICON_COLOR.success;
    case "WARNING":
      return ICON_COLOR.warning;
    case "ERROR":
      return ICON_COLOR.danger;
    case "INFO":
    default:
      return ICON_COLOR.info;
  }
};

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat | null>();

/** `Intl.RelativeTimeFormat` for `locale`, or null where the runtime lacks it
 * (older Hermes builds ship only part of `Intl`). One instance per locale for
 * the module's lifetime, not one per row. */
function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat | null {
  if (
    typeof Intl === "undefined" ||
    typeof Intl.RelativeTimeFormat !== "function"
  ) {
    return null;
  }
  if (relativeTimeFormats.has(locale)) {
    return relativeTimeFormats.get(locale) ?? null;
  }
  let rtf: Intl.RelativeTimeFormat | null;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, {
      numeric: "auto",
      style: "narrow",
    });
  } catch {
    rtf = null;
  }
  relativeTimeFormats.set(locale, rtf);
  return rtf;
}

/**
 * Minimal relative-time formatter. With no `locale` it produces the compact
 * English "just now", "2m ago", "3h ago", "1d ago" exactly as it always has.
 * With one it uses `Intl.RelativeTimeFormat` ("ahora", "hace 5 min",
 * "hace 6 d"), and falls back to the English form where that is missing.
 */
export function timeAgo(date: Date, locale?: string): string {
  const rtf = locale ? relativeTimeFormat(locale) : null;
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return rtf ? rtf.format(0, "second") : "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return rtf ? rtf.format(-mins, "minute") : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf ? rtf.format(-hours, "hour") : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf ? rtf.format(-days, "day") : `${days}d ago`;
  return rtf ? date.toLocaleDateString(locale) : date.toLocaleDateString();
}

// ─── Component ──────────────────────────────────────────────────────────────

export const NotificationItem = memo(
  ({
    notification,
    onMarkRead,
    onAction,
    onDismiss,
    labels: labelsProp,
    locale,
  }: NotificationItemProps) => {
    const labels = useMemo(
      () => mergeDefinedLabels(DEFAULT_NOTIFICATION_ITEM_LABELS, labelsProp),
      [labelsProp],
    );
    const { id, title, body, kind, readAt, action, createdAt } = notification;
    const isUnread = readAt === null;
    const icon = useMemo(() => kindToIcon(kind), [kind]);
    // Clock- and locale-dependent, so only hydration-safe because rows render
    // client-side only (no server prefetch of the list; the panel starts closed).
    const timestamp = useMemo(
      () => timeAgo(createdAt, locale),
      [createdAt, locale],
    );
    const [expanded, setExpanded] = useState(false);

    const isLongBody = body.length > BODY_TRUNCATE_CHARS;
    // Bounded AFTER the `??`, so a long title is cut the same way a long body
    // is. See `truncateForName`.
    const subject = truncateForName(title ?? body, labels.genericSubject);
    const actionAccessibleName = action
      ? `${action.label}: ${subject}`
      : undefined;
    const bodyId = useId();
    const displayBody =
      !isLongBody || expanded
        ? body
        : `${body.slice(0, BODY_TRUNCATE_CHARS).trimEnd()}…`;

    const handlePress = useCallback(() => {
      if (isUnread && onMarkRead) {
        onMarkRead(id);
      }
      // Only navigate on press if there's no expand toggle (short body)
      // or the card is already expanded. Otherwise the user may be trying
      // to read the full text first.
      if (action?.href && onAction && (!isLongBody || expanded)) {
        onAction(action.href);
      }
    }, [id, isUnread, onMarkRead, action, onAction, isLongBody, expanded]);

    const markReadIfUnread = useCallback(() => {
      if (isUnread && onMarkRead) {
        onMarkRead(id);
      }
    }, [id, isUnread, onMarkRead]);

    // Native: the CTA is a pressable with no href, so the press does both jobs.
    const handleActionPress = useCallback(
      (e?: { stopPropagation?: () => void }) => {
        e?.stopPropagation?.();
        markReadIfUnread();
        if (action?.href && onAction) {
          onAction(action.href);
        }
      },
      [markReadIfUnread, action, onAction],
    );

    // Web: the CTA is an anchor. Every activation marks the notification read
    // and never bubbles to the row (the row would mark it again and could
    // navigate a second time). A plain click / Enter is routed through
    // `onAction` so the app's client router handles it; modifier-clicks fall
    // through to the browser so new-tab / new-window keep working.
    const handleActionClick = useCallback(
      (e: ReactMouseEvent<HTMLAnchorElement>) => {
        e.stopPropagation();
        markReadIfUnread();
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!action?.href || !onAction) return;
        e.preventDefault();
        onAction(action.href);
      },
      [markReadIfUnread, action, onAction],
    );

    // Middle-click fires `auxclick`, not `click`: the browser opens the tab,
    // we only record the read.
    const handleActionAuxClick = useCallback(
      (e: ReactMouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 1) return;
        e.stopPropagation();
        markReadIfUnread();
      },
      [markReadIfUnread],
    );

    const handleDismiss = useCallback(
      (e?: { stopPropagation?: () => void }) => {
        e?.stopPropagation?.();
        if (onDismiss) {
          onDismiss(id);
        } else if (isUnread && onMarkRead) {
          // Fallback: mark as read when no dismiss handler
          onMarkRead(id);
        }
      },
      [id, isUnread, onMarkRead, onDismiss],
    );

    const handleToggleExpand = useCallback(
      (e?: { stopPropagation?: () => void }) => {
        e?.stopPropagation?.();
        setExpanded((prev) => !prev);
      },
      [],
    );

    return (
      <ItemContainer
        unread={isUnread}
        onPress={handlePress}
        role="listitem"
        // Same bounded subject as the controls inside it: `role="listitem"`
        // takes its name from the author only, and the raw body made the row
        // announce all 843 characters while its three controls announced 109.
        aria-label={subject}
        // Web only: lets the container find "the row that replaces this one"
        // after a dismiss, to move focus there instead of dropping it to
        // <body> when the row unmounts. See NotificationInboxContainer's
        // focus-after-dismiss handling.
        {...(isWeb ? { "data-notification-id": id } : {})}
      >
        {/* Kind icon */}
        <IconBox>{icon}</IconBox>

        {/* Content. minWidth 0 lets the column shrink below its text, so a
            long unbroken title truncates instead of widening the row. */}
        <YStack flex={1} minWidth={0} gap="$1">
          {title ? (
            <Text variant="bodySmall" weight="bold" truncate>
              {title}
            </Text>
          ) : null}

          <Text
            variant="bodySmall"
            tone="muted"
            {...(isWeb ? { id: bodyId } : {})}
          >
            {displayBody}
          </Text>

          {/* Expand/collapse toggle for long body text */}
          {isLongBody ? (
            <ExpandToggle
              onPress={handleToggleExpand}
              opacity={0.65}
              {...(isWeb
                ? {
                    type: "button",
                    "aria-expanded": expanded,
                    "aria-controls": bodyId,
                    // Per-row name, same reason the CTA and Dismiss got one:
                    // a bare "Show more"/"Show less" collides across every
                    // long-body row in the list.
                    "aria-label": expanded
                      ? labels.showLessNamed(subject)
                      : labels.showMoreNamed(subject),
                  }
                : {
                    accessibilityRole: "button" as const,
                    accessibilityState: { expanded },
                    accessibilityLabel: expanded
                      ? labels.showLessNamed(subject)
                      : labels.showMoreNamed(subject),
                  })}
            >
              {expanded ? (
                <ChevronUp
                  size={12}
                  color={ICON_COLOR.muted}
                  aria-hidden="true"
                />
              ) : (
                <ChevronDown
                  size={12}
                  color={ICON_COLOR.muted}
                  aria-hidden="true"
                />
              )}
              <Text variant="span" tone="muted" fontSize={11} weight="bold">
                {expanded ? labels.showLess : labels.showMore}
              </Text>
            </ExpandToggle>
          ) : null}

          {/* Action CTA — a real link on web. Its name carries the
              notification so "Review your lineups" is not announced N times
              with nothing to tell the rows apart. */}
          {action?.href ? (
            <ActionButton
              {...(isWeb
                ? {
                    tag: "a" as const,
                    href: action.href,
                    role: "link" as const,
                    "aria-label": actionAccessibleName,
                    style: { textDecoration: "none" } as const,
                    onClick: handleActionClick,
                    onAuxClick: handleActionAuxClick,
                  }
                : {
                    onPress: handleActionPress,
                    accessibilityRole: "link" as const,
                    accessibilityLabel: actionAccessibleName,
                  })}
            >
              <Text
                variant="span"
                weight="bold"
                color="$onStructure"
                fontSize={12}
              >
                {action.label}
              </Text>
              <ArrowUpRight
                size={12}
                color={ICON_COLOR.onStructure}
                aria-hidden="true"
              />
            </ActionButton>
          ) : null}

          <Text variant="span" tone="muted" fontSize={11} marginTop="$1">
            {timestamp}
          </Text>
        </YStack>

        {/* Dismiss button */}
        <DismissButton
          onPress={handleDismiss}
          aria-label={labels.dismissNamed(subject)}
          {...(isWeb
            ? { type: "button" }
            : { accessibilityRole: "button" as const })}
        >
          <X
            size={14}
            strokeWidth={2}
            color={ICON_COLOR.ink}
            aria-hidden="true"
          />
        </DismissButton>
      </ItemContainer>
    );
  },
);

NotificationItem.displayName = "NotificationItem";
