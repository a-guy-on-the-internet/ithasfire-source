"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { styled, XStack, YStack, Paragraph } from "tamagui";
import { useTranslations } from "@th/ui";
import Link from "next/link";

import { useIsMobile } from "@/hooks/useIsMobile";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface FeaturedItem {
  id: string;
  itemType: "EVENT" | "HUMAN" | "ORGANIZATION" | "PLACE";
  title: string | null;
  subtitle: string | null;
  heroImageUrl: string | null;
  ctaUrl: string | null;
  ctaLabel: string | null;
  sortOrder: number;
}

export interface FeaturedHeroCarouselProps {
  items: FeaturedItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_BADGE_KEYS: Record<FeaturedItem["itemType"], string> = {
  EVENT: "admin.featuredTypeBadgeEvent",
  HUMAN: "admin.featuredTypeBadgeHuman",
  ORGANIZATION: "admin.featuredTypeBadgeOrg",
  PLACE: "admin.featuredTypeBadgePlace",
};

const AUTO_ADVANCE_MS = 6_000;

// ─────────────────────────────────────────────────────────────────────────────
// Styled components
// ─────────────────────────────────────────────────────────────────────────────

const CarouselRoot = styled(YStack, {
  name: "FeaturedHeroCarousel",
  width: "100%",
  overflow: "hidden",
  position: "relative",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$backgroundStrong",
});

const SlideTrack = styled(XStack, {
  name: "SlideTrack",
  width: "100%",
  height: "100%",
  position: "absolute",
  top: 0,
  left: 0,
});

const Slide = styled(YStack, {
  name: "Slide",
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  justifyContent: "flex-end",
  padding: "$5",
  // Off-scale on purpose: this is functional clearance, not spacing. The
  // IndicatorRow sits at `bottom: 12` with ~16px of dots, so the copy needs
  // more room at the bottom edge than $6 (32) gives and less than $7 (48).
  paddingBottom: 40,
  // Slide copy is spaced with gap, not per-child margins (DS v2 §4). Both
  // SlideSubtitle and CtaButton are conditional, and gap only applies between
  // children that actually render — so an item with no subtitle collapses
  // cleanly instead of leaving the old marginTop behind.
  gap: "$2",
});

const GradientOverlay = styled(YStack, {
  name: "GradientOverlay",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
});

const TypeBadge = styled(Paragraph, {
  name: "TypeBadge",
  fontSize: 11,
  fontWeight: "800",
  textTransform: "uppercase",
  letterSpacing: 2,
  color: "$brandSecondary",
  paddingHorizontal: "$2",
  // 3 is an optical value on an 11px uppercase pill, deliberately left
  // off-scale — $1 (4) would grow the badge 2px for no reason.
  paddingVertical: 3,
  borderWidth: 1,
  borderColor: "$brandSecondary",
  borderRadius: 0,
  alignSelf: "flex-start",
});

const SlideTitle = styled(Paragraph, {
  name: "SlideTitle",
  fontSize: 28,
  fontWeight: "900",
  textTransform: "uppercase",
  letterSpacing: -0.5,
  // Slide copy always sits on the dark GradientOverlay (a black scrim over
  // artwork, or the $structure wash without it), so it stays deliberately
  // light — via $onStructure rather than a raw white.
  color: "$onStructure",
  lineHeight: 32,
});

const SlideSubtitle = styled(Paragraph, {
  name: "SlideSubtitle",
  fontSize: 14,
  fontWeight: "400",
  color: "$onStructure",
  // Text-only node, so element opacity == the old 0.75 colour alpha.
  opacity: 0.75,
  lineHeight: 20,
});

// Mirrors the @th/ui Button "primary" grammar (ink on orange — white-on-orange
// is only 3.16:1 and fails AA). Stays a styled Paragraph because the real
// interactive element is the wrapping next/link anchor.
const CtaButton = styled(Paragraph, {
  name: "CtaButton",
  fontSize: 12,
  fontWeight: "700",
  textTransform: "uppercase",
  letterSpacing: 1.5,
  color: "$onBrandSecondary",
  backgroundColor: "$brandSecondary",
  paddingHorizontal: "$4",
  paddingVertical: "$2",
  borderRadius: 0,
  alignSelf: "flex-start",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$brandSecondaryHover",
  },
});

const IndicatorRow = styled(XStack, {
  name: "IndicatorRow",
  position: "absolute",
  bottom: 12,
  right: 16,
  gap: 6,
  alignItems: "center",
  zIndex: 10,
});

