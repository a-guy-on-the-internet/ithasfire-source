"use client";

import { useCallback, useMemo, useState } from "react";
import { styled, XStack, YStack, Stack } from "tamagui";
import {
  Copy,
  Download,
  RotateCcw,
  Eye,
  Palette,
  Check,
  Save,
  Trash2,
} from "lucide-react";

import { Text, useNotify, useTranslations } from "@th/ui";
import {
  THEME_TOKEN_GROUPS,
  getStubThemeSnapshot,
  type ThemeTokenKey,
} from "@th/ui";
import { trpc } from "@/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// Layout primitives
// ─────────────────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
  padding: 32,
  gap: 32,
  maxWidth: 1200,
  width: "100%",
  marginHorizontal: "auto",
});

const Header = styled(XStack, {
  justifyContent: "space-between",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 16,
});

const GroupCard = styled(YStack, {
  borderWidth: 1,
  borderColor: "$borderColorSoft",
  borderRadius: 0,
  padding: 20,
  gap: 16,
  backgroundColor: "$surface",
});

const TokenRow = styled(XStack, {
  alignItems: "center",
  gap: 12,
  paddingVertical: 6,
  paddingHorizontal: 8,
  borderRadius: 0,
  hoverStyle: {
    backgroundColor: "$surfaceOverlay",
  },
});

const SwatchButton = styled(Stack, {
  width: 36,
  height: 36,
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColorSoft",
  cursor: "pointer",
  flexShrink: 0,
  overflow: "hidden",
  position: "relative",
});

const PreviewSection = styled(YStack, {
  borderWidth: 1,
  borderColor: "$borderColorSoft",
  borderRadius: 0,
  overflow: "hidden",
});

const PreviewRow = styled(XStack, {
  padding: 20,
  gap: 16,
  alignItems: "center",
  flexWrap: "wrap",
});

const PreviewCard = styled(YStack, {
  borderRadius: 0,
  padding: 16,
  gap: 8,
  minWidth: 160,
  flex: 1,
});

const ToolbarButton = styled(XStack, {
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColorSoft",
  gap: 6,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceOverlay",
  },
});

