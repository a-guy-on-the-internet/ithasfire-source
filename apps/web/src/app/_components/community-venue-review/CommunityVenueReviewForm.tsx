"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowRight, ArrowLeft, Check, SkipForward } from "lucide-react";
import { Button, CharCountTextarea, Spinner, Text, useTranslations } from "@th/ui";
import { normalizeError } from "@th/errors";
import { styled, XStack, YStack, useMedia } from "tamagui";

import { ACCENT } from "@/lib/design-tokens";
import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";

import { RatingScale } from "@/app/_components/attendee-review/_primitives/RatingScale";
import {
  ANIM_ENTER,
  ANIM_EXIT,
  BORDER,
  ERROR_RED,
  EXIT_EASE,
  FG,
  INPUT_STYLE,
  MUTED,
  SPRING_EASE,
  getSlideStyle,
  type SlideDir,
} from "@/app/_components/attendee-review/_shared/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// CommunityVenueReviewForm (venue-rating-block-and-owner-optin FR-009/FR-011)
//
// The UNVERIFIED, venue-direct "community" review — the cold-start floor that is
// always available to everyone. Same conversational, one-question-per-screen
// house pattern as the verified attendee flow (place-review precedent), and it
// deliberately REUSES that flow's shared primitives (RatingScale + tokens)
// rather than re-implementing them. It is a sibling, not a fork of the verified
// orchestrator, so the verified path (attendeeReviews.submit) is untouched.
//
// Signed-in viewers submit with their session humanId (injected server-side) and
// skip the name/email screens. Guests supply name + a REQUIRED-but-unverified
// email (FR-013). Copy states plainly that everything — including the words —
// goes privately to the venue and is never shown attributed (FR-011).
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_MAX = 2000;

const FormSurface = styled(YStack, {
  name: "CommunityVenueReviewSurface",
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
    maxHeight: "min(640px, 80vh)",
    maxWidth: 600,
  },
  // Embedded inside the rate_venue modal: the modal panel owns the frame, so
  // the surface fills it without a second border and sizes to the panel.
  variants: {
    chromeless: {
      true: {
        borderWidth: 0,
        minHeight: 0,
        height: "100%",
        $gtMd: { minHeight: 0, maxHeight: "none", maxWidth: "none" },
      },
    },
  } as const,
});

interface CommunityFormData {
  name: string;
  email: string;
  overallRating: number;
  soundQuality: number;
  organization: number;
  venueComfort: number;
  valueForMoney: number;
  text: string;
}

const EMPTY: CommunityFormData = {
  name: "",
  email: "",
  overallRating: 0,
  soundQuality: 0,
  organization: 0,
  venueComfort: 0,
  valueForMoney: 0,
  text: "",
};

type Phase = "core" | "optional";

interface ScreenDef {
  id: string;
  phase: Phase;
  question: string;
  helper?: string;
  validate?: (d: CommunityFormData) => string | undefined;
  /** Auto-advance after a rating tap. */
  autoAdvance?: boolean;
  render: (
    d: CommunityFormData,
    onChange: (patch: Partial<CommunityFormData>) => void,
    advance: () => void,
  ) => ReactNode;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AUTO_ADVANCE_MS = 420;

export interface CommunityVenueReviewFormProps {
  placeId: string;
  /** Drops the surface's own border so it fills a modal panel. */
  chromeless?: boolean;
  onSubmitted?: () => void;
}

export function CommunityVenueReviewForm({
  placeId,
  chromeless = false,
  onSubmitted,
}: CommunityVenueReviewFormProps) {
  const t = useTranslations();
  const formId = useId();
  const media = useMedia();

  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);