const ProgressBarContainer = styled(YStack, {
  name: "ProgressBarContainer",
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: 3,
  // Track behind the accent fill. Alpha lives in the colour, not `opacity` —
  // the fill is a child and would inherit the fade.
  backgroundColor:
    "color-mix(in srgb, var(--onStructure, #FDFAF3) 15%, transparent)",
  zIndex: 10,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FeaturedHeroCarousel({ items }: FeaturedHeroCarouselProps) {
  const t = useTranslations();
  const isMobile = useIsMobile();
  const [activeIndex, setActiveIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const paused = isHovered || isFocusWithin;

  // Detect prefers-reduced-motion
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const count = items.length;

  const goTo = useCallback(
    (index: number) => {
      setActiveIndex(index % count);
      setProgress(0);
    },
    [count],
  );

  // ── Timer helpers ───────────────────────────────────────────────────────

  const stopTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (progressRef.current) {
      clearInterval(progressRef.current);
      progressRef.current = null;
    }
  }, []);

  const startTimers = useCallback(() => {
    stopTimers();
    if (count <= 1 || reducedMotion) return;

    const progressInterval = 50;
    progressRef.current = setInterval(() => {
      setProgress((prev) => {
        const next = prev + (progressInterval / AUTO_ADVANCE_MS) * 100;
        return next >= 100 ? 100 : next;
      });
    }, progressInterval);

    timerRef.current = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % count);
      setProgress(0);
    }, AUTO_ADVANCE_MS);
  }, [count, reducedMotion, stopTimers]);

  // Auto-advance timer
  useEffect(() => {
    if (paused) {
      stopTimers();
      return;
    }
    startTimers();
    return stopTimers;
  }, [count, reducedMotion, paused, startTimers, stopTimers]);

  // Reset timers on manual navigation
  const handleIndicatorClick = useCallback(
    (index: number) => {
      goTo(index);
      if (!paused) {
        startTimers();
      }
    },
    [goTo, paused, startTimers],
  );

  // Keyboard navigation (WCAG carousel pattern)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handleIndicatorClick((activeIndex - 1 + count) % count);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleIndicatorClick((activeIndex + 1) % count);
      }
    },
    [activeIndex, count, handleIndicatorClick],
  );

  // Pause on hover/focus (WCAG 2.2.2)
  const handleMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);
  const handleFocusCapture = useCallback(() => setIsFocusWithin(true), []);
  const handleBlurCapture = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const nextTarget = e.relatedTarget;
      if (nextTarget && e.currentTarget.contains(nextTarget as Node)) {
        return;
      }
      setIsFocusWithin(false);
    },
    [],
  );

  if (count === 0) return null;

  const carouselHeight = isMobile ? 220 : 300;

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      /* Arrow keys drive this carousel, so a keyboard user has to be able to
         see they have landed on it — it had `outline: none` and no replacement.
         `data-focus-inset` because it is full-width: at the system's +2px the
         ring would be drawn past the viewport edge. */
      data-focus-inset=""
    >
      <CarouselRoot
        style={{ height: carouselHeight }}
        role="region"
        aria-roledescription="carousel"
        aria-label={String(t("admin.featuredPageTitle") ?? "Featured items")}
      >
        {items.map((item, i) => {
          const isActive = i === activeIndex;
          const hasImage = Boolean(item.heroImageUrl);

          return (
            <SlideTrack
              key={item.id}
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}`}
              aria-hidden={!isActive}
              style={{
                opacity: isActive ? 1 : 0,
                zIndex: isActive ? 2 : 1,
                transition: reducedMotion ? "none" : "opacity 400ms ease-out",
              }}
            >
              {/* Background image */}
              {hasImage && (
                <img
                  src={item.heroImageUrl!}
                  alt=""
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              )}

              {/* Gradient overlay for text readability */}
              <GradientOverlay
                style={{
                  background: hasImage
                    ? "linear-gradient(0deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.25) 50%, rgba(0,0,0,0.05) 100%)"
                    : `linear-gradient(135deg, ${STRUCTURAL} 0%, color-mix(in srgb, ${STRUCTURAL} 80%, transparent) 50%, color-mix(in srgb, ${ACCENT} 27%, transparent) 100%)`,
                }}
              />

              {/* Text content */}
              <Slide>
                <TypeBadge>
                  {String(t(TYPE_BADGE_KEYS[item.itemType]))}
                </TypeBadge>
                {/* Title + subtitle are one typographic unit set tighter than
                    the slide's own rhythm, so they get their own gap rather
                    than the subtitle carrying a marginTop. */}
                <YStack gap="$1">
                  <SlideTitle
                    style={
                      isMobile ? { fontSize: 22, lineHeight: 26 } : undefined
                    }
                  >
                    {item.title ?? "Untitled"}
                  </SlideTitle>
                  {item.subtitle && (
                    <SlideSubtitle>{item.subtitle}</SlideSubtitle>
                  )}
                </YStack>
                {isActive && item.ctaUrl && item.ctaLabel && (
                  <Link
                    href={item.ctaUrl}
                    style={{ textDecoration: "none", alignSelf: "flex-start" }}
                  >
                    <CtaButton>{item.ctaLabel}</CtaButton>
                  </Link>
                )}
              </Slide>
            </SlideTrack>
          );
        })}

        {/* Dot indicators */}
        {count > 1 && (
          <IndicatorRow>
            {items.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Go to slide ${i + 1}`}
                onClick={() => handleIndicatorClick(i)}
                style={{
                  width: i === activeIndex ? 24 : 8,
                  height: 8,
                  borderRadius: 0,
                  border: "none",
                  backgroundColor:
                    i === activeIndex
                      ? ACCENT
                      : "color-mix(in srgb, var(--onStructure, #FDFAF3) 40%, transparent)",
                  cursor: "pointer",
                  padding: 0,
                  transition: reducedMotion ? "none" : "all 200ms ease-out",
                }}
              />
            ))}
          </IndicatorRow>
        )}

        {/* Progress bar */}
        {count > 1 && (
          <ProgressBarContainer>
            <div
              style={{
                height: "100%",
                backgroundColor: ACCENT,
                width: `${progress}%`,
                transition: "width 50ms linear",
              }}
            />
          </ProgressBarContainer>
        )}
      </CarouselRoot>
    </div>
  );
}

FeaturedHeroCarousel.displayName = "FeaturedHeroCarousel";