const PresetChip = styled(XStack, {
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 0,
  borderWidth: 1,
  gap: 8,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceOverlay",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Lucide takes a plain `color` string, so theme tokens reach it as `var()` with
// the Stub value as the SSR/first-paint fallback.
const MUTED_ICON = "var(--colorMuted, #5C544A)";
const SUCCESS_ICON = "var(--success, #166534)";
const DANGER_ICON = "var(--danger, #B91C1C)";

// Soft status tint for the "active preset" tag. There is no `successSoft` token
// (unlike `$accentSoft`), so this follows the design-system's sanctioned
// alpha recipe — color-mix over the token, never a concatenated alpha suffix.
const SUCCESS_TINT =
  "color-mix(in srgb, var(--success, #166534) 15%, transparent)";

/** Pretty-print a token key: "backgroundInverted" → "Background Inverted" */
const tokenLabel = (key: string): string =>
  key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();

/** Check if a value is a simple hex color (not rgba/transparent). */
const isHexColor = (v: string): boolean => /^#[0-9a-fA-F]{6,8}$/.test(v);

/** Convert a hex string to an input[type=color] compatible 6-char hex. */
const toInputHex = (v: string): string => {
  if (isHexColor(v)) return v.slice(0, 7);
  return "#000000";
};

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Platform theme editor.
 *
 * NOTE on raw hex: this surface has two distinct colour spaces, and only one of
 * them is themeable.
 *   • The editor's own CHROME (headings, labels, panels, borders, hovers) uses
 *     semantic tokens like any other component.
 *   • The EDITED VALUES are data — swatches, hex text inputs, per-token
 *     defaults, preset accents, the live-preview strip and its export payload
 *     all render literal hex BY DESIGN. A theme editor that tokenised its own
 *     preview would show you the current theme instead of the one you're
 *     editing. Raw hex below the "Preview" comment is therefore correct.
 */
export const ThemeEditor = () => {
  const { toast } = useNotify();
  const t = useTranslations();
  const utils = trpc.useUtils();

  const stubDefaults = useMemo(() => getStubThemeSnapshot(), []);

  // ── Presets data ────────────────────────────────────────────────────────
  const presetsQuery = trpc.platform.getThemePresets.useQuery(undefined, {
    staleTime: 30_000,
  });
  const presets = presetsQuery.data?.presets ?? [];
  const activeSlug = presetsQuery.data?.activeSlug ?? null;

  const saveMutation = trpc.platform.saveThemePreset.useMutation();
  const activateMutation = trpc.platform.activateThemePreset.useMutation();
  const deleteMutation = trpc.platform.deleteThemePreset.useMutation();

  // ── Editor state ────────────────────────────────────────────────────────
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [values, setValues] =
    useState<Record<ThemeTokenKey, string>>(stubDefaults);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveSlug, setSaveSlug] = useState("");
  const [saveName, setSaveName] = useState("");

  // Resolve which snapshot to compare against (stub base)
  const defaults = stubDefaults;

  const handlePresetSelect = useCallback(
    (slug: string) => {
      const preset = presets.find((p) => p.slug === slug);
      if (!preset) return;
      // Merge preset tokens on top of stub base
      const merged = { ...stubDefaults } as Record<ThemeTokenKey, string>;
      for (const [k, v] of Object.entries(preset.tokens)) {
        if (k in merged) (merged as Record<string, string>)[k] = v;
      }
      setValues(merged);
      setSelectedSlug(slug);
    },
    [presets, stubDefaults],
  );

  const handleChange = useCallback((key: ThemeTokenKey, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleReset = useCallback(() => {
    setValues(stubDefaults);
    setSelectedSlug(null);
    toast.info({
      id: "theme-reset",
      title: String(t("admin.teResetTitle")),
      message: String(t("admin.teResetMessage", { mode: "dark" })),
    });
  }, [stubDefaults, toast, t]);

  const diffCount = useMemo(() => {
    let count = 0;
    for (const key of Object.keys(values) as ThemeTokenKey[]) {
      if (values[key] !== defaults[key]) count++;
    }
    return count;
  }, [values, defaults]);

  const handleCopyJSON = useCallback(() => {
    const output = JSON.stringify(values, null, 2);
    navigator.clipboard.writeText(output).then(() => {
      toast.success({
        id: "theme-copied",
        title: String(t("admin.teCopiedTitle")),
        message: String(t("admin.teCopiedMessage")),
      });
    });
  }, [values, toast, t]);

  const handleExport = useCallback(() => {
    const output = JSON.stringify({ mode: "dark", tokens: values }, null, 2);
    const blob = new Blob([output], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ithasfire-theme-dark.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [values]);

  // ── Preset actions ──────────────────────────────────────────────────────
  const handleOpenSave = useCallback(() => {
    setSaveSlug(selectedSlug ?? "");
    setSaveName("");
    setShowSaveModal(true);
  }, [selectedSlug]);

  const handleSavePreset = useCallback(async () => {
    if (!saveSlug || !saveName) return;
    // Compute diff tokens vs stub base
    const tokens: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if ((stubDefaults as Record<string, string>)[k] !== v) {
        tokens[k] = v;
      }
    }
    try {
      await saveMutation.mutateAsync({
        preset: { slug: saveSlug, name: saveName, tokens },
      });
      toast.success({
        id: "preset-saved",
        title: String(t("admin.teSavePresetTitle")),
        message: String(t("admin.teSavePresetMessage", { name: saveName })),
      });
      setShowSaveModal(false);
      setSelectedSlug(saveSlug);
      void presetsQuery.refetch();
    } catch {
      // tRPC error will be shown by global handler
    }
  }, [
    saveSlug,
    saveName,
    values,
    stubDefaults,
    saveMutation,
    toast,
    t,
    presetsQuery,
  ]);

  const handleActivate = useCallback(
    async (slug: string | null) => {
      try {
        await activateMutation.mutateAsync({ slug });
        const preset = presets.find((p) => p.slug === slug);
        if (slug && preset) {
          toast.success({
            id: "preset-activated",
            title: String(t("admin.teActivateTitle")),
            message: String(
              t("admin.teActivateMessage", { name: preset.name }),
            ),
          });
        } else {
          toast.success({
            id: "preset-deactivated",
            title: String(t("admin.teDeactivateTitle")),
            message: String(t("admin.teDeactivateMessage")),
          });
        }
        void presetsQuery.refetch();
        // Invalidate the public theme query so ActiveThemeInjector picks up the change
        void utils.platform.getActiveTheme.invalidate();
      } catch {
        // handled by global error
      }
    },
    [activateMutation, presets, toast, t, presetsQuery, utils],
  );

  const handleDeletePreset = useCallback(
    async (slug: string) => {
      const preset = presets.find((p) => p.slug === slug);
      try {
        await deleteMutation.mutateAsync({ slug });
        toast.success({
          id: "preset-deleted",
          title: String(t("admin.teDeletePresetTitle")),
          message: String(
            t("admin.teDeletePresetMessage", { name: preset?.name ?? slug }),
          ),
        });
        if (selectedSlug === slug) {
          setSelectedSlug(null);
          setValues(stubDefaults);
        }
        void presetsQuery.refetch();
      } catch {
        // handled by global error
      }
    },
    [
      deleteMutation,
      presets,
      selectedSlug,
      stubDefaults,
      toast,
      t,
      presetsQuery,
    ],
  );

  const builtInPresets = presets.filter((p) => p.builtIn);
  const customPresets = presets.filter((p) => !p.builtIn);

  return (
    <PageContainer>
      {/* Header */}
      <Header>
        <YStack gap={4}>
          <Text style={{ fontSize: 24, fontWeight: "700" }}>
            {String(t("admin.teTitle"))}
          </Text>
          <Text tone="muted" style={{ fontSize: 14 }}>
            {String(t("admin.teSubtitle", { mode: "dark" }))}
            {diffCount > 0
              ? ` ${String(t("admin.teChangesPending", { count: diffCount }))}`
              : ""}
          </Text>
        </YStack>

        <XStack gap={8} flexWrap="wrap">
          <ToolbarButton onPress={handleReset}>
            <RotateCcw size={14} color={MUTED_ICON} />
            <Text tone="muted" style={{ fontSize: 13 }}>
              {String(t("admin.teReset"))}
            </Text>
          </ToolbarButton>

          <ToolbarButton onPress={handleCopyJSON}>
            <Copy size={14} color={MUTED_ICON} />
            <Text tone="muted" style={{ fontSize: 13 }}>
              {String(t("admin.teCopyJson"))}
            </Text>
          </ToolbarButton>

          <ToolbarButton onPress={handleExport}>
            <Download size={14} color={MUTED_ICON} />
            <Text tone="muted" style={{ fontSize: 13 }}>
              {String(t("admin.teExport"))}
            </Text>
          </ToolbarButton>

          <ToolbarButton onPress={handleOpenSave}>
            <Save size={14} color={MUTED_ICON} />
            <Text tone="muted" style={{ fontSize: 13 }}>
              {String(t("admin.teSavePreset"))}
            </Text>
          </ToolbarButton>
        </XStack>
      </Header>

      {/* Preset selector */}
      <GroupCard>
        <XStack gap={8} alignItems="center">
          <Palette size={16} color={MUTED_ICON} />
          <Text tone="muted" style={{ fontSize: 14, fontWeight: "700" }}>
            {String(t("admin.tePresetLabel"))}
          </Text>
        </XStack>

        {/* Built-in presets */}
        {builtInPresets.length > 0 && (
          <YStack gap={8}>
            <Text
              tone="muted"
              style={{
                fontSize: 12,
                fontWeight: "500",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {String(t("admin.tePresetBuiltInSection"))}
            </Text>
            <XStack gap={8} flexWrap="wrap">
              {builtInPresets.map((preset) => {
                const isSelected = selectedSlug === preset.slug;
                const isActive =
                  activeSlug === preset.slug ||
                  (activeSlug === null && preset.slug === "default");
                const accentColor = preset.tokens.accent ?? "#3B82F6";
                return (
                  <PresetChip
                    key={preset.slug}
                    onPress={() => handlePresetSelect(preset.slug)}
                    borderColor={isSelected ? accentColor : "$borderColorSoft"}
                    backgroundColor={
                      isSelected ? "$surfaceMuted" : "transparent"
                    }
                  >
                    <Stack
                      width={12}
                      height={12}
                      borderRadius={0}
                      backgroundColor={accentColor}
                    />
                    <Text
                      tone={isSelected ? "default" : "muted"}
                      style={{
                        fontSize: 13,
                        fontWeight: isSelected ? "700" : "400",
                      }}
                    >
                      {preset.name}
                    </Text>
                    {isActive && (
                      <Stack
                        paddingHorizontal={5}
                        paddingVertical={1}
                        borderRadius={0}
                        backgroundColor={SUCCESS_TINT}
                      >
                        <Text
                          tone="success"
                          style={{ fontSize: 10, fontWeight: "700" }}
                        >
                          {String(t("admin.teActiveTag"))}
                        </Text>
                      </Stack>
                    )}
                  </PresetChip>
                );
              })}
            </XStack>
          </YStack>
        )}

        {/* Custom presets */}
        {customPresets.length > 0 && (
          <YStack gap={8}>
            <Text
              tone="muted"
              style={{
                fontSize: 12,
                fontWeight: "500",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {String(t("admin.tePresetCustomSection"))}
            </Text>
            <XStack gap={8} flexWrap="wrap">
              {customPresets.map((preset) => {
                const isSelected = selectedSlug === preset.slug;
                const isActive = activeSlug === preset.slug;
                const accentColor = preset.tokens.accent ?? "#3B82F6";
                return (
                  <PresetChip
                    key={preset.slug}
                    onPress={() => handlePresetSelect(preset.slug)}
                    borderColor={isSelected ? accentColor : "$borderColorSoft"}
                    backgroundColor={
                      isSelected ? "$surfaceMuted" : "transparent"
                    }
                  >
                    <Stack
                      width={12}
                      height={12}
                      borderRadius={0}
                      backgroundColor={accentColor}
                    />
                    <Text
                      tone={isSelected ? "default" : "muted"}
                      style={{
                        fontSize: 13,
                        fontWeight: isSelected ? "700" : "400",
                      }}
                    >
                      {preset.name}
                    </Text>
                    {isActive && (
                      <Stack
                        paddingHorizontal={5}
                        paddingVertical={1}
                        borderRadius={0}
                        backgroundColor={SUCCESS_TINT}
                      >
                        <Text
                          tone="success"
                          style={{ fontSize: 10, fontWeight: "700" }}
                        >
                          {String(t("admin.teActiveTag"))}
                        </Text>
                      </Stack>
                    )}
                    <Stack
                      cursor="pointer"
                      opacity={0.4}
                      hoverStyle={{ opacity: 1 }}
                      onPress={(e: { stopPropagation: () => void }) => {
                        e.stopPropagation();
                        void handleDeletePreset(preset.slug);
                      }}
                      paddingHorizontal={2}
                    >
                      <Trash2 size={12} color={DANGER_ICON} />
                    </Stack>
                  </PresetChip>
                );
              })}
            </XStack>
          </YStack>
        )}

        {/* Activate / deactivate button */}
        {selectedSlug && (
          <XStack gap={8}>
            {activeSlug === selectedSlug ||
            (activeSlug === null && selectedSlug === "default") ? (
              <ToolbarButton onPress={() => void handleActivate(null)}>
                <RotateCcw size={14} color={MUTED_ICON} />
                <Text tone="muted" style={{ fontSize: 13 }}>
                  {String(t("admin.teDeactivate"))}
                </Text>
              </ToolbarButton>
            ) : (
              <ToolbarButton onPress={() => void handleActivate(selectedSlug)}>
                <Check size={14} color={SUCCESS_ICON} />
                <Text tone="success" style={{ fontSize: 13 }}>
                  {String(t("admin.teActivate"))}
                </Text>
              </ToolbarButton>
            )}
          </XStack>
        )}
      </GroupCard>

      {/* Save Preset Modal (inline) */}
      {showSaveModal && (
        <GroupCard>
          <Text style={{ fontSize: 16, fontWeight: "700" }}>
            {String(t("admin.teSavePreset"))}
          </Text>
          <YStack gap={12}>
            <YStack gap={4}>
              <Text tone="muted" style={{ fontSize: 12 }}>
                {String(t("admin.teSavePresetSlug"))}
              </Text>
              <input
                type="text"
                value={saveSlug}
                onChange={(e) =>
                  setSaveSlug(
                    e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                  )
                }
                placeholder="my-custom-theme"
                spellCheck={false}
                style={{
                  padding: "8px 12px",
                  fontSize: 14,
                  fontFamily: "var(--font-mono, monospace)",
                  backgroundColor: "var(--surfaceMuted, #EFE7D6)",
                  border:
                    "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
                  borderRadius: 0,
                  color: "var(--color, #211C16)",
                  width: "100%",
                  maxWidth: 400,
                }}
              />
            </YStack>
            <YStack gap={4}>
              <Text tone="muted" style={{ fontSize: 12 }}>
                {String(t("admin.teSavePresetName"))}
              </Text>
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="My Custom Theme"
                spellCheck={false}
                style={{
                  padding: "8px 12px",
                  fontSize: 14,
                  backgroundColor: "var(--surfaceMuted, #EFE7D6)",
                  border:
                    "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
                  borderRadius: 0,
                  color: "var(--color, #211C16)",
                  width: "100%",
                  maxWidth: 400,
                }}
              />
            </YStack>
            <XStack gap={8}>
              <ToolbarButton onPress={() => setShowSaveModal(false)}>
                <Text tone="muted" style={{ fontSize: 13 }}>
                  {String(t("admin.teSavePresetCancel"))}
                </Text>
              </ToolbarButton>
              <ToolbarButton
                onPress={() => void handleSavePreset()}
                opacity={!saveSlug || !saveName ? 0.4 : 1}
              >
                <Save size={14} color={SUCCESS_ICON} />
                <Text tone="success" style={{ fontSize: 13 }}>
                  {String(t("admin.teSavePresetConfirm"))}
                </Text>
              </ToolbarButton>
            </XStack>
          </YStack>
        </GroupCard>
      )}

      {/* Preview */}
      <YStack gap={8}>
        <XStack gap={6} alignItems="center">
          <Eye size={16} color={MUTED_ICON} />
          <Text tone="muted" style={{ fontSize: 14, fontWeight: "700" }}>
            {String(t("admin.teLivePreview"))}
          </Text>
        </XStack>

        {/* Everything inside PreviewSection is DATA-driven (`values.*`) — it
            renders the theme being EDITED, not the app theme. The literal
            #FFFFFF / rgba(255,255,255,…) foregrounds below are the preview's
            assumed on-fill colors for the user's own accent/danger/strong
            swatches, and must stay literal. */}
        <PreviewSection>
          {/* Page background strip */}
          <PreviewRow backgroundColor={values.background}>
            <PreviewCard
              backgroundColor={values.surface}
              borderWidth={2}
              borderColor={values.borderColor}
            >
              <Text
                style={{ fontSize: 13, fontWeight: "700", color: values.color }}
              >
                {String(t("admin.teSurfaceCard"))}
              </Text>
              <Text style={{ fontSize: 12, color: values.colorMuted }}>
                {String(t("admin.teSurfaceCardDesc"))}
              </Text>
            </PreviewCard>

            <PreviewCard backgroundColor={values.surfaceMuted}>
              <Text
                style={{ fontSize: 13, fontWeight: "700", color: values.color }}
              >
                {String(t("admin.teMutedSurface"))}
              </Text>
              <Text style={{ fontSize: 12, color: values.colorMuted }}>
                {String(t("admin.teMutedSurfaceDesc"))}
              </Text>
            </PreviewCard>

            <PreviewCard backgroundColor={values.backgroundStrong}>
              <Text
                style={{ fontSize: 13, fontWeight: "700", color: "#FFFFFF" }}
              >
                {String(t("admin.teStrongBg"))}
              </Text>
              <Text style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                {String(t("admin.teStrongBgDesc"))}
              </Text>
            </PreviewCard>
          </PreviewRow>

          {/* Button preview strip */}
          <PreviewRow backgroundColor={values.background}>
            <YStack gap={8}>
              <Text
                style={{
                  fontSize: 12,
                  color: values.colorMuted,
                  fontWeight: "500",
                }}
              >
                {String(t("admin.teButtons"))}
              </Text>
              <XStack gap={8} flexWrap="wrap">
                <Stack
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={0}
                  backgroundColor={values.accent}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "700",
                      color: "#FFFFFF",
                    }}
                  >
                    {String(t("admin.tePrimary"))}
                  </Text>
                </Stack>
                <Stack
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={0}
                  borderWidth={2}
                  borderColor={values.accent}
                  backgroundColor="transparent"
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "700",
                      color: values.accent,
                    }}
                  >
                    {String(t("admin.teOutlined"))}
                  </Text>
                </Stack>
                <Stack
                  paddingHorizontal={16}
                  paddingVertical={8}
                  borderRadius={0}
                  backgroundColor={values.danger}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "700",
                      color: "#FFFFFF",
                    }}
                  >
                    {String(t("admin.teDestructive"))}
                  </Text>
                </Stack>
              </XStack>
            </YStack>

            <YStack gap={8}>
              <Text
                style={{
                  fontSize: 12,
                  color: values.colorMuted,
                  fontWeight: "500",
                }}
              >
                {String(t("admin.teAccentsBorders"))}
              </Text>
              <XStack gap={8} alignItems="center" flexWrap="wrap">
                <Stack
                  width={40}
                  height={40}
                  borderRadius={0}
                  backgroundColor={values.accent}
                />
                <Stack
                  width={40}
                  height={40}
                  borderRadius={0}
                  backgroundColor={values.accentHard}
                />
                <Stack
                  width={40}
                  height={40}
                  borderRadius={0}
                  borderWidth={2}
                  borderColor={values.borderColorHover}
                  backgroundColor="transparent"
                />
                <Stack
                  width={40}
                  height={40}
                  borderRadius={0}
                  backgroundColor={values.accentSoft}
                />
              </XStack>
            </YStack>

            <YStack gap={8}>
              <Text
                style={{
                  fontSize: 12,
                  color: values.colorMuted,
                  fontWeight: "500",
                }}
              >
                {String(t("admin.teStatus"))}
              </Text>
              <XStack gap={6} flexWrap="wrap">
                {(["success", "warning", "danger", "info"] as const).map(
                  (s) => (
                    <Stack
                      key={s}
                      paddingHorizontal={10}
                      paddingVertical={4}
                      borderRadius={0}
                      backgroundColor={values[s]}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: "700",
                          color: "#FFFFFF",
                        }}
                      >
                        {s}
                      </Text>
                    </Stack>
                  ),
                )}
              </XStack>
            </YStack>
          </PreviewRow>
        </PreviewSection>
      </YStack>

      {/* Token Groups */}
      <YStack gap={20}>
        {THEME_TOKEN_GROUPS.map((group) => (
          <GroupCard key={group.label}>
            <Text style={{ fontSize: 16, fontWeight: "700" }}>
              {group.label}
            </Text>
            <YStack gap={2}>
              {group.tokens.map((key) => {
                const value = values[key];
                const defaultValue = defaults[key];
                const changed = value !== defaultValue;
                const hex = isHexColor(value);

                return (
                  <TokenRow key={key}>
                    {/* Color swatch / picker */}
                    <SwatchButton
                      backgroundColor={value}
                      {...(hex ? {} : { borderStyle: "dashed" as never })}
                    >
                      {hex ? (
                        <input
                          type="color"
                          value={toInputHex(value)}
                          onChange={(e) => handleChange(key, e.target.value)}
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            opacity: 0,
                            cursor: "pointer",
                            border: "none",
                          }}
                        />
                      ) : null}
                    </SwatchButton>

                    {/* Label */}
                    <YStack flex={1} gap={2}>
                      <XStack gap={6} alignItems="center">
                        <Text style={{ fontSize: 13, fontWeight: "500" }}>
                          {tokenLabel(key)}
                        </Text>
                        {changed ? (
                          <Stack
                            paddingHorizontal={6}
                            paddingVertical={1}
                            borderRadius={0}
                            backgroundColor="$accentSoft"
                          >
                            <Text
                              tone="accent"
                              style={{ fontSize: 10, fontWeight: "700" }}
                            >
                              {String(t("admin.teChanged"))}
                            </Text>
                          </Stack>
                        ) : null}
                      </XStack>
                      <Text tone="muted" style={{ fontSize: 11 }}>
                        {key}
                      </Text>
                    </YStack>

                    {/* Value input */}
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => handleChange(key, e.target.value)}
                      spellCheck={false}
                      style={{
                        width: 180,
                        padding: "6px 10px",
                        fontSize: 13,
                        fontFamily: "var(--font-mono, monospace)",
                        backgroundColor: "var(--surfaceMuted, #EFE7D6)",
                        border: changed
                          ? "1px solid color-mix(in srgb, var(--accent, #E2481D) 40%, transparent)"
                          : "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
                        borderRadius: 0,
                        color: "var(--color, #211C16)",
                      }}
                    />

                    {/* Reset single token */}
                    {changed ? (
                      <Stack
                        cursor="pointer"
                        opacity={0.5}
                        hoverStyle={{ opacity: 1 }}
                        onPress={() => handleChange(key, defaultValue)}
                        paddingHorizontal={4}
                      >
                        <RotateCcw size={14} color={MUTED_ICON} />
                      </Stack>
                    ) : (
                      <Stack width={22} />
                    )}
                  </TokenRow>
                );
              })}
            </YStack>
          </GroupCard>
        ))}
      </YStack>
    </PageContainer>
  );
};

ThemeEditor.displayName = "ThemeEditor";
