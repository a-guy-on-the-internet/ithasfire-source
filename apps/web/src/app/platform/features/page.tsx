"use client";

import { useState, useCallback, useMemo } from "react";
import { styled, YStack, XStack } from "tamagui";
import { Text, useTranslations, Switch } from "@th/ui";
import { Check, ToggleLeft } from "lucide-react";

import { ACCENT } from "@/lib/design-tokens";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { trpc } from "@/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GateConfig {
  slug: string;
  /** DB setting key, e.g. "feature:promos" */
  settingKey: string;
  labelKey: string;
  descKey: string;
}

const GATE_CONFIGS: GateConfig[] = [
  {
    slug: "travelTime",
    settingKey: "feature:travelTime",
    labelKey: "admin.fgGateTravelTime",
    descKey: "admin.fgGateTravelTimeDesc",
  },
  {
    slug: "createEvents",
    settingKey: "feature:createEvents",
    labelKey: "admin.fgGateCreateEvents",
    descKey: "admin.fgGateCreateEventsDesc",
  },
  {
    slug: "buyTickets",
    settingKey: "feature:buyTickets",
    labelKey: "admin.fgGateBuyTickets",
    descKey: "admin.fgGateBuyTicketsDesc",
  },
  {
    slug: "promos",
    settingKey: "feature:promos",
    labelKey: "admin.fgGatePromos",
    descKey: "admin.fgGatePromosDesc",
  },
  {
    slug: "maintenanceMode",
    settingKey: "feature:maintenanceMode",
    labelKey: "admin.fgGateMaintenanceMode",
    descKey: "admin.fgGateMaintenanceModeDesc",
  },
  {
    slug: "entityPageEditor",
    settingKey: "feature:entityPageEditor",
    labelKey: "admin.fgGateEntityPageEditor",
    descKey: "admin.fgGateEntityPageEditorDesc",
  },
  {
    slug: "humanProfilesPublic",
    settingKey: "feature:humanProfilesPublic",
    labelKey: "admin.fgGateHumanProfilesPublic",
    descKey: "admin.fgGateHumanProfilesPublicDesc",
  },
  {
    slug: "resale",
    settingKey: "feature:resale",
    labelKey: "admin.fgGateResale",
    descKey: "admin.fgGateResaleDesc",
  },
  {
    slug: "arrivalAreas",
    settingKey: "feature:arrivalAreas",
    labelKey: "admin.fgGateArrivalAreas",
    descKey: "admin.fgGateArrivalAreasDesc",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hero style types
// ─────────────────────────────────────────────────────────────────────────────

type HeroStyle = "map" | "carousel" | "both";

const HERO_OPTIONS: Array<{
  value: HeroStyle;
  labelKey: string;
  descKey: string;
}> = [
  {
    value: "map",
    labelKey: "admin.heroStyleMap",
    descKey: "admin.heroStyleMapDesc",
  },
  {
    value: "carousel",
    labelKey: "admin.heroStyleCarousel",
    descKey: "admin.heroStyleCarouselDesc",
  },
  {
    value: "both",
    labelKey: "admin.heroStyleBoth",
    descKey: "admin.heroStyleBothDesc",
  },
];

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

const GateCard = styled(XStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 20,
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  backgroundColor: "$background",
});

const GateInfo = styled(YStack, {
  flex: 1,
  gap: 4,
});

const GateName = styled(Text, {
  fontSize: 15,
  weight: "bold",
  color: "$color",
  textTransform: "uppercase",
  letterSpacing: 0.5,
});

const GateDesc = styled(Text, {
  fontSize: 13,
  color: "$colorMuted",
});

const StatusBadge = styled(XStack, {
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 0,
  borderWidth: 1,
  variants: {
    active: {
      true: {
        backgroundColor: "$green3",
        borderColor: "$green8",
      },
      false: {
        backgroundColor: "$red3",
        borderColor: "$red8",
      },
    },
  } as const,
});

const StatusText = styled(Text, {
  fontSize: 11,
  weight: "bold",
  textTransform: "uppercase",
  letterSpacing: 1,
  variants: {
    active: {
      true: { color: "$green11" },
      false: { color: "$red11" },
    },
  } as const,
});

const SavingText = styled(Text, {
  fontSize: 11,
  color: "$colorMuted",
});

const LayoutCard = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 20,
  gap: 16,
  backgroundColor: "$background",
});

const HeroChip = styled(YStack, {
  flex: 1,
  minWidth: 220,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 14,
  gap: 8,
  cursor: "pointer",
  backgroundColor: "$background",
  variants: {
    selected: {
      true: {
        backgroundColor: "rgba(226, 72, 29, 0.12)",
        borderColor: ACCENT,
        boxShadow: `inset 0 0 0 1px ${ACCENT}`,
      },
    },
  } as const,
  hoverStyle: {
    opacity: 0.92,
    borderColor: ACCENT,
  },
});

