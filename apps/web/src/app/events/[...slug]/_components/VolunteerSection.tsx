"use client";

import { useMemo, useState } from "react";
import { YStack, XStack, Card, styled } from "tamagui";
import {
  Clock,
  Check,
  AlertCircle,
  CircleCheck,
  CircleDashed,
  CircleX,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  Badge,
  BottomSheet,
  Button,
  Text,
  TextInput,
  useTranslations,
  useFormatters,
} from "@th/ui";
import type { EventStatus } from "@th/types";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { getAppErrorCode } from "@/lib/app-error";
import { AddToCalendarButton } from "@/components/volunteering/AddToCalendarButton";
import { SmsLegalLinks } from "@/components/notifications/SmsLegalLinks";
import {
  SignupSmsToggle,
  TapTargetCheckbox,
  isSmsRequiresUsPhone,
} from "@/components/volunteering/SignupSmsToggle";

import {
  buildApplyResult,
  eventPickReminderAnchor,
  isCapacityFull,
  shouldHideVolunteerSection,
  shouldRetryVolunteerRolesQuery,
  type ApplyResult,
  type EventPickReminderAnchor,
  type VolunteerSignupStatus,
} from "./volunteer-section.helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type VolunteerShift = {
  id: string;
  label: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  capacity: number | null;
  sortOrder: number;
  signupCount: number;
  /** APPROVED | CHECKED_IN only — the count that capacity governs. */
  acceptedCount: number;
};

type VolunteerRole = {
  id: string;
  name: string;
  description: string | null;
  capacity: number | null;
  sortOrder: number;
  signupCount: number;
  /** See `VolunteerShift.acceptedCount`. */
  acceptedCount: number;
  shifts: VolunteerShift[];
};

type ExistingSignup = {
  signupId: string;
  status: VolunteerSignupStatus;
  /** Per-signup SMS reminder consent (Gap 6) — toggleable in place. */
  smsOptIn: boolean;
  /** SMS toggle only renders when the signup captured a phone. */
  hasPhone: boolean;
  /**
   * Shift-bound signups have a time window, so the per-signup .ics
   * download (AddToCalendarButton) is only offered for them.
   */
  hasShift: boolean;
  /**
   * What reminds this signup: its shift, the event start (a role with no
   * shifts), or nothing. Texts can only be switched ON when it has one.
   */
  reminderAnchor: EventPickReminderAnchor | null;
};

export type VolunteerSectionProps = {
  eventId: string;
  /**
   * Event status — the section is hidden unless the event is PUBLISHED.
   * Matches the server-side gate in `listPublicEventVolunteerRoles`.
   */
  eventStatus?: EventStatus;
  /**
   * Event end time. Events in the past hide the section client-side even
   * though the server would still return roles.
   */
  eventEndsAt?: Date | string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Selection-key helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeKey = (roleId: string, shiftId: string | null): string =>
  `${roleId}::${shiftId ?? ""}`;

const parseKey = (key: string): { roleId: string; shiftId: string | null } => {
  const [roleId, shiftPart] = key.split("::", 2);
  return { roleId: roleId ?? "", shiftId: shiftPart ? shiftPart : null };
};

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

const dateBucketKey = (value: Date | string): string => {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "tba";
  // Use the viewer's local date — toISOString() uses UTC which splits
  // late-night shifts into the next day, fragmenting "all on April 30" into
  // two date buckets.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const RoleCard = styled(Card, {
  padding: "$4",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  gap: "$3",
});

const ShiftRow = styled(YStack, {
  padding: "$3",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  gap: "$2",
});

