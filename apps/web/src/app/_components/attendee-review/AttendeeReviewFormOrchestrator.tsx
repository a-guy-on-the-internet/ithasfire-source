"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ArrowRight, ArrowLeft, Check, SkipForward } from "lucide-react";
import { Button, Spinner, Text, useTranslations } from "@th/ui";
import { normalizeError } from "@th/errors";
import { styled, XStack, YStack, useMedia } from "tamagui";

import { ACCENT } from "@/lib/design-tokens";
import { trpc } from "@/trpc";

import { AttendeeSuccessScreen } from "./_primitives/AttendeeSuccessScreen";
import { buildAttendeeScreens } from "./_screens";
import {
  ANIM_ENTER,
  ANIM_EXIT,
  BORDER,
  ERROR_RED,
  EXIT_EASE,
  FG,
  MUTED,
  SPRING_EASE,
  getSlideStyle,
  type SlideDir,
} from "./_shared/tokens";
import { EMPTY, buildPayload, type AttendeeFormData } from "./_shared/types";

// ─────────────────────────────────────────────────────────────────────────────
// Surface — mirrors the place-review form shell (Swiss, thick border, full
// viewport on mobile, stable height on desktop).
// ─────────────────────────────────────────────────────────────────────────────

const FormSurface = styled(YStack, {
  name: "AttendeeReviewSurface",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  padding: 0,
  overflow: "clip" as never,
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  $gtMd: {
    minHeight: 480,
    maxHeight: "min(640px, 75vh)",
    maxWidth: 600,
  },
});

const AUTO_ADVANCE_MS = 420;

interface AttendeeReviewFormOrchestratorProps {
  eventId: string;
  eventSlug?: string | null;
  /** Prompt-campaign attribution (reserved; not sent this loop). */
  campaign?: string;
  onSubmitted?: () => void;
}

