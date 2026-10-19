"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  Badge,
  Button,
  Checkbox,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { AlertCircle, CircleCheck, CircleDashed, CircleX, PauseCircle } from "lucide-react";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { getAppErrorCode } from "@/lib/app-error";
import { AddToCalendarButton } from "@/components/volunteering/AddToCalendarButton";
import { SmsLegalLinks } from "@/components/notifications/SmsLegalLinks";
import {
  ASK_CADENCE_LABEL_KEY,
  getVolunteerConflictReason,
  parseAskFormQuestions,
  type AskCadence,
} from "@/components/volunteering/volunteering-helpers";
import { formatAskWindow } from "@/components/volunteering/ask-window-label";

// ─────────────────────────────────────────────────────────────────────────────
// Styles (strict Swiss — mirrors the event VolunteerSection role cards)
// ─────────────────────────────────────────────────────────────────────────────

const RoleCard = styled(YStack, {
  padding: "$4",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  gap: "$2",
});

const FormBand = styled(YStack, {
  gap: "$3",
  paddingTop: "$4",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
});

// Waiver bodies are plain text / lightweight markdown — preserve newlines and
// wrap in the scroll box (same rendering as the event builder's preview).
const waiverBodyTextStyle: CSSProperties = { whiteSpace: "pre-wrap" };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PublicAskViewProps = {
  askId: string;
};

type SubmitResult = {
  roleId: string;
  roleLabel: string;
  ok: boolean;
  status?: "PENDING" | "APPROVED";
  error?: string;
  signupId?: string;
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "done"; results: SubmitResult[] };

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

function mapSubmitError(
  err: unknown,
  t: ReturnType<typeof useTranslations>,
): string {
  const appCode = getAppErrorCode(err);
  const reason = getVolunteerConflictReason(err);
  if (reason === "ask_not_open") {
    return String(t("volunteering.publicClosedBody"));
  }
  if (appCode === "WAIVER_REQUIRED") {
    return String(t("volunteering.publicErrWaiverRequired"));
  }
  // The server refused SMS reminders for a number outside the US.
  const message = (err as { message?: unknown } | null)?.message;
  if (message === "sms_requires_us_phone") {
    return String(t("volunteering.publicErrSmsUsOnly"));
  }
  if (appCode === "ROLE_NOT_FOUND" || appCode === "NOT_FOUND") {
    return String(t("volunteering.publicErrNotFound"));
  }
  return String(t("volunteering.publicErrGeneric"));
}

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public signup page for a generic volunteer ask (/v/[askId], FR-003).
 * DRAFT/ARCHIVED collapse to not-found server-side; PAUSED/CLOSED render a
 * friendly "not taking signups" state. Submitting is idempotent per
 * (role, email) — a resubmit succeeds without creating a duplicate, so the
 * success copy covers both cases.
 */