const SelectedHeroBadge = styled(XStack, {
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  paddingHorizontal: 8,
  paddingVertical: 4,
  borderRadius: 0,
  // The #B93312 rung (`$brandSecondaryHover`), NOT `$accent`: this badge carries a small label, and
  // #E2481D has no AA foreground either way (white 4.06:1, ink 4.38:1). White on the rung is 5.92:1.
  // The old comment claimed "ink on orange" but set `$onBrandSecondary`, which is white on Stub.
  backgroundColor: "$brandSecondaryHover",
  // @ts-expect-error — color valid on web element (inherits to label/icon)
  color: "$onBrandSecondary",
  alignSelf: "flex-start",
});

// Tamagui's YStack doesn't declare onKeyDown in its types, but forwards unknown
// props to the underlying DOM element on web. Cast to accept keyboard events.
const HeroChipInteractive = HeroChip as React.ComponentType<
  React.ComponentPropsWithRef<typeof HeroChip> & {
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  }
>;

// ─────────────────────────────────────────────────────────────────────────────
// Hero style selector
// ─────────────────────────────────────────────────────────────────────────────

interface HeroStyleSelectorProps {
  currentValue: HeroStyle;
  onSave: (v: HeroStyle) => Promise<void>;
}

function HeroStyleSelector({ currentValue, onSave }: HeroStyleSelectorProps) {
  const t = useTranslations();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "saved" | "error">("idle");

  const handleSelect = useCallback(
    async (value: HeroStyle) => {
      if (saving || value === currentValue) return;
      setSaving(true);
      setFeedback("idle");
      try {
        await onSave(value);
        setFeedback("saved");
        setTimeout(() => setFeedback("idle"), 2000);
      } catch {
        setFeedback("error");
      } finally {
        setSaving(false);
      }
    },
    [currentValue, onSave, saving],
  );

  return (
    <LayoutCard>
      <YStack gap={4}>
        <GateName>{t("admin.heroStyleTitle") as string}</GateName>
        <GateDesc>{t("admin.heroStyleDesc") as string}</GateDesc>
      </YStack>
      <XStack
        gap={12}
        flexWrap="wrap"
        role="radiogroup"
        aria-label={t("admin.heroStyleTitle") as string}
      >
        {HERO_OPTIONS.map((opt) => (
          <HeroChipInteractive
            key={opt.value}
            selected={currentValue === opt.value}
            opacity={saving ? 0.5 : 1}
            onPress={() => handleSelect(opt.value)}
            role="radio"
            aria-checked={currentValue === opt.value}
            tabIndex={0}
            onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                handleSelect(opt.value);
              }
            }}
          >
            <XStack alignItems="center" justifyContent="space-between" gap={8}>
              <Text
                fontSize={13}
                weight="bold"
                textTransform="uppercase"
                letterSpacing={0.5}
                color="$color"
              >
                {t(opt.labelKey) as string}
              </Text>
              {currentValue === opt.value && (
                <SelectedHeroBadge aria-hidden>
                  <Check size={12} />
                  <Text
                    fontSize={10}
                    weight="bold"
                    tone="inherit"
                    textTransform="uppercase"
                  >
                    {t("admin.heroStyleActiveBadge") as string}
                  </Text>
                </SelectedHeroBadge>
              )}
            </XStack>
            <Text
              fontSize={11}
              color={currentValue === opt.value ? "$color" : "$colorMuted"}
            >
              {t(opt.descKey) as string}
            </Text>
          </HeroChipInteractive>
        ))}
      </XStack>
      {(saving || feedback !== "idle") && (
        <XStack gap={12}>
          {saving && (
            <SavingText>{t("admin.heroStyleSaving") as string}</SavingText>
          )}
          {feedback === "saved" && (
            <Text fontSize={11} tone="success">
              {t("admin.heroStyleSaved") as string}
            </Text>
          )}
          {feedback === "error" && (
            <Text fontSize={11} tone="error">
              {t("admin.heroStyleError") as string}
            </Text>
          )}
        </XStack>
      )}
    </LayoutCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate row
// ─────────────────────────────────────────────────────────────────────────────

interface GateRowProps {
  config: GateConfig;
  currentValue: boolean;
  hasDbOverride: boolean;
  onToggle: (settingKey: string, newValue: boolean) => Promise<void>;
}

