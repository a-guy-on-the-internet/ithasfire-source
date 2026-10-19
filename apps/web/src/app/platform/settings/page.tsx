"use client";

import { useState, useCallback, type CSSProperties } from "react";
import { styled, useTheme, YStack, XStack } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";
import { Settings } from "lucide-react";

import { trpc } from "@/trpc";
import { ACCENT } from "@/lib/design-tokens";
import { FALLBACK_SUPPORT_EMAIL } from "@/lib/support-email";

// ─────────────────────────────────────────────────────────────────────────────
// Styled components
// ─────────────────────────────────────────────────────────────────────────────

const Container = styled(YStack, {
  padding: 32,
  gap: 32,
  maxWidth: 720,
  width: "100%",
  marginHorizontal: "auto",
});

const PageTitle = styled(Text, {
  tag: "h1",
  fontSize: 24,
  weight: "bold",
  color: "$color",
});

const Subtitle = styled(Text, {
  fontSize: 14,
  color: "$colorMuted",
});

const FieldGroup = styled(YStack, {
  gap: 6,
});

const Label = styled(Text, {
  fontSize: 14,
  weight: "semibold",
  color: "$color",
});

const Hint = styled(Text, {
  fontSize: 12,
  color: "$colorMuted",
});

const StatusText = styled(Text, {
  fontSize: 12,
});

// Swiss focus treatment: sharp orange border on focus, no glow ring.
const FOCUS_COLOR = ACCENT;

// Shared field chrome for the raw <input>/<select> controls. Border color is
// overridden per-control for the focus state.
const fieldStyle: CSSProperties = {
  flex: 1,
  border: "1px solid var(--borderColor, #211C16)",
  backgroundColor: "var(--surface, #FDFAF3)",
  paddingInline: 12,
  paddingBlock: 10,
  fontSize: 14,
  color: "inherit",
  borderRadius: 0,
};

// Announces save success/failure to assistive tech without stealing focus.
function StatusRegion({
  status,
  t,
}: {
  status: "idle" | "saved" | "error";
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <YStack aria-live="polite" minHeight={status === "idle" ? 0 : undefined}>
      {status === "saved" && (
        <StatusText tone="success">{String(t("admin.psSaved"))}</StatusText>
      )}
      {status === "error" && (
        <StatusText tone="error">{String(t("admin.psSaveError"))}</StatusText>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Setting row component
// ─────────────────────────────────────────────────────────────────────────────

type SettingKey =
  | "supportEmail"
  | "platformName"
  | "email:physicalAddress";

interface SettingRowProps {
  settingKey: SettingKey;
  label: string;
  hint: string;
  currentValue: string;
  onSave: (key: SettingKey, value: string) => Promise<void>;
  saving: boolean;
  placeholder?: string;
}

function SettingRow({
  settingKey,
  label,
  hint,
  currentValue,
  onSave,
  saving,
  placeholder,
}: SettingRowProps) {
  const t = useTranslations();
  const [value, setValue] = useState(currentValue);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [focused, setFocused] = useState(false);

  const isDirty = value !== currentValue;
  const fieldId = `setting-${settingKey}`;
  const hintId = `${fieldId}-hint`;

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    try {
      await onSave(settingKey, value);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  }, [settingKey, value, isDirty, saving, onSave]);

  return (
    <FieldGroup>
      <Label tag="label" htmlFor={fieldId}>
        {label}
      </Label>
      <Hint id={hintId}>{hint}</Hint>
      <XStack gap={8} alignItems="center">
        <input
          id={fieldId}
          aria-describedby={hintId}
          style={{
            ...fieldStyle,
            minHeight: 44,
            borderColor: focused ? FOCUS_COLOR : undefined,
          }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder ?? ""}
        />
        <Button
          variant="secondary"
          size="$4"
          disabled={!isDirty || saving}
          onPress={handleSave}
        >
          {saving ? String(t("admin.psSaving")) : String(t("admin.psSave"))}
        </Button>
      </XStack>
      <StatusRegion status={status} t={t} />
    </FieldGroup>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_CONFIG: Array<{
  key: SettingKey;
  labelKey: string;
  hintKey: string;
  defaultValue: string;
  placeholder?: string;
}> = [
  {
    key: "supportEmail",
    labelKey: "admin.psSupportEmail",
    hintKey: "admin.psSupportEmailHint",
    defaultValue: FALLBACK_SUPPORT_EMAIL,
  },
  {
    key: "platformName",
    labelKey: "admin.psPlatformName",
    hintKey: "admin.psPlatformNameHint",
    defaultValue: "Ithas Fire",
  },
  {
    key: "email:physicalAddress",
    labelKey: "admin.psPhysicalAddress",
    hintKey: "admin.psPhysicalAddressHint",
    defaultValue: "",
    placeholder: "123 Main St, Austin, TX 78701",
  },
];

export default function PlatformSettingsPage() {
  const t = useTranslations();
  const theme = useTheme();
  const utils = trpc.useUtils();

  const { data, isLoading, error } = trpc.platform.getSettings.useQuery(
    {},
    { staleTime: 30_000 },
  );
  const mutation = trpc.platform.updateSetting.useMutation();

  const [savingKey, setSavingKey] = useState<string | null>(null);

  const handleSave = useCallback(
    async (key: SettingKey, value: string) => {
      setSavingKey(key);
      try {
        await mutation.mutateAsync({ key, value });
        await utils.platform.getSettings.invalidate();
      } finally {
        setSavingKey(null);
      }
    },
    [mutation, utils],
  );

  const settingsMap = new Map(
    (data?.settings ?? []).map((s) => [s.key, s.value]),
  );

  if (isLoading) {
    return (
      <Container>
        <Text tone="muted">{String(t("admin.loading"))}</Text>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Text tone="error">{error.message}</Text>
      </Container>
    );
  }

  return (
    <Container>
      <YStack gap={8}>
        <XStack gap={8} alignItems="center">
          <Settings size={20} color={theme.color?.val} />
          <PageTitle>{String(t("admin.psTitle"))}</PageTitle>
        </XStack>
        <Subtitle>{String(t("admin.psSubtitle"))}</Subtitle>
      </YStack>

      <YStack gap={24}>
        {SETTINGS_CONFIG.map((cfg) => {
          return (
            <SettingRow
              key={cfg.key}
              settingKey={cfg.key}
              label={String(t(cfg.labelKey as any))}
              hint={String(t(cfg.hintKey as any))}
              currentValue={settingsMap.get(cfg.key) ?? cfg.defaultValue}
              onSave={handleSave}
              saving={savingKey === cfg.key}
              placeholder={cfg.placeholder}
            />
          );
        })}
      </YStack>
    </Container>
  );
}