export function PublicAskView({ askId }: PublicAskViewProps) {
  const t = useTranslations();
  // No SMS provider configured → nothing is ever texted, so the reminder
  // opt-in is not offered. Fail-closed: only an explicit `sms === true`
  // shows it; it returns on its own when SMS is switched on.
  const { gates } = useFeatureGates();
  const smsAvailable = gates?.sms === true;
  const fmt = useFormatters();
  const notify = useNotify();
  const session = authClient.useSession();
  const sessionUser = session.data?.user;
  const isSignedIn = Boolean(sessionUser);

  const askQuery = trpc.volunteer.publicAsks.get.useQuery(
    { askId },
    { staleTime: 30_000, retry: 1, meta: { silent: true } },
  );

  // Effective waiver gate (FR-006): armed only when the ask requires a waiver
  // AND a template resolves. `alreadyOnFile` is true for a signed-in returning
  // volunteer; guests always get false.
  const waiverQuery = trpc.volunteer.publicAsks.waiver.useQuery(
    { askId },
    { staleTime: 30_000, retry: 1, meta: { silent: true } },
  );

  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(
    new Set(),
  );
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  const submit = trpc.volunteer.signups.submit.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const questions = useMemo(
    () => parseAskFormQuestions(askQuery.data?.ask.formSchema),
    [askQuery.data?.ask.formSchema],
  );

  // ── Loading / not-found ─────────────────────────────────────────────────

  if (askQuery.isLoading) {
    return (
      <YStack paddingVertical="$8" alignItems="center" role="status">
        <Text color="$colorMuted">{String(t("common.loading"))}</Text>
      </YStack>
    );
  }

  if (askQuery.isError || !askQuery.data) {
    return (
      <YStack
        gap="$3"
        alignItems="center"
        paddingVertical="$8"
        data-testid="public-ask-not-found"
      >
        <Text variant="h3" weight="bold" textAlign="center">
          {String(t("volunteering.publicNotFoundTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
          {String(t("volunteering.publicNotFoundBody"))}
        </Text>
      </YStack>
    );
  }

  const { ask, roles } = askQuery.data;

  const windowLabel = formatAskWindow(fmt, t, ask);

  const header = (
    <YStack gap="$2">
      <Text tag="h1" variant="h2" weight="bold">
        {ask.title}
      </Text>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Badge tone="info" size="sm">
          {String(t(ASK_CADENCE_LABEL_KEY[ask.cadence as AskCadence]))}
        </Badge>
        {windowLabel ? (
          <Text variant="caption" tone="muted">
            {windowLabel}
          </Text>
        ) : null}
      </XStack>
      {ask.description ? (
        <Text variant="body" tone="muted">
          {ask.description}
        </Text>
      ) : null}
    </YStack>
  );

  // ── Friendly closed / paused state ──────────────────────────────────────

  if (ask.status !== "OPEN") {
    return (
      <YStack gap="$4" data-testid="public-ask-closed">
        {header}
        <YStack
          gap="$2"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          alignItems="flex-start"
        >
          <XStack gap="$2" alignItems="center">
            <PauseCircle size={18} color="var(--colorMuted)" />
            <Text variant="subtitle" weight="bold">
              {String(
                t(
                  ask.status === "PAUSED"
                    ? "volunteering.publicPausedTitle"
                    : "volunteering.publicClosedTitle",
                ),
              )}
            </Text>
          </XStack>
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.publicClosedBody"))}
          </Text>
        </YStack>
      </YStack>
    );
  }

  // ── Submit ──────────────────────────────────────────────────────────────

  const trimmedEmail = (
    isSignedIn ? (sessionUser?.email ?? "") : guestEmail
  ).trim();
  const trimmedName = (
    isSignedIn ? (sessionUser?.name ?? "") : guestName
  ).trim();
  const trimmedPhone = phone.trim();
  // Offered only where a reminder is really sent: the server says the ask
  // reminds (one-time, with a start; `textRemindersOffered`), SMS is on, and
  // there is a number to text. The organiser's old `smsOptInEnabled` switch
  // gates nothing (volunteer-ask-reminders R5).
  const smsOptInOffered =
    smsAvailable && ask.textRemindersOffered && trimmedPhone.length > 0;

  const missingRequiredAnswer = questions.some(
    (q) => q.required && !(answers[q.id] ?? "").trim(),
  );

  // The waiver read is the source of truth for the gate — a flag with no
  // resolvable template imposes NO gate (removes the text-less checkbox).
  const waiverData = waiverQuery.data;
  const waiverEffectivelyRequired = waiverData?.waiverRequired === true;
  const waiverDoc = waiverData?.waiver ?? null;
  const waiverAlreadyOnFile =
    waiverEffectivelyRequired && waiverData?.alreadyOnFile === true;
  // The ask flags a waiver but the effective read hasn't resolved yet — block
  // submit so a fast click can't skip a not-yet-loaded gate.
  const waiverUnresolved = ask.waiverRequired && !waiverQuery.isSuccess;
  const waiverSatisfied =
    !waiverEffectivelyRequired || waiverAlreadyOnFile || waiverAccepted;
  const canSubmit =
    selectedRoleIds.size > 0 &&
    submitState.kind !== "submitting" &&
    waiverSatisfied &&
    !waiverUnresolved;

  const toggleRole = (roleId: string) => {
    setSelectedRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const handleSubmit = async () => {
    const roleIds = Array.from(selectedRoleIds);
    if (roleIds.length === 0) return;

    if (!trimmedEmail) {
      setSubmitState({
        kind: "error",
        message: String(t("volunteering.publicErrEmailRequired")),
      });
      return;
    }
    if (missingRequiredAnswer) {
      setSubmitState({
        kind: "error",
        message: String(t("volunteering.publicErrAnswersRequired")),
      });
      return;
    }

    setSubmitState({ kind: "submitting" });

    const answerEntries = Object.fromEntries(
      Object.entries(answers)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v.length > 0),
    );

    const settled = await Promise.allSettled(
      roleIds.map((roleId) =>
        submit.mutateAsync({
          askId,
          roleId,
          contactEmail: trimmedEmail,
          contactName: trimmedName || undefined,
          contactPhone: trimmedPhone || undefined,
          // A tick hidden by a cleared phone or an ask that stopped
          // offering texts never travels.
          smsOptIn: smsOptInOffered ? smsOptIn : false,
          answers:
            Object.keys(answerEntries).length > 0 ? answerEntries : undefined,
          // Only send acceptance when the gate is effectively armed and not
          // already satisfied on file; the server enforces it regardless.
          ...(waiverEffectivelyRequired && !waiverAlreadyOnFile
            ? { waiverAccepted: true }
            : {}),
        }),
      ),
    );

    const results: SubmitResult[] = roleIds.map((roleId, i) => {
      const role = roles.find((r) => r.id === roleId);
      const outcome = settled[i];
      if (outcome?.status === "fulfilled") {
        return {
          roleId,
          roleLabel: role?.name ?? "—",
          ok: true,
          status:
            outcome.value.status === "APPROVED" ? "APPROVED" : "PENDING",
          signupId: outcome.value.id,
        };
      }
      return {
        roleId,
        roleLabel: role?.name ?? "—",
        ok: false,
        error: mapSubmitError(outcome?.reason, t),
      };
    });

    // Refetch the waiver read too: a signed-in volunteer who just accepted now
    // has it on file, so returning to the form shows the "on file" state.
    await Promise.all([askQuery.refetch(), waiverQuery.refetch()]);
    setSubmitState({ kind: "done", results });
    setSelectedRoleIds(new Set());
  };

  // ── Success summary ─────────────────────────────────────────────────────

  if (submitState.kind === "done") {
    const results = submitState.results;
    const okResults = results.filter((r) => r.ok);
    const allOk = okResults.length === results.length;
    const firstOkSignupId = okResults[0]?.signupId;
    const hasWindow = Boolean(ask.startsAt || ask.endsAt);

    return (
      <YStack gap="$4">
        {header}
        <YStack
          gap="$3"
          role="status"
          aria-live="polite"
          padding="$4"
          borderWidth={2}
          borderColor={allOk ? "$success" : okResults.length === 0 ? "$danger" : "$warning"}
          borderRadius={0}
          data-testid="public-ask-success"
        >
          <XStack gap="$2" alignItems="center">
            {allOk ? (
              <CircleCheck size={20} color="var(--success, #166534)" />
            ) : (
              <AlertCircle size={20} color="var(--warning, #92400E)" />
            )}
            <Text variant="subtitle" weight="bold">
              {String(
                t(
                  allOk
                    ? "volunteering.publicSuccessTitle"
                    : "volunteering.publicSuccessPartialTitle",
                ),
              )}
            </Text>
          </XStack>

          <YStack gap="$2">
            {results.map((r) => (
              <XStack key={r.roleId} gap="$2" alignItems="flex-start">
                {!r.ok ? (
                  <CircleX size={14} color="var(--danger, #B91C1C)" />
                ) : r.status === "APPROVED" ? (
                  <CircleCheck
                    size={14}
                    color="var(--success, #166534)"
                  />
                ) : (
                  <CircleDashed size={14} color="var(--info, #211C16)" />
                )}
                <YStack gap="$1" flex={1}>
                  <Text variant="bodySmall">{r.roleLabel}</Text>
                  {r.ok ? (
                    <Text variant="caption" tone="muted">
                      {String(
                        t(
                          r.status === "APPROVED"
                            ? "volunteering.publicResultApproved"
                            : "volunteering.publicResultPending",
                        ),
                      )}
                    </Text>
                  ) : (
                    <Text variant="caption" color="$danger">
                      {r.error}
                    </Text>
                  )}
                </YStack>
              </XStack>
            ))}
          </YStack>

          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.publicSuccessEmailHint"))}
          </Text>

          {isSignedIn && firstOkSignupId && hasWindow ? (
            <AddToCalendarButton signupId={firstOkSignupId} compact />
          ) : null}

          <XStack justifyContent="flex-end">
            <Button
              variant="secondary"
              size="$3"
              minHeight={44}
              onPress={() => setSubmitState({ kind: "idle" })}
            >
              {String(t("common.back"))}
            </Button>
          </XStack>
        </YStack>
      </YStack>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────

  return (
    <YStack gap="$4" className="th-no-zoom">
      {header}

      <YStack gap="$3" data-testid="public-ask-roles">
        <Text tag="h2" variant="h4" weight="bold" style={{ textTransform: "uppercase" }}>
          {String(t("volunteering.publicRolesTitle"))}
        </Text>
        {roles.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.publicNoRoles"))}
          </Text>
        ) : (
          roles.map((role) => {
            const full =
              role.capacity !== null && role.acceptedCount >= role.capacity;
            const checked = selectedRoleIds.has(role.id);
            const checkboxId = `public-ask-role-${role.id}`;
            return (
              <RoleCard key={role.id}>
                <XStack
                  gap="$3"
                  alignItems="flex-start"
                  justifyContent="space-between"
                  flexWrap="wrap"
                >
                  <YStack gap="$1" flex={1} minWidth={200}>
                    <Text variant="subtitle" weight="bold">
                      {role.name}
                    </Text>
                    {role.description ? (
                      <Text variant="bodySmall" tone="muted">
                        {role.description}
                      </Text>
                    ) : null}
                    {role.defaultHours != null ? (
                      <Text variant="caption" tone="muted">
                        {String(
                          t("volunteering.publicRoleHours", {
                            hours: role.defaultHours,
                          }),
                        )}
                      </Text>
                    ) : null}
                  </YStack>
                  <YStack gap="$2" alignItems="flex-end">
                    {role.capacity === null ? (
                      <Badge tone="info" size="sm">
                        {String(t("volunteering.publicSpotsOpen"))}
                      </Badge>
                    ) : full ? (
                      <Badge tone="warning" size="sm">
                        {String(t("volunteering.publicSpotsFull"))}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" size="sm">
                        {`${role.acceptedCount} / ${role.capacity}`}
                      </Badge>
                    )}
                    <label
                      htmlFor={checkboxId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        minHeight: 44,
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                    >
                      <Checkbox
                        id={checkboxId}
                        size="lg"
                        checked={checked}
                        onCheckedChange={() => toggleRole(role.id)}
                        testIdBase={checkboxId}
                      />
                      <Text variant="bodySmall" weight="medium">
                        {String(
                          t(
                            full
                              ? "volunteering.publicJoinWaitlist"
                              : "volunteering.publicSelectRole",
                          ),
                        )}
                      </Text>
                    </label>
                  </YStack>
                </XStack>
              </RoleCard>
            );
          })
        )}
      </YStack>

      <FormBand>
        {isSignedIn ? (
          <XStack
            gap="$3"
            alignItems="center"
            padding="$3"
            borderWidth={1}
            borderColor="$borderColor"
            borderRadius={0}
          >
            <CircleCheck size={16} color="var(--success, #166534)" />
            <YStack gap="$1" flex={1}>
              <Text variant="caption" tone="muted">
                {String(t("volunteering.publicSubmittingAs"))}
              </Text>
              <Text variant="bodySmall" weight="bold">
                {trimmedName
                  ? `${trimmedName} · ${trimmedEmail}`
                  : trimmedEmail}
              </Text>
            </YStack>
          </XStack>
        ) : (
          <>
            <YStack gap="$2">
              <Text variant="bodySmall" weight="bold">
                {String(t("volunteering.publicFieldName"))}{" "}
                <Text variant="caption" tone="muted" tag="span">
                  ({String(t("volunteering.publicFieldOptional"))})
                </Text>
              </Text>
              <TextInput
                value={guestName}
                onChangeText={setGuestName}
                fullWidth
                autoComplete="name"
                minHeight={44}
                testId="public-ask-name"
                aria-label={String(t("volunteering.publicFieldName"))}
              />
            </YStack>
            <YStack gap="$2">
              <Text variant="bodySmall" weight="bold">
                {String(t("volunteering.publicFieldEmail"))}
              </Text>
              <TextInput
                value={guestEmail}
                onChangeText={setGuestEmail}
                fullWidth
                type="email"
                inputMode="email"
                autoComplete="email"
                minHeight={44}
                testId="public-ask-email"
                aria-label={String(t("volunteering.publicFieldEmail"))}
              />
            </YStack>
          </>
        )}

        <YStack gap="$2">
          <Text variant="bodySmall" weight="bold">
            {String(t("volunteering.publicFieldPhone"))}{" "}
            <Text variant="caption" tone="muted" tag="span">
              ({String(t("volunteering.publicFieldOptional"))})
            </Text>
          </Text>
          <TextInput
            value={phone}
            onChangeText={(next) => {
              setPhone(next);
              // An emptied phone hides the opt-in box; clear its tick so
              // retyping shows it unticked, not a hidden consent.
              if (next.trim().length === 0) setSmsOptIn(false);
            }}
            fullWidth
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            minHeight={44}
            testId="public-ask-phone"
            aria-label={String(t("volunteering.publicFieldPhone"))}
          />
        </YStack>

        {smsOptInOffered ? (
          <YStack gap="$1">
            <label
              htmlFor="public-ask-sms-opt-in"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minHeight: 44,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <Checkbox
                id="public-ask-sms-opt-in"
                checked={smsOptIn}
                onCheckedChange={(next) => setSmsOptIn(next === true)}
                testIdBase="public-ask-sms-opt-in"
              />
              <Text variant="bodySmall" weight="medium">
                {String(t("volunteering.publicSmsOptIn"))}
              </Text>
            </label>
            {/* Outside the label so a link click never toggles the opt-in. */}
            <Text variant="bodySmall" tone="muted">
              <SmsLegalLinks />
            </Text>
          </YStack>
        ) : null}

        {questions.map((q) => {
          const inputId = `public-ask-question-${q.id}`;
          return (
            <YStack key={q.id} gap="$2">
              <Text variant="bodySmall" weight="bold">
                {q.label}
                {!q.required ? (
                  <Text variant="caption" tone="muted" tag="span">
                    {" "}
                    ({String(t("volunteering.publicFieldOptional"))})
                  </Text>
                ) : null}
              </Text>
              <TextInput
                id={inputId}
                value={answers[q.id] ?? ""}
                onChangeText={(v) =>
                  setAnswers((prev) => ({ ...prev, [q.id]: v }))
                }
                fullWidth
                multiline={q.multiline}
                numberOfLines={q.multiline ? 3 : undefined}
                minHeight={44}
                testId={inputId}
                aria-label={q.label}
              />
            </YStack>
          );
        })}

        {ask.waiverRequired ? (
          waiverQuery.isLoading ? (
            <YStack
              gap="$2"
              padding="$3"
              borderWidth={1}
              borderColor="$borderColor"
              borderRadius={0}
              role="status"
              data-testid="public-ask-waiver-loading"
            >
              <Text variant="bodySmall" tone="muted">
                {String(t("common.loading"))}
              </Text>
            </YStack>
          ) : waiverQuery.isError ? (
            <XStack
              gap="$2"
              alignItems="center"
              flexWrap="wrap"
              padding="$3"
              borderWidth={1}
              borderColor="$danger"
              borderRadius={0}
              role="alert"
              data-testid="public-ask-waiver-error"
            >
              <AlertCircle size={16} color="var(--danger, #B91C1C)" />
              <Text variant="bodySmall" color="$danger">
                {String(t("volunteering.publicWaiverLoadError"))}
              </Text>
              <Button
                variant="outlined"
                size="$2"
                minHeight={44}
                onPress={() => {
                  void waiverQuery.refetch();
                }}
              >
                {String(t("volunteering.retryCta"))}
              </Button>
            </XStack>
          ) : waiverEffectivelyRequired && waiverDoc ? (
            waiverAlreadyOnFile ? (
              <XStack
                gap="$3"
                alignItems="flex-start"
                padding="$3"
                borderWidth={1}
                borderColor="$borderColor"
                borderRadius={0}
                data-testid="public-ask-waiver-on-file"
              >
                <CircleCheck
                  size={18}
                  color="var(--success, #166534)"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <YStack gap="$1" flex={1}>
                  <Text variant="bodySmall" weight="bold">
                    {String(t("volunteering.publicWaiverOnFile"))}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {String(t("volunteering.publicWaiverOnFileHint"))}
                  </Text>
                </YStack>
              </XStack>
            ) : (
              <YStack gap="$2" data-testid="public-ask-waiver-armed">
                <Text variant="subtitle" weight="bold">
                  {waiverDoc.name}
                </Text>
                <Text variant="caption" tone="muted">
                  {String(t("volunteering.publicWaiverReview"))}
                </Text>
                <YStack
                  padding="$4"
                  borderWidth={2}
                  borderColor="$borderColor"
                  borderRadius={0}
                  backgroundColor="$backgroundHover"
                  maxHeight={240}
                  tabIndex={0}
                  role="region"
                  aria-label={String(t("volunteering.publicWaiverScrollLabel"))}
                  style={{ overflowY: "auto" } as CSSProperties}
                  data-testid="public-ask-waiver-body"
                >
                  <Text variant="bodySmall" style={waiverBodyTextStyle}>
                    {waiverDoc.body}
                  </Text>
                </YStack>
                <label
                  htmlFor="public-ask-waiver"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 44,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <Checkbox
                    id="public-ask-waiver"
                    checked={waiverAccepted}
                    onCheckedChange={(next) => setWaiverAccepted(next === true)}
                    testIdBase="public-ask-waiver"
                  />
                  <Text variant="bodySmall" weight="medium">
                    {String(t("volunteering.publicWaiverLabel"))}
                  </Text>
                </label>
              </YStack>
            )
          ) : null
        ) : null}

        {submitState.kind === "error" ? (
          <XStack
            gap="$2"
            alignItems="center"
            padding="$3"
            borderWidth={1}
            borderColor="$danger"
            borderRadius={0}
            role="alert"
            aria-live="assertive"
          >
            <AlertCircle size={16} color="var(--danger, #B91C1C)" />
            <Text variant="bodySmall" color="$danger">
              {submitState.message}
            </Text>
          </XStack>
        ) : null}

        <XStack
          alignItems="center"
          justifyContent="space-between"
          gap="$3"
          flexWrap="wrap"
        >
          <Text variant="bodySmall" tone="muted">
            {selectedRoleIds.size === 0
              ? String(t("volunteering.publicSelectionNone"))
              : String(
                  t("volunteering.publicSelectionCount", {
                    count: selectedRoleIds.size,
                  }),
                )}
          </Text>
          <Button
            variant="primary"
            size="$3"
            minHeight={44}
            disabled={!canSubmit}
            onPress={() => {
              void handleSubmit().catch(() => {
                notify.toast.danger({
                  id: "public-ask-submit-failed",
                  title: String(t("volunteering.publicErrGeneric")),
                });
              });
            }}
            data-testid="public-ask-submit"
          >
            {submitState.kind === "submitting"
              ? String(t("common.loading"))
              : String(t("volunteering.publicApplyCta"))}
          </Button>
        </XStack>
      </FormBand>
    </YStack>
  );
}
