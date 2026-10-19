"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack } from "tamagui";
import { AlertTriangle } from "lucide-react";
import {
  Text,
  Button,
  LabeledTextInput,
  LabeledPasswordInput,
  Spinner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { SectionCard } from "./settings-primitives";

/**
 * Why the confirm panel is blocked, distinguishing "you mistyped the
 * confirmation email" or "your current password" (input-level problems,
 * anchored on their respective fields) from the two server-side guard
 * states (real, expected outcomes for the account itself — no retyping
 * fixes them, so they render as a standalone message rather than input
 * `helperText`).
 */
type DeleteBlockReason =
  | "mismatch"
  | "history"
  | "sole-owner"
  | "password-required"
  | "password-invalid"
  | null;

export function DangerZone() {
  const t = useTranslations();
  const router = useRouter();
  const { toast } = useNotify();
  const sessionQuery = authClient.useSession();
  const userEmail = sessionQuery.data?.user?.email ?? null;

  const [confirming, setConfirming] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [blockedReason, setBlockedReason] = useState<DeleteBlockReason>(null);

  const isMatch = useMemo(
    () =>
      Boolean(userEmail) &&
      confirmValue.trim().toLowerCase() === userEmail!.trim().toLowerCase(),
    [confirmValue, userEmail],
  );

  // Accounts created via Google/Apple/passkey have no password to re-enter —
  // the typed-email confirmation remains their sole gate. Only accounts with
  // a real password credential get the extra step-up field.
  const passwordCredentialQuery = trpc.humans.hasPasswordCredential.useQuery();
  const hasPassword = passwordCredentialQuery.data?.hasPassword ?? false;

  const canSubmit = isMatch && (!hasPassword || passwordValue.length > 0);

  const deleteMutation = trpc.humans.deleteMyAccount.useMutation();

  const handleDelete = useCallback(async () => {
    if (!canSubmit) return;
    setBlockedReason(null);
    try {
      await deleteMutation.mutateAsync({
        confirmationPhrase: confirmValue.trim(),
        ...(hasPassword ? { currentPassword: passwordValue } : {}),
      });
      toast.success({
        id: "account-deleted",
        title: String(t("account.sDeletedTitle")),
        message: String(t("account.sDeletedMsg")),
      });
      // Server-side session row is already gone via cascade; clear
      // client-side cookie/session state too before navigating away.
      await authClient.signOut();
      router.push("/");
    } catch (error) {
      // Branch on the STRUCTURED domain error code (data.appCode), not the
      // raw tRPC transport code — both a confirmation-phrase mismatch and a
      // generic Zod validation failure surface as tRPC `BAD_REQUEST`, so
      // comparing against that would conflate them.
      const appCode = getAppErrorCode(error);
      if (appCode === "CONFIRMATION_PHRASE_MISMATCH") {
        // Confirmation phrase didn't match — surface inline near the input
        // rather than only as a toast, so the user knows to retype it.
        setBlockedReason("mismatch");
        return;
      }
      if (appCode === "CANNOT_DELETE_ACCOUNT_WITH_ORDER_HISTORY") {
        // Expected outcome for most real ticket-buying accounts, not a
        // failure — surface as informational guidance, not the generic
        // danger toast.
        setBlockedReason("history");
        return;
      }
      if (appCode === "CANNOT_DELETE_SOLE_ORG_OWNER") {
        // Actionable guard: the user has a concrete next step (transfer
        // ownership) rather than something to retry.
        setBlockedReason("sole-owner");
        return;
      }
      if (appCode === "CURRENT_PASSWORD_REQUIRED") {
        // Defensive: the account has a password but the client-side gate
        // didn't send one (e.g. `hasPasswordCredential` was stale). Surface
        // inline near the password field, same as a mismatch.
        setBlockedReason("password-required");
        return;
      }
      if (appCode === "CURRENT_PASSWORD_INVALID") {
        // Typed password didn't match — inline near the field, not a toast,
        // so the user knows exactly what to retype.
        setBlockedReason("password-invalid");
        return;
      }
      console.error("[account] deleteMyAccount failed", error);
      toast.danger({
        id: "delete-failed",
        title: String(t("account.sDeleteFailedTitle")),
        message: String(t("account.sDeleteFailedMsg")),
      });
    }
  }, [
    canSubmit,
    confirmValue,
    deleteMutation,
    hasPassword,
    passwordValue,
    router,
    t,
    toast,
  ]);

  const deleting = deleteMutation.isPending;

  // $red2/$red6/$red10 were used here and in the confirm block below, but none
  // of them exist in the palette — Tamagui logged "missing token borderColor in
  // category color - $red6" and fell through to the default, so this section
  // has never actually rendered a danger signal. The real tokens are $danger
  // (fills/borders, 3:1 non-text floor) and $dangerSoft (the danger hue at
  // small-text legibility on every canvas).
  return (
    <SectionCard borderColor="$danger">
      <XStack gap="$2" alignItems="center">
        <AlertTriangle size={18} color="$dangerSoft" />
        <Text variant="h4" weight="bold" color="$dangerSoft">
          {String(t("account.sDangerTitle"))}
        </Text>
      </XStack>

      <Text variant="body" tone="muted">
        {String(t("account.sDeleteDesc"))}
      </Text>

      {!confirming ? (
        <XStack>
          <Button
            variant="outlined"
            size="$3"
            onPress={() => setConfirming(true)}
          >
            {String(t("account.sDeleteBtn"))}
          </Button>
        </XStack>
      ) : (
        <YStack
          gap="$3"
          padding="$3"
          backgroundColor="$surfaceMuted"
          borderLeftWidth={3}
          borderLeftColor="$danger"
          borderRadius={0}
        >
          <Text variant="body" weight="medium">
            {String(t("account.sDeleteConfirm"))}
          </Text>

          <LabeledTextInput
            label={String(t("account.sDeleteConfirmInstructions"))}
            name="delete-confirm-email"
            value={confirmValue}
            onChangeText={(value) => {
              setConfirmValue(value);
              // Only clear the reason this field can actually fix — leave
              // password / server-guard states alone so retyping the email
              // doesn't silently hide an unrelated error.
              if (blockedReason === "mismatch") setBlockedReason(null);
            }}
            placeholder={String(t("account.sDeleteConfirmPlaceholder"))}
            autoComplete="off"
            autoCapitalize="none"
            status={blockedReason === "mismatch" ? "error" : undefined}
            helperText={
              blockedReason === "mismatch"
                ? String(t("account.sDeleteConfirmMismatch"))
                : undefined
            }
            disabled={deleting}
          />

          {/* Only accounts with a real password credential get this extra
              step-up field — OAuth/passkey-only accounts rely solely on the
              typed-email confirmation above (explicit scope decision). */}
          {hasPassword ? (
            <LabeledPasswordInput
              label={String(t("account.sDeleteConfirmPasswordLabel"))}
              name="delete-confirm-password"
              value={passwordValue}
              onChangeText={(value) => {
                setPasswordValue(value);
                // Only clear the reasons this field can actually fix.
                if (
                  blockedReason === "password-required" ||
                  blockedReason === "password-invalid"
                ) {
                  setBlockedReason(null);
                }
              }}
              placeholder={String(
                t("account.sDeleteConfirmPasswordPlaceholder"),
              )}
              autoComplete="current-password"
              toggleLabel={String(t("account.sTogglePw"))}
              visibleStateLabel={String(t("account.sPwVisible"))}
              hiddenStateLabel={String(t("account.sPwHidden"))}
              status={
                blockedReason === "password-required" ||
                blockedReason === "password-invalid"
                  ? "error"
                  : undefined
              }
              helperText={
                blockedReason === "password-required"
                  ? String(t("account.sDeleteConfirmPasswordRequired"))
                  : blockedReason === "password-invalid"
                    ? String(t("account.sDeleteConfirmPasswordInvalid"))
                    : undefined
              }
              disabled={deleting}
            />
          ) : null}

          {/* The two server guard states aren't about the typed value being
              wrong, so they render as a standalone message rather than
              input helperText — order history is a normal, expected state
              (informational tone); sole-owner is an actionable blocker the
              user must resolve elsewhere first. */}
          {blockedReason === "history" ? (
            <Text variant="bodySmall" tone="info" role="status">
              {String(t("account.sDeleteBlockedByHistory"))}
            </Text>
          ) : null}
          {blockedReason === "sole-owner" ? (
            <Text variant="bodySmall" tone="warning" role="alert">
              {String(t("account.sDeleteBlockedBySoleOwner"))}
            </Text>
          ) : null}

          <XStack gap="$3">
            <Button
              variant="ghost"
              size="$3"
              onPress={() => {
                setConfirming(false);
                setConfirmValue("");
                setPasswordValue("");
                setBlockedReason(null);
              }}
              disabled={deleting}
            >
              {String(t("account.sCancel"))}
            </Button>
            <Button
              variant="destructive"
              size="$3"
              onPress={handleDelete}
              disabled={deleting || !canSubmit}
            >
              {deleting ? (
                <Spinner size="sm" />
              ) : (
                String(t("account.sDeleteConfirmBtn"))
              )}
            </Button>
          </XStack>
        </YStack>
      )}
    </SectionCard>
  );
}