  const [data, setData] = useState<CommunityFormData>(EMPTY);
  const [screen, setScreen] = useState(0);
  const [displayScreen, setDisplayScreen] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  // ── Reduced motion ──────────────────────────────────────────────────────
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ── Screens ─────────────────────────────────────────────────────────────
  const screens = useMemo<ScreenDef[]>(() => {
    const tr = (k: string) => String(t(k));

    const rating = (
      id: string,
      phase: Phase,
      field: keyof Pick<
        CommunityFormData,
        | "overallRating"
        | "soundQuality"
        | "organization"
        | "venueComfort"
        | "valueForMoney"
      >,
      opts: { required?: boolean } = {},
    ): ScreenDef => {
      const question = tr(`attendeeReview.form.${id}.q`);
      return {
        id,
        phase,
        question,
        helper: tr(`attendeeReview.form.${id}.helper`),
        autoAdvance: true,
        validate: opts.required
          ? (d) =>
              d[field] >= 1
                ? undefined
                : tr("attendeeReview.validation.pickRating")
          : undefined,
        render: (d, onChange, advance) => (
          <RatingScale
            value={d[field]}
            onChange={(v) =>
              onChange({ [field]: v } as Partial<CommunityFormData>)
            }
            onCommit={() => advance()}
            lowLabel={tr("attendeeReview.rating.low")}
            highLabel={tr("attendeeReview.rating.high")}
            ariaLabel={question}
            testIdBase={`community-${id}`}
          />
        ),
      };
    };

    const guestScreens: ScreenDef[] = isSignedIn
      ? []
      : [
          {
            id: "name",
            phase: "core",
            question: tr("attendeeReview.community.name.q"),
            helper: tr("attendeeReview.community.name.helper"),
            validate: (d) =>
              d.name.trim().length > 0
                ? undefined
                : tr("attendeeReview.community.validation.name"),
            render: (d, onChange) => (
              <input
                type="text"
                autoComplete="name"
                value={d.name}
                onChange={(e) => onChange({ name: e.target.value })}
                placeholder={tr("attendeeReview.community.name.placeholder")}
                aria-label={tr("attendeeReview.community.name.q")}
                style={INPUT_STYLE}
                data-testid="community-name-input"
              />
            ),
          },
          {
            id: "email",
            phase: "core",
            question: tr("attendeeReview.community.email.q"),
            helper: tr("attendeeReview.community.email.helper"),
            validate: (d) =>
              EMAIL_RE.test(d.email.trim())
                ? undefined
                : tr("attendeeReview.community.validation.email"),
            render: (d, onChange) => (
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={d.email}
                onChange={(e) => onChange({ email: e.target.value })}
                placeholder={tr("attendeeReview.community.email.placeholder")}
                aria-label={tr("attendeeReview.community.email.q")}
                style={INPUT_STYLE}
                data-testid="community-email-input"
              />
            ),
          },
        ];

    return [
      ...guestScreens,
      rating("overall", "core", "overallRating", { required: true }),
      rating("sound", "core", "soundQuality"),
      rating("organization", "core", "organization"),
      rating("venueComfort", "optional", "venueComfort"),
      rating("value", "optional", "valueForMoney"),
      {
        id: "text",
        phase: "optional",
        question: tr("attendeeReview.form.text.q"),
        // FR-011: state plainly the words go privately to the venue owner.
        helper: tr("attendeeReview.community.privacyNote"),
        render: (d, onChange) => (
          <CharCountTextarea
            value={d.text}
            onChange={(v) => onChange({ text: v })}
            placeholder={tr("attendeeReview.form.text.placeholder")}
            maxLength={TEXT_MAX}
            minHeight={140}
            testIdBase="community-text"
          />
        ),
      },
    ];
  }, [t, isSignedIn]);

  const totalScreens = screens.length;

  // Signed-in state can flip after mount (session resolves async); clamp.
  useEffect(() => {
    if (screen >= totalScreens) {
      setScreen(totalScreens - 1);
      setDisplayScreen(totalScreens - 1);
    }
  }, [screen, totalScreens]);

