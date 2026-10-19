"use client";

import { useState, useCallback } from "react";
import { XStack } from "tamagui";
import { Lock } from "lucide-react";
import {
  Text,
  Button,
  PasswordInput,
  Spinner,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { useFormErrors } from "@/hooks/useFormErrors";
import {
  SectionCard,
  FieldRow,
} from "./settings-primitives";

export function PasswordSection() {
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [saving, setSaving] = useState(false);

  const canSubmit =
    currentPw.length >= 6 &&
    newPw.length >= 8 &&
    newPw === confirmPw &&
    !saving;

  const handleChange = useCallback(async () => {
    if (!canSubmit) return;
    clearAll();
    setSaving(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword: currentPw,
        newPassword: newPw,
        revokeOtherSessions: true,
      });
      if (error) throw error;
      toast.success({
        id: "pw-changed",
        title: String(t("account.sPwChangedTitle")),
        message: String(t("account.sPwChangedMsg")),
      });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }, [canSubmit, currentPw, newPw, t, toast, clearAll, setError]);

  const toggleLabel = String(t("account.sTogglePw"));
  const visibleStateLabel = String(t("account.sPwVisible"));
  const hiddenStateLabel = String(t("account.sPwHidden"));

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Lock size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sSecurityTitle"))}
        </Text>
      </XStack>

      <FormErrorBanner message={formError} onDismiss={clearAll} />

      <FieldRow>
        <Text variant="caption" tone="muted" weight="medium">
          {String(t("account.sCurrentPw"))}
        </Text>
        <PasswordInput
          value={currentPw}
          onChangeText={setCurrentPw}
          autoComplete="current-password"
          toggleLabel={toggleLabel}
          visibleStateLabel={visibleStateLabel}
          hiddenStateLabel={hiddenStateLabel}
        />
      </FieldRow>

      <FieldRow>
        <Text variant="caption" tone="muted" weight="medium">
          {String(t("account.sNewPw"))}
        </Text>
        <PasswordInput
          value={newPw}
          onChangeText={setNewPw}
          autoComplete="new-password"
          toggleLabel={toggleLabel}
          visibleStateLabel={visibleStateLabel}
          hiddenStateLabel={hiddenStateLabel}
        />
      </FieldRow>

      <FieldRow>
        <Text variant="caption" tone="muted" weight="medium">
          {String(t("account.sConfirmPw"))}
        </Text>
        <PasswordInput
          value={confirmPw}
          onChangeText={setConfirmPw}
          autoComplete="new-password"
          toggleLabel={toggleLabel}
          visibleStateLabel={visibleStateLabel}
          hiddenStateLabel={hiddenStateLabel}
        />
        {confirmPw.length > 0 && newPw !== confirmPw && (
          <Text variant="caption" tone="error">
            {String(t("account.sPwMismatch"))}
          </Text>
        )}
      </FieldRow>

      <XStack justifyContent="flex-end">
        <Button
          variant="primary"
          size="$3"
          onPress={handleChange}
          disabled={!canSubmit}
        >
          {saving ? <Spinner size="sm" /> : String(t("account.sChangePw"))}
        </Button>
      </XStack>
    </SectionCard>
  );
}
