"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { XStack, YStack, styled, type GetProps } from "tamagui";

import { useTranslations } from "../../../../locale";
import { motionTokens } from "../../tokens/motion";
import { CardSurface } from "../display/Card";
import { Button } from "../forms/Button";
import { Checkbox } from "../forms/Checkbox";
import { LabeledTextInput } from "../forms/labeledtextinput";
import { Radio, RadioGroupField } from "../forms/Radio";
import { TextInput } from "../forms/TextInput";
import { Text } from "../typography/Text";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApplicationQuestionType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "MULTI_CHOICE"
  | "SINGLE_CHOICE";

export interface ApplicationQuestion {
  id: string;
  type: ApplicationQuestionType;
  label: string;
  description?: string | null;
  options?: Array<{ value: string; label?: string }> | null;
  isRequired: boolean;
  order: number;
}

export interface ApplicationFormData {
  introText?: string | null;
  questions: ApplicationQuestion[];
}

export type ApplicationStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "EXPIRED"
  | "WAITLISTED";

export interface ViewerSubmission {
  id: string;
  status: ApplicationStatus;
  createdAt: Date;
  reviewedAt?: Date | null;
  /**
   * The organizer's note to this applicant. The server populates it ONLY on a
   * REJECTED submission; null/absent otherwise.
   */
  decisionReason?: string | null;
}

/**
 * Application-window state (spec Phase 2), computed by the parent from the
 * form's `opensAt`/`closesAt` — the server enforces the same boundaries
 * (exactly-at is OPEN) in `submit-event-application`.
 */
export type ApplicationWindowState = "open" | "notYetOpen" | "closed";

// ─────────────────────────────────────────────────────────────────────────────
// Motion (design canvas "04 Motion spec")
//
// Durations come from the DS motion tokens (120 / 180 / 240) and the easing
// from the canvas token `cubic-bezier(.2,.8,.3,1)`. Everything below is OFF
// under `prefers-reduced-motion`: the step swaps instantly and the timeline
// lands filled. Nothing animates per keystroke.
// ─────────────────────────────────────────────────────────────────────────────

const EASE = "cubic-bezier(0.2, 0.8, 0.3, 1)";
const OUT_MS = motionTokens.duration.fast; // outgoing question
const IN_MS = motionTokens.duration.base; // incoming question
const FILL_MS = motionTokens.duration.slow; // status timeline
const SLIDE_PX = 24;

/**
 * Resolved AFTER mount so the server render and the first client render
 * agree (both assume motion is fine); a reduced-motion client flips on the
 * next tick, before any navigation can happen. Same approach as `Reveal`.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    if (!mq) return undefined;
    const sync = () => setReduced(Boolean(mq.matches));
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

type SlideDir = "forward" | "backward";
type SlidePhase = "active" | "exiting" | "entering";

/**
 * The outgoing question slides 24px the way you're leaving and fades
 * (120ms); the incoming one starts 24px on the other side and settles
 * (180ms). `transform: none` at rest, not `translateX(0)`, so the resting
 * step creates no containing block or stacking context for its children.
 */
