import { styled, YStack, XStack, Paragraph } from "tamagui";
import { Text } from "@th/ui";

import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ItemType = "EVENT" | "HUMAN" | "ORGANIZATION" | "PLACE";

export const ITEM_TYPES: ItemType[] = [
  "EVENT",
  "HUMAN",
  "ORGANIZATION",
  "PLACE",
];

export const TYPE_BADGE_KEYS: Record<ItemType, string> = {
  EVENT: "admin.featuredTypeBadgeEvent",
  HUMAN: "admin.featuredTypeBadgeHuman",
  ORGANIZATION: "admin.featuredTypeBadgeOrg",
  PLACE: "admin.featuredTypeBadgePlace",
};

export const CTA_URL_PLACEHOLDERS: Record<ItemType, string> = {
  EVENT: "/events/my-event-slug",
  HUMAN: "/p/artist-page-slug",
  ORGANIZATION: "/p/org-page-slug",
  PLACE: "/p/place-page-slug",
};

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

export const Container = styled(YStack, {
  padding: 32,
  gap: 32,
  maxWidth: 720,
  width: "100%",
  marginHorizontal: "auto",
});

export const PageTitle = styled(Paragraph, {
  tag: "h1",
  fontSize: 24,
  fontWeight: "bold",
  color: "$color",
});

export const Subtitle = styled(Text, {
  fontSize: 14,
  color: "$colorMuted",
});

export const SectionHeader = styled(Paragraph, {
  tag: "h2",
  fontSize: 16,
  fontWeight: "bold",
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "$color",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
  paddingBottom: 8,
});

// ─────────────────────────────────────────────────────────────────────────────
// Form primitives
// ─────────────────────────────────────────────────────────────────────────────

export const FormCard = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 24,
  gap: 16,
  backgroundColor: "$background",
});

export const FieldRow = styled(YStack, {
  gap: 4,
});

export const FieldLabel = styled(Paragraph, {
  tag: "label",
  fontSize: 11,
  fontWeight: "700",
  textTransform: "uppercase",
  letterSpacing: 1.5,
  color: "$colorMuted",
});

const FieldInput = styled(YStack, {
  tag: "input",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  paddingHorizontal: 12,
  paddingVertical: 8,
  // @ts-expect-error — fontSize valid on web input tag
  fontSize: 14,
  color: "$color",
  backgroundColor: "$background",
  outlineStyle: "none",
  focusStyle: {
    borderColor: ACCENT,
  },
});

const FieldSelect = styled(YStack, {
  tag: "select",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  paddingHorizontal: 12,
  paddingVertical: 8,
  // @ts-expect-error — fontSize valid on web select tag
  fontSize: 14,
  color: "$color",
  backgroundColor: "$background",
  outlineStyle: "none",
  cursor: "pointer",
});

const FieldTextarea = styled(YStack, {
  tag: "textarea",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  paddingHorizontal: 12,
  paddingVertical: 8,
  // @ts-expect-error — fontSize valid on web textarea tag
  fontSize: 14,
  color: "$color",
  backgroundColor: "$background",
  outlineStyle: "none",
  minHeight: 64,
  resize: "none",
});

export const SubmitButton = styled(XStack, {
  tag: "button",
  // Rests on the brandSecondaryHover (#B93312) rung, NOT brandSecondary
  // (#E2481D) — the accent carries no AA small-text label in either polarity
  // (white 4.06:1). White on #B93312 is 5.92:1; hover deepens to
  // brandSecondaryStrong (#98240B, 8.10:1). Matches the Button `primary` atom.
  backgroundColor: "$brandSecondaryHover",
  // @ts-expect-error — color valid on web button tag (inherits to label/icon)
  color: "$onBrandSecondary",
  paddingHorizontal: 20,
  paddingVertical: 10,
  borderRadius: 0,
  borderWidth: 0,
  cursor: "pointer",
  alignSelf: "flex-start",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  hoverStyle: {
    backgroundColor: "$brandSecondaryStrong",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

// Web-specific casts — styled(YStack, { tag }) doesn't expose HTML form types
export const WebInput = FieldInput as unknown as React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { className?: string }
>;
export const WebSelect = FieldSelect as unknown as React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & { children?: React.ReactNode }
>;
export const WebTextarea = FieldTextarea as unknown as React.FC<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>;

// ─────────────────────────────────────────────────────────────────────────────
// Item list primitives
// ─────────────────────────────────────────────────────────────────────────────

export const ItemCard = styled(XStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 16,
  gap: 12,
  alignItems: "center",
  backgroundColor: "$background",
  flexWrap: "wrap",
});

export const TypeBadge = styled(Paragraph, {
  fontSize: 10,
  fontWeight: "800",
  textTransform: "uppercase",
  letterSpacing: 1.5,
  paddingHorizontal: 8,
  paddingVertical: 2,
  borderWidth: 1,
  borderRadius: 0,
  variants: {
    itemType: {
      EVENT: {
        color: ACCENT,
        borderColor: ACCENT,
      },
      HUMAN: {
        color: STRUCTURAL,
        borderColor: STRUCTURAL,
      },
      ORGANIZATION: {
        color: STRUCTURAL,
        borderColor: STRUCTURAL,
      },
      PLACE: {
        color: STRUCTURAL,
        borderColor: STRUCTURAL,
      },
    },
  } as const,
});

export const StatusDot = styled(YStack, {
  width: 8,
  height: 8,
  borderRadius: 0,
  variants: {
    active: {
      true: {
        backgroundColor: "$success",
      },
      false: {
        backgroundColor: "$danger",
      },
    },
  } as const,
});

export const RemoveButton = styled(XStack, {
  tag: "button",
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderWidth: 2,
  borderColor: "$danger",
  borderRadius: 0,
  backgroundColor: "transparent",
  // Label/icon inherit via currentColor so the hover inversion stays legible.
  color: "$danger",
  cursor: "pointer",
  alignItems: "center",
  gap: 4,
  hoverStyle: {
    backgroundColor: "$danger",
    // @ts-expect-error — color valid on web button tag (inherits to label)
    color: "$colorInverted",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

export const MonoText = styled(Text, {
  fontFamily: "$mono",
  fontSize: 12,
  color: "$colorMuted",
});

export const EmptyState = styled(YStack, {
  padding: 32,
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  borderStyle: "dashed",
});
