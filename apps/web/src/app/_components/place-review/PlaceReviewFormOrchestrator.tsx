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
import { Button, Spinner, Text } from "@th/ui";
import { isHumanJob } from "@th/core/lib/human-jobs";
import { styled, XStack, YStack, useMedia } from "tamagui";
import { ACCENT } from "@/lib/design-tokens";
import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";

import type { FormData } from "./_shared/types";
import { EMPTY, getScreenStatus, rangeToMidpointCents } from "./_shared/types";
import {
  BORDER,
  FG,
  MUTED,
  ERROR_RED,
  SPRING_EASE,
  EXIT_EASE,
  ANIM_ENTER,
  ANIM_EXIT,
  getSlideStyle,
  type SlideDir,
} from "./_shared/tokens";
import { PAYMENT_LABELS, PAYOUT_RANGES } from "./_shared/labels";
import { buildScreensForJobs } from "./_screens";
import { buildCompletionIncentiveScreen } from "./_screens/session";
import { SuccessScreen } from "./_primitives/SuccessScreen";

// ─────────────────────────────────────────────────────────────────────────────
// Tamagui surface
// ─────────────────────────────────────────────────────────────────────────────

const FormSurface = styled(YStack, {
  name: "ReviewFormSurface",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  padding: 0,
  // "clip" clips overflow like "hidden" but does NOT create a scroll context,
  // so `position: sticky` on the nav bar works against the page scroll.
  overflow: "clip" as any,
  // Full-viewport on mobile — consistent height for RN parity
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
  // Width is capped at EVERY size, not just $gtMd. As a `flex: 0 0 auto` item
  // with no width, this box sizes to its own max-content — measured at 1807px
  // on a 320px viewport, which pushed the nav's CONTINUE button ~570px off
  // screen. Nothing inside needs that room (constrained to 288px, no
  // descendant overflows), so the cap alone fixes it.
  width: "100%",
  maxWidth: 640,
  minWidth: 0,
  $gtMd: {
    // Stable height on desktop — prevents card from resizing per question
    minHeight: 520,
    maxHeight: "min(680px, 75vh)",
  },
  // Embedded inside the rate_venue modal/sheet: the panel owns the frame and
  // the height, so the surface fills it without a second border and without the
  // full-viewport minHeight that would overflow a bottom sheet on mobile.
  variants: {
    chromeless: {
      true: {
        borderWidth: 0,
        minHeight: 0,
        height: "100%",
        // The panel already sizes itself, so fill it rather than re-cap at 640.
        maxWidth: "none",
        $gtMd: { minHeight: 0, maxHeight: "none", maxWidth: "none" },
      },
    },
  } as const,
});

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface PlaceReviewFormOrchestratorProps {
  initialName?: string;
  initialEmail?: string;
  initialPlaceId?: string;
  initialPlaceName?: string;
  variant?: "page" | "embedded";
  chromeless?: boolean;
  campaign?: string;
  onSubmitted?: () => void;
}

