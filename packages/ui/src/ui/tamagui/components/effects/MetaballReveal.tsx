"use client";

/**
 * MetaballReveal - A sophisticated reveal animation that mimics fluid/metaball
 * behavior using animated clip-paths and layered transforms.
 *
 * The effect creates multiple "blob" shapes that expand and merge from the
 * press point, giving an organic, liquid-like dissolution of the card surface.
 *
 * Web-only for now. Falls back to simple fade on native.
 */
import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";
import { Stack, styled, useTheme, type GetProps } from "tamagui";

import { stubTheme } from "../../tokens/colors";
import { hexToRgba } from "../shared";

const isWeb = Platform.OS === "web";

/** Alpha for the default, theme-derived blob tint. */
const BLOB_ALPHA = 0.35;

const EffectContainer = styled(Stack, {
  name: "MetaballRevealContainer",
  position: "relative",
  overflow: "hidden",
});

type BlobState = {
  id: number;
  x: number;
  y: number;
  scale: number;
  delay: number;
};

type AnimationState = {
  active: boolean;
  blobs: BlobState[];
  centerX: number;
  centerY: number;
};

export interface MetaballRevealProps extends Omit<
  GetProps<typeof EffectContainer>,
  "onPress"
> {
  /** Content to render inside the effect container */
  children: ReactNode;
  /** Called when the reveal animation completes */
  onRevealComplete?: () => void;
  /** Total duration of the animation in ms */
  duration?: number;
  /**
   * Primary color of the blob effect. Defaults to the active theme's
   * foreground at 35% — ink on Stub's paper, light on Ember's navy.
   */
  blobColor?: string;
  /** Number of blob elements to spawn */
  blobCount?: number;
  /** Whether the effect is disabled */
  disabled?: boolean;
}

// Generate staggered blob positions around a center point
const generateBlobs = (
  centerX: number,
  centerY: number,
  count: number,
): BlobState[] => {
  const blobs: BlobState[] = [];

  // Central blob
  blobs.push({
    id: 0,
    x: centerX,
    y: centerY,
    scale: 2.5,
    delay: 0,
  });

  // Surrounding blobs in a staggered pattern
  for (let i = 1; i < count; i++) {
    const angle = (i / (count - 1)) * Math.PI * 2;
    const distance = 15 + Math.random() * 10;
    const x = centerX + Math.cos(angle) * distance;
    const y = centerY + Math.sin(angle) * distance;
    const scale = 1.8 + Math.random() * 0.8;
    const delay = 30 + i * 15 + Math.random() * 20;

    blobs.push({ id: i, x, y, scale, delay });
  }

  return blobs;
};

/**
 * Wraps content with a metaball-style reveal animation.
 * When pressed, spawns multiple "blobs" that expand and merge organically.
 */
export const MetaballReveal = memo<MetaballRevealProps>(
  ({
    children,
    onRevealComplete,
    duration = 500,
    blobColor: blobColorProp,
    blobCount = 6,
    disabled = false,
    ...containerProps
  }) => {
    const theme = useTheme();
    // The blobs overlay caller-supplied content, so the only surface-agnostic
    // default is the active theme's own foreground. A raw white (the previous
    // default) was authored for Ember and is invisible on the shipped Stub paper.
    const blobColor =
      blobColorProp ??
      hexToRgba(theme.color?.val ?? stubTheme.color, BLOB_ALPHA);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [animation, setAnimation] = useState<AnimationState>({
      active: false,
      blobs: [],
      centerX: 50,
      centerY: 50,
    });

    const handlePress = useCallback(
      (event: unknown) => {
        if (disabled || !isWeb) {
          onRevealComplete?.();
          return;
        }

        const mouseEvent = event as React.MouseEvent | React.TouchEvent;
        const container = containerRef.current;
        if (!container) {
          onRevealComplete?.();
          return;
        }

        const rect = container.getBoundingClientRect();
        let clientX: number;
        let clientY: number;

        if ("touches" in mouseEvent && mouseEvent.touches.length > 0) {
          clientX = mouseEvent.touches[0]!.clientX;
          clientY = mouseEvent.touches[0]!.clientY;
        } else if ("clientX" in mouseEvent) {
          clientX = mouseEvent.clientX;
          clientY = mouseEvent.clientY;
        } else {
          clientX = rect.left + rect.width / 2;
          clientY = rect.top + rect.height / 2;
        }

        const centerX = ((clientX - rect.left) / rect.width) * 100;
        const centerY = ((clientY - rect.top) / rect.height) * 100;
        const blobs = generateBlobs(centerX, centerY, blobCount);

        setAnimation({
          active: true,
          blobs,
          centerX,
          centerY,
        });

        setTimeout(() => {
          setAnimation({
            active: false,
            blobs: [],
            centerX: 50,
            centerY: 50,
          });
          onRevealComplete?.();
        }, duration);
      },
      [blobCount, disabled, duration, onRevealComplete],
    );

    // Native fallback
    if (!isWeb) {
      return (
        <EffectContainer {...containerProps} onPress={onRevealComplete}>
          {children}
        </EffectContainer>
      );
    }

    return (
      <EffectContainer
        {...containerProps}
        ref={containerRef as any}
        onPress={handlePress}
        cursor={disabled ? undefined : "pointer"}
      >
        {children}
        {animation.active && (
          <div style={styles.blobContainer}>
            {animation.blobs.map((blob) => (
              <div
                key={blob.id}
                style={
                  {
                    ...styles.blob,
                    left: `${blob.x}%`,
                    top: `${blob.y}%`,
                    background: blobColor,
                    animationDuration: `${duration}ms`,
                    animationDelay: `${blob.delay}ms`,
                    // Scale varies per blob for organic feel
                    "--blob-scale": blob.scale,
                  } as React.CSSProperties
                }
              />
            ))}
            {/* SVG filter for metaball merging effect */}
            <svg style={styles.svgFilter}>
              <defs>
                <filter id="metaball-filter">
                  <feGaussianBlur
                    in="SourceGraphic"
                    stdDeviation="10"
                    result="blur"
                  />
                  <feColorMatrix
                    in="blur"
                    mode="matrix"
                    values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 25 -10"
                    result="metaball"
                  />
                  <feComposite
                    in="SourceGraphic"
                    in2="metaball"
                    operator="atop"
                  />
                </filter>
              </defs>
            </svg>
          </div>
        )}
        <style>{keyframes}</style>
      </EffectContainer>
    );
  },
);

MetaballReveal.displayName = "MetaballReveal";

// CSS keyframes for blob animation
const keyframes = `
  @keyframes metaball-expand {
    0% {
      transform: translate(-50%, -50%) scale(0);
      opacity: 1;
    }
    60% {
      opacity: 0.8;
    }
    100% {
      transform: translate(-50%, -50%) scale(var(--blob-scale, 2));
      opacity: 0;
    }
  }
`;

// Inline styles for web-only elements
const styles: Record<string, React.CSSProperties> = {
  blobContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none",
    zIndex: 10,
    filter: "url(#metaball-filter)",
    overflow: "hidden",
  },
  blob: {
    position: "absolute",
    width: "60%",
    paddingBottom: "60%", // Square aspect ratio
    borderRadius: "50%",
    transform: "translate(-50%, -50%) scale(0)",
    animation: "metaball-expand cubic-bezier(0.22, 1, 0.36, 1) forwards",
    willChange: "transform, opacity",
  },
  svgFilter: {
    position: "absolute",
    width: 0,
    height: 0,
    visibility: "hidden" as const,
  },
};
