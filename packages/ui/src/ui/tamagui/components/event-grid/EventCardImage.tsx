import { memo } from "react";
import { Platform } from "react-native";
import { Image, Stack, styled, type GetProps } from "tamagui";

import { Text } from "../typography/Text";
import type { EventSummaryMedia } from "./types";
import { DEFAULT_MEDIA_ASPECT_RATIO } from "./sizes";

const MediaContainer = styled(Stack, {
  name: "EventCardImageContainer",
  width: "100%",
  // radius: 0 is locked system-wide, and a ticket's art window especially is a
  // cut rectangle. The rounded top corners here were invisible only because
  // the card frame clipped them; on any square-cornered parent they showed.
  borderRadius: 0,
  overflow: "hidden",
  backgroundColor: "$surfaceMuted",
  position: "relative",
  flexShrink: 0,
});

/**
 * The no-photo fallback.
 *
 * Initials set huge, ghosted, and bled off the bottom-right corner of the
 * window — the DS's `.if-aspect__fallback`. It reads as a printer's mark on
 * the ticket rather than as a missing image, which is what an empty grey
 * rectangle reads as. Decorative: the title is already the accessible name.
 */
const FallbackMark = styled(Stack, {
  name: "EventCardImageFallback",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  alignItems: "flex-end",
  justifyContent: "flex-end",
  overflow: "hidden",
  pointerEvents: "none",
});

const Overlay = styled(Stack, {
  name: "EventCardImageOverlay",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "transparent",
  pointerEvents: "none",
});

export interface EventCardImageProps extends GetProps<typeof MediaContainer> {
  media?: EventSummaryMedia;
  showOverlay?: boolean;
  children?: React.ReactNode;
  height?: number | string;
  maxHeight?: number | string;
  minHeight?: number | string;
  aspectRatio?: number;
  enforceAspectRatio?: boolean;
  /** Initials shown when there is no image, e.g. "H&". Decorative. */
  fallbackText?: string;
  /**
   * A whole rendered artwork to stand in for a missing upload — today, the
   * `DateStub`. Decorative; the caller owns hiding it from assistive tech.
   *
   * When present it REPLACES the ghosted-initials mark rather than stacking
   * with it: two fallbacks painted on top of each other is not a treatment, and
   * the stub already carries the initials' job (it says which event this is)
   * plus the date and the place.
   *
   * Sits at `zIndex: 0`, UNDER the `<Image>`, for the same reason the initials
   * do: the commonest failure in the wild is an upload whose URL 404s, where
   * `media` is truthy and the image paints nothing. Painting beneath means a
   * broken upload degrades to the same honest ticket as no upload at all.
   */
  fallback?: React.ReactNode;
  /**
   * What the art window is made of.
   *
   * `light` — a pale placeholder panel. Correct when nothing is printed on
   * top of the image.
   *
   * `ink` — a dark ground with the upload composited onto it and run through
   * the system's duotone. This is the poster's answer to "contrast becomes
   * conditional on the organizer's upload": the panel is ink whether or not
   * an image loads, the duotone flattens the range of whatever does load, and
   * the reversed-out type therefore has a floor it can rely on. The ghosted
   * initials flip to paper so they read on it.
   */
  ground?: "light" | "ink";
}

/**
 * The poster's image treatment. Photographs keep their COLOUR.
 *
 * This was the DS's warm duotone (`grayscale(1) sepia(.34) …`), which turned
 * every card monochrome. It was pulling double duty: a house style, and a
 * contrast guarantee — flattening every upload into one tonal band so the
 * reversed-out title could not be undone by a bright photo.
 *
 * Only the second job was load-bearing, and the scrim already does it: the
 * poster's ink ground plus `POSTER_SCRIM`'s 55% mid-stop hold the title band
 * regardless of what is behind it. So the desaturation bought nothing the
 * gradient was not already buying, and it cost every event its colour — on a
 * discovery page whose whole job is making gigs look like somewhere you want
 * to be.
 *
 * What is left is a slight lift: enough to keep flat phone snapshots from
 * looking washed out beside professional shots, nowhere near enough to
 * restyle them.
 */
const POSTER_IMAGE_FILTER = "saturate(1.06) contrast(1.03)";