  // ── Slide animation ─────────────────────────────────────────────────────
  const [slideDir, setSlideDir] = useState<SlideDir>("none");
  const [animPhase, setAnimPhase] = useState<"active" | "exiting" | "entering">(
    "active",
  );
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending gentle auto-advance (rating pick). A manual Continue/Back MUST cancel
  // it so both never fire for one intent (the double-advance / screen-skip bug).
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelAutoAdvance = useCallback(() => {
    if (autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
  }, []);

  const submitMut =
    trpc.attendeeReviews.submitCommunityVenueReview.useMutation({
      onSuccess: () => {
        setSuccess(true);
        onSubmitted?.();
      },
      onError: (err) => {
        const { formError } = normalizeError(err, (k) => String(t(k)));
        setError(
          formError ?? String(t("attendeeReview.community.error.submitFailed")),
        );
        // Error recovery: a submit never navigates, so snap any in-flight
        // transition back to "active" and drop pending timers. Otherwise a
        // Back tapped while the request was in flight can leave animPhase stuck
        // off "active", which disables BOTH Back and Submit (dead-end form).
        if (animTimer.current) {
          clearTimeout(animTimer.current);
          animTimer.current = null;
        }
        cancelAutoAdvance();
        setSlideDir("none");
        setAnimPhase("active");
      },
    });

  const onChange = useCallback((patch: Partial<CommunityFormData>) => {
    setData((prev) => ({ ...prev, ...patch }));
    setError(undefined);
  }, []);

  const facet = (v: number) => (v >= 1 && v <= 5 ? v : undefined);

  const handleSubmit = useCallback(() => {
    if (data.overallRating < 1) {
      setScreen(0);
      setDisplayScreen(0);
      setError(String(t("attendeeReview.validation.pickRating")));
      return;
    }
    // The server schema is `.strict()` with every optional facet as
    // `rating.optional()` — which accepts a value or an ABSENT key but REJECTS
    // an explicit `null`/`undefined` on the wire. So OMIT any unset optional
    // field entirely (conditional spread) rather than sending an empty value.
    const sound = facet(data.soundQuality);
    const organization = facet(data.organization);
    const venueComfort = facet(data.venueComfort);
    const valueForMoney = facet(data.valueForMoney);
    const text = data.text.trim().slice(0, TEXT_MAX);
    const name = data.name.trim().slice(0, 120);
    const email = data.email.trim().toLowerCase();

    submitMut.mutate({
      placeId,
      overallRating: data.overallRating,
      ...(sound !== undefined ? { soundQuality: sound } : {}),
      ...(organization !== undefined ? { organization } : {}),
      ...(venueComfort !== undefined ? { venueComfort } : {}),
      ...(valueForMoney !== undefined ? { valueForMoney } : {}),
      ...(text.length > 0 ? { text } : {}),
      // Guests carry name/email; signed-in submitters bind to their humanId
      // server-side, so these keys are absent entirely for them.
      ...(isSignedIn
        ? {}
        : {
            ...(name ? { anonymousName: name } : {}),
            ...(email ? { anonymousEmail: email } : {}),
          }),
    });
  }, [data, placeId, isSignedIn, submitMut, t]);

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
    // A manual advance consumes any pending gentle auto-advance so a rating
    // tap + Continue can't fire twice and skip a screen.
    cancelAutoAdvance();
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
  }, [screen, screens, totalScreens, data, animateTo, handleSubmit, cancelAutoAdvance]);

  const handleBack = useCallback(() => {
    if (screen > 0) {
      // Drop a pending auto-advance too, else it fires after we've gone back
      // and yanks the user forward again.
      cancelAutoAdvance();
      setError(undefined);
      animateTo(screen - 1);
    }
  }, [screen, animateTo, cancelAutoAdvance]);

  // ── Gentle auto-advance on rating pick ──────────────────────────────────
  const handleNextRef = useRef(handleNext);
  handleNextRef.current = handleNext;
  const requestAutoAdvance = useCallback(() => {
    cancelAutoAdvance();
    autoTimer.current = setTimeout(
      () => handleNextRef.current(),
      reducedMotion ? 120 : AUTO_ADVANCE_MS,
    );
  }, [reducedMotion, cancelAutoAdvance]);
  useEffect(() => {
    return () => cancelAutoAdvance();
  }, [screen, cancelAutoAdvance]);

  // ── Enter advances (except inside the textarea) ─────────────────────────
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

  // ── Focus management on screen change (skip first render) ───────────────
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
        'button[role="radio"][tabindex="0"], input, textarea, button',
      );
      focusable?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [screen, animPhase]);

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

  // ── Success ─────────────────────────────────────────────────────────────
  if (success) {
    return (
      <FormSurface chromeless={chromeless}>
        <YStack
          alignItems="center"
          justifyContent="center"
          padding={40}
          gap={16}
          flex={1}
          minHeight={280}
          role="status"
          aria-live="polite"
        >
          <div
            style={{
              width: 56,
              height: 56,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: `3px solid ${ACCENT}`,
              color: ACCENT,
            }}
            aria-hidden="true"
          >
            <Check size={28} />
          </div>
          <Text variant="h3" weight="bold" color="$color" margin={0} textAlign="center">
            {String(t("attendeeReview.community.success.title"))}
          </Text>
          <Text
            variant="body"
            color="$colorMuted"
            margin={0}
            textAlign="center"
            maxWidth={360}
          >
            {String(t("attendeeReview.community.success.body"))}
          </Text>
        </YStack>
      </FormSurface>
    );
  }

  const currentDef = screens[displayScreen]!;
  const isLast = displayScreen === totalScreens - 1;
  const showSkip = currentDef.phase === "optional" && !isLast;
  const isCompactNav = media.sm;
  const questionId = `${formId}-q`;
  const helperId = `${formId}-h`;

  return (
    <FormSurface
      chromeless={chromeless}
      role="form"
      aria-label={String(t("attendeeReview.community.pageTitle"))}
    >
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

      {/* Unverified/community provenance marker (FR-011) */}
      <div style={{ padding: "16px 20px 0" }}>
        <span
          style={{
            display: "inline-block",
            padding: "3px 8px",
            border: `1px solid ${BORDER}`,
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: MUTED,
          }}
        >
          {String(t("attendeeReview.community.kicker"))} ·{" "}
          {String(t("attendeeReview.community.unverified"))}
        </span>
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
      <div style={{ padding: "16px 20px 0", ...questionStyle }}>
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

CommunityVenueReviewForm.displayName = "CommunityVenueReviewForm";
