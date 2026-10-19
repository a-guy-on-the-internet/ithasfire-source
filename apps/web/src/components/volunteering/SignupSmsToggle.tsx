"use client";

import { useState, type ReactNode } from "react";
import { YStack, type YStackProps } from "tamagui";
import { Checkbox, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";

// ─────────────────────────────────────────────────────────────────────────────
// Tap-target checkbox
// ─────────────────────────────────────────────────────────────────────────────

type TapTargetCheckboxProps = {
  id: string;
  checked: boolean;
  onCheckedChange: (next: boolean | "indeterminate") => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  testIdBase?: string;
  size?: "sm" | "md" | "lg";
};

/**
 * Checkbox + label wrapped in a native `<label>` so the entire row — not
 * just the small visual box — is the tap target (≥44px tall on touch
 * surfaces). The visual box keeps its Swiss size; only the hit area grows.
 * Web-only surface, so a plain `<label>` is fine: it forwards activation
 * to the checkbox via `htmlFor`, and the browser suppresses the duplicate
 * dispatch when the press lands on the control itself.
 */
export function TapTargetCheckbox({
  id,
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  testIdBase,
  size = "md",
}: TapTargetCheckboxProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <YStack gap="$1" minWidth={0} flexShrink={1} maxWidth="100%">
      <label
        htmlFor={id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 44,
          minWidth: 0,
          cursor: disabled ? "not-allowed" : "pointer",
          userSelect: "none",
        }}
      >
        <Checkbox
          id={id}
          size={size}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          testIdBase={testIdBase}
          aria-describedby={descriptionId}
        />
        <Text
          fontFamily="$body"
          fontSize="$3"
          lineHeight="$3"
          weight="medium"
          flexShrink={1}
          minWidth={0}
        >
          {label}
        </Text>
      </label>
      {description ? (
        <Text id={descriptionId} variant="bodySmall" tone="muted">
          {description}
        </Text>
      ) : null}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-signup texts switch
// ─────────────────────────────────────────────────────────────────────────────

/** The server refused SMS for a number outside the US (submit or toggle). */
export function isSmsRequiresUsPhone(err: unknown): boolean {
  return (
    (err as { message?: unknown } | null)?.message === "sms_requires_us_phone"
  );
}

export type SignupSmsToggleProps = {
  signupId: string;
  /** The signup's stored opt-in: the switch shows server truth, never a guess. */
  smsOptIn: boolean;
  /**
   * A reminder is really sent for this signup (`signupReminderAnchor`). Off,
   * the switch is revoke-only: it can withdraw consent already given, never
   * give new consent. The server refuses ON anyway (`sms_reminders_unavailable`).
   */
  remindersOffered: boolean;
  /** A phone is on file. No phone → nothing to text → no switch to turn on. */
  hasPhone: boolean;
  /** The signup can still be reminded (PENDING or APPROVED). */
  live: boolean;
  /** i18n key naming what the reminder comes before (shift, event, ask). */
  labelKey: string;
  /** Refetch the list the row came from, success or failure. */
  onSettled: () => void;
  /** Where the switch and its captions sit in the row. */
  align?: "start" | "end";
  /** Spacing around the switch, applied only when it renders. */
  frameProps?: Pick<
    YStackProps,
    "paddingHorizontal" | "paddingTop" | "paddingBottom"
  >;
  testId?: string;
};

/**
 * The "Text me reminders" switch for one existing signup, shared by the
 * event page's signup rows and `/my-volunteering`. Renders nothing when it
 * has nothing to offer.
 *
 * With SMS unavailable (no provider), or on a signup no reminder is sent
 * for, the switch is revoke-only: a signup that already consented keeps a
 * way to withdraw it, but it can only be switched off, and once off it is
 * gone. Pending signups keep it too: they may be approved later, and the
 * consent should be revocable the whole time.
 */
export function SignupSmsToggle({
  signupId,
  smsOptIn,
  remindersOffered,
  hasPhone,
  live,
  labelKey,
  onSettled,
  align = "end",
  frameProps,
  testId,
}: SignupSmsToggleProps) {
  const t = useTranslations();
  // No SMS provider configured → nothing is ever texted. Fail-closed: only
  // an explicit `sms === true` offers turning texts on.
  const { gates } = useFeatureGates();
  const smsAvailable = gates?.sms === true;
  const [prefsError, setPrefsError] = useState<null | "generic" | "us_only">(
    null,
  );
  // Set when switching reminders ON comes back with the server's static
  // START hint; cleared by switching them off or by an error.
  const [smsStartHint, setSmsStartHint] = useState(false);
  const updatePrefs = trpc.volunteer.signups.updateContactPrefs.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: (data, variables) => {
      setPrefsError(null);
      setSmsStartHint(
        variables.smsOptIn === true && data.smsMayNeedStart === true,
      );
    },
    onError: (err) => {
      setSmsStartHint(false);
      setPrefsError(isSmsRequiresUsPhone(err) ? "us_only" : "generic");
    },
    // Refetch either way: success confirms the flip, failure reverts the
    // checkbox to server truth instead of leaving a lying control.
    onSettled,
  });

  const revokeOnly = !smsAvailable || !remindersOffered;
  // No phone on file → no switch: the server rejects enabling without a
  // destination, and a permanently-disabled control is just noise.
  const show =
    ((smsAvailable && remindersOffered) || smsOptIn) && hasPhone && live;
  if (!show) return null;

  const alignItems = align === "end" ? "flex-end" : "flex-start";

  return (
    <YStack
      gap="$1"
      alignItems={alignItems}
      flexShrink={1}
      minWidth={0}
      maxWidth="100%"
      {...frameProps}
      data-testid={testId}
    >
      <TapTargetCheckbox
        id={`volunteer-sms-prefs-${signupId}`}
        checked={smsOptIn}
        disabled={updatePrefs.isPending}
        onCheckedChange={(next) => {
          if (revokeOnly && next === true) return;
          updatePrefs.mutate({ signupId, smsOptIn: next === true });
        }}
        label={String(t(labelKey))}
        testIdBase={`volunteer-sms-prefs-${signupId}`}
      />
      {/* Captions only, so the switch's own label is never re-read. Kept
          mounted (even empty) so a caption that appears or changes after a
          toggle is announced. */}
      <YStack
        gap="$1"
        alignItems={alignItems}
        minWidth={0}
        maxWidth="100%"
        aria-live="polite"
        data-testid={`volunteer-sms-prefs-captions-${signupId}`}
      >
        {/* One caption, never two: the START hint replaces the STOP hint
            when it applies, so each rule is stated once. */}
        {revokeOnly ? null : (
          <Text variant="caption" tone="muted">
            {String(
              t(
                smsStartHint && smsOptIn && !prefsError
                  ? "eventDetail.volunteerSmsMayNeedStart"
                  : "eventDetail.volunteerSmsStopHint",
              ),
            )}
          </Text>
        )}
        {prefsError ? (
          <Text variant="caption" tone="error">
            {String(
              t(
                prefsError === "us_only"
                  ? "eventDetail.volunteerSmsToggleUsOnly"
                  : "eventDetail.volunteerSmsUpdateFailed",
              ),
            )}
          </Text>
        ) : null}
      </YStack>
    </YStack>
  );
}
