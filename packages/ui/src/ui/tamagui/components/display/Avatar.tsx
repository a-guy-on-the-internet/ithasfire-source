import { forwardRef } from "react";
import { Avatar as TamaguiAvatar, styled, type GetProps } from "tamagui";

import { Text } from "../typography/Text";

const AvatarFrame = styled(TamaguiAvatar, {
  name: "Avatar",
  overflow: "hidden",
  alignItems: "center",
  justifyContent: "center",
  // Square, always. `radius: 0` is locked for content (design-system-v2 §4) and
  // the base Tamagui Avatar is circular by default, so this has to be explicit.
  // This used to be enforced by a `shape: circle | square` variant whose two
  // branches both set 0 — a prop that read as a choice and was not one.
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surfaceMuted",
  flexShrink: 0,
  variants: {
    /**
     * ── Why all SIX box properties are spelled out ───────────────────────────
     * Do NOT "simplify" these back to `width`/`height`.
     *
     * The base Tamagui `Avatar` carries its own `size` variant, and its default
     * (`size: true`) emits `_minWidth-t-size-true` / `_maxWidth-t-size-true` /
     * `_minHeight-…` / `_maxHeight-…`, all resolving to `var(--t-size-true)`,
     * which this design system maps to **14px** (`tokens/size.ts` — `true` is
     * `$3`). A bare `width`/`height` here lands as inline style, and
     * `max-width` beats `width` no matter which side is inline, so every
     * `<Avatar>` in the product collapsed to 14x14 (a 10px content box after
     * the 2px borders) and clipped its monogram. Measured live on /admin.
     *
     * Writing min/max/base for both axes makes this variant emit its own
     * classes for the same atomic properties, so it wins the merge instead of
     * fighting the clamp.
     */
    frameSize: {
      sm: {
        width: 40,
        height: 40,
        minWidth: 40,
        maxWidth: 40,
        minHeight: 40,
        maxHeight: 40,
      },
      md: {
        width: 56,
        height: 56,
        minWidth: 56,
        maxWidth: 56,
        minHeight: 56,
        maxHeight: 56,
      },
      lg: {
        width: 72,
        height: 72,
        minWidth: 72,
        maxWidth: 72,
        minHeight: 72,
        maxHeight: 72,
      },
    },
  },
  defaultVariants: {
    frameSize: "md",
  },
});

const initialsVariantMap = {
  sm: "body",
  md: "subtitle",
  lg: "h5",
} as const;

export interface AvatarProps extends Omit<
  GetProps<typeof AvatarFrame>,
  "frameSize"
> {
  size?: keyof typeof initialsVariantMap;
  src?: string;
  alt?: string;
  initials?: string;
}

export const Avatar = forwardRef<HTMLDivElement, AvatarProps>(
  (
    { size = "md", src, alt, initials, children, ...rest },
    ref,
  ) => {
    const fallbackContent =
      children ??
      (initials ? (
        <Text
          variant={initialsVariantMap[size]}
          weight="bold"
          style={{ textTransform: "uppercase" }}
          margin={0}
          textAlign="center"
        >
          {initials}
        </Text>
      ) : null);

    return (
      <AvatarFrame ref={ref} frameSize={size} {...rest}>
        {src ? (
          <TamaguiAvatar.Image
            accessibilityLabel={alt}
            src={src}
            width="100%"
            height="100%"
            style={{ objectFit: "cover" }}
          />
        ) : null}
        {src ? (
          <TamaguiAvatar.Fallback delayMs={120}>
            {fallbackContent}
          </TamaguiAvatar.Fallback>
        ) : (
          fallbackContent
        )}
      </AvatarFrame>
    );
  },
);

Avatar.displayName = "Avatar";