function GateRow({
  config,
  currentValue,
  hasDbOverride,
  onToggle,
}: GateRowProps) {
  const t = useTranslations();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "saved" | "error">("idle");

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (saving) return;
      setSaving(true);
      setFeedback("idle");
      try {
        await onToggle(config.settingKey, next);
        setFeedback("saved");
        setTimeout(() => setFeedback("idle"), 2000);
      } catch {
        setFeedback("error");
      } finally {
        setSaving(false);
      }
    },
    [config.settingKey, onToggle, saving],
  );

  return (
    <GateCard>
      <GateInfo>
        <XStack alignItems="center" gap="$2">
          <GateName>{t(config.labelKey) as string}</GateName>
          <StatusBadge active={currentValue}>
            <StatusText active={currentValue}>
              {currentValue
                ? (t("admin.fgEnabled") as string)
                : (t("admin.fgDisabled") as string)}
            </StatusText>
          </StatusBadge>
          {!hasDbOverride && (
            <Text fontSize={10} tone="muted" fontStyle="italic">
              {t("admin.fgEnvDefault") as string}
            </Text>
          )}
        </XStack>
        <GateDesc>{t(config.descKey) as string}</GateDesc>
        {saving && <SavingText>{t("admin.fgSaving") as string}</SavingText>}
        {feedback === "saved" && (
          <Text fontSize={11} tone="success">
            {t("admin.fgSaved") as string}
          </Text>
        )}
        {feedback === "error" && (
          <Text fontSize={11} tone="error">
            {t("admin.fgError") as string}
          </Text>
        )}
      </GateInfo>
      <Switch
        checked={currentValue}
        onCheckedChange={handleToggle}
        disabled={saving}
        saving={saving}
        aria-label={`Toggle ${config.slug}`}
      />
    </GateCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformFeaturesPage() {
  const t = useTranslations();
  const utils = trpc.useUtils();

  // Read current resolved gate values
  const gatesQuery = trpc.features.getFeatureGates.useQuery(undefined, {
    staleTime: 10_000,
  });

  // Read raw platform settings to determine which gates have DB overrides
  const settingsQuery = trpc.platform.getSettings.useQuery(
    {},
    {
      staleTime: 10_000,
    },
  );

  const updateMutation = trpc.platform.updateSetting.useMutation();

  // Current hero style
  const ALLOWED_HERO_STYLES: HeroStyle[] = ["map", "carousel", "both"];
  const currentHeroStyle = useMemo((): HeroStyle => {
    const settings = settingsQuery.data?.settings;
    if (!settings) return "map";
    const raw = settings.find(
      (s: { key: string }) => s.key === "homepage:heroStyle",
    )?.value;
    return ALLOWED_HERO_STYLES.includes(raw as HeroStyle)
      ? (raw as HeroStyle)
      : "map";
  }, [settingsQuery.data]);

  // Compute which gates have explicit DB overrides
  const dbOverrides = useMemo(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings) return new Set<string>();
    return new Set(
      settings
        .filter((s: { key: string }) => s.key.startsWith("feature:"))
        .map((s: { key: string }) => s.key),
    );
  }, [settingsQuery.data]);

  const handleToggle = useCallback(
    async (settingKey: string, newValue: boolean) => {
      await updateMutation.mutateAsync({
        key: settingKey as any,
        value: String(newValue),
      });
      // Invalidate both queries so the UI refreshes
      await Promise.all([
        utils.features.getFeatureGates.invalidate(),
        utils.platform.getSettings.invalidate(),
      ]);
    },
    [updateMutation, utils],
  );

  const handleHeroStyleSave = useCallback(
    async (value: HeroStyle) => {
      await updateMutation.mutateAsync({
        key: "homepage:heroStyle" as any,
        value,
      });
      // Only settings needs invalidation — hero style is not a feature gate
      utils.platform.getSettings
        .invalidate()
        .catch(traceIgnoredError("platform.features.invalidate"));
    },
    [updateMutation, utils],
  );

  const gates = gatesQuery.data;

  return (
    <Container>
      <YStack gap="$1">
        <XStack alignItems="center" gap="$3">
          <ToggleLeft size={24} />
          <PageTitle>{t("admin.fgTitle") as string}</PageTitle>
        </XStack>
        <Subtitle>{t("admin.fgSubtitle") as string}</Subtitle>
      </YStack>

      <HeroStyleSelector
        currentValue={currentHeroStyle}
        onSave={handleHeroStyleSave}
      />

      <YStack gap={16}>
        {GATE_CONFIGS.map((config) => (
          <GateRow
            key={config.slug}
            config={config}
            currentValue={
              gates
                ? ((gates as Record<string, boolean>)[config.slug] ?? true)
                : true
            }
            hasDbOverride={dbOverrides.has(config.settingKey)}
            onToggle={handleToggle}
          />
        ))}
      </YStack>
    </Container>
  );
}
