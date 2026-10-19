"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { YStack, XStack } from "tamagui";
import {
  Text,
  CardSurface,
  LabeledTextInput,
  StyledSelect,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Palette } from "lucide-react";

import { useRegisterPageSettingsSave } from "./page-settings-save";

import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  ENTITY_PAGE_FONT_KEYS,
  ENTITY_PAGE_LAYOUT_KEYS,
  normalizeEntityPageFontKey,
  normalizeEntityPageLayoutKey,
  resolveDefaultEntityPageLayoutKey,
  type EntityPageFontKey,
  type EntityPageLayoutKey,
} from "@th/core/use-cases/entity-pages";
import { isSafeThemeColor } from "@th/core/lib/theme-color";
import { loneColorUnmeasurable } from "./theme-pair-hint";

/**
 * The swatch's background, or undefined when the value is not CSS colour
 * syntax: a row saved before the server checked colours would otherwise go
 * into the inline style as is (on SSR too).
 */
function swatchColor(value: string): string | undefined {
  const trimmed = value.trim();
  return isSafeThemeColor(trimmed) ? trimmed : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

interface ThemeData {
  colorPrimary: string | null;
  colorBg: string | null;
  colorText: string | null;
  fontKey: string | null;
  layoutKey: string | null;
}

function normalizeFontKey(
  fontKey: string | null | undefined,
): EntityPageFontKey {
  return normalizeEntityPageFontKey(fontKey) ?? "montserrat";
}

/**
 * Resolve the layout to show as selected. An explicit stored value wins;
 * otherwise fall back to the owner-type default so the editor mirrors what the
 * public page actually renders (PLACE → "standard").
 */
function normalizeLayoutKey(
  layoutKey: string | null | undefined,
  ownerType: PageOwnerType,
): EntityPageLayoutKey {
  return (
    normalizeEntityPageLayoutKey(layoutKey) ??
    resolveDefaultEntityPageLayoutKey(ownerType)
  );
}

const FONT_LABEL_KEYS: Record<EntityPageFontKey, string> = {
  montserrat: "admin.peThemeFontMontserrat",
  system: "admin.peThemeFontSystem",
  serif: "admin.peThemeFontSerif",
  mono: "admin.peThemeFontMono",
  editorial: "admin.peThemeFontEditorial",
  condensed: "admin.peThemeFontCondensed",
};

const LAYOUT_LABEL_KEYS: Record<EntityPageLayoutKey, string> = {
  standard: "admin.peThemeLayoutStandard",
  stack: "admin.peThemeLayoutStack",
  grid: "admin.peThemeLayoutGrid",
};

const LAYOUT_HELP_KEYS: Record<EntityPageLayoutKey, string> = {
  standard: "admin.peThemeLayoutStandardHelp",
  stack: "admin.peThemeLayoutFreeformHelp",
  grid: "admin.peThemeLayoutFreeformHelp",
};

export interface PageThemeEditorProps {
  theme: ThemeData | null;
  ownerType: PageOwnerType;
  ownerId: string;
  onSaved?: () => void;
  /**
   * Drop the `CardSurface` so the form sits inside a host section that
   * already draws the frame (strict Swiss: no card inside a card). The venue
   * settings page's "Public page" section is the one caller; the page
   * editor's own settings drawer keeps the default.
   */
  embedded?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PageThemeEditor({
  theme,
  ownerType,
  ownerId,
  onSaved,
  embedded = false,
}: PageThemeEditorProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // Freeform block editor gate. Loading/undefined → treat as OFF (locked): only
  // the "standard" layout is offered and the layout picker is disabled.
  const { gates } = useFeatureGates();
  const editorGateOn = gates?.entityPageEditor === true;

  // ── Form state ──────────────────────────────────────────────
  const [colorPrimary, setColorPrimary] = useState(theme?.colorPrimary ?? "");
  const [colorBg, setColorBg] = useState(theme?.colorBg ?? "");
  const [colorText, setColorText] = useState(theme?.colorText ?? "");
  const [fontKey, setFontKey] = useState<EntityPageFontKey>(() =>
    normalizeFontKey(theme?.fontKey),
  );
  const [layoutKey, setLayoutKey] = useState<EntityPageLayoutKey>(() =>
    normalizeLayoutKey(theme?.layoutKey, ownerType),
  );

  const fontOptions = useMemo(
    () =>
      ENTITY_PAGE_FONT_KEYS.map((value) => ({
        value,
        label: String(t(FONT_LABEL_KEYS[value])),
      })),
    [t],
  );

  // "standard" is now the default template for every owner type, so offer it to
  // all. When the freeform editor is locked, offer ONLY "standard".
  const layoutOptions = useMemo(() => {
    const keys: readonly EntityPageLayoutKey[] = editorGateOn
      ? ENTITY_PAGE_LAYOUT_KEYS
      : ["standard"];
    return keys.map((value) => ({
      value,
      label: String(t(LAYOUT_LABEL_KEYS[value])),
    }));
  }, [t, editorGateOn]);

  // When locked, always DISPLAY "standard" (the forced experience) without
  // mutating the stored `layoutKey` — a legacy grid/stack page is preserved and
  // returns to freeform once the gate is re-enabled.
  const displayLayoutKey: EntityPageLayoutKey = editorGateOn
    ? layoutKey
    : "standard";

  // Reseed on data change
  useEffect(() => {
    setColorPrimary(theme?.colorPrimary ?? "");
    setColorBg(theme?.colorBg ?? "");
    setColorText(theme?.colorText ?? "");
    setFontKey(normalizeFontKey(theme?.fontKey));
    setLayoutKey(normalizeLayoutKey(theme?.layoutKey, ownerType));
  }, [theme, ownerType]);

  // ── Dirty tracking ──────────────────────────────────────────
  const isDirty = useMemo(() => {
    return (
      colorPrimary !== (theme?.colorPrimary ?? "") ||
      colorBg !== (theme?.colorBg ?? "") ||
      colorText !== (theme?.colorText ?? "") ||
      fontKey !== normalizeFontKey(theme?.fontKey) ||
      layoutKey !== normalizeLayoutKey(theme?.layoutKey, ownerType)
    );
  }, [colorPrimary, colorBg, colorText, fontKey, layoutKey, theme, ownerType]);

  // ── Mutation ────────────────────────────────────────────────
  const updateThemeMutation = trpc.entityPages.updatePageTheme.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
      toast.success({
        id: "theme-updated",
        title: String(t("admin.peThemeUpdated")),
        message: String(t("admin.peThemeUpdatedMessage")),
      });
      onSaved?.();
    },
    onError: (err) => {
      toast.danger({
        id: "theme-update-failed",
        title: String(t("admin.peThemeUpdateFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  // ASYNC for the same reason as PageFieldsEditor's: `saveAll` callers are
  // held until the request settles. `onError` still owns the toast.
  const handleSave = useCallback(async () => {
    try {
      await updateThemeMutation.mutateAsync({
        ownerType,
        ownerId,
        colorPrimary: colorPrimary.trim() || null,
        colorBg: colorBg.trim() || null,
        colorText: colorText.trim() || null,
        fontKey,
        layoutKey,
      });
    } catch {
      // Reported by the mutation's own `onError` toast.
    }
  }, [
    ownerType,
    ownerId,
    colorPrimary,
    colorBg,
    colorText,
    fontKey,
    layoutKey,
    updateThemeMutation,
  ]);

  // Theme's Save lives in the editor toolbar alongside Profile's — see
  // `page-settings-save`. Nothing here can block a save the way a taken slug
  // blocks the profile form, so no `blocked`.
  useRegisterPageSettingsSave({
    id: "theme",
    isDirty,
    isPending: updateThemeMutation.isPending,
    save: handleSave,
  });

  // The frame is the host's when embedded; the content and its rhythm are not.
  const Frame = embedded ? YStack : CardSurface;

  return (
    <Frame>
      <YStack gap="$4" padding={embedded ? 0 : "$4"}>
        <XStack gap="$2" alignItems="center">
          <Palette size={18} />
          <Text variant={embedded ? "body" : "h4"} weight="bold">
            {String(t("admin.peThemeTitle"))}
          </Text>
        </XStack>

        <Text variant="caption" color="$colorMuted">
          {String(t("admin.peThemeDescription"))}
        </Text>

        {/* ── Color inputs ──────────────────────────────── */}
        <XStack gap="$3" flexWrap="wrap">
          <YStack flex={1} minWidth={140} gap="$2">
            <LabeledTextInput
              label={String(t("admin.peColorPrimaryLabel"))}
              placeholder="#6366f1"
              value={colorPrimary}
              onChangeText={setColorPrimary}
            />
            {colorPrimary.trim() ? (
              <XStack
                width={24}
                height={24}
                borderRadius={0}
                borderWidth={2}
                borderColor="$borderColor"
                style={{ backgroundColor: swatchColor(colorPrimary) }}
              />
            ) : null}
          </YStack>

          <YStack flex={1} minWidth={140} gap="$2">
            <LabeledTextInput
              label={String(t("admin.peColorBgLabel"))}
              placeholder="#0a0a0a"
              value={colorBg}
              onChangeText={setColorBg}
            />
            {colorBg.trim() ? (
              <XStack
                width={24}
                height={24}
                borderRadius={0}
                borderWidth={2}
                borderColor="$borderColor"
                style={{ backgroundColor: swatchColor(colorBg) }}
              />
            ) : null}
          </YStack>

          <YStack flex={1} minWidth={140} gap="$2">
            <LabeledTextInput
              label={String(t("admin.peColorTextLabel"))}
              placeholder="#ffffff"
              value={colorText}
              onChangeText={setColorText}
            />
            {colorText.trim() ? (
              <XStack
                width={24}
                height={24}
                borderRadius={0}
                borderWidth={2}
                borderColor="$borderColor"
                style={{ backgroundColor: swatchColor(colorText) }}
              />
            ) : null}
          </YStack>
        </XStack>

        {loneColorUnmeasurable(colorBg, colorText) ? (
          <Text
            variant="caption"
            color="$colorMuted"
            testID="entity-page-theme-pair-hint"
          >
            {String(t("admin.peColorPairHint"))}
          </Text>
        ) : null}

        {/* ── Font & layout ─────────────────────────────── */}
        <XStack gap="$3" flexWrap="wrap">
          <YStack flex={1} minWidth={180} gap="$2">
            <Text variant="caption" weight="bold" color="$colorMuted">
              {String(t("admin.peFontKeyLabel"))}
            </Text>
            <StyledSelect<EntityPageFontKey>
              value={fontKey}
              options={fontOptions}
              onChange={setFontKey}
              size="md"
              fullWidth
              testId="entity-page-theme-font"
            />
          </YStack>
          <YStack flex={1} minWidth={180} gap="$2">
            <Text variant="caption" weight="bold" color="$colorMuted">
              {String(t("admin.peLayoutKeyLabel"))}
            </Text>
            <StyledSelect<EntityPageLayoutKey>
              value={displayLayoutKey}
              options={layoutOptions}
              onChange={editorGateOn ? setLayoutKey : () => {}}
              disabled={!editorGateOn}
              size="md"
              fullWidth
              testId="entity-page-theme-layout"
            />
            <Text variant="caption" color="$colorMuted">
              {String(t(LAYOUT_HELP_KEYS[displayLayoutKey]))}
            </Text>
            {!editorGateOn && (
              <Text variant="caption" color="$colorMuted">
                {String(t("admin.peThemeLayoutLockedHint"))}
              </Text>
            )}
            <Text variant="caption" color="$colorMuted">
              {String(t("admin.peThemeLayoutPreview"))}
            </Text>
            <XStack
              gap="$2"
              padding="$2"
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surface"
              accessibilityLabel={String(t("admin.peThemeLayoutPreview"))}
            >
              {displayLayoutKey === "standard" ? (
                // Polished template: hero band over a two-column body.
                <YStack flex={1} gap="$2">
                  <YStack
                    height={22}
                    backgroundColor="$colorMuted"
                    opacity={0.4}
                  />
                  <XStack gap="$2">
                    <YStack
                      flex={2}
                      height={28}
                      backgroundColor="$colorMuted"
                      opacity={0.28}
                    />
                    <YStack
                      flex={1}
                      height={28}
                      backgroundColor="$colorMuted"
                      opacity={0.16}
                    />
                  </XStack>
                </YStack>
              ) : displayLayoutKey === "grid" ? (
                <>
                  <YStack
                    flex={1}
                    height={42}
                    backgroundColor="$colorMuted"
                    opacity={0.34}
                  />
                  <YStack
                    flex={1}
                    height={42}
                    backgroundColor="$colorMuted"
                    opacity={0.18}
                  />
                </>
              ) : (
                <YStack flex={1} gap="$2">
                  <YStack
                    height={16}
                    backgroundColor="$colorMuted"
                    opacity={0.34}
                  />
                  <YStack
                    height={16}
                    backgroundColor="$colorMuted"
                    opacity={0.22}
                  />
                </YStack>
              )}
            </XStack>
          </YStack>
        </XStack>

      </YStack>
    </Frame>
  );
}