export const EventCardImage = memo<EventCardImageProps>(
  ({
    media,
    showOverlay = true,
    children,
    height,
    maxHeight,
    minHeight,
    aspectRatio,
    enforceAspectRatio = true,
    fallbackText,
    fallback,
    ground = "light",
    style,
    ...rest
  }) => {
    const resolvedAspectRatio = enforceAspectRatio
      ? (aspectRatio ?? media?.aspectRatio ?? DEFAULT_MEDIA_ASPECT_RATIO)
      : undefined;
    const resolvedHeight = typeof height !== "undefined" ? height : undefined;
    const resolvedMaxHeight =
      typeof maxHeight !== "undefined" ? maxHeight : resolvedHeight;
    const resolvedMinHeight =
      typeof minHeight !== "undefined" ? minHeight : resolvedHeight;

    const sharedDimensionsProps = {
      ...(typeof resolvedHeight !== "undefined"
        ? { height: resolvedHeight }
        : {}),
      ...(typeof resolvedMinHeight !== "undefined"
        ? { minHeight: resolvedMinHeight }
        : {}),
      ...(typeof resolvedMaxHeight !== "undefined"
        ? { maxHeight: resolvedMaxHeight }
        : {}),
    } as const;

    return (
      <MediaContainer
        {...(ground === "ink" ? { backgroundColor: "$scrim" as const } : {})}
        {...rest}
        {...sharedDimensionsProps}
        {...(resolvedAspectRatio ? { aspectRatio: resolvedAspectRatio } : {})}
        style={style}
      >
        {/*
          The mark sits UNDER the image rather than instead of it.

          Gating it on `media` being absent only covers the "no upload" case.
          The commoner failure in the wild is an upload whose URL 404s or is
          empty — `media` is truthy, the <Image> renders nothing, and the card
          shows a blank panel. Painting the initials beneath means a broken
          upload degrades to the same honest ticket as no upload at all.
        */}
        {fallback ? (
          <FallbackMark zIndex={0} alignItems="stretch" justifyContent="center">
            {fallback}
          </FallbackMark>
        ) : null}
        {fallbackText && !fallback ? (
          <FallbackMark
            zIndex={0}
            {...(Platform.OS === "web" ? { "aria-hidden": true } : {})}
          >
            <Text
              variant="span"
              fontFamily="$heading"
              weight="black"
              {...(ground === "ink"
                ? { color: "$onScrim" as const }
                : { tone: "muted" as const })}
              // Bled off the corner, the way the DS sets it: the mark is a
              // texture on the window, not a label centred in a box. The
              // negative offsets are what push it past the edge so it crops.
              fontSize={72}
              lineHeight={56}
              letterSpacing={-6}
              marginRight={-6}
              marginBottom={-10}
              style={{ opacity: 0.35 }}
            >
              {fallbackText}
            </Text>
          </FallbackMark>
        ) : null}
        {media ? (
          <Image
            accessibilityLabel={media.alt}
            resizeMode="cover"
            source={{ uri: media.url }}
            style={
              {
                width: "100%",
                height: "100%",
                // Above the fallback mark. An absolutely-positioned sibling
                // paints over in-flow content by default, so without this the
                // initials would sit ON the photo rather than behind it.
                position: "relative",
                zIndex: 1,
                ...(ground === "ink" && Platform.OS === "web"
                  ? { filter: POSTER_IMAGE_FILTER }
                  : {}),
                ...(resolvedAspectRatio
                  ? { aspectRatio: resolvedAspectRatio }
                  : {}),
                ...(typeof resolvedMaxHeight !== "undefined"
                  ? { maxHeight: resolvedMaxHeight }
                  : {}),
                ...(typeof resolvedMinHeight !== "undefined"
                  ? { minHeight: resolvedMinHeight }
                  : {}),
                ...(Platform.OS === "web" ? { objectFit: "cover" } : {}),
              } as Record<string, unknown>
            }
            {...(Platform.OS === "web"
              ? ({
                  role: "img",
                  "aria-label": media.alt,
                  src: media.url,
                } as Record<string, unknown>)
              : {})}
          />
        ) : null}
        {showOverlay ? <Overlay /> : null}
        {children}
      </MediaContainer>
    );
  },
);

EventCardImage.displayName = "EventCardImage";