function slideStyle(phase: SlidePhase, dir: SlideDir | null): CSSProperties {
  const sign = dir === "backward" ? -1 : 1;
  if (phase === "exiting") {
    return {
      opacity: 0,
      transform: `translateX(${-sign * SLIDE_PX}px)`,
      transition: `opacity ${OUT_MS}ms ${EASE}, transform ${OUT_MS}ms ${EASE}`,
    };
  }
  if (phase === "entering") {
    return {
      opacity: 0,
      transform: `translateX(${sign * SLIDE_PX}px)`,
      transition: "none",
    };
  }
  return {
    opacity: 1,
    transform: "none",
    ...(dir
      ? {
          transition: `opacity ${IN_MS}ms ${EASE}, transform ${IN_MS}ms ${EASE}`,
        }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw-CSS colour references (inline styles cannot take `$tokens`). The
// fallback is the Stub value: it is what SSR / first paint renders.
// ─────────────────────────────────────────────────────────────────────────────

const CSS = {
  ink: "var(--color, #211C16)",
  muted: "var(--colorMuted, #5C544A)",
  border: "var(--borderColor, #211C16)",
  soft: "var(--borderColorSoft, rgba(33, 28, 22, 0.3))",
  accent: "var(--accent, #E2481D)",
  support: "var(--support, #F59E0B)",
  surface: "var(--surface, #FDFAF3)",
} as const;

const CONTROL_SELECTOR =
  'input:not([type="hidden"]), textarea, [role="radio"], [role="checkbox"]';

// ─────────────────────────────────────────────────────────────────────────────
// Styled Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kept for custom composition (`EventApplicationGate.Card`). The gate itself
 * no longer draws a card: it is the page's content column.
 */
const GateCard = styled(CardSurface, {
  name: "EventApplicationGateCard",
  maxWidth: 480,
  width: "100%",
  padding: "$5",
  gap: "$4",
  zIndex: 1,
});

const GateSection = styled(YStack, {
  name: "EventApplicationGateSection",
  width: "100%",
  minWidth: 0,
  gap: "$4",
});

const ListRow = styled(XStack, {
  name: "EventApplicationGateListRow",
  tag: "button",
  width: "100%",
  minHeight: 44,
  alignItems: "center",
  gap: "$3",
  paddingHorizontal: 14,
  paddingVertical: "$2",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceRaised" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
});

const LinkToggle = styled(XStack, {
  name: "EventApplicationGateListToggle",
  tag: "button",
  minHeight: 44,
  alignItems: "center",
  paddingHorizontal: 0,
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  cursor: "pointer",
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

/** Without an explicit type a <button> inside a <form> is a SUBMIT button. */
const BUTTON_TYPE = { type: "button" } as Record<string, string>;

const HEADLINE_PROPS = {
  fontSize: 40,
  lineHeight: 42,
  letterSpacing: -0.8,
  textTransform: "none",
  fontWeight: "800",
  $sm: { fontSize: 34, lineHeight: 36, letterSpacing: -0.7 },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Status timeline: Applied → In review → Decision
// ─────────────────────────────────────────────────────────────────────────────

type SegmentState = "done" | "current" | "todo";
type SegmentTone = "accent" | "ink" | "support" | "muted";

interface TimelineSpec {
  segments: Array<{ state: SegmentState; tone: SegmentTone; labelKey: string }>;
  /** Index carrying `aria-current="step"`. */
  current: number;
}

const APPLIED = "eventDetail.appTimelineApplied";
const IN_REVIEW = "eventDetail.appTimelineInReview";

const TIMELINES: Record<ApplicationStatus, TimelineSpec> = {
  PENDING: {
    segments: [
      { state: "done", tone: "accent", labelKey: APPLIED },
      { state: "current", tone: "accent", labelKey: IN_REVIEW },
      {
        state: "todo",
        tone: "accent",
        labelKey: "eventDetail.appTimelineDecision",
      },
    ],
    current: 1,
  },
  APPROVED: {
    segments: [
      { state: "done", tone: "accent", labelKey: APPLIED },
      { state: "done", tone: "accent", labelKey: IN_REVIEW },
      {
        state: "done",
        tone: "accent",
        labelKey: "eventDetail.appTimelineApproved",
      },
    ],
    current: 2,
  },
  REJECTED: {
    segments: [
      { state: "done", tone: "accent", labelKey: APPLIED },
      { state: "done", tone: "accent", labelKey: IN_REVIEW },
      {
        state: "done",
        tone: "ink",
        labelKey: "eventDetail.appTimelineNotApproved",
      },
    ],
    current: 2,
  },
  WAITLISTED: {
    segments: [
      { state: "done", tone: "accent", labelKey: APPLIED },
      { state: "done", tone: "accent", labelKey: IN_REVIEW },
      {
        state: "done",
        tone: "support",
        labelKey: "eventDetail.appTimelineWaitlist",
      },
    ],
    current: 2,
  },
  WITHDRAWN: {
    segments: [
      { state: "done", tone: "muted", labelKey: APPLIED },
      { state: "todo", tone: "muted", labelKey: IN_REVIEW },
      {
        state: "done",
        tone: "muted",
        labelKey: "eventDetail.appTimelineWithdrawn",
      },
    ],
    current: 2,
  },
  EXPIRED: {
    segments: [
      { state: "done", tone: "muted", labelKey: APPLIED },
      { state: "todo", tone: "muted", labelKey: IN_REVIEW },
      {
        state: "done",
        tone: "muted",
        labelKey: "eventDetail.appTimelineExpired",
      },
    ],
    current: 2,
  },
};

const TONE_FILL: Record<SegmentTone, string> = {
  accent: CSS.accent,
  ink: CSS.ink,
  support: CSS.support,
  muted: CSS.muted,
};

const StatusTimeline = ({
  status,
  reducedMotion,
}: {
  status: ApplicationStatus;
  reducedMotion: boolean;
}) => {
  const t = useTranslations();
  // Unknown future statuses read as "still in review" — never a crash.
  const spec = TIMELINES[status] ?? TIMELINES.PENDING;

  // Fill from empty to the status's shape on mount and on every status
  // change: 240ms in four hard steps. Reduced motion lands it filled.
  const [filledFor, setFilledFor] = useState<string | null>(null);
  useEffect(() => {
    if (reducedMotion) {
      setFilledFor(status);
      return undefined;
    }
    setFilledFor(null);
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setFilledFor(status));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [status, reducedMotion]);
  const filled = filledFor === status;

  return (
    <ol
      aria-label={String(t("eventDetail.appTimelineLabel"))}
      data-testid="application-timeline"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 4,
      }}
    >
      {spec.segments.map((segment, index) => {
        const isCurrent = index === spec.current;
        return (
          <li
            key={segment.labelKey}
            aria-current={isCurrent ? "step" : undefined}
            data-state={segment.state}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minWidth: 0,
            }}
          >
            <div
              aria-hidden="true"
              data-testid="application-timeline-segment"
              style={{
                position: "relative",
                height: 10,
                overflow: "hidden",
                boxSizing: "border-box",
                backgroundColor:
                  segment.state === "todo" ? CSS.soft : "transparent",
                border:
                  segment.state === "current"
                    ? `2px solid ${CSS.ink}`
                    : undefined,
              }}
            >
              {segment.state === "done" ? (
                <div
                  data-testid="application-timeline-fill"
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: TONE_FILL[segment.tone],
                    transformOrigin: "0 50%",
                    transform: `scaleX(${filled ? 1 : 0})`,
                    transition: reducedMotion
                      ? "none"
                      : `transform ${FILL_MS}ms steps(4, end)`,
                  }}
                />
              ) : null}
            </div>
            <Text
              variant="overline"
              tone={isCurrent ? "default" : "muted"}
              weight={isCurrent ? "bold" : "semibold"}
              style={{ overflowWrap: "break-word" }}
            >
              {String(t(segment.labelKey))}
            </Text>
          </li>
        );
      })}
    </ol>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Status Display Component
// ─────────────────────────────────────────────────────────────────────────────

interface StatusDisplayProps {
  submission: ViewerSubmission;
  /** Kept for API stability; the page header carries the title now. */
  eventTitle?: string;
  onViewEvent?: () => void;
  /**
   * Withdraw affordance for the viewer's own PENDING application. The parent
   * owns the confirm dialog + mutation; the button renders only for PENDING
   * and only when this is provided.
   */
  onWithdraw?: () => void;
  /** Disables the withdraw button while the mutation is in flight. */
  isWithdrawing?: boolean;
  /**
   * Re-apply affordance for a WITHDRAWN application. The parent provides it
   * only while the application window is open (submit re-checks server-side
   * regardless).
   */
  onReapply?: () => void;
}

type StatusCopy = {
  titleKey: string;
  bodyKey: string;
  /** Headline colour: accent text for "You're in", muted for closed-out states. */
  headlineTone?: "accent" | "muted";
};

const STATUS_COPY: Record<ApplicationStatus, StatusCopy> = {
  PENDING: {
    titleKey: "eventDetail.appStatusSentTitle",
    bodyKey: "eventDetail.appStatusSentBody",
  },
  APPROVED: {
    titleKey: "eventDetail.appStatusYoureInTitle",
    bodyKey: "eventDetail.appStatusApprovedBody",
    headlineTone: "accent",
  },
  REJECTED: {
    titleKey: "eventDetail.appStatusNotApprovedTitle",
    bodyKey: "eventDetail.appStatusNotApprovedBody",
  },
  WAITLISTED: {
    titleKey: "eventDetail.appStatusWaitlistedTitle",
    bodyKey: "eventDetail.appStatusWaitlistedBody",
  },
  WITHDRAWN: {
    titleKey: "eventDetail.appStatusWithdrawnTitle",
    bodyKey: "eventDetail.appStatusWithdrawnBody",
    headlineTone: "muted",
  },
  EXPIRED: {
    titleKey: "eventDetail.appStatusExpiredTitle",
    bodyKey: "eventDetail.appStatusExpiredBody",
    headlineTone: "muted",
  },
};

/**
 * Safe fallback for statuses this build doesn't know yet — a server ahead of
 * the client must degrade to neutral copy, never TypeError on a destructure
 * of `undefined` (the exact crash the 3-status map shipped).
 */
const DEFAULT_STATUS_COPY: StatusCopy = {
  titleKey: "eventDetail.appStatusDefaultTitle",
  bodyKey: "eventDetail.appStatusDefaultBody",
};

const StatusDisplay = ({
  submission,
  onViewEvent,
  onWithdraw,
  isWithdrawing,
  onReapply,
}: StatusDisplayProps) => {
  const t = useTranslations();
  const reducedMotion = usePrefersReducedMotion();
  const copy = STATUS_COPY[submission.status] ?? DEFAULT_STATUS_COPY;
  const note =
    submission.status === "REJECTED" ? submission.decisionReason?.trim() : "";

  return (
    <GateSection
      gap="$5"
      testID="application-status"
      data-status={submission.status}
    >
      <StatusTimeline
        status={submission.status}
        reducedMotion={reducedMotion}
      />

      {/* No kicker: the timeline's current step already names the stage. */}
      <YStack gap="$3">
        <Text
          variant="h2"
          {...HEADLINE_PROPS}
          color={
            copy.headlineTone === "accent"
              ? "$accentText"
              : copy.headlineTone === "muted"
                ? "$colorMuted"
                : "$color"
          }
        >
          {String(t(copy.titleKey))}
        </Text>
        <Text variant="body" tone="muted" maxWidth={560}>
          {String(t(copy.bodyKey))}
        </Text>
      </YStack>

      {note ? (
        <YStack
          gap="$2"
          paddingLeft="$3"
          borderLeftWidth={4}
          borderLeftColor="$borderColor"
          testID="application-organizer-note"
        >
          <Text variant="overline" tone="muted">
            {String(t("eventDetail.appStatusFromOrganizer"))}
          </Text>
          {/* The organizer typed this; keep their line breaks. */}
          <Text variant="body" style={{ whiteSpace: "pre-line" }}>
            {note}
          </Text>
        </YStack>
      ) : null}

      {submission.status === "APPROVED" && onViewEvent ? (
        <XStack>
          <Button variant="primary" size="$4" onPress={onViewEvent}>
            {String(t("eventDetail.appViewEventCta"))}
          </Button>
        </XStack>
      ) : null}

      {submission.status === "PENDING" && onWithdraw ? (
        <XStack>
          <Button
            variant="secondary"
            size="$4"
            disabled={isWithdrawing}
            onPress={onWithdraw}
            testID="application-withdraw-btn"
          >
            {String(t("eventDetail.appWithdrawCta"))}
          </Button>
        </XStack>
      ) : null}

      {submission.status === "WITHDRAWN" && onReapply ? (
        <XStack>
          <Button
            variant="primary"
            size="$4"
            onPress={onReapply}
            testID="application-reapply-btn"
          >
            {String(t("eventDetail.appReapplyCta"))}
          </Button>
        </XStack>
      ) : null}
    </GateSection>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Window State Component (spec Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

interface WindowStateCardProps {
  /** Kept for API stability; the page header carries the title now. */
  eventTitle?: string;
  windowState: Exclude<ApplicationWindowState, "open">;
  /** Pre-formatted, locale-aware `opensAt` label supplied by the parent. */
  opensAtLabel?: string | null;
}

/**
 * "Applications open {date}" / "Applications are closed", shown INSTEAD of a
 * doomed form when the window is not open. The server enforces the same
 * window in `submit-event-application` regardless.
 */
const WindowStateCard = ({
  windowState,
  opensAtLabel,
}: WindowStateCardProps) => {
  const t = useTranslations();
  const isClosed = windowState === "closed";

  return (
    <GateSection testID="application-window-state">
      <Text variant="kicker" tone="muted">
        {String(t("eventDetail.appGateWindowKicker"))}
      </Text>
      <Text variant="h2" {...HEADLINE_PROPS}>
        {String(
          t(
            isClosed
              ? "eventDetail.appWindowClosedTitle"
              : "eventDetail.appWindowNotOpenTitle",
          ),
        )}
      </Text>
      <Text variant="body" tone="muted" maxWidth={560}>
        {/* Without a date, fall back to window-specific copy — NOT the
            submission-status default, which talks about an application the
            viewer hasn't made yet. */}
        {isClosed
          ? String(t("eventDetail.appWindowClosedBody"))
          : opensAtLabel
            ? String(t("eventDetail.appWindowOpensOn", { date: opensAtLabel }))
            : String(t("eventDetail.appWindowNotOpenBody"))}
      </Text>
    </GateSection>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Application Form Component — one question at a time
// ─────────────────────────────────────────────────────────────────────────────

interface ApplicationFormProps {
  eventTitle: string;
  form: ApplicationFormData;
  answers: Record<string, unknown>;
  contactEmail: string;
  contactPhone: string;
  isSubmitting: boolean;
  /** A submission-level error (server / verification). Shown in an alert. */
  error?: string | null;
  /**
   * Field-level contact errors from the caller's own validation (format
   * checks). Rendered under the field they belong to.
   */
  contactErrors?: { email?: string | null; phone?: string | null };
  onAnswerChange: (questionId: string, value: unknown) => void;
  onContactEmailChange: (value: string) => void;
  onContactPhoneChange: (value: string) => void;
  onSubmit: () => void;
  /**
   * Slot rendered on the contact step, above the send button, for a
   * bot-verification widget on the ANONYMOUS submit path (spec Phase 3).
   * Kept as a plain ReactNode so @th/ui never takes a Cloudflare dependency —
   * the web wrapper renders the actual `<Turnstile>` into it, and
   * native/embedded consumers simply pass nothing.
   */
  verificationSlot?: ReactNode;
  /**
   * Slot rendered on the contact step under the contact fields — the web
   * wrapper's "Applying as a guest, sign in to track it" note.
   */
  contactNote?: ReactNode;
  /**
   * Extra send-blocking condition owned by the caller (e.g. "Turnstile
   * hasn't produced a token yet"). It can only ever disable, never enable.
   */
  submitDisabled?: boolean;
}

type FormStep =
  | { kind: "question"; question: ApplicationQuestion }
  | { kind: "contact" };

const ApplicationForm = ({
  eventTitle,
  form,
  answers,
  contactEmail,
  contactPhone,
  isSubmitting,
  error,
  contactErrors,
  onAnswerChange,
  onContactEmailChange,
  onContactPhoneChange,
  onSubmit,
  verificationSlot,
  contactNote,
  submitDisabled = false,
}: ApplicationFormProps) => {
  const t = useTranslations();
  const baseId = useId();
  const reducedMotion = usePrefersReducedMotion();

  // Copied sort — never mutate the props array. A question with nothing to
  // render (a choice question whose options are all malformed, an unknown
  // future type) gets no step at all: a blank screen is a dead end.
  const steps = useMemo<FormStep[]>(
    () => [
      ...[...form.questions]
        .sort((a, b) => a.order - b.order)
        .filter(isQuestionRenderable)
        .map((question) => ({ kind: "question" as const, question })),
      { kind: "contact" as const },
    ],
    [form.questions],
  );
  const questionCount = steps.length - 1;
  const lastIndex = steps.length - 1;

  const [displayStep, setDisplayStep] = useState(0);
  const [phase, setPhase] = useState<SlidePhase>("active");
  const [dir, setDir] = useState<SlideDir | null>(null);
  const [stepError, setStepError] = useState<{
    step: number;
    message: string;
  } | null>(null);
  const [listOpen, setListOpen] = useState(false);

  // A form whose question set shrank under a mounted gate must not point
  // past its end.
  const current = Math.min(displayStep, lastIndex);
  const step = steps[current]!;
  const isContact = step.kind === "contact";

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frames = useRef<number[]>([]);
  const navigatedRef = useRef(false);
  const stepAreaRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLElement | null>(null);

  const clearMotion = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    frames.current.forEach((id) => cancelAnimationFrame(id));
    frames.current = [];
  }, []);
  useEffect(() => clearMotion, [clearMotion]);

  const isAnswered = useCallback(
    (index: number) => {
      const target = steps[index];
      if (!target) return false;
      if (target.kind === "contact") return contactEmail.trim().length > 0;
      return isAnswerProvided(target.question, answers[target.question.id]);
    },
    [steps, answers, contactEmail],
  );

  const goTo = useCallback(
    (target: number, errorMessage?: string) => {
      if (target < 0 || target > lastIndex) return;
      setStepError(
        errorMessage ? { step: target, message: errorMessage } : null,
      );
      if (target === current) return;
      navigatedRef.current = true;
      clearMotion();
      if (reducedMotion) {
        setDir(null);
        setPhase("active");
        setDisplayStep(target);
        return;
      }
      // A jump from the list slides from the side the target sits on.
      setDir(target > current ? "forward" : "backward");
      setPhase("exiting");
      timer.current = setTimeout(() => {
        setDisplayStep(target);
        setPhase("entering");
        // Two frames: the entering offset must PAINT before the transition
        // back to rest has a start keyframe.
        const first = requestAnimationFrame(() => {
          const second = requestAnimationFrame(() => setPhase("active"));
          frames.current.push(second);
        });
        frames.current.push(first);
      }, OUT_MS);
    },
    [current, lastIndex, reducedMotion, clearMotion],
  );

  const focusCurrentControl = useCallback(() => {
    stepAreaRef.current
      ?.querySelector<HTMLElement>(CONTROL_SELECTOR)
      ?.focus();
  }, []);

  // After a navigation, put focus on the new step's control (never on the
  // first render — the gate must not steal focus or scroll on load). The
  // control is labelled by the question, so this also announces it.
  useEffect(() => {
    if (phase !== "active" || !navigatedRef.current) return;
    focusCurrentControl();
  }, [current, phase, focusCurrentControl]);

  const firstMissingRequired = useCallback(() => {
    for (let index = 0; index < questionCount; index += 1) {
      const candidate = steps[index];
      if (
        candidate?.kind === "question" &&
        candidate.question.isRequired &&
        !isAnswerProvided(candidate.question, answers[candidate.question.id])
      ) {
        return index;
      }
    }
    return -1;
  }, [steps, questionCount, answers]);

  const handleNext = useCallback(() => {
    if (phase !== "active") return;
    if (step.kind === "question") {
      if (
        step.question.isRequired &&
        !isAnswerProvided(step.question, answers[step.question.id])
      ) {
        setStepError({
          step: current,
          message: String(t("eventDetail.appGateAnswerRequired")),
        });
        focusCurrentControl();
        return;
      }
      goTo(current + 1);
      return;
    }

    // Contact step: the send. Every required answer first — jump to the
    // first one missing, with its error already showing.
    if (isSubmitting || submitDisabled) return;
    const missing = firstMissingRequired();
    if (missing >= 0) {
      goTo(missing, String(t("eventDetail.appGateAnswerRequired")));
      return;
    }
    if (!contactEmail.trim()) {
      setStepError({
        step: current,
        message: String(t("eventDetail.appEnterEmail")),
      });
      focusCurrentControl();
      return;
    }
    onSubmit();
  }, [
    phase,
    step,
    answers,
    current,
    t,
    goTo,
    isSubmitting,
    submitDisabled,
    firstMissingRequired,
    contactEmail,
    onSubmit,
    focusCurrentControl,
  ]);

  const handleBack = useCallback(() => {
    if (phase !== "active") return;
    goTo(current - 1);
  }, [phase, goTo, current]);

  // Escape closes the question list and hands focus back to its toggle.
  //
  // Enter is NOT handled here: react-native-web's TextInput stops keydown
  // propagation, so a container listener never sees it. Enter advances
  // through `onSubmitEditing` on the single-line fields instead (RNW fires it
  // for Enter on a non-multiline input, and not mid-IME-composition), which
  // also keeps a textarea's Enter a newline and a button's Enter a click.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && listOpen) {
        setListOpen(false);
        toggleRef.current?.focus();
      }
    },
    [listOpen],
  );

  const handleAnswer = useCallback(
    (questionId: string, value: unknown) => {
      // Clear on input: an error never nags while the reader fixes it.
      setStepError((prev) => (prev?.step === current ? null : prev));
      onAnswerChange(questionId, value);
    },
    [current, onAnswerChange],
  );

  const handleEmail = useCallback(
    (value: string) => {
      setStepError((prev) => (prev?.step === current ? null : prev));
      onContactEmailChange(value);
    },
    [current, onContactEmailChange],
  );

  const jumpTo = useCallback(
    (index: number) => {
      setListOpen(false);
      if (index === current) {
        focusCurrentControl();
        return;
      }
      goTo(index);
    },
    [current, goTo, focusCurrentControl],
  );

  const ids = {
    heading: `${baseId}-question`,
    description: `${baseId}-description`,
    progress: `${baseId}-progress`,
    error: `${baseId}-error`,
    list: `${baseId}-list`,
  };

  const progressLabel = isContact
    ? String(
        t(
          questionCount > 0
            ? "eventDetail.appGateContactStep"
            : "eventDetail.appGateContactOnly",
        ),
      )
    : String(
        t("eventDetail.appGateQuestionOf", {
          current: current + 1,
          total: questionCount,
        }),
      );

  const visibleError = stepError?.step === current ? stepError.message : null;
  const emailError =
    isContact && visibleError ? visibleError : (contactErrors?.email ?? null);

  const contactQuestion = String(t("eventDetail.appGateContactQuestion"));
  const stepLabel = (index: number) => {
    const target = steps[index]!;
    return target.kind === "contact"
      ? contactQuestion
      : `${index + 1}. ${target.question.label}`;
  };

  return (
    <div onKeyDown={handleKeyDown} style={{ width: "100%", minWidth: 0 }}>
      <GateSection
        gap="$5"
        testID="application-form"
        role="group"
        aria-label={String(
          t("eventDetail.appGateFormLabel", { title: eventTitle }),
        )}
      >
        {form.introText ? (
          <Text
            variant="body"
            tone="muted"
            maxWidth={600}
            style={{ whiteSpace: "pre-line" }}
          >
            {form.introText}
          </Text>
        ) : null}

        {/* ── Step band: a picture of progress, plus the jump list ── */}
        <YStack gap="$2">
          <XStack
            gap={4}
            aria-hidden
            testID="application-step-band"
          >
            {steps.map((_, index) => (
              <div
                key={index}
                data-on={index <= current ? "true" : "false"}
                style={{
                  flex: 1,
                  height: 8,
                  backgroundColor: index <= current ? CSS.accent : CSS.soft,
                  transition: reducedMotion
                    ? "none"
                    : `background-color ${OUT_MS}ms steps(1, end)`,
                }}
              />
            ))}
          </XStack>
          <XStack
            justifyContent="space-between"
            alignItems="center"
            gap="$3"
            flexWrap="wrap"
          >
            <Text variant="overline" tone="muted" id={ids.progress}>
              {progressLabel}
            </Text>
            {steps.length > 1 ? (
              <LinkToggle
                ref={toggleRef as never}
                {...BUTTON_TYPE}
                aria-expanded={listOpen}
                aria-controls={ids.list}
                onPress={() => setListOpen((open) => !open)}
                testID="application-all-questions"
              >
                <Text
                  variant="overline"
                  color={listOpen ? "$color" : "$accentText"}
                  style={{
                    textDecorationLine: "underline",
                    textDecorationColor: CSS.accent,
                    textDecorationThickness: 2,
                    textUnderlineOffset: 5,
                  }}
                >
                  {String(t("eventDetail.appGateAllQuestions"))}
                </Text>
              </LinkToggle>
            ) : null}
          </XStack>

          {listOpen ? (
            <ol
              id={ids.list}
              aria-label={String(t("eventDetail.appGateAllQuestions"))}
              data-testid="application-question-list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                border: `2px solid ${CSS.border}`,
                backgroundColor: CSS.surface,
              }}
            >
              {steps.map((_, index) => {
                const isCur = index === current;
                const answered = isAnswered(index);
                const stateKey = isCur
                  ? "eventDetail.appGateStateCurrent"
                  : answered
                    ? "eventDetail.appGateStateAnswered"
                    : "eventDetail.appGateStateNotAnswered";
                return (
                  <li
                    key={index}
                    style={
                      index > 0
                        ? { borderTop: `1px solid ${CSS.soft}` }
                        : undefined
                    }
                  >
                    <ListRow
                      {...BUTTON_TYPE}
                      aria-current={isCur ? "step" : undefined}
                      backgroundColor={isCur ? "$surfaceRaised" : "transparent"}
                      onPress={() => jumpTo(index)}
                      testID={`application-jump-${index}`}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 12,
                          height: 12,
                          flex: "none",
                          boxSizing: "border-box",
                          border: `2px solid ${answered || isCur ? CSS.accent : CSS.border}`,
                          backgroundColor: answered
                            ? CSS.accent
                            : "transparent",
                        }}
                      />
                      <Text
                        variant="bodySmall"
                        weight={isCur ? "semibold" : "medium"}
                        truncate
                        flex={1}
                        minWidth={0}
                        textAlign="left"
                      >
                        {stepLabel(index)}
                      </Text>
                      <Text variant="overline" tone="muted" flexShrink={0}>
                        {String(t(stateKey))}
                      </Text>
                    </ListRow>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </YStack>

        {/* ── The step ── */}
        <div
          ref={stepAreaRef}
          data-testid="application-step"
          data-step={current}
          data-phase={phase}
          style={{ ...slideStyle(phase, dir), minWidth: 0 }}
        >
          <YStack gap="$4" minHeight={200} $sm={{ minHeight: 0 }}>
            {step.kind === "question" ? (
              <QuestionStep
                question={step.question}
                value={answers[step.question.id]}
                onChange={(value) => handleAnswer(step.question.id, value)}
                onEnter={handleNext}
                ids={ids}
                error={visibleError}
              />
            ) : (
              <YStack gap="$4">
                <QuestionHeading id={ids.heading}>
                  {contactQuestion}
                </QuestionHeading>
                <LabeledTextInput
                  label={String(t("eventDetail.appGateEmailLabel"))}
                  labelVariant="overline"
                  id={`${baseId}-email`}
                  name="contactEmail"
                  type="email"
                  autoComplete="email"
                  required
                  value={contactEmail}
                  onChangeText={handleEmail}
                  onSubmitEditing={handleNext}
                  placeholder={String(
                    t("eventDetail.appGateEmailPlaceholder"),
                  )}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  status={emailError ? "error" : undefined}
                  helperText={emailError ?? undefined}
                  aria-invalid={emailError ? true : undefined}
                  fontSize={16}
                  minHeight={48}
                />
                <LabeledTextInput
                  label={String(t("eventDetail.appGatePhoneLabel"))}
                  labelVariant="overline"
                  id={`${baseId}-phone`}
                  name="contactPhone"
                  type="tel"
                  autoComplete="tel"
                  value={contactPhone}
                  onChangeText={onContactPhoneChange}
                  onSubmitEditing={handleNext}
                  keyboardType="phone-pad"
                  status={contactErrors?.phone ? "error" : undefined}
                  helperText={contactErrors?.phone ?? undefined}
                  aria-invalid={contactErrors?.phone ? true : undefined}
                  fontSize={16}
                  minHeight={48}
                />
                {contactNote}
                {verificationSlot}
              </YStack>
            )}
          </YStack>
        </div>

        {error ? (
          <Text
            variant="bodySmall"
            tone="error"
            weight="semibold"
            role="alert"
          >
            {error}
          </Text>
        ) : null}

        {/* ── Back / Next. The page pins this bar on phones (DS Task rule).
            A plain element on purpose: Tamagui paints `position` inline at
            runtime, which a page stylesheet cannot override, so the hook the
            page styles (`th-appgate-nav`) must not be a Tamagui view. ── */}
        <div className="th-appgate-nav" data-testid="application-nav">
          <XStack className="th-appgate-nav__row" gap="$3" alignItems="center">
            {current > 0 ? (
              <Button
                variant="secondary"
                size="$4"
                onPress={handleBack}
                testID="application-back"
              >
                {String(t("eventDetail.appGateBack"))}
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="$4"
              marginLeft="auto"
              onPress={handleNext}
              disabled={isContact && (isSubmitting || submitDisabled)}
              aria-busy={isContact && isSubmitting ? true : undefined}
              testID={isContact ? "application-send" : "application-next"}
            >
              {String(
                t(
                  isContact
                    ? isSubmitting
                      ? "eventDetail.appGateSending"
                      : "eventDetail.appGateSend"
                    : "eventDetail.appGateNext",
                ),
              )}
            </Button>
          </XStack>
        </div>
      </GateSection>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// One question
// ─────────────────────────────────────────────────────────────────────────────

/** The question itself, big: it is the whole screen's point. */
const QuestionHeading = ({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) => (
  <Text
    id={id}
    variant="h2"
    fontSize={24}
    lineHeight={30}
    letterSpacing={-0.24}
    textTransform="none"
    fontWeight="700"
    $sm={{ fontSize: 21, lineHeight: 27 }}
    style={{ overflowWrap: "break-word" }}
  >
    {children}
  </Text>
);

interface QuestionStepProps {
  question: ApplicationQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
  ids: {
    heading: string;
    description: string;
    progress: string;
    error: string;
  };
  error: string | null;
  /** Enter in a single-line answer: same as pressing Next. */
  onEnter: () => void;
}

const QuestionStep = ({
  question,
  value,
  onChange,
  ids,
  error,
  onEnter,
}: QuestionStepProps) => {
  const t = useTranslations();
  const describedBy =
    [
      question.description ? ids.description : null,
      error ? ids.error : null,
      ids.progress,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <YStack gap="$4" testID={`question-${question.id}`}>
      <YStack gap="$2">
        <QuestionHeading id={ids.heading}>{question.label}</QuestionHeading>
        {/* Optional is marked; required is not (DS §6a). Required-ness
            travels on the control as aria-required. */}
        {!question.isRequired ? (
          <Text variant="overline" tone="muted">
            {String(t("eventDetail.appGateOptional"))}
          </Text>
        ) : null}
        {question.description ? (
          <Text id={ids.description} variant="bodySmall" tone="muted">
            {question.description}
          </Text>
        ) : null}
      </YStack>

      <QuestionControl
        question={question}
        value={value}
        onChange={onChange}
        labelledBy={ids.heading}
        describedBy={describedBy}
        invalid={Boolean(error)}
        onEnter={onEnter}
      />

      {error ? (
        <Text
          id={ids.error}
          variant="bodySmall"
          tone="error"
          weight="semibold"
          role="alert"
        >
          {error}
        </Text>
      ) : null}
    </YStack>
  );
};

interface QuestionControlProps {
  question: ApplicationQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
  labelledBy: string;
  describedBy?: string;
  invalid: boolean;
  onEnter: () => void;
}

const QuestionControl = ({
  question,
  value,
  onChange,
  labelledBy,
  describedBy,
  invalid,
  onEnter,
}: QuestionControlProps) => {
  const t = useTranslations();
  const required = question.isRequired || undefined;

  switch (question.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT": {
      const isLong = question.type === "LONG_TEXT";
      return (
        <TextInput
          fullWidth
          name={`question-${question.id}`}
          id={`question-${question.id}`}
          value={typeof value === "string" ? value : ""}
          onChangeText={(next) => onChange(next)}
          placeholder={String(t("eventDetail.appGateAnswerPlaceholder"))}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          required={question.isRequired}
          status={invalid ? "error" : undefined}
          fontSize={16}
          {...(isLong
            ? { multiline: true, numberOfLines: 6, minHeight: 150 }
            : { minHeight: 48, onSubmitEditing: onEnter })}
        />
      );
    }

    case "SINGLE_CHOICE": {
      const options = parseQuestionOptions(question.options);
      if (options.length === 0) return null;
      const selected = typeof value === "string" ? value : "";
      return (
        <RadioGroupField
          name={`question-${question.id}`}
          value={selected}
          onValueChange={(next) => onChange(next)}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-required={required}
          aria-invalid={invalid || undefined}
        >
          {options.map((option, index) => (
            <Radio
              key={option.value}
              id={`question-${question.id}-option-${index}`}
              value={option.value}
              label={option.label}
              testIdBase={`question-${question.id}-option-${index}`}
            />
          ))}
        </RadioGroupField>
      );
    }

    case "MULTI_CHOICE": {
      const options = parseQuestionOptions(question.options);
      if (options.length === 0) return null;
      const selected = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
      return (
        <YStack
          gap="$3"
          role="group"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-required={required}
          aria-invalid={invalid || undefined}
        >
          {options.map((option, index) => (
            <Checkbox
              key={option.value}
              id={`question-${question.id}-option-${index}`}
              label={option.label}
              checked={selected.includes(option.value)}
              testIdBase={`question-${question.id}-option-${index}`}
              onCheckedChange={(next) => {
                const nextSelected = new Set(selected);
                if (next === true) {
                  nextSelected.add(option.value);
                } else {
                  nextSelected.delete(option.value);
                }
                // Emit in option order for a stable, readable answer array.
                onChange(
                  options
                    .filter((candidate) => nextSelected.has(candidate.value))
                    .map((candidate) => candidate.value),
                );
              }}
            />
          ))}
        </YStack>
      );
    }

    default:
      return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Loading State Component
// ─────────────────────────────────────────────────────────────────────────────

const LoadingState = (_props: { eventTitle?: string }) => {
  const t = useTranslations();
  return (
    <GateSection aria-busy testID="application-loading">
      <XStack gap={4} aria-hidden>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            style={{ flex: 1, height: 8, backgroundColor: CSS.soft }}
          />
        ))}
      </XStack>
      <Text variant="body" tone="muted">
        {String(t("eventDetail.appGateLoading"))}
      </Text>
    </GateSection>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export interface EventApplicationGateProps {
  eventTitle: string;
  isLoading?: boolean;
  viewerSubmission?: ViewerSubmission | null;
  form?: ApplicationFormData | null;
  /**
   * Application-window state (spec Phase 2), computed by the parent from
   * the form's opensAt/closesAt. Defaults to "open" so pre-window callers
   * keep today's behavior.
   */
  windowState?: ApplicationWindowState;
  /** Pre-formatted, locale-aware opensAt label for the not-yet-open state. */
  opensAtLabel?: string | null;
  /** Called when viewer clicks "View Event" after approval */
  onViewEvent?: () => void;
  /** Withdraw affordance for the viewer's own PENDING application. */
  onWithdraw?: () => void;
  /** Disables the withdraw button while the mutation is in flight. */
  isWithdrawing?: boolean;
  /** Re-apply affordance for a WITHDRAWN application (window open only). */
  onReapply?: () => void;
  /** Render prop for custom form handling (for platform-specific tRPC hooks) */
  renderForm?: (props: {
    form: ApplicationFormData;
    eventTitle: string;
  }) => ReactNode;
}

/**
 * Shared UI component for application-gated events — the BODY of the gate.
 * The page around it (poster rail / compact header, the event title) belongs
 * to the caller.
 *
 * Displays one of four states:
 * 1. Loading state
 * 2. Application status (if viewer has already submitted)
 * 3. Window state (applications not yet open / closed)
 * 4. Application form (window open, no submission) — one question at a time
 *
 * The form submission logic should be handled by the parent component
 * using platform-specific hooks (tRPC on web, etc.)
 */
export const EventApplicationGate = ({
  eventTitle,
  isLoading,
  viewerSubmission,
  form,
  windowState = "open",
  opensAtLabel,
  onViewEvent,
  onWithdraw,
  isWithdrawing,
  onReapply,
  renderForm,
}: EventApplicationGateProps) => {
  const t = useTranslations();

  if (isLoading) {
    return <LoadingState eventTitle={eventTitle} />;
  }

  // Show submission status if viewer has already applied
  if (viewerSubmission) {
    return (
      <StatusDisplay
        submission={viewerSubmission}
        eventTitle={eventTitle}
        onViewEvent={onViewEvent}
        onWithdraw={onWithdraw}
        isWithdrawing={isWithdrawing}
        onReapply={windowState === "open" ? onReapply : undefined}
      />
    );
  }

  // Window not open: show the open/closed state instead of a doomed form.
  if (windowState !== "open") {
    return (
      <WindowStateCard
        eventTitle={eventTitle}
        windowState={windowState}
        opensAtLabel={opensAtLabel}
      />
    );
  }

  // Show form if available and renderForm provided
  if (form && renderForm) {
    return <>{renderForm({ form, eventTitle })}</>;
  }

  // Fallback: no form available yet
  return (
    <GateSection testID="application-unavailable">
      <Text variant="body" tone="muted">
        {String(t("eventDetail.appGateUnavailable"))}
      </Text>
    </GateSection>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponent Exports (for custom composition)
// ─────────────────────────────────────────────────────────────────────────────

EventApplicationGate.Form = ApplicationForm;
EventApplicationGate.Status = StatusDisplay;
EventApplicationGate.WindowState = WindowStateCard;
EventApplicationGate.Loading = LoadingState;
EventApplicationGate.Card = GateCard;

export type EventApplicationGateCardProps = GetProps<typeof GateCard>;

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

interface NormalizedQuestionOption {
  /** Stored as the answer value AND shown to the applicant. Human-readable
   * on purpose: the review queue renders answers with `String(value)`, so
   * an opaque id would be unreadable to organizers. */
  value: string;
  label: string;
}

/**
 * Defensively normalize a question's `options` Json.
 *
 * The shape at rest is inconsistent across layers (builder/transport write
 * `{value, label?}`, core's canonical schema says `{id, label}`, and the
 * transport form read is `z.any()`), so accept every shape we know about —
 * plain strings, `{value, label?}`, `{id, label}` — and drop anything else.
 * Blank and duplicate entries are skipped; a malformed payload yields `[]`.
 */
function parseQuestionOptions(raw: unknown): NormalizedQuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: NormalizedQuestionOption[] = [];

  for (const entry of raw) {
    let text: string | null = null;

    if (typeof entry === "string") {
      text = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      // Numeric option lists ([15, 30, 45]) render as their string form
      // rather than vanishing.
      text = String(entry);
    } else if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label : null;
      const value = typeof record.value === "string" ? record.value : null;
      // Builder shape puts the display text in `value` (label optional);
      // core shape puts it in `label`. Prefer `label` when present.
      text = label?.trim() ? label : value;
    }

    const trimmed = text?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push({ value: trimmed, label: trimmed });
  }

  return normalized;
}

/**
 * Whether a question gets a step at all. Choice questions with no usable
 * options and unknown future types render nothing — and so can never block
 * the send either (only stepped questions are checked as required).
 */
function isQuestionRenderable(question: ApplicationQuestion): boolean {
  switch (question.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT":
      return true;
    case "SINGLE_CHOICE":
    case "MULTI_CHOICE":
      return parseQuestionOptions(question.options).length > 0;
    default:
      return false;
  }
}

function isAnswerProvided(
  question: ApplicationQuestion,
  value: unknown,
): boolean {
  switch (question.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT":
    case "SINGLE_CHOICE":
      return typeof value === "string" && value.trim().length > 0;
    case "MULTI_CHOICE":
      return (
        Array.isArray(value) &&
        value.some((item) => typeof item === "string" && item.trim().length > 0)
      );
    default:
      // Unknown future types never block submission.
      return true;
  }
}