export function AttendeeReviewFormOrchestrator({
  eventId,
  eventSlug,
  onSubmitted,
}: AttendeeReviewFormOrchestratorProps) {
  const t = useTranslations();
  const formId = useId();
  const media = useMedia();

  const screens = useMemo(() => buildAttendeeScreens((k) => t(k)), [t]);
  const totalScreens = screens.length;

  const [screen, setScreen] = useState(0);
  const [displayScreen, setDisplayScreen] = useState(0);
  const [data, setData] = useState<AttendeeFormData>(EMPTY);
  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  // ── Reduced motion ─────────────────────────────────────────────────────
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ── Slide animation ────────────────────────────────────────────────────
  const [slideDir, setSlideDir] = useState<SlideDir>("none");
  const [animPhase, setAnimPhase] = useState<"active" | "exiting" | "entering">(
    "active",
  );
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Mutation ───────────────────────────────────────────────────────────
  const submitMut = trpc.attendeeReviews.submit.useMutation({
    onSuccess: () => {
      setSuccess(true);
      onSubmitted?.();
    },
    onError: (err) => {
      const { formError } = normalizeError(err, (k) => String(t(k)));
      setError(formError ?? String(t("attendeeReview.error.submitFailed")));
    },
  });

  const onChange = useCallback((patch: Partial<AttendeeFormData>) => {
    setData((prev) => ({ ...prev, ...patch }));
    setError(undefined);
  }, []);

  const handleSubmit = useCallback(() => {
    // Overall is the only server-required field; re-check before firing.
    if (data.overallRating < 1) {
      setScreen(0);
      setDisplayScreen(0);
      setError(String(t("attendeeReview.validation.pickRating")));
      return;
    }
    setError(undefined);
    submitMut.mutate(buildPayload(eventId, data));
  }, [data, eventId, submitMut, t]);

  const animateTo = useCallback(
    (next: number) => {
      if (next === screen) return;
      if (reducedMotion) {
        setScreen(next);
        setDisplayScreen(next);
        setSlideDir("none");
        setAnimPhase("active");
        return;
      }
      if (animTimer.current) clearTimeout(animTimer.current);
      setSlideDir(next > screen ? "forward" : "backward");
      setAnimPhase("exiting");
      animTimer.current = setTimeout(() => {
        setDisplayScreen(next);
        setAnimPhase("entering");
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setScreen(next);
            setAnimPhase("active");
            animTimer.current = setTimeout(
              () => setSlideDir("none"),
              ANIM_ENTER,
            );
          });
        });
      }, ANIM_EXIT);
    },
    [screen, reducedMotion],
  );

  const handleNext = useCallback(() => {
    const def = screens[screen];
    if (!def) return;
    if (def.validate) {
      const err = def.validate(data);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(undefined);
    if (screen === totalScreens - 1) {
      handleSubmit();
      return;
    }
    animateTo(screen + 1);
  }, [screen, screens, totalScreens, data, animateTo, handleSubmit]);

  const handleBack = useCallback(() => {
    if (screen > 0) {
      setError(undefined);
      animateTo(screen - 1);
    }
  }, [screen, animateTo]);

  // ── Gentle auto-advance (rating pick) ──────────────────────────────────
  const handleNextRef = useRef(handleNext);
  handleNextRef.current = handleNext;
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestAutoAdvance = useCallback(() => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(
      () => handleNextRef.current(),
      reducedMotion ? 120 : AUTO_ADVANCE_MS,
    );
  }, [reducedMotion]);
  // Cancel a pending auto-advance whenever the screen changes or on unmount.
  useEffect(() => {
    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
  }, [screen]);

  // ── Enter advances (except inside the textarea) ────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (animPhase !== "active") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA") return;
      e.preventDefault();
      handleNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNext, animPhase]);

  // ── Focus management on screen change (skip first render) ──────────────
  const hasNavigated = useRef(false);
  useEffect(() => {
    if (animPhase !== "active") return;
    if (!hasNavigated.current) {
      hasNavigated.current = true;
      return;
    }
    const container = contentRef.current;
    if (!container) return;
    const timer = setTimeout(() => {
      const focusable = container.querySelector<HTMLElement>(
        'button[role="radio"][tabindex="0"], textarea, input, button',
      );
      focusable?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [screen, animPhase]);

  // ── Computed styles ────────────────────────────────────────────────────
  const slideStyle = useMemo<CSSProperties>(() => {
    const phase =
      animPhase === "exiting"
        ? "exit"
        : animPhase === "entering"
          ? "enter"
          : "active";
    return getSlideStyle(slideDir, phase);
  }, [slideDir, animPhase]);

  const questionStyle = useMemo<CSSProperties>(() => {
    if (reducedMotion) return { opacity: 1, transform: "none" };
    if (animPhase === "exiting")
      return {
        opacity: 0,
        transform: "translateY(-8px)",
        transition: `opacity ${ANIM_EXIT}ms ${EXIT_EASE}, transform ${ANIM_EXIT}ms ${EXIT_EASE}`,
      };
    if (animPhase === "entering")
      return {
        opacity: 0,
        transform: "translateY(12px)",
        transition: `opacity ${ANIM_ENTER}ms ${SPRING_EASE}, transform ${ANIM_ENTER}ms ${SPRING_EASE}`,
      };
    return {
      opacity: 1,
      transform: "translateY(0)",
      transition: `opacity ${ANIM_ENTER}ms ${SPRING_EASE}, transform ${ANIM_ENTER}ms ${SPRING_EASE}`,
    };
  }, [animPhase, reducedMotion]);

  // ── Success ────────────────────────────────────────────────────────────
  if (success) {
    return (
      <FormSurface>
        <AttendeeSuccessScreen
          eventSlug={eventSlug}
          reducedMotion={reducedMotion}
        />
      </FormSurface>
    );
  }

  const currentDef = screens[displayScreen]!;
  const isLast = displayScreen === totalScreens - 1;
  const isOptional = currentDef.phase === "optional";
  const showSkip = isOptional && !isLast;

  const isCompactNav = media.sm;
  const questionId = `${formId}-q`;
  const helperId = `${formId}-h`;

  return (
    <FormSurface role="form" aria-label={String(t("attendeeReview.pageTitle"))}>
      {/* Progress bar */}
      <div
        style={{ height: 3, width: "100%", background: BORDER, overflow: "hidden" }}
        role="progressbar"
        aria-valuenow={displayScreen + 1}
        aria-valuemin={1}
        aria-valuemax={totalScreens}
        aria-label={String(
          t("attendeeReview.progress", {
            current: displayScreen + 1,
            total: totalScreens,
          }),
        )}
      >
        <div
          style={{
            height: "100%",
            width: `${((displayScreen + 1) / totalScreens) * 100}%`,
            background: ACCENT,
            transition: reducedMotion ? "none" : "width 300ms ease-out",
          }}
        />
      </div>

      {/* SR live region */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {String(
          t("attendeeReview.progress", {
            current: displayScreen + 1,
            total: totalScreens,
          }),
        )}
        {`: ${currentDef.question}`}
      </div>

      {/* Question */}
      <div style={{ padding: "24px 20px 0", ...questionStyle }}>
        <div
          id={questionId}
          role="heading"
          aria-level={2}
          style={{
            fontFamily: "var(--font-body, 'Montserrat', sans-serif)",
            fontWeight: 800,
            fontSize: 24,
            lineHeight: 1.25,
            color: FG,
            margin: 0,
          }}
        >
          {currentDef.question}
        </div>
        {currentDef.helper && (
          <div
            id={helperId}
            style={{
              marginTop: 10,
              fontSize: 14,
              color: MUTED,
              lineHeight: 1.6,
              letterSpacing: "0.01em",
            }}
          >
            {currentDef.helper}
          </div>
        )}
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        aria-labelledby={questionId}
        aria-describedby={currentDef.helper ? helperId : undefined}
        style={{
          padding: "24px 20px 36px",
          overflowY: "auto",
          overflowX: "hidden",
          position: "relative",
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={slideStyle}>
          {currentDef.render(data, onChange, requestAutoAdvance)}
        </div>
      </div>

      {/* Error */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={{
          padding: error ? "0 20px 12px" : 0,
          color: ERROR_RED,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {error ?? ""}
      </div>

      {/* Nav */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: isCompactNav ? 8 : 12,
          padding: isCompactNav ? "16px 12px" : "16px 20px",
          paddingBottom: "max(16px, env(safe-area-inset-bottom, 16px))",
          borderTop: `1px solid ${BORDER}`,
          position: "sticky",
          bottom: 0,
          // Frosted chrome: the same paper as FormSurface, held translucent so
          // the blur has something to work on as content scrolls under it.
          background: "color-mix(in srgb, var(--surface, #FDFAF3) 80%, transparent)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          zIndex: 2,
        }}
      >
        {screen > 0 ? (
          <Button
            variant="ghost"
            size="$3"
            onPress={handleBack}
            disabled={animPhase !== "active"}
            aria-label={String(t("attendeeReview.nav.backAria"))}
          >
            <XStack alignItems="center" gap={6}>
              <ArrowLeft size={16} />
              <Text variant="bodySmall" weight="bold" color="$color" margin={0}>
                {String(t("attendeeReview.nav.back"))}
              </Text>
            </XStack>
          </Button>
        ) : (
          <div />
        )}

        <XStack alignItems="center" gap={10}>
          {showSkip && (
            <Button
              variant="ghost"
              size={isCompactNav ? "$2" : "$3"}
              onPress={handleSubmit}
              disabled={submitMut.isPending || animPhase !== "active"}
              aria-label={String(t("attendeeReview.nav.skipAria"))}
              flexShrink={1}
              minWidth={0}
            >
              <XStack alignItems="center" gap={isCompactNav ? 4 : 6} minWidth={0}>
                <SkipForward size={14} />
                <Text
                  variant="bodySmall"
                  weight="bold"
                  color="$colorMuted"
                  margin={0}
                >
                  {String(t("attendeeReview.nav.skip"))}
                </Text>
              </XStack>
            </Button>
          )}

          <Button
            variant="primary"
            size={isCompactNav ? "$3" : "$4"}
            onPress={handleNext}
            disabled={submitMut.isPending || animPhase !== "active"}
            aria-label={String(
              isLast
                ? t("attendeeReview.nav.submitAria")
                : t("attendeeReview.nav.continueAria"),
            )}
            flexShrink={0}
          >
            <XStack alignItems="center" gap={8}>
              {submitMut.isPending ? (
                <Spinner size="sm" indicatorColor="$colorInverted" />
              ) : isLast ? (
                <Check size={16} />
              ) : null}
              <Text
                variant="bodySmall"
                weight="bold"
                color="$colorInverted"
                margin={0}
              >
                {String(
                  isLast
                    ? t("attendeeReview.nav.submit")
                    : t("attendeeReview.nav.continue"),
                )}
              </Text>
              {!isLast && <ArrowRight size={16} />}
            </XStack>
          </Button>
        </XStack>
      </div>
    </FormSurface>
  );
}

AttendeeReviewFormOrchestrator.displayName = "AttendeeReviewFormOrchestrator";