export function PlaceReviewFormOrchestrator({
  initialName,
  initialEmail,
  initialPlaceId,
  initialPlaceName,
  variant = "embedded",
  chromeless = false,
  campaign,
  onSubmitted,
}: PlaceReviewFormOrchestratorProps = {}) {
  const formId = useId();
  const media = useMedia();
  // The venue is known from context (place page block, ?placeId= deep link) —
  // the flow drops "Where did you play?" and this place stays authoritative.
  const knownPlace = Boolean(initialPlaceId);
  const initialData = useMemo<FormData>(
    () => ({
      ...EMPTY,
      ...(initialName ? { anonymousName: initialName } : {}),
      ...(initialEmail ? { anonymousEmail: initialEmail } : {}),
      ...(initialPlaceId ? { placeId: initialPlaceId } : {}),
      ...(initialPlaceName ? { placeName: initialPlaceName } : {}),
    }),
    [initialName, initialEmail, initialPlaceId, initialPlaceName],
  );
  const [formVersion, setFormVersion] = useState(0);
  const FORM_STORAGE_KEY = "th_review_form_state";
  const savedFormStateApplied = useRef(false);

  // Check URL params for recovery link (e.g. ?session=xxx&step=page_1_screen_5_sound)
  // after mount so the server and first client render stay identical.
  const [urlStep, setUrlStep] = useState<string | null>(null);
  const [urlSession, setUrlSession] = useState<string | null>(null);

  const [screen, setScreen] = useState(0);
  const [data, setData] = useState<FormData>(initialData);

  // Recovery URL handling is deferred until displayScreen + sessionTokenRef are declared (below).

  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);
  const [reviewId, setReviewId] = useState<string | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setUrlStep(params.get("step"));
    setUrlSession(params.get("session"));
  }, []);

  // Persist form state to localStorage on changes (debounced)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!savedFormStateApplied.current) return;
    if (success) return; // don't save after submission
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(
          FORM_STORAGE_KEY,
          JSON.stringify({ ...data, _screen: screen }),
        );
      } catch {
        /* quota exceeded — ignore */
      }
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [data, screen, success]);

  // Live stats for SuccessScreen
  const statsQuery = trpc.placeReviews.globalStats.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Analytics
  const formStartedAt = useRef<number>(Date.now());
  const screenEnteredAt = useRef<number>(Date.now());
  const screenTimings = useRef<Record<string, number>>({});

  useEffect(() => {
    screenEnteredAt.current = Date.now();
  }, [screen]);

  // Sync CTA prefills
  useEffect(() => {
    if (initialName)
      setData((prev) => ({ ...prev, anonymousName: initialName }));
  }, [initialName]);
  useEffect(() => {
    if (initialEmail)
      setData((prev) => ({ ...prev, anonymousEmail: initialEmail }));
  }, [initialEmail]);
  // A context-supplied place is authoritative: if it changes under a mounted
  // form, re-point the review (and drop the previous venue's locality).
  useEffect(() => {
    if (!initialPlaceId) return;
    setData((prev) =>
      prev.placeId === initialPlaceId
        ? prev
        : {
            ...prev,
            placeId: initialPlaceId,
            placeName: initialPlaceName ?? "",
            placeCity: "",
            placeState: "",
            placeCountry: "",
          },
    );
  }, [initialPlaceId, initialPlaceName]);
  // ── Dynamic screens based on humanJobs ────────────────────────────────

  // Query trusted venues for the completion incentive screen
  const trustedVenuesQuery =
    trpc.placeReviews.getTrustedVenuesNearPlace.useQuery(
      { placeId: data.placeId, limit: 4 },
      { enabled: !!data.placeId, staleTime: 300_000 },
    );

  const screens = useMemo(() => {
    const base = buildScreensForJobs(data.humanJobs, { knownPlace });
    const venues = trustedVenuesQuery.data;

    // Insert completion incentive before bridge when >= 2 local venues
    if (venues && venues.venues.length >= 2) {
      const bridgeIdx = base.findIndex((s) => s.id === "bridge");
      if (bridgeIdx >= 0) {
        const incentive = buildCompletionIncentiveScreen(
          venues.venues,
          venues.city,
          venues.venues.length,
          false,
        );
        base.splice(bridgeIdx, 0, incentive);
      }
    }

    return base;
  }, [data.humanJobs, trustedVenuesQuery.data, knownPlace]);

  const totalScreens = screens.length;
  const reviewIdx = screens.findIndex((s) => s.phase === "review");

  // ── Profile pre-population ────────────────────────────────────────────

  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const isAuthed = Boolean(session?.user) && !isSessionPending;
  const myProfile = trpc.humans.getMyProfile.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
    enabled: isAuthed,
  });
  const profileApplied = useRef(false);
  useEffect(() => {
    if (profileApplied.current || !myProfile.data) return;
    const { jobs, genreTags, otherJobDescription } = myProfile.data;
    const humanJobs = jobs.filter(isHumanJob);
    if (humanJobs.length > 0) {
      profileApplied.current = true;
      setData((prev) => ({
        ...prev,
        humanJobs,
        genreTags: genreTags.length > 0 ? genreTags : prev.genreTags,
        humanOtherJobDescription:
          otherJobDescription || prev.humanOtherJobDescription,
      }));
    }
  }, [myProfile.data]);

  // ── Session tracking ─────────────────────────────────────────────────

  const sessionTokenRef = useRef<string>("");
  // These three are drop-on-the-floor progress telemetry: a failure must never
  // interrupt someone mid-review. `onError` alone does NOT stop the toast —
  // GlobalMutationErrorNotifier subscribes to the mutation cache and fires
  // "Action failed" for anything without `meta.silent`.
  const noop = () => {};
  const silent = { silent: true } as const;
  const createSessionMut = trpc.placeReviews.createSession.useMutation({
    onError: noop,
    meta: silent,
  });
  const updateStepMut = trpc.placeReviews.updateSessionStep.useMutation({
    onError: noop,
    meta: silent,
  });
  const completeSessionMut = trpc.placeReviews.completeSession.useMutation({
    onError: noop,
    meta: silent,
  });

  // Get or create a session token in localStorage
  const createdSessionKey = useRef<string>("");
  useEffect(() => {
    const STORAGE_KEY = "th_review_session_token";
    let token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, token);
    }
    sessionTokenRef.current = token;

    // Create session once we have a placeId — at most once per (token, place).
    // The effect runs twice on mount under StrictMode, and both calls land in
    // one tRPC batch, so without this the pair races the same upsert.
    if (data.placeId) {
      const key = `${token}:${data.placeId}`;
      if (createdSessionKey.current !== key) {
        createdSessionKey.current = key;
        createSessionMut.mutate({
          sessionToken: token,
          placeId: data.placeId,
          humanId: session?.user?.id,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.placeId]);

  // ── Eager job save (debounced 800ms) ──────────────────────────────────

  const updateJobsMut = trpc.humans.updateJobs.useMutation();
  const jobsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedJobs = useRef<string>("");

  useEffect(() => {
    // Only save when user has authed profile loaded (mutation requires auth)
    if (!myProfile.data) return;
    const key = JSON.stringify({
      jobs: data.humanJobs,
      genreTags: data.genreTags,
      other: data.humanOtherJobDescription,
    });
    if (key === lastSavedJobs.current) return;

    if (jobsSaveTimer.current) clearTimeout(jobsSaveTimer.current);
    jobsSaveTimer.current = setTimeout(() => {
      if (data.humanJobs.length === 0) return;
      lastSavedJobs.current = key;
      updateJobsMut.mutate({
        jobs: data.humanJobs,
        genreTags: data.genreTags,
        otherJobDescription: data.humanOtherJobDescription || undefined,
      });
    }, 800);
    return () => {
      if (jobsSaveTimer.current) clearTimeout(jobsSaveTimer.current);
    };
  }, [
    data.humanJobs,
    data.genreTags,
    data.humanOtherJobDescription,
    myProfile.data,
    updateJobsMut,
  ]);

  // ── Clamp screen when screens shrink ──────────────────────────────────

  useEffect(() => {
    if (screen >= totalScreens) {
      const clamped = totalScreens - 1;
      setScreen(clamped);
      setDisplayScreen(clamped);
    }
  }, [screen, totalScreens]);
  // ── Slide animation ──────────────────────────────────────────────────────

  const [slideDir, setSlideDir] = useState<SlideDir>("none");
  const [animPhase, setAnimPhase] = useState<"active" | "exiting" | "entering">(
    "active",
  );
  const [displayScreen, setDisplayScreen] = useState(0);
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore saved form state after mount so SSR and the first client render match.
  useEffect(() => {
    if (savedFormStateApplied.current) return;
    savedFormStateApplied.current = true;
    try {
      const saved = localStorage.getItem(FORM_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as Partial<FormData> & {
        _screen?: unknown;
      };
      const { _screen: savedScreen, ...formFields } = parsed;
      const restored: FormData = { ...initialData, ...formFields };
      if (initialData.placeId) {
        // The venue came from context, so it wins over the draft. A draft left
        // over from rating a DIFFERENT venue must not silently re-point this
        // review (or leak that venue's city/state) — drop its place fields.
        if (formFields.placeId !== initialData.placeId) {
          restored.placeCity = initialData.placeCity;
          restored.placeState = initialData.placeState;
          restored.placeCountry = initialData.placeCountry;
        }
        restored.placeId = initialData.placeId;
        restored.placeName = initialData.placeName || restored.placeName;
      }
      setData(restored);
      if (
        typeof savedScreen === "number" &&
        Number.isFinite(savedScreen) &&
        savedScreen >= 0
      ) {
        const restoredScreen = Math.floor(savedScreen);
        setScreen(restoredScreen);
        setDisplayScreen(restoredScreen);
      }
    } catch {
      /* ignore */
    }
  }, [FORM_STORAGE_KEY, initialData]);

  // Recovery URL: jump to the right screen when arriving from a recovery email
  const recoveryApplied = useRef(false);
  useEffect(() => {
    if (recoveryApplied.current || !urlStep) return;
    recoveryApplied.current = true;
    const stepId = urlStep.split("_").pop();
    if (!stepId) return;
    const idx = screens.findIndex((s) => s.id === stepId);
    if (idx > 0) {
      setScreen(idx);
      setDisplayScreen(idx);
    }
    if (urlSession) {
      sessionTokenRef.current = urlSession;
      localStorage.setItem("th_review_session_token", urlSession);
    }
  }, [urlStep, urlSession, screens]);

  // Track step transitions (fire-and-forget, after displayScreen is declared)
  useEffect(() => {
    if (!sessionTokenRef.current || animPhase !== "active") return;
    const def = screens[displayScreen];
    if (!def) return;
    const screenIdx = displayScreen + 1;
    const pageReached =
      def.phase === "core" || def.phase === "bridge"
        ? 1
        : def.phase === "optional"
          ? 2
          : 3;
    updateStepMut.mutate({
      sessionToken: sessionTokenRef.current,
      lastStepKey: `page_${pageReached}_screen_${screenIdx}_${def.id}`,
      pageReached,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayScreen, animPhase]);

  // Track whether the user has ever reached the review screen.
  const [hasReachedReview, setHasReachedReview] = useState(false);
  useEffect(() => {
    if (screens[screen]?.phase === "review") setHasReachedReview(true);
  }, [screen, screens]);

  // Focus management: auto-focus first interactive element when screen changes,
  // but only after the user has navigated (skip the very first render so we
  // don't steal focus and jump the page on initial load).
  const hasNavigatedRef = useRef(false);
  useEffect(() => {
    if (animPhase !== "active") return;
    if (!hasNavigatedRef.current) {
      // Mark that we've seen the first "active" phase — subsequent screen
      // changes are real navigations that should receive focus.
      hasNavigatedRef.current = true;
      return;
    }
    const container = contentRef.current;
    if (!container) return;
    const timer = setTimeout(() => {
      const focusable = container.querySelector<HTMLElement>(
        'input:not([type="hidden"]), select, textarea, button[type="button"]',
      );
      focusable?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [screen, animPhase]);

  // ── Mutation ─────────────────────────────────────────────────────────────

  const submitMut = trpc.placeReviews.submit.useMutation({
    onSuccess: (result) => {
      const totalMs = Date.now() - formStartedAt.current;
      console.info(
        `[analytics:review-form] completed in ${Math.round(totalMs / 1000)}s`,
        screenTimings.current,
      );
      setReviewId(result.reviewId);
      statsQuery.refetch();
      setSuccess(true);
      // Clear saved form state
      try {
        localStorage.removeItem(FORM_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      // Mark session as completed
      if (sessionTokenRef.current) {
        completeSessionMut.mutate({
          sessionToken: sessionTokenRef.current,
          placeReviewId: result.reviewId,
        });
      }
      // Notify parent component
      onSubmitted?.();
    },
    onError: (err) => setError(err.message ?? "Submission failed"),
  });

  const patchEmailMut = trpc.placeReviews.patchEmail.useMutation();

  const handleEmailSubmit = useCallback(
    async (email: string) => {
      // The server binds the email to the session that wrote the review, so
      // the token minted for createSession has to ride along.
      if (!reviewId || !sessionTokenRef.current) return;
      await patchEmailMut.mutateAsync({
        reviewId,
        email,
        sessionToken: sessionTokenRef.current,
      });
    },
    [reviewId, patchEmailMut],
  );

  // ── Callbacks ────────────────────────────────────────────────────────────

  const onChange = useCallback((patch: Partial<FormData>) => {
    setData((prev) => ({ ...prev, ...patch }));
    setError(undefined);
  }, []);

  const recordScreenTiming = useCallback(
    (idx: number) => {
      const def = screens[idx];
      if (!def) return;
      const elapsed = Date.now() - screenEnteredAt.current;
      screenTimings.current[def.id] =
        (screenTimings.current[def.id] ?? 0) + elapsed;
    },
    [screens],
  );

  const animateTo = useCallback(
    (next: number) => {
      if (animTimer.current) clearTimeout(animTimer.current);
      const dir: SlideDir = next > screen ? "forward" : "backward";
      recordScreenTiming(screen);

      setSlideDir(dir);
      setAnimPhase("exiting");

      animTimer.current = setTimeout(() => {
        setDisplayScreen(next);
        setAnimPhase("entering");

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setScreen(next);
            setAnimPhase("active");
            animTimer.current = setTimeout(() => {
              setSlideDir("none");
            }, ANIM_ENTER);
          });
        });
      }, ANIM_EXIT);
    },
    [screen, recordScreenTiming],
  );

  const handleSubmit = useCallback(() => {
    // The button is disabled while pending, but the keyboard handlers reach
    // here through handleNext — never fire a second submit in flight.
    if (submitMut.isPending) return;
    recordScreenTiming(screen);

    let payoutCents: number | undefined;
    if (data.payoutRange === "SPECIFIC") {
      const raw = data.payoutCents ? parseInt(data.payoutCents, 10) : undefined;
      payoutCents =
        raw !== undefined && !Number.isNaN(raw) ? raw * 100 : undefined;
    } else if (data.payoutRange) {
      payoutCents = rangeToMidpointCents(data.payoutRange);
    }

    // Build source attribution based on variant and campaign
    let sourceAttribution:
      | { campaign?: string; channel?: "email" | "homepage" | "direct" }
      | undefined;

    if (variant === "embedded") {
      // Homepage embedded form
      sourceAttribution = {
        channel: "homepage",
        ...(campaign ? { campaign } : {}),
      };
    } else if (variant === "page") {
      // Standalone /review-a-place page
      if (campaign) {
        sourceAttribution = { campaign, channel: "email" };
      } else {
        sourceAttribution = { channel: "direct" };
      }
    }

    submitMut.mutate({
      // Binds the review to this browser's session row server-side — the
      // only binding the later email capture (patchEmail) accepts.
      ...(sessionTokenRef.current
        ? { sessionToken: sessionTokenRef.current }
        : {}),
      placeId: data.placeId || undefined,
      placeName: data.placeName || undefined,
      placeCity: data.placeCity || undefined,
      payoutCents: payoutCents ?? null,
      paymentMethod: (data.paymentMethods.find((m) => m !== "OTHER") ??
        data.paymentMethods[0] ??
        "OTHER") as "GUARANTEE",
      paymentDetail:
        [
          data.paymentMethodDetail,
          data.paymentMethods.length > 1
            ? `[Methods: ${data.paymentMethods.map((m) => PAYMENT_LABELS[m] ?? m).join(", ")}]`
            : undefined,
          data.paymentMethodOther
            ? `[Other: ${data.paymentMethodOther}]`
            : undefined,
          data.payoutRange && data.payoutRange !== "SPECIFIC"
            ? `[Payout range: ${PAYOUT_RANGES[data.payoutRange]}]`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 500) || undefined,
      venuePromoted: data.venuePromoted as "ACTIVELY_PROMOTED",
      promotionDetail: data.venuePromotedDetail.slice(0, 500) || undefined,
      soundQuality: data.soundQuality as "GREAT",
      soundDetail:
        [
          data.soundQualityDetail,
          data.soundDetail,
          data.fohRating ? `[FOH: ${data.fohRating}]` : undefined,
          data.fohDetail ? `[FOH detail: ${data.fohDetail}]` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 500) || undefined,
      stageEquipment: (data.stageEquipment || "NONE") as "FULL",
      stageEquipmentDetail:
        data.stageEquipmentDetail.slice(0, 500) || undefined,
      audienceFit: data.audienceFit as "PERFECT_FIT",
      audienceDetail:
        [
          data.audienceFitDetail,
          data.totalAttendance
            ? `[Total attendance: ${data.totalAttendance}]`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 500) || undefined,
      wouldPlayAgain: data.wouldPlayAgain as "YES",
      parkingLoadIn: (data.parkingLoadIn || "STREET_NEARBY") as "DEDICATED_LOT",
      parkingDetail:
        [
          data.parkingLoadInDetail,
          data.loadInEarliest
            ? `[Load-in earliest: ${data.loadInEarliest}]`
            : undefined,
          data.loadOutLatest
            ? `[Load-out latest: ${data.loadOutLatest}]`
            : undefined,
          data.securityFrontDoor
            ? `[Security front door: ${data.securityFrontDoor}]`
            : undefined,
          data.securityLoadIn
            ? `[Security load-in: ${data.securityLoadIn}]`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 500) || undefined,
      bookerRating: (data.bookerRating || "OKAY") as "EXCELLENT",
      bookerDetail: data.bookerRatingDetail.slice(0, 500) || undefined,
      genre: data.genreTags.length > 0 ? data.genreTags[0] : undefined,
      genreTags: data.genreTags.length > 0 ? data.genreTags : undefined,
      estimatedDraw: data.estimatedDraw
        ? parseInt(data.estimatedDraw, 10)
        : undefined,
      gigDate: data.gigDate ? new Date(data.gigDate + "T12:00:00") : undefined,
      gigTimeOfDay: data.gigTimeOfDay
        ? (data.gigTimeOfDay as "MORNING")
        : undefined,
      gigTimeExact: data.gigTimeExact || undefined,
      dayOfWeek: data.dayOfWeek ?? undefined,
      merchAllowed: data.merchAllowed
        ? (data.merchAllowed as "ALLOWED_FREELY")
        : undefined,
      merchCutPct: data.merchCutPct
        ? parseInt(data.merchCutPct, 10)
        : undefined,
      staffSupport: data.staffSupport
        ? (data.staffSupport as "YES")
        : undefined,
      independentVenue: data.independentVenue
        ? (data.independentVenue as "YES")
        : undefined,
      comment:
        [
          data.comment,
          data.wouldPlayAgainDetail
            ? `[Would play again: ${data.wouldPlayAgainDetail}]`
            : undefined,
          data.staffSupportDetail
            ? `[Staff: ${data.staffSupportDetail}]`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 1000) || undefined,
      anonymousEmail: data.anonymousEmail || undefined,
      anonymousName: data.anonymousName?.slice(0, 120) || undefined,
      source: "SURVEY",
      sourceAttribution,
    });
  }, [data, screen, recordScreenTiming, submitMut, variant, campaign]);

  const handleNext = useCallback(() => {
    const def = screens[screen];
    if (!def) return;

    // Review screen → validate all required, then submit
    if (def.phase === "review") {
      for (const s of screens) {
        if (s.phase === "bridge" || s.phase === "review") continue;
        if (s.validate) {
          const err = s.validate(data);
          if (err) {
            setError(err);
            return;
          }
        }
      }
      setError(undefined);
      handleSubmit();
      return;
    }

    // Validate current screen
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

  const handleSkipToEnd = useCallback(() => {
    setError(undefined);
    animateTo(reviewIdx);
  }, [animateTo, reviewIdx]);

  const handleReset = useCallback(() => {
    setData({ ...initialData });
    try {
      localStorage.removeItem(FORM_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setFormVersion((prev) => prev + 1);
    setScreen(0);
    setDisplayScreen(0);
    setError(undefined);
    setSuccess(false);
    setReviewId(undefined);
    setSlideDir("none");
    setAnimPhase("active");
    setHasReachedReview(false);
    profileApplied.current = false;
    lastSavedJobs.current = "";
    formStartedAt.current = Date.now();
    screenEnteredAt.current = Date.now();
    screenTimings.current = {};
  }, [initialData]);

  // ── Auto-advance ─────────────────────────────────────────────────────────

  const autoAdvanceFired = useRef(false);
  const autoAdvanceCancelled = useRef(false);
  const screenWasCompleteOnEntry = useRef(false);
  const [autoAdvanceActive, setAutoAdvanceActive] = useState(false);
  const [autoAdvanceDelay, setAutoAdvanceDelay] = useState(0);

  useEffect(() => {
    autoAdvanceFired.current = false;
    autoAdvanceCancelled.current = false;
    setAutoAdvanceActive(false);
    const def = screens[screen];
    screenWasCompleteOnEntry.current = def
      ? getScreenStatus(def.id, data) === "complete"
      : false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on screen change
  }, [screen]);

  // Cancel auto-advance when a textarea or input gets focus
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const handler = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") {
        autoAdvanceCancelled.current = true;
        setAutoAdvanceActive(false);
      }
    };
    container.addEventListener("focusin", handler);
    return () => container.removeEventListener("focusin", handler);
  }, [screen]);

  useEffect(() => {
    if (animPhase !== "active") return;
    if (autoAdvanceFired.current) return;
    if (autoAdvanceCancelled.current) return;
    if (screenWasCompleteOnEntry.current && screens[screen]?.phase !== "bridge")
      return;

    const def = screens[screen];
    if (!def?.autoAdvance) return;

    const shouldAdvance =
      typeof def.autoAdvance === "function"
        ? def.autoAdvance(data)
        : def.autoAdvance === true
          ? def.phase === "bridge" ||
            getScreenStatus(def.id, data) === "complete"
          : false;

    if (!shouldAdvance) return;

    const delay = def.autoAdvanceDelay ?? (def.phase === "bridge" ? 2800 : 800);
    setAutoAdvanceDelay(delay);
    setAutoAdvanceActive(true);
    const timer = setTimeout(() => {
      if (autoAdvanceFired.current || autoAdvanceCancelled.current) return;
      autoAdvanceFired.current = true;
      setAutoAdvanceActive(false);
      handleNext();
    }, delay);
    return () => {
      clearTimeout(timer);
      setAutoAdvanceActive(false);
    };
  }, [screen, data, animPhase, handleNext]);

  // Enter key advances (except textareas)
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

  // ── Computed styles ──────────────────────────────────────────────────────

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
    if (animPhase === "exiting") {
      return {
        opacity: 0,
        transform: "translateY(-8px)",
        transition: `opacity ${ANIM_EXIT}ms ${EXIT_EASE}, transform ${ANIM_EXIT}ms ${EXIT_EASE}`,
      };
    }
    if (animPhase === "entering") {
      return {
        opacity: 0,
        transform: "translateY(12px)",
        transition: `opacity ${ANIM_ENTER}ms ${SPRING_EASE}, transform ${ANIM_ENTER}ms ${SPRING_EASE}`,
      };
    }
    return {
      opacity: 1,
      transform: "translateY(0)",
      transition: `opacity ${ANIM_ENTER}ms ${SPRING_EASE}, transform ${ANIM_ENTER}ms ${SPRING_EASE}`,
    };
  }, [animPhase]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (success) {
    return (
      <FormSurface key={`success-${formVersion}`} chromeless={chromeless}>
        <SuccessScreen
          onReset={handleReset}
          venuesRated={statsQuery.data?.venuesRated ?? 0}
          contributors={statsQuery.data?.contributors ?? 0}
          email={data.anonymousEmail}
          onEmailSubmit={handleEmailSubmit}
          variant={variant}
        />
      </FormSurface>
    );
  }

  const currentDef = screens[displayScreen]!;
  const isReviewScreen = currentDef.phase === "review";
  const isLastScreen = isReviewScreen;
  const isBridge = currentDef.phase === "bridge";
  const isOptional = currentDef.phase === "optional";
  const showSkip =
    !isReviewScreen &&
    displayScreen > 0 &&
    (isBridge || isOptional || hasReachedReview);
  const isCompactNav = media.sm && showSkip;
  const skipLabel = isCompactNav ? "SKIP" : "SKIP TO END";

  const questionId = `${formId}-q`;
  const helperId = `${formId}-h`;

  return (
    <FormSurface
      key={`form-${formVersion}`}
      chromeless={chromeless}
      role="form"
      aria-label="Place review form"
    >
      {/* Progress bar — thin orange line at top */}
      <div
        style={{
          height: 3,
          width: "100%",
          background: BORDER,
          overflow: "hidden",
        }}
        role="progressbar"
        aria-valuenow={displayScreen + 1}
        aria-valuemin={1}
        aria-valuemax={totalScreens}
        aria-label={`Question ${displayScreen + 1} of ${totalScreens}`}
      >
        <div
          style={{
            height: "100%",
            width: `${((displayScreen + 1) / totalScreens) * 100}%`,
            background: ACCENT,
            transition: "width 300ms ease-out",
          }}
        />
      </div>

      {/* Screen reader live region — announces question changes */}
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
        {`Question ${displayScreen + 1} of ${totalScreens}: ${currentDef.question}`}
      </div>

      {/* Question — big, conversational, full attention */}
      <div style={{ padding: "24px 20px 0", ...questionStyle }}>
        <div
          id={questionId}
          role="heading"
          aria-level={2}
          style={{
            fontFamily: "var(--th-font-body, 'Inter', sans-serif)",
            fontWeight: 700,
            fontSize: 22,
            lineHeight: 1.3,
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

      {/* Content area — scrolls internally so nav stays visible */}
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
          {currentDef.render(data, onChange, error, animateTo)}
        </div>
      </div>

      {/* Nudge text */}
      {currentDef.nudgeText &&
        getScreenStatus(currentDef.id, data) === "complete" && (
          <div
            style={{
              padding: "8px 20px",
              fontSize: 13,
              color: MUTED,
              fontStyle: "italic",
              opacity: 0.8,
            }}
          >
            {currentDef.nudgeText}
          </div>
        )}

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

      {/* Auto-advance countdown line */}
      {autoAdvanceActive && autoAdvanceDelay > 0 && (
        <div
          style={{
            height: 2,
            width: "100%",
            overflow: "hidden",
          }}
          aria-hidden="true"
        >
          <div
            style={{
              height: "100%",
              width: "100%",
              background: ACCENT,
              transformOrigin: "left",
              animation: `autoAdvanceFill ${autoAdvanceDelay}ms linear forwards`,
            }}
          />
        </div>
      )}

      {/* Navigation — sticky on mobile for thumb reach */}
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
          background:
            "color-mix(in srgb, var(--surface, #FDFAF3) 80%, transparent)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          zIndex: 2,
        }}
      >
        {/* Left: Back */}
        {screen > 0 ? (
          <Button
            variant="ghost"
            size="$3"
            onPress={handleBack}
            disabled={animPhase !== "active"}
            aria-label="Go back to previous question"
          >
            <XStack alignItems="center" gap={6}>
              <ArrowLeft size={16} />
              <Text variant="bodySmall" weight="bold" color="$color" margin={0}>
                BACK
              </Text>
            </XStack>
          </Button>
        ) : (
          <div />
        )}

        {/* Right: Skip + Next/Submit */}
        <XStack alignItems="center" gap={10}>
          {showSkip && (
            <Button
              variant="ghost"
              size={isCompactNav ? "$2" : "$3"}
              onPress={handleSkipToEnd}
              disabled={animPhase !== "active"}
              aria-label="Skip optional questions"
              flexShrink={1}
              minWidth={0}
            >
              <XStack
                alignItems="center"
                gap={isCompactNav ? 4 : 6}
                minWidth={0}
              >
                <SkipForward size={14} />
                <Text
                  variant="bodySmall"
                  weight="bold"
                  color="$colorMuted"
                  margin={0}
                >
                  {skipLabel}
                </Text>
              </XStack>
            </Button>
          )}

          <Button
            variant="primary"
            size={isCompactNav ? "$3" : "$4"}
            onPress={handleNext}
            disabled={submitMut.isPending || animPhase !== "active"}
            aria-label={
              isLastScreen ? "Submit review" : "Continue to next question"
            }
            flexShrink={0}
          >
            <XStack alignItems="center" gap={8}>
              {submitMut.isPending ? (
                <Spinner size="sm" indicatorColor="$colorInverted" />
              ) : isLastScreen ? (
                <Check size={16} />
              ) : null}
              <Text
                variant="bodySmall"
                weight="bold"
                color="$colorInverted"
                margin={0}
              >
                {isLastScreen
                  ? "SUBMIT REVIEW"
                  : isBridge
                    ? "KEEP GOING"
                    : "CONTINUE"}
              </Text>
              {!isLastScreen && !isBridge && <ArrowRight size={16} />}
            </XStack>
          </Button>
        </XStack>
      </div>

      {/* Keyframes */}
      <style>{`
        @keyframes scaleIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @keyframes autoAdvanceFill {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }
      `}</style>
    </FormSurface>
  );
}

PlaceReviewFormOrchestrator.displayName = "PlaceReviewFormOrchestrator";
