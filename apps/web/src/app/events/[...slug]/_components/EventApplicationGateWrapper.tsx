"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

import { TURNSTILE_SITE_KEY } from "@/app/embed/[embedId]/_components/embed-helpers";
import { useRouter } from "@bprogress/next/app";
import Image from "next/image";
import { YStack } from "tamagui";
import {
  EventApplicationGate,
  NextLinkAnchor,
  Text,
  type ApplicationFormData,
  type ApplicationWindowState,
  type ViewerSubmission,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import type { PublicApplicationFormSeed } from "@/server/events";
import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { isEventNotFoundAnswer } from "@/lib/event-not-found-answer";
import { fmtDate } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { WaitlistJoinForm } from "@/components/events/WaitlistJoinForm";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import {
  contactPairSchema,
  validateForm,
  type FieldErrors,
} from "@/lib/validation";

// The page frame (poster rail / compact header / phone-pinned nav) is plain
// CSS: it switches layout at the event page's own 768px split, which no
// Tamagui media key matches. See the file for why the steps are what they are.
import "./application-gate.css";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Client-side mirror of the server's window enforcement
 * (`submit-event-application`): exactly-at `opensAt` is OPEN, exactly-at
 * `closesAt` is still open — only strictly outside the window shows the
 * closed/not-open state. The server re-checks on submit regardless.
 */
export function resolveWindowState(
  opensAt: Date | null | undefined,
  closesAt: Date | null | undefined,
  now: Date,
): ApplicationWindowState {
  if (opensAt && now.getTime() < opensAt.getTime()) return "notYetOpen";
  if (closesAt && now.getTime() > closesAt.getTime()) return "closed";
  return "open";
}

const WINDOW_ERROR_CODES = new Set([
  "APPLICATION_WINDOW_NOT_OPEN",
  "APPLICATION_WINDOW_CLOSED",
  "APPLICATION_CAP_REACHED",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export type EventApplicationGateWrapperProps = {
  eventId: string;
  slug: string;
  title: string;
  heroImageUrl: string | null;
  /** When true, a "Notify me" sign-up form is shown below the gate card. */
  waitlistOpen?: boolean;
  /** Organizer-provided blurb for the notify-me form. */
  waitlistDescription?: string | null;
  /**
   * Called by "View event" once the viewer has been approved, INSTEAD of
   * `router.refresh()`.
   *
   * A gated event page is edge-cached and identity-free by design, so a refresh
   * refetches the very same gate wall — and because this component is reconciled
   * rather than remounted, `GatedEventShell`'s access probe would not re-fire
   * either. The shell passes that probe here instead. Omitted (e.g. a
   * standalone/test mount) → falls back to refresh.
   *
   * Resolves `false` when the probe did NOT open the event (approval
   * rescinded since the status read, or the probe failed): "View event" then
   * says so and re-reads the status instead of doing nothing.
   */
  onUnlocked?: () => void | Promise<boolean>;
  /**
   * One line under the title (a dead or reset invite link:
   * `InviteDeadNotice`). Shown only over the form: not while the status
   * read loads, never with a submission status card.
   */
  notice?: ReactNode;
  /**
   * The public form definition, read on the server (page.tsx), so the form
   * is the first paint instead of a loading line that grows into it.
   * Omitted/null: the form is fetched after paint, as before.
   */
  formSeed?: PublicApplicationFormSeed | null;
};

/**
 * Client component that shows the application gate UI.
 *
 * Handles:
 * 1. Fetching the viewer's existing application (if any)
 * 2. Fetching the application form (incl. window state, spec Phase 2)
 * 3. Submitting new applications (and re-applying after a withdrawal)
 * 4. Displaying application status + withdrawing a PENDING application
 *
 * On approval, reloads the page so full event details are shown.
 */
export const EventApplicationGateWrapper = ({
  eventId,
  slug,
  title,
  heroImageUrl,
  waitlistOpen = false,
  waitlistDescription,
  onUnlocked,
  notice,
  formSeed = null,
}: EventApplicationGateWrapperProps) => {
  const router = useRouter();
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  // `waitlists` gate — fail-CLOSED, matching EventContent's join affordance.
  const { gates } = useFeatureGates();
  const waitlistsGateOn = gates?.waitlists === true;

  // Session is still read, but ONLY to decide whether to ask for the viewer's
  // own application status (that read is authed by design — see below). It no
  // longer gates the form or the gate itself: guests can apply (spec Phase 3).
  const sessionQuery = authClient.useSession();
  const isAuthed = Boolean(sessionQuery.data?.user);
  const sessionLoading = sessionQuery.isPending;

  /**
   * `hasMounted` — the guard for every SESSION-DERIVED piece of RENDERED
   * output below.
   *
   * `authClient.useSession()` reports `isPending: true` during the server
   * pass but can resolve SYNCHRONOUSLY on the client's first render from its
   * own store. Anything rendered from `isAuthed`/`sessionLoading` therefore
   * differs between the server HTML and the hydrating client render — an
   * extra element at hydration, which React reports as a full hydration
   * failure and which regenerates this whole tree on the client.
   *
   * This is the same mechanism that took `HoursStatementSheet` down and was
   * later fixed in `TicketPrintSheet`; it was reproduced here by driving the
   * signed-out gate in a browser, where the "sign in to track it" block and
   * the Turnstile widget are both session-derived.
   *
   * Note this guards RENDER only — `statusQuery`'s `enabled: isAuthed` is a
   * fetch decision, produces no server markup, and is deliberately left
   * alone.
   */
  const [hasMounted, setHasMounted] = useState(false);
  const [turnstileSize, setTurnstileSize] = useState<"normal" | "compact">(
    "normal",
  );
  useEffect(() => {
    setHasMounted(true);
    if (window.innerWidth < 360) setTurnstileSize("compact");
  }, []);

  // Viewer's existing application status. Still `enabled: isAuthed` on
  // purpose — `getViewerApplicationStatus` keys on the SESSION, and there is
  // deliberately no guest equivalent: any endpoint that answered "has
  // <email> applied?" would be an enumeration oracle. A guest's own status
  // reaches them via the submit response and the emailed claim link instead.
  const statusQuery = trpc.events.getViewerApplicationStatus.useQuery(
    { eventId },
    { refetchOnWindowFocus: true, enabled: isAuthed },
  );

  const viewerStatus = statusQuery.data?.submission?.status ?? null;

  // Fetch the application form.
  //
  // MUST be `getPublicApplicationForm`, NOT `getApplicationForm`. The authed
  // one runs behind `ensureActorCanEditEvent` — and this gate only renders
  // for viewers who are LOCKED OUT, i.e. never editors. Pointing it there
  // makes the form resolve null for every real applicant and nobody can apply
  // to any application-gated event. The public read returns the definition
  // only (no defaults / maxSubmissions / autoApprove).
  //
  // No `isAuthed` in the guard: the public read needs no session.
  // Also needed on a WITHDRAWN submission: the withdrawn card offers "Apply
  // again" only while the window is open, and re-applying renders the form.
  //
  // Seeded from the server's read when there is one (only for THIS event's
  // input). The seed carries ISO strings across the RSC boundary; revived
  // here into the exact shape the query returns (superjson → `Date`).
  // `initialDataUpdatedAt` is the server's read time, so a seed older than
  // the app's staleTime (an edge-cached document can be minutes old) is
  // refetched on mount and an organizer's edit still shows up.
  const seed =
    formSeed && formSeed.form.eventId === eventId ? formSeed : null;
  const seeded = seed !== null;
  const seedInitialData = useMemo(
    () =>
      seed
        ? {
            ...seed.form,
            opensAt: seed.form.opensAt ? new Date(seed.form.opensAt) : null,
            closesAt: seed.form.closesAt ? new Date(seed.form.closesAt) : null,
          }
        : undefined,
    [seed],
  );
  const formQuery = trpc.events.getPublicApplicationForm.useQuery(
    { eventId },
    {
      enabled: !statusQuery.data?.hasSubmission || viewerStatus === "WITHDRAWN",
      retry: false,
      // A past/cancelled gated event answers EVENT_NOT_FOUND by design; the
      // gate renders its own unavailable state, so no toast or Sentry event.
      meta: { silentWhen: isEventNotFoundAnswer },
      ...(seed && seedInitialData
        ? {
            initialData: seedInitialData,
            initialDataUpdatedAt: Date.parse(seed.fetchedAt),
          }
        : {}),
    },
  );

  // After a successful withdraw the viewer drops straight back into the
  // form (window permitting) — a returning visit shows the withdrawn card
  // with an "Apply again" affordance instead.
  const [reapplying, setReapplying] = useState(false);

  // A GUEST's own result, from the submit response. The status read above is
  // session-keyed on purpose (no "has <email> applied?" oracle), so without
  // this a guest who sent an application was left looking at the form. It
  // lives for this visit only; afterwards the emailed claim link carries it.
  // Set by a successful send; consumed once the status view has rendered.
  const [justSubmitted, setJustSubmitted] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [guestSubmission, setGuestSubmission] =
    useState<ViewerSubmission | null>(null);

  // Submit mutation
  const submitMutation = trpc.events.submitApplication.useMutation({
    onSuccess: (result) => {
      setReapplying(false);
      setJustSubmitted(true);
      if (result.submissionId && result.status) {
        setGuestSubmission({
          id: result.submissionId,
          status: result.status,
          createdAt: new Date(),
        });
      }
      // Refetch status to show the new submission. Signed-in only: the read
      // is session-keyed, and `refetch()` would fire it even while disabled.
      if (isAuthed) void statusQuery.refetch();
    },
  });

  // Withdraw mutation + confirm dialog (per repo ConfirmDialog pattern).
  const [withdrawConfirmOpen, setWithdrawConfirmOpen] = useState(false);
  const withdrawMutation = trpc.events.withdrawApplication.useMutation();

  // Form state
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  // Turnstile: the SERVER enforces it for unauthenticated submitters only
  // (submit-event-application), so mirror that here — an authed applicant
  // never sees or needs the widget.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const needsTurnstile = Boolean(
    hasMounted && !isAuthed && !sessionLoading && TURNSTILE_SITE_KEY,
  );
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  // Format errors land under the field they belong to (the contact step),
  // and clear the moment that field is edited (DS §6a: clear on input).
  const [fieldErrors, setFieldErrors] = useState<
    FieldErrors<"contactEmail" | "contactPhone">
  >({});

  const handleAnswerChange = useCallback(
    (questionId: string, value: unknown) => {
      setAnswers((prev) => ({ ...prev, [questionId]: value }));
    },
    [],
  );

  const handleContactEmailChange = useCallback((value: string) => {
    setContactEmail(value);
    setFieldErrors((prev) =>
      prev.contactEmail ? { ...prev, contactEmail: undefined } : prev,
    );
  }, []);

  const handleContactPhoneChange = useCallback((value: string) => {
    setContactPhone(value);
    setFieldErrors((prev) =>
      prev.contactPhone ? { ...prev, contactPhone: undefined } : prev,
    );
  }, []);

  const handleSubmit = useCallback(() => {
    const result = validateForm({
      schema: contactPairSchema,
      data: { contactEmail, contactPhone },
      t,
    });

    if (!result.success) {
      // Inline, under the offending field — not repeated as a general alert.
      setFieldErrors(result.fieldErrors);
      setError(null);
      return;
    }

    setFieldErrors({});
    setError(null);
    if (needsTurnstile && !turnstileToken) {
      setError(String(t("eventDetail.appVerifyToContinue")));
      return;
    }

    submitMutation.mutate(
      {
        eventId,
        contactEmail: result.data.contactEmail || undefined,
        contactPhone: result.data.contactPhone || undefined,
        answers,
        ...(turnstileToken ? { turnstileToken } : {}),
      },
      {
        onError: (err) => {
          // A consumed/failed Turnstile token is dead — reset for retry.
          turnstileRef.current?.reset();
          setTurnstileToken(null);
          const code = getAppErrorCode(err);
          // `contact_required` is a Zod refinement message (input-validation
          // error), not a canonical AppErrorCode — keep matching it on the
          // surfaced message.
          if (err.message === "contact_required") {
            setError(String(t("eventDetail.appContactRequired")));
          } else if (code === "EVENT_NOT_APPLICATION_GATED") {
            setError(String(t("eventDetail.appNoLongerRequired")));
          } else if (code && WINDOW_ERROR_CODES.has(code)) {
            // Window/cap enforcement (spec Phase 2): the errors.* catalog
            // carries friendly copy for all three codes. Refetch the form so
            // the gate re-derives its open/closed state from fresh bounds.
            setError(formatErrorMessage(err, t));
            void formQuery.refetch();
          } else {
            setError(String(t("eventDetail.appGenericError")));
          }
        },
      },
    );
  }, [
    eventId,
    contactEmail,
    contactPhone,
    answers,
    submitMutation,
    formQuery,
    needsTurnstile,
    turnstileToken,
    t,
  ]);

  // One "View event" probe at a time: a second press while the first is in
  // flight would only queue another probe behind it.
  const viewingRef = useRef(false);
  // A verdict that lands after the viewer moved on (another event, or away)
  // must not toast on the next page: the toast is global.
  const liveEventId = useRef(eventId);
  liveEventId.current = eventId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const handleViewEvent = useCallback(async () => {
    if (viewingRef.current) return;
    const askedFor = eventId;
    // If approved, the unlock should exist — re-ask for access. See `onUnlocked`
    // on the props: `router.refresh()` alone cannot reveal a gated page.
    // The flag is what the password gate sets on unlock: without it the
    // reveal is an instant swap and focus drops to <body> with the removed
    // button, instead of landing on the event's headline (EventDetail).
    try {
      sessionStorage.setItem(`th-event-just-unlocked:${eventId}`, "1");
    } catch {
      // sessionStorage may be unavailable (private window quirks).
    }
    if (!onUnlocked) {
      router.refresh();
      return;
    }
    viewingRef.current = true;
    try {
      const opened = await onUnlocked();
      const stillHere =
        mountedRef.current && liveEventId.current === askedFor;
      if (opened === false && stillHere) {
        toast.danger({
          id: `application-view-error-${eventId}`,
          title: String(t("eventDetail.appGenericError")),
        });
        // The status may have changed under us (a rescinded approval):
        // re-read it so the card shows the real state.
        if (isAuthed) void statusQuery.refetch();
      }
    } finally {
      viewingRef.current = false;
    }
  }, [eventId, onUnlocked, router, toast, t, isAuthed, statusQuery]);

  const handleWithdrawConfirm = useCallback(() => {
    withdrawMutation.mutate(
      { eventId },
      {
        onSuccess: () => {
          setWithdrawConfirmOpen(false);
          // Drop straight back into the form-or-closed state per window:
          // the refetched status is WITHDRAWN, and `reapplying` suppresses
          // the withdrawn card in favour of the form when the window allows.
          setReapplying(true);
          void statusQuery.refetch();
        },
        onError: (err) => {
          setWithdrawConfirmOpen(false);
          toast.danger({
            id: `application-withdraw-error-${eventId}`,
            title: String(t("eventDetail.appWithdrawFailed")),
            message: formatErrorMessage(err, t),
          });
          // The submission may have been decided while the dialog was open —
          // refresh so the card reflects the real status.
          void statusQuery.refetch();
        },
      },
    );
  }, [eventId, withdrawMutation, statusQuery, toast, t]);

  // Map query data to component props. The form query runs for everyone, so
  // only the STATUS leg is still session-dependent.
  //
  // `statusPending`: we do not yet know whether this viewer has applied (the
  // session is resolving — always, on the server — or a signed-in viewer's
  // status read is in flight).
  const statusPending = sessionLoading || (isAuthed && statusQuery.isLoading);
  // Seeded: the form is shown while the session and status resolve, on the
  // server and on every client render after, never form → loading → form.
  // If the status then reports a submission (a returning signed-in
  // applicant, unknowable on the server) the status card replaces the form.
  // Unseeded: today's rule, unchanged.
  const isLoading = seeded
    ? false
    : statusPending ||
      (formQuery.isLoading && !statusQuery.data?.hasSubmission);
  // The status read has settled, on a mounted client. Holds the invite
  // notice (below) so it does not flash for someone who already applied.
  const statusSettled = hasMounted && !statusPending;

  const viewerSubmission: ViewerSubmission | null = statusQuery.data?.submission
    ? {
        id: statusQuery.data.submission.id,
        status: statusQuery.data.submission.status,
        createdAt: statusQuery.data.submission.createdAt,
        reviewedAt: statusQuery.data.submission.reviewedAt,
        // The organizer's note — non-null only on a REJECTED submission.
        decisionReason: statusQuery.data.submission.decisionReason,
      }
    : null;

  // The PUBLIC output is FLAT ({introText, questions, opensAt, closesAt}) —
  // not the authed proc's { form: {...}, questions }.
  const opensAt = formQuery.data?.opensAt ?? null;
  const closesAt = formQuery.data?.closesAt ?? null;
  // A seeded window is first computed from the SERVER's read time, on the
  // server and on the hydrating render alike, so the two cannot disagree
  // when the cached HTML straddles `opensAt`/`closesAt`. From mount on it is
  // the live clock (a re-render then swaps form ↔ window card if needed).
  const windowNow =
    seed && !hasMounted ? new Date(seed.fetchedAt) : new Date();
  const windowState = resolveWindowState(opensAt, closesAt, windowNow);
  // The formatter has no fixed time zone, so the server (UTC) and the
  // browser would print different times: a seeded label waits for mount,
  // and the card shows its no-date copy until then.
  const opensAtLabel =
    opensAt && (!seeded || hasMounted) ? fmtDate(fmt, opensAt) : null;

  // A withdrawn application mid-"apply again" behaves like no submission:
  // the gate falls through to the form (window permitting).
  // Seeded, the server painted the form, so the hydrating render must too:
  // a submission (from a query cache warmer than the server's) is shown
  // from mount on.
  const displayedSubmission =
    seeded && !hasMounted
      ? null
      : reapplying && viewerSubmission?.status === "WITHDRAWN"
        ? null
        : (viewerSubmission ?? guestSubmission);
  // Withdrawing is an authed call: only offer it on the session's own
  // submission, never on a guest's this-visit result.
  const canWithdraw = Boolean(viewerSubmission) && displayedSubmission !== null;

  // The status view replaces the form in place, so after a send the page was
  // left scrolled to where the contact step ended (MEASURED: the timeline and
  // headline under the navbar at 1440, off-screen at 320) and focus fell to
  // <body> with the unmounted Send button. Bring the page top back and put
  // focus on the headline, which announces the outcome.
  useEffect(() => {
    if (!justSubmitted || !displayedSubmission) return;
    setJustSubmitted(false);
    const page = pageRef.current;
    if (!page) return;
    page.scrollIntoView?.({ block: "start" });
    const headline = page.querySelector<HTMLElement>(
      '[data-testid="application-status"] h2',
    );
    if (headline) {
      headline.setAttribute("tabindex", "-1");
      headline.focus({ preventScroll: true });
    }
  }, [justSubmitted, displayedSubmission]);

  const form: ApplicationFormData | null =
    formQuery.data && formQuery.data.questions
      ? {
          introText: formQuery.data.introText,
          questions: formQuery.data.questions.map((q) => ({
            id: q.id,
            type: q.type,
            label: q.label,
            description: q.description,
            options:
              q.options as ApplicationFormData["questions"][0]["options"],
            isRequired: q.isRequired,
            order: q.order,
          })),
        }
      : null;

  // Optional "sign in to track your application" note — never a gate. It
  // sits on the contact step, beside the address it is about. Session-derived,
  // so behind `hasMounted` (see above).
  const guestNote =
    hasMounted && !isAuthed && !sessionLoading ? (
      <p className="th-appgate__note" data-testid="application-guest-note">
        {String(t("eventDetail.appSignInToTrackBody"))}{" "}
        <NextLinkAnchor
          className="th-appgate__link"
          href={`/sign-in?redirect=${encodeURIComponent(`/events/${slug}`)}`}
          // NextLinkAnchor paints `display:flex; text-decoration:none;
          // color:inherit` INLINE; a caller style is merged over it, and a
          // class cannot win. Inline, underlined, ink — a link in a sentence.
          style={{
            display: "inline",
            color: "var(--color, #211C16)",
            fontWeight: 600,
            textDecorationLine: "underline",
            textDecorationColor: "var(--accent, #E2481D)",
            textDecorationThickness: 2,
            textUnderlineOffset: 3,
          }}
        >
          {String(t("eventDetail.appSignInToTrackCta"))}
        </NextLinkAnchor>
      </p>
    ) : null;

  return (
    <div
      className={
        heroImageUrl ? "th-appgate" : "th-appgate th-appgate--posterless"
      }
      data-testid="application-gate-page"
      ref={pageRef}
    >
      {/* Wide screens: the poster in the rail, where the event page puts it,
          so "View event" changes the column and nothing else. */}
      {heroImageUrl ? (
        <div className="th-appgate__rail">
          <div className="th-appgate__poster">
            <Image
              src={heroImageUrl}
              alt=""
              fill
              sizes="(min-width: 1200px) 440px, (min-width: 900px) 360px, 300px"
              style={{ objectFit: "cover" }}
              priority
            />
          </div>
        </div>
      ) : null}

      <div className="th-appgate__main">
        <header className="th-appgate__head">
          {/* Phones: a compact thumbnail instead of the rail. */}
          {heroImageUrl ? (
            <div className="th-appgate__thumb">
              <Image
                src={heroImageUrl}
                alt=""
                fill
                sizes="56px"
                style={{ objectFit: "cover" }}
              />
            </div>
          ) : null}
          <div className="th-appgate__head-text">
            <Text variant="kicker" tone="muted">
              {String(t("eventDetail.appGateKicker"))}
            </Text>
            <h1 className="th-appgate__title">{title}</h1>
          </div>
        </header>

        {/* The line (a dead or reset invite link) ends "…or apply.": it
            belongs over the form, never over a status card, and is held
            until the status read settles so it does not flash and vanish
            for a viewer who already has an application. */}
        {statusSettled && !isLoading && displayedSubmission === null
          ? notice
          : null}

        {/* FORM-FIRST (spec Phase 3 item 4). There is no anonymous
            short-circuit any more: a guest sees the real form. Signing in is
            an optional affordance on the contact step, not a prerequisite. */}
        <EventApplicationGate
          eventTitle={title}
          isLoading={isLoading}
          viewerSubmission={displayedSubmission}
          form={form}
          windowState={windowState}
          opensAtLabel={opensAtLabel}
          onViewEvent={handleViewEvent}
          onWithdraw={
            canWithdraw ? () => setWithdrawConfirmOpen(true) : undefined
          }
          isWithdrawing={withdrawMutation.isPending}
          onReapply={() => setReapplying(true)}
          renderForm={({ form: formData, eventTitle }) => (
            <EventApplicationGate.Form
              eventTitle={eventTitle}
              form={formData}
              answers={answers}
              contactEmail={contactEmail}
              contactPhone={contactPhone}
              isSubmitting={submitMutation.isPending}
              error={error}
              contactErrors={{
                email: fieldErrors.contactEmail,
                phone: fieldErrors.contactPhone,
              }}
              onAnswerChange={handleAnswerChange}
              onContactEmailChange={handleContactEmailChange}
              onContactPhoneChange={handleContactPhoneChange}
              onSubmit={handleSubmit}
              contactNote={guestNote}
              // Turnstile is enforced server-side for UNAUTHENTICATED
              // submitters only, so the widget renders only for guests —
              // and only when a site key is actually configured.
              verificationSlot={
                needsTurnstile ? (
                  <YStack
                    gap="$2"
                    alignItems="flex-start"
                    data-testid="application-turnstile"
                  >
                    <Turnstile
                      ref={turnstileRef}
                      siteKey={TURNSTILE_SITE_KEY}
                      // The fixed 300px `normal` widget is wider than the
                      // 288px column on a 320px phone. Chosen once, at
                      // mount: `size` is in the library's render memo, so
                      // changing it later would throw away a token.
                      options={{ theme: "light", size: turnstileSize }}
                      onSuccess={setTurnstileToken}
                      onExpire={() => setTurnstileToken(null)}
                      onError={() => setTurnstileToken(null)}
                    />
                    {!turnstileToken && (
                      <Text variant="caption" tone="muted">
                        {String(t("eventDetail.appVerifyToContinue"))}
                      </Text>
                    )}
                  </YStack>
                ) : null
              }
              submitDisabled={needsTurnstile && !turnstileToken}
            />
          )}
        />

        {waitlistsGateOn && waitlistOpen && (
          <YStack width="100%" maxWidth={480}>
            <WaitlistJoinForm
              eventId={eventId}
              description={waitlistDescription}
            />
          </YStack>
        )}
      </div>

      <ConfirmDialog
        open={withdrawConfirmOpen}
        onConfirm={handleWithdrawConfirm}
        onCancel={() => setWithdrawConfirmOpen(false)}
        title={String(t("eventDetail.appWithdrawConfirmTitle"))}
        description={String(t("eventDetail.appWithdrawConfirmBody"))}
        confirmLabel={String(t("eventDetail.appWithdrawConfirmCta"))}
        cancelLabel={String(t("common.cancel"))}
        tone="danger"
        loading={withdrawMutation.isPending}
      />
    </div>
  );
};

EventApplicationGateWrapper.displayName = "EventApplicationGateWrapper";