const DisclosureToggle = styled(XStack, {
  cursor: "pointer",
  paddingVertical: "$2",
  alignItems: "center",
  gap: "$2",
  // Touch surface: keep the disclosure comfortably tappable on phones.
  minHeight: 44,
  hoverStyle: { opacity: 0.7 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function VolunteerSection({
  eventId,
  eventStatus,
  eventEndsAt,
}: VolunteerSectionProps) {
  const t = useTranslations();
  // No SMS provider configured → nothing is ever texted, so the text-reminder
  // opt-ins are not offered. Fail-closed: only an explicit `sms === true`
  // shows them; they return on their own when SMS is switched on.
  const { gates } = useFeatureGates();
  const smsAvailable = gates?.sms === true;
  const session = authClient.useSession();
  const sessionUser = session.data?.user;
  const isSignedIn = Boolean(sessionUser);

  const hidePreQuery = useMemo(
    () => shouldHideVolunteerSection(eventStatus, eventEndsAt),
    [eventEndsAt, eventStatus],
  );

  const rolesQuery = trpc.volunteer.publicRoles.list.useQuery(
    { eventId },
    {
      enabled: !hidePreQuery,
      staleTime: 30_000,
      // `volunteer-open-sheet-btn` is gated on this query: with `retry: false`
      // one transient failure (API restart, venue wifi blip) hid the CTA
      // for the whole session — observed during a live event (Gap 8).
      // Retry transient errors; never retry the expected NOT_FOUND that
      // means "volunteering is off for this event".
      retry: shouldRetryVolunteerRolesQuery,
      // Server returns `not_found` when the event has volunteering
      // disabled — it intentionally collapses the visibility gate into a
      // single shape so we can't leak whether a draft event exists. That
      // makes the 404 expected-noise from the client's perspective: the
      // section just renders null. Silence the global query-error logger
      // so users don't see a "something went wrong" toast for what is in
      // fact a feature being off.
      meta: { silent: true },
    },
  );

  const mineQuery = trpc.volunteer.signups.listMine.useQuery(undefined, {
    enabled: !hidePreQuery && isSignedIn,
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  // Waiver gate metadata (Gap 3). Same visibility gate / NOT_FOUND collapse
  // as the roles query, so the same enabled/retry/silent treatment applies.
  // `alreadyAccepted` is computed server-side for the signed-in actor and is
  // always false for guests.
  const waiverQuery = trpc.volunteer.publicRoles.waiver.useQuery(
    { eventId },
    {
      enabled: !hidePreQuery,
      staleTime: 30_000,
      retry: shouldRetryVolunteerRolesQuery,
      meta: { silent: true },
    },
  );

  // Map of `${roleId}::${shiftId|""}` → { signupId, status } for the current user.
  // Withdrawn signups are skipped so users can re-apply.
  const existingByKey = useMemo(() => {
    const map = new Map<string, ExistingSignup>();
    if (!mineQuery.data) return map;
    const roles = rolesQuery.data?.roles ?? [];
    for (const s of mineQuery.data) {
      if (s.eventId !== eventId) continue;
      if (s.status === "WITHDRAWN") continue;
      map.set(makeKey(s.roleId, s.shiftId), {
        signupId: s.id,
        status: s.status as VolunteerSignupStatus,
        smsOptIn: s.smsOptIn === true,
        hasPhone: Boolean(s.contactPhone?.trim()),
        hasShift: Boolean(s.shiftId),
        reminderAnchor: eventPickReminderAnchor(
          { roleId: s.roleId, shiftId: s.shiftId ?? null },
          roles,
        ),
      });
    }
    return map;
  }, [eventId, mineQuery.data, rolesQuery.data]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [showDetails, setShowDetails] = useState(false);

  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [phone, setPhone] = useState("");
  /**
   * TCPA opt-in for SMS shift reminders. Default false. Only relevant when
   * `phone` is non-empty — the checkbox renders below the phone field
   * conditionally so we don't pollute the form for volunteers who skipped it.
   */
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [note, setNote] = useState("");
  /**
   * Affirmative volunteer-waiver acceptance (Gap 3). Only meaningful while
   * the waiver gate is active — APPLY stays disabled until checked, and the
   * flag is forwarded as `waiverAccepted: true` on every submit call.
   */
  const [waiverAccepted, setWaiverAccepted] = useState(false);

  const [submitState, setSubmitState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "error"; message: string }
    | { kind: "done"; results: ApplyResult[]; smsMayNeedStart: boolean }
  >({ kind: "idle" });

  const submit = trpc.volunteer.signups.submit.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const withdraw = trpc.volunteer.signups.withdraw.useMutation({
    retry: false,
    meta: { silent: true },
  });

  if (hidePreQuery) return null;
  if (rolesQuery.isLoading) return null;
  if (rolesQuery.isError) return null;
  const data = rolesQuery.data;
  if (!data || data.roles.length === 0) return null;

  const introText = data.introText;

  // The waiver gate is active when the event requires a waiver, a template
  // resolved server-side, and the signed-in viewer has no current acceptance
  // on file. While the (silent, retried) waiver query is still loading or
  // failed transiently the gate renders nothing — a premature submit is then
  // caught server-side and surfaced via the `waiver_required` mapping below.
  const waiverData = waiverQuery.data;
  const waiverGateActive = Boolean(
    waiverData?.waiverRequired &&
    waiverData.waiver &&
    !waiverData.alreadyAccepted,
  );

  // Full shifts/roles stay selectable on purpose: capacity governs
  // acceptance, not application. Applying to a full shift lands the signup
  // in PENDING as a natural waitlist (Gap 1, 2026-06-10).
  // What reminds a signup made from this pick (null: nothing does).
  const pickAnchor = (key: string) =>
    eventPickReminderAnchor(parseKey(key), data.roles);

  const toggle = (key: string) => {
    const next = new Set(selection);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelection(next);
    // With nothing remindable picked the text box is hidden; clear its tick
    // so picking one again shows it unticked rather than carrying a hidden
    // consent.
    if (!Array.from(next).some((k) => pickAnchor(k) !== null)) {
      setSmsOptIn(false);
    }
  };

  const resetForm = () => {
    setSelection(new Set());
    setPhone("");
    setSmsOptIn(false);
    setNote("");
    setWaiverAccepted(false);
    setShowDetails(false);
    setSubmitState({ kind: "idle" });
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setTimeout(resetForm, 250);
  };

  const handleApply = async () => {
    const keys = Array.from(selection);
    if (keys.length === 0) return;

    const trimmedName = isSignedIn
      ? (sessionUser?.name?.trim() ?? "")
      : guestName.trim();
    const trimmedEmail = isSignedIn
      ? (sessionUser?.email?.trim() ?? "")
      : guestEmail.trim();

    if (!trimmedEmail) {
      setSubmitState({
        kind: "error",
        message: String(t("eventDetail.volunteerErrorEmailRequired")),
      });
      return;
    }

    setSubmitState({ kind: "submitting" });

    const trimmedPhone = phone.trim() || undefined;
    const trimmedNote = note.trim();
    const answers = trimmedNote ? { note: trimmedNote } : undefined;

    // Only propagate opt-in when a phone was actually provided, and only on
    // a signup that is reminded (a shift, or a role with no shifts): any
    // other signup never gets a reminder, so recording consent on it would
    // promise a text that never comes.
    const sentSmsOptIn = keys.map((key) =>
      Boolean(
        trimmedPhone && smsAvailable && pickAnchor(key) !== null && smsOptIn,
      ),
    );

    const settled = await Promise.allSettled(
      keys.map((key, i) => {
        const { roleId, shiftId } = parseKey(key);
        return submit.mutateAsync({
          eventId,
          roleId,
          shiftId: shiftId ?? undefined,
          contactEmail: trimmedEmail,
          contactName: trimmedName || undefined,
          contactPhone: trimmedPhone,
          smsOptIn: sentSmsOptIn[i] ?? false,
          answers,
          // Only sent while the waiver gate is active — the footer keeps
          // APPLY disabled until the checkbox is ticked, so reaching this
          // line with the gate up implies an affirmative acceptance. When
          // an acceptance is already on file the server needs nothing.
          ...(waiverGateActive ? { waiverAccepted: true } : {}),
        });
      }),
    );

    const results: ApplyResult[] = keys.map((key, i) => {
      const { roleId, shiftId } = parseKey(key);
      const role = data.roles.find((x) => x.id === roleId);
      const shift = shiftId ? role?.shifts.find((s) => s.id === shiftId) : null;
      const labelParts = [role?.name ?? "—"];
      if (shift?.label) labelParts.push(shift.label);
      return buildApplyResult({
        key,
        label: labelParts.join(" · "),
        settled: settled[i],
        // Fullness at submit time, from the roles snapshot the user acted
        // on: the shift when one was picked, otherwise the shiftless role.
        targetWasFull: isCapacityFull(shiftId ? shift : role),
        mapError: (reason) => mapSubmitError(reason, t),
      });
    });

    await Promise.all([
      rolesQuery.refetch(),
      isSignedIn ? mineQuery.refetch() : Promise.resolve(),
      // Signed-in volunteers who just accepted flip to "already on file";
      // for guests the server can't attribute the acceptance to the
      // session, so the refetch is a harmless no-op.
      waiverGateActive ? waiverQuery.refetch() : Promise.resolve(),
    ]);

    // The server's START hint is static (it never says whether the number
    // replied STOP), and only means something where this submit consented.
    const smsMayNeedStart = settled.some(
      (r, i) =>
        sentSmsOptIn[i] === true &&
        r.status === "fulfilled" &&
        r.value.smsMayNeedStart === true,
    );

    setSubmitState({ kind: "done", results, smsMayNeedStart });
    setSelection(new Set());
  };

  const handleWithdraw = async (signupId: string) => {
    if (!isSignedIn) return;
    try {
      await withdraw.mutateAsync({ signupId });
      await Promise.all([rolesQuery.refetch(), mineQuery.refetch()]);
    } catch (error) {
      // Surface a transient error toast in the future; for now log so the
      // failure isn't invisible while the badge UI recovers state.
      console.error("[volunteer] withdraw failed", { signupId, error });
    }
  };

  const selectedCount = selection.size;
  // The opt-in is offered only when a picked item is reminded: a shift
  // (before the shift) or a role with no shifts (before the event starts).
  // The label names what the picks are reminded of, so a volunteer on a
  // shiftless role is never told about "my shift".
  const pickedAnchors = new Set(
    Array.from(selection)
      .map(pickAnchor)
      .filter((a): a is EventPickReminderAnchor => a !== null),
  );
  const selectionIsReminded = pickedAnchors.size > 0;
  const smsOptInLabelKey = pickedAnchors.has("SHIFT")
    ? pickedAnchors.has("EVENT_START")
      ? "eventDetail.volunteerSmsOptInLabelMixed"
      : "eventDetail.volunteerSmsOptInLabel"
    : "eventDetail.volunteerSmsOptInLabelEventStart";
  const showSuccess = submitState.kind === "done";

  return (
    <>
      {/* The section's only trigger. Until 2026-08-27 the sheet could ONLY be
          opened from the floating action bar, so removing that bar would have
          made volunteering unreachable. */}
      <YStack gap="$3" paddingVertical="$4">
        <Text variant="h3">{t("eventDetail.volunteerSectionTitle")}</Text>
        <Text variant="body" tone="muted">
          {t("eventDetail.volunteerSectionSubtitle")}
        </Text>
        <Button
          variant="secondary"
          size="$4"
          alignSelf="flex-start"
          onPress={() => setSheetOpen(true)}
          data-testid="volunteer-open-sheet-btn"
        >
          {t("pageActions.volunteer")}
        </Button>
      </YStack>
      <BottomSheet open={sheetOpen} onClose={closeSheet}>
        <BottomSheet.Panel maxHeightVh={85}>
          <BottomSheet.Header
            title={String(t("eventDetail.volunteerSectionTitle"))}
            subtitle={String(t("eventDetail.volunteerSectionSubtitle"))}
            onClose={closeSheet}
          />
          <BottomSheet.Body>
            {introText && (
              <Text variant="body" tone="muted">
                {introText}
              </Text>
            )}

            {showSuccess ? (
              <SuccessSummary
                results={submitState.results}
                smsMayNeedStart={submitState.smsMayNeedStart}
                signedIn={isSignedIn}
                onClose={closeSheet}
              />
            ) : (
              <>
                <YStack gap="$3">
                  {data.roles.map((role) => (
                    <RoleCardView
                      key={role.id}
                      role={role as VolunteerRole}
                      selection={selection}
                      existingByKey={existingByKey}
                      onToggle={toggle}
                      onWithdraw={isSignedIn ? handleWithdraw : undefined}
                      withdrawPending={withdraw.isPending}
                    />
                  ))}
                </YStack>

                <YStack
                  gap="$3"
                  paddingTop="$4"
                  borderTopWidth={2}
                  borderTopColor="$borderColor"
                  // th-no-zoom (globals.css) forces a 16px font on every
                  // <input>/<textarea> below — iOS Safari auto-zooms inputs
                  // with smaller text, wrecking the sheet, and Tamagui drops
                  // both `fontSize` and `style` props at these call sites.
                  className="th-no-zoom"
                >
                  {isSignedIn ? (
                    <SignedInIdentity
                      name={sessionUser?.name ?? null}
                      email={sessionUser?.email ?? ""}
                    />
                  ) : (
                    <GuestIdentityFields
                      name={guestName}
                      email={guestEmail}
                      onNameChange={setGuestName}
                      onEmailChange={setGuestEmail}
                    />
                  )}

                  <DisclosureToggle
                    onPress={() => setShowDetails((v) => !v)}
                    role="button"
                    aria-expanded={showDetails}
                    aria-controls="volunteer-extra-details"
                  >
                    {showDetails ? (
                      <ChevronUp size={14} color="var(--color)" />
                    ) : (
                      <ChevronDown size={14} color="var(--color)" />
                    )}
                    <Text variant="bodySmall" weight="bold">
                      {String(t("eventDetail.volunteerAddDetails"))}
                    </Text>
                  </DisclosureToggle>

                  {showDetails && (
                    <YStack gap="$3" id="volunteer-extra-details">
                      <FieldBlock
                        label={String(t("eventDetail.volunteerFieldPhone"))}
                        optional
                      >
                        <TextInput
                          value={phone}
                          onChangeText={setPhone}
                          fullWidth
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          enterKeyHint="next"
                          // 44px height: iOS tap-target floor. The 16px
                          // anti-zoom font comes from the th-no-zoom wrapper.
                          minHeight={44}
                          aria-label={String(
                            t("eventDetail.volunteerFieldPhone"),
                          )}
                        />
                      </FieldBlock>

                      {/* SMS opt-in. Only shown when a phone is present —
                        a checkbox without a phone to text is just noise,
                        and the server refuses SMS dispatch without one
                        regardless. TCPA wants an affirmative opt-in,
                        which is exactly what this checkbox represents. */}
                      {smsAvailable &&
                      selectionIsReminded &&
                      phone.trim().length > 0 ? (
                        <TapTargetCheckbox
                          id="volunteer-sms-opt-in"
                          checked={smsOptIn}
                          onCheckedChange={(next) => setSmsOptIn(next === true)}
                          label={String(t(smsOptInLabelKey))}
                          // TCPA / CTIA boilerplate carriers expect:
                          // identify sender + frequency + msg-rate
                          // disclaimer + STOP/HELP keywords (kept in
                          // English in every locale — carriers only match
                          // the English keywords). The opt-in is persisted
                          // server-side on the signup row with the
                          // timestamp implicit via createdAt.
                          description={
                            <>
                              {String(
                                t("eventDetail.volunteerSmsOptInDescription"),
                              )}{" "}
                              <SmsLegalLinks />
                            </>
                          }
                          testIdBase="volunteer-sms-opt-in"
                        />
                      ) : null}

                      <FieldBlock
                        label={String(t("eventDetail.volunteerFieldNote"))}
                        optional
                      >
                        <TextInput
                          value={note}
                          onChangeText={setNote}
                          fullWidth
                          multiline
                          numberOfLines={2}
                          enterKeyHint="done"
                          minHeight={44}
                          aria-label={String(
                            t("eventDetail.volunteerFieldNote"),
                          )}
                        />
                      </FieldBlock>
                    </YStack>
                  )}

                  {/* Volunteer waiver (Gap 3). Rendered between the identity
                    fields and the submit footer. With a current acceptance
                    on file we show a compact confirmation instead of
                    re-prompting; otherwise the legal text + an affirmative
                    checkbox that gates APPLY. */}
                  {waiverData?.waiverRequired && waiverData.waiver ? (
                    waiverData.alreadyAccepted ? (
                      <XStack
                        gap="$2"
                        alignItems="center"
                        data-testid="volunteer-waiver-on-file"
                      >
                        <CircleCheck
                          size={16}
                          color="var(--success, #166534)"
                        />
                        <Text variant="bodySmall" tone="muted">
                          {String(t("eventDetail.volunteerWaiverOnFile"))}
                        </Text>
                      </XStack>
                    ) : (
                      <YStack gap="$2" data-testid="volunteer-waiver-block">
                        <Text variant="bodySmall" weight="bold">
                          {waiverData.waiver.title}
                        </Text>
                        {/* Scrollable legal text. Plain div (web-only surface)
                          so the region can take tabIndex for keyboard
                          scrolling — mirrors the checkout waiver block. */}
                        <div
                          role="region"
                          aria-label={waiverData.waiver.title}
                          tabIndex={0}
                          data-testid="volunteer-waiver-body"
                          style={{
                            // Cap relative to the *visible* viewport too:
                            // with the keyboard open (~500px vvp) a fixed
                            // 200px nested scroll region swallowed nearly
                            // all touch scrolling in the sheet body.
                            maxHeight: "min(200px, 35vh)",
                            overflowY: "auto",
                            padding: "12px 14px",
                            border: "1px solid var(--borderColor, #211C16)",
                            borderRadius: 0,
                            whiteSpace: "pre-wrap",
                            fontSize: 13,
                            lineHeight: 1.6,
                            color: "var(--colorMuted, #5C544A)",
                          }}
                        >
                          {waiverData.waiver.body}
                        </div>
                        <TapTargetCheckbox
                          id="volunteer-waiver-accept"
                          checked={waiverAccepted}
                          onCheckedChange={(next) =>
                            setWaiverAccepted(next === true)
                          }
                          label={String(
                            t("eventDetail.volunteerWaiverAgreeLabel"),
                          )}
                          testIdBase="volunteer-waiver-accept"
                        />
                      </YStack>
                    )
                  ) : null}

                  {submitState.kind === "error" && (
                    <XStack
                      gap="$2"
                      alignItems="center"
                      padding="$3"
                      borderWidth={1}
                      borderColor="$danger"
                      borderRadius={0}
                      role="alert"
                      aria-live="assertive"
                      aria-atomic="true"
                    >
                      <AlertCircle size={16} color="var(--danger, #B91C1C)" />
                      <Text variant="bodySmall" tone="error">
                        {submitState.message}
                      </Text>
                    </XStack>
                  )}
                </YStack>
              </>
            )}
          </BottomSheet.Body>

          {!showSuccess && (
            <BottomSheet.Footer>
              <XStack
                flex={1}
                alignItems="center"
                justifyContent="space-between"
                gap="$3"
                flexWrap="wrap"
              >
                <Text variant="bodySmall" tone="muted">
                  {selectedCount === 0
                    ? String(t("eventDetail.volunteerSelectionNone"))
                    : `${selectedCount} ${
                        selectedCount === 1
                          ? String(t("eventDetail.volunteerSelectionOne"))
                          : String(t("eventDetail.volunteerSelectionMany"))
                      }`}
                </Text>
                <XStack gap="$2">
                  <Button
                    variant="secondary"
                    size="$3"
                    minHeight={44}
                    onPress={closeSheet}
                  >
                    {String(t("common.back"))}
                  </Button>
                  <Button
                    variant="primary"
                    size="$3"
                    minHeight={44}
                    onPress={() => {
                      void handleApply();
                    }}
                    disabled={
                      selectedCount === 0 ||
                      submitState.kind === "submitting" ||
                      (waiverGateActive && !waiverAccepted)
                    }
                    data-testid="volunteer-apply-button"
                  >
                    {submitState.kind === "submitting"
                      ? String(t("common.loading"))
                      : selectedCount === 0
                        ? String(t("eventDetail.volunteerApplyEmpty"))
                        : String(t("eventDetail.volunteerApplyCta"))}
                  </Button>
                </XStack>
              </XStack>
            </BottomSheet.Footer>
          )}
        </BottomSheet.Panel>
      </BottomSheet>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Role card
// ─────────────────────────────────────────────────────────────────────────────

type RoleCardViewProps = {
  role: VolunteerRole;
  selection: Set<string>;
  existingByKey: Map<string, ExistingSignup>;
  onToggle: (key: string) => void;
  onWithdraw?: (signupId: string) => Promise<void>;
  withdrawPending: boolean;
};

function RoleCardView({
  role,
  selection,
  existingByKey,
  onToggle,
  onWithdraw,
  withdrawPending,
}: RoleCardViewProps) {
  const t = useTranslations();
  const fmt = useFormatters();

  const roleFull = isCapacityFull(role);
  const hasShifts = role.shifts.length > 0;
  const roleKey = makeKey(role.id, null);
  const roleExisting = !hasShifts ? existingByKey.get(roleKey) : undefined;
  const roleSelected = !hasShifts && selection.has(roleKey);

  // Group shifts by date (YYYY-MM-DD) so multi-day events are easier to scan.
  // We only render the date heading when there is more than one bucket — for
  // single-day events the heading would be redundant.
  const grouped = useMemo(() => {
    const buckets = new Map<string, VolunteerShift[]>();
    const sorted = [...role.shifts].sort((a, b) => {
      const ta = toDate(a.startsAt).getTime();
      const tb = toDate(b.startsAt).getTime();
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });
    for (const shift of sorted) {
      const k = dateBucketKey(shift.startsAt);
      const arr = buckets.get(k) ?? [];
      arr.push(shift);
      buckets.set(k, arr);
    }
    return Array.from(buckets.entries());
  }, [role.shifts]);

  return (
    <RoleCard>
      <XStack
        justifyContent="space-between"
        alignItems="flex-start"
        gap="$3"
        flexWrap="wrap"
      >
        <YStack gap="$1" flex={1} minWidth={200}>
          <Text variant="subtitle" weight="bold">
            {role.name}
          </Text>
          {role.description && (
            <Text variant="bodySmall" tone="muted">
              {role.description}
            </Text>
          )}
        </YStack>
        <CapacityBadge
          acceptedCount={role.acceptedCount}
          capacity={role.capacity}
        />
      </XStack>

      {hasShifts ? (
        <YStack gap="$3">
          {grouped.map(([bucket, shifts], idx) => (
            <YStack key={bucket} gap="$2">
              {grouped.length > 1 && shifts[0] ? (
                <Text variant="caption" weight="bold" tone="muted">
                  {Number.isNaN(toDate(shifts[0].startsAt).getTime())
                    ? String(t("eventDetail.volunteerShiftDateTba"))
                    : fmt.dateTime(toDate(shifts[0].startsAt), {
                        dateStyle: "full",
                      })}
                </Text>
              ) : null}
              {shifts.map((shift) => {
                const key = makeKey(role.id, shift.id);
                const existing = existingByKey.get(key);
                const checked = selection.has(key);
                const full = isCapacityFull(shift);
                return (
                  <ShiftRowView
                    key={shift.id}
                    shift={shift}
                    existing={existing}
                    checked={checked}
                    full={full}
                    onToggle={() => onToggle(key)}
                    onWithdraw={onWithdraw}
                    withdrawPending={withdrawPending}
                    fmt={fmt}
                    t={t}
                    checkboxId={`volunteer-shift-${shift.id}`}
                  />
                );
              })}
              {idx < grouped.length - 1 ? null : null}
            </YStack>
          ))}
        </YStack>
      ) : (
        <XStack
          justifyContent="flex-end"
          alignItems="center"
          gap="$2"
          flexWrap="wrap"
          minWidth={0}
          maxWidth="100%"
        >
          {roleExisting ? (
            <ExistingStatusRow
              existing={roleExisting}
              onWithdraw={onWithdraw}
              withdrawPending={withdrawPending}
            />
          ) : (
            <TapTargetCheckbox
              id={`volunteer-role-${role.id}`}
              testIdBase={`volunteer-role-${role.id}`}
              size="lg"
              checked={roleSelected}
              onCheckedChange={() => onToggle(roleKey)}
              label={
                roleFull
                  ? String(t("eventDetail.volunteerFullWaitlist"))
                  : String(t("eventDetail.volunteerSelectCta"))
              }
            />
          )}
        </XStack>
      )}
    </RoleCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shift row
// ─────────────────────────────────────────────────────────────────────────────

type ShiftRowViewProps = {
  shift: VolunteerShift;
  existing: ExistingSignup | undefined;
  checked: boolean;
  full: boolean;
  onToggle: () => void;
  onWithdraw?: (signupId: string) => Promise<void>;
  withdrawPending: boolean;
  fmt: ReturnType<typeof useFormatters>;
  t: ReturnType<typeof useTranslations>;
  checkboxId: string;
};

function ShiftRowView({
  shift,
  existing,
  checked,
  full,
  onToggle,
  onWithdraw,
  withdrawPending,
  fmt,
  t,
  checkboxId,
}: ShiftRowViewProps) {
  const starts = toDate(shift.startsAt);
  const ends = toDate(shift.endsAt);

  const startLabel = Number.isNaN(starts.getTime())
    ? ""
    : fmt.dateTime(starts, { timeStyle: "short" });
  const endLabel = Number.isNaN(ends.getTime())
    ? ""
    : fmt.dateTime(ends, { timeStyle: "short" });

  return (
    <ShiftRow>
      <XStack
        gap="$3"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        <XStack gap="$2" alignItems="center" flex={1} minWidth={200}>
          <Clock size={14} color="var(--colorMuted)" aria-hidden />
          <YStack gap="$1">
            {shift.label && (
              <Text variant="bodySmall" weight="bold">
                {shift.label}
              </Text>
            )}
            <Text variant="caption" tone="muted">
              {startLabel}
              {endLabel ? ` – ${endLabel}` : ""}
            </Text>
          </YStack>
        </XStack>

        {/* Right cluster: badge + status/withdraw/SMS or the select
            checkbox. Must be able to shrink and wrap inside narrow
            sheets — without minWidth 0 this cluster forced the row to
            ~450px at 390px viewports and panned the sheet sideways. */}
        <XStack
          gap="$3"
          alignItems="center"
          flexWrap="wrap"
          justifyContent="flex-end"
          flexShrink={1}
          minWidth={0}
          maxWidth="100%"
        >
          <CapacityBadge
            acceptedCount={shift.acceptedCount}
            capacity={shift.capacity}
            compact
          />
          {existing ? (
            <ExistingStatusRow
              existing={existing}
              onWithdraw={onWithdraw}
              withdrawPending={withdrawPending}
            />
          ) : (
            <TapTargetCheckbox
              id={checkboxId}
              testIdBase={checkboxId}
              size="lg"
              checked={checked}
              onCheckedChange={onToggle}
              label={
                full
                  ? String(t("eventDetail.volunteerFullWaitlist"))
                  : String(t("eventDetail.volunteerSelectCta"))
              }
            />
          )}
        </XStack>
      </XStack>
    </ShiftRow>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing-status badge + withdraw control
// ─────────────────────────────────────────────────────────────────────────────

function ExistingStatusRow({
  existing,
  onWithdraw,
  withdrawPending,
}: {
  existing: ExistingSignup;
  onWithdraw?: (signupId: string) => Promise<void>;
  withdrawPending: boolean;
}) {
  const t = useTranslations();
  const utils = trpc.useUtils();

  // Withdrawing a CHECKED_IN signup is meaningless and the use case rejects
  // anything past the approval gate after teardown anyway.
  const canWithdraw =
    Boolean(onWithdraw) &&
    (existing.status === "PENDING" || existing.status === "APPROVED");

  return (
    // The whole status cluster must shrink and wrap inside narrow sheets —
    // its children (badge + withdraw + SMS toggle + STOP caption) used to
    // refuse to shrink and pushed the sheet body to ~450px at 390px wide.
    <YStack
      gap="$2"
      alignItems="flex-end"
      flexShrink={1}
      minWidth={0}
      maxWidth="100%"
    >
      <XStack
        gap="$2"
        alignItems="center"
        flexWrap="wrap"
        justifyContent="flex-end"
        minWidth={0}
        maxWidth="100%"
      >
        <ExistingStatusBadge status={existing.status} />
        {canWithdraw && onWithdraw ? (
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            disabled={withdrawPending}
            onPress={() => {
              void onWithdraw(existing.signupId);
            }}
            data-testid={`volunteer-withdraw-${existing.signupId}`}
          >
            {String(t("eventDetail.volunteerWithdrawCta"))}
          </Button>
        ) : null}
      </XStack>
      {/* Per-signup texts switch (shared with /my-volunteering). Live
          while reminders can still fire; revoke-only when SMS is off or
          nothing reminds this signup (a role-level signup on a role that
          has shifts). */}
      <SignupSmsToggle
        signupId={existing.signupId}
        smsOptIn={existing.smsOptIn}
        remindersOffered={existing.reminderAnchor !== null}
        hasPhone={existing.hasPhone}
        live={existing.status === "PENDING" || existing.status === "APPROVED"}
        labelKey={
          existing.reminderAnchor === "EVENT_START"
            ? "eventDetail.volunteerSmsToggleLabelEventStart"
            : "eventDetail.volunteerSmsToggleLabel"
        }
        onSettled={() => void utils.volunteer.signups.listMine.invalidate()}
      />
      {/* Calendar export (FR-012): only accepted, shift-bound signups have
          a time window to export. Feed subscribe rides along in the same
          control. */}
      {existing.hasShift &&
      (existing.status === "APPROVED" || existing.status === "CHECKED_IN") ? (
        <AddToCalendarButton signupId={existing.signupId} compact />
      ) : null}
    </YStack>
  );
}

function ExistingStatusBadge({ status }: { status: VolunteerSignupStatus }) {
  const t = useTranslations();

  switch (status) {
    case "APPROVED":
    case "CHECKED_IN":
      return (
        <XStack gap="$2" alignItems="center" aria-live="polite">
          <CircleCheck size={16} color="var(--success, #166534)" />
          <Text variant="bodySmall" weight="bold">
            {String(t("eventDetail.volunteerStatusApproved"))}
          </Text>
        </XStack>
      );
    case "PENDING":
      return (
        <XStack gap="$2" alignItems="center" aria-live="polite">
          <CircleDashed size={16} color="var(--info, #211C16)" />
          <Text variant="bodySmall" weight="bold">
            {String(t("eventDetail.volunteerStatusPending"))}
          </Text>
        </XStack>
      );
    case "REJECTED":
      return (
        <XStack gap="$2" alignItems="center" aria-live="polite">
          <CircleX size={16} color="var(--danger, #B91C1C)" />
          <Text variant="bodySmall" weight="bold">
            {String(t("eventDetail.volunteerStatusRejected"))}
          </Text>
        </XStack>
      );
    case "WITHDRAWN":
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacity badge
// ─────────────────────────────────────────────────────────────────────────────

function CapacityBadge({
  acceptedCount,
  capacity,
  compact = false,
}: {
  /** Accepted (APPROVED | CHECKED_IN) signups — pending never counts. */
  acceptedCount: number;
  capacity: number | null;
  compact?: boolean;
}) {
  const t = useTranslations();

  if (capacity == null) {
    return (
      <Badge tone="info" size={compact ? "sm" : "md"}>
        {String(t("eventDetail.volunteerSpotsOpen"))}
      </Badge>
    );
  }
  const full = acceptedCount >= capacity;
  if (full) {
    return (
      <Badge tone="warning" size={compact ? "sm" : "md"}>
        {String(t("eventDetail.volunteerSpotsFull"))}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" size={compact ? "sm" : "md"}>
      {`${acceptedCount} / ${capacity}`}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity views
// ─────────────────────────────────────────────────────────────────────────────

function SignedInIdentity({
  name,
  email,
}: {
  name: string | null;
  email: string;
}) {
  const t = useTranslations();
  return (
    <XStack
      gap="$3"
      alignItems="center"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      borderRadius={0}
    >
      <Check size={16} color="var(--success, #166534)" />
      <YStack gap="$1" flex={1}>
        <Text variant="caption" tone="muted">
          {String(t("eventDetail.volunteerSubmittingAs"))}
        </Text>
        <Text variant="bodySmall" weight="bold">
          {name ? `${name} · ${email}` : email}
        </Text>
      </YStack>
    </XStack>
  );
}

function GuestIdentityFields({
  name,
  email,
  onNameChange,
  onEmailChange,
}: {
  name: string;
  email: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
}) {
  const t = useTranslations();
  return (
    <YStack gap="$3">
      <FieldBlock label={String(t("eventDetail.volunteerFieldName"))} optional>
        <TextInput
          value={name}
          onChangeText={onNameChange}
          fullWidth
          autoComplete="name"
          enterKeyHint="next"
          // 44px height: iOS tap-target floor. The 16px anti-zoom font
          // comes from the th-no-zoom wrapper in the parent sheet.
          minHeight={44}
          aria-label={String(t("eventDetail.volunteerFieldName"))}
        />
      </FieldBlock>
      <FieldBlock label={String(t("eventDetail.volunteerFieldEmail"))}>
        <TextInput
          value={email}
          onChangeText={onEmailChange}
          fullWidth
          type="email"
          inputMode="email"
          autoComplete="email"
          enterKeyHint="next"
          minHeight={44}
          aria-label={String(t("eventDetail.volunteerFieldEmail"))}
        />
      </FieldBlock>
    </YStack>
  );
}

function FieldBlock({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations();
  return (
    <YStack gap="$2">
      <XStack gap="$1" alignItems="baseline">
        <Text variant="bodySmall" weight="bold">
          {label}
        </Text>
        {optional && (
          <Text variant="caption" tone="muted">
            ({String(t("eventDetail.volunteerFieldOptional"))})
          </Text>
        )}
      </XStack>
      {children}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Success summary
// ─────────────────────────────────────────────────────────────────────────────

function SuccessSummary({
  results,
  smsMayNeedStart,
  signedIn,
  onClose,
}: {
  results: ApplyResult[];
  smsMayNeedStart: boolean;
  signedIn: boolean;
  onClose: () => void;
}) {
  const t = useTranslations();
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const allOk = failed === 0;
  const allFailed = ok === 0;
  const allConfirmed = allOk && results.every((r) => r.status === "APPROVED");

  return (
    <YStack
      gap="$3"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      padding="$4"
      borderWidth={2}
      borderColor={allOk ? "$success" : allFailed ? "$danger" : "$warning"}
      borderRadius={0}
    >
      <XStack gap="$2" alignItems="center">
        {allOk ? (
          <Check size={20} color="var(--success, #166534)" />
        ) : allFailed ? (
          <CircleX size={20} color="var(--danger, #B91C1C)" />
        ) : (
          <AlertCircle size={20} color="var(--warning, #92400E)" />
        )}
        <Text variant="subtitle" weight="bold">
          {allOk
            ? String(
                signedIn
                  ? t("eventDetail.volunteerSuccessAuth")
                  : t("eventDetail.volunteerSuccessGuest"),
              )
            : allFailed
              ? String(t("eventDetail.volunteerErrorGeneric"))
              : String(t("eventDetail.volunteerSuccessPartial"))}
        </Text>
      </XStack>

      <YStack gap="$2">
        {results.map((r) => (
          <XStack key={r.key} gap="$2" alignItems="flex-start">
            {/* Waitlisted is a positive-neutral state — dashed/info, never
                the danger treatment. Approved and normal-pending keep the
                green check. */}
            {!r.ok ? (
              <CircleX size={14} color="var(--danger, #B91C1C)" />
            ) : r.waitlisted ? (
              <CircleDashed size={14} color="var(--info, #211C16)" />
            ) : (
              <CircleCheck size={14} color="var(--success, #166534)" />
            )}
            <YStack gap="$1" flex={1}>
              <Text variant="bodySmall">{r.label}</Text>
              {r.ok && r.status === "APPROVED" ? (
                <Text variant="caption" tone="muted">
                  {String(t("eventDetail.volunteerResultApproved"))}
                </Text>
              ) : null}
              {r.ok && r.waitlisted ? (
                <Text variant="caption" tone="muted">
                  {String(t("eventDetail.volunteerResultWaitlisted"))}
                </Text>
              ) : null}
              {!r.ok && r.error ? (
                <Text variant="caption" tone="error">
                  {r.error}
                </Text>
              ) : null}
            </YStack>
          </XStack>
        ))}
      </YStack>

      {allOk && (
        <Text variant="bodySmall" tone="muted">
          {String(
            t(
              allConfirmed
                ? "eventDetail.volunteerSuccessEmailHintConfirmed"
                : "eventDetail.volunteerSuccessEmailHint",
            ),
          )}
        </Text>
      )}

      {smsMayNeedStart ? (
        <Text variant="caption" tone="muted">
          {String(t("eventDetail.volunteerSmsMayNeedStart"))}
        </Text>
      ) : null}

      <XStack justifyContent="flex-end">
        <Button variant="primary" size="$3" minHeight={44} onPress={onClose}>
          {String(t("common.back"))}
        </Button>
      </XStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

type TRPCLikeError = {
  data?: { code?: string } | null;
  message?: string;
};

function mapSubmitError(
  err: unknown,
  t: ReturnType<typeof useTranslations>,
): string {
  const e = err as TRPCLikeError;
  const code = e?.data?.code;
  const appCode = getAppErrorCode(err);
  // Route by canonical AppErrorCode FIRST, independent of the transport bucket.
  // These map to different tRPC codes (ALREADY_SIGNED_UP / VOLUNTEERING_DISABLED
  // → CONFLICT, WAIVER_REQUIRED → PRECONDITION_FAILED), so keying off
  // `data.code` would make the precondition cases unreachable.
  if (appCode === "ALREADY_SIGNED_UP") {
    return String(t("eventDetail.volunteerAlreadySignedUp"));
  }
  if (appCode === "VOLUNTEERING_DISABLED") {
    return String(t("eventDetail.volunteerErrorDisabled"));
  }
  if (isSmsRequiresUsPhone(err)) {
    return String(t("eventDetail.volunteerSmsUsOnly"));
  }
  if (appCode === "WAIVER_REQUIRED") {
    // Waiver gate (Gap 3): the event requires acceptance and none was
    // sent (e.g. the silent waiver query hadn't resolved when the user
    // submitted, so the checkbox never rendered).
    return String(t("eventDetail.volunteerErrorWaiverRequired"));
  }
  if (code === "CONFLICT") {
    // Capacity never blocks submission (full shifts waitlist as PENDING),
    // so an unrecognized conflict is not a fullness problem.
    return String(t("eventDetail.volunteerErrorGeneric"));
  }
  if (code === "NOT_FOUND")
    return String(t("eventDetail.volunteerErrorNotFound"));
  if (code === "BAD_REQUEST")
    return String(t("eventDetail.volunteerErrorInvalid"));
  if (code === "FORBIDDEN")
    return String(t("eventDetail.volunteerErrorForbidden"));
  return String(t("eventDetail.volunteerErrorGeneric"));
}
