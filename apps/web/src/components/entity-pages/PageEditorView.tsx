"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { styled, YStack, XStack, useMedia, useTheme } from "tamagui";
import { Text, Spinner, Button, Tooltip, useTranslations } from "@th/ui";
import {
  FileText,
  Plus,
  Monitor,
  Smartphone,
  ChevronDown,
  RefreshCw,
  Undo2,
  Redo2,
  X,
  ExternalLink,
  Save,
} from "lucide-react";
import { shortcutHint } from "@/lib/platform";
import type {
  EntityPageRecord,
  EntitySummary,
  PageBlockRecord,
  PageThemeRecord,
} from "@th/types/repos/entity-pages";
import { placeAcceptsBookingRequests } from "@th/types/repos/entity-pages";

import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import {
  getPaletteBlockConfigs,
  normalizeBlockSection,
  normalizeEntityPageLayoutKey,
  resolveDefaultEntityPageLayoutKey,
  type BlockConfigCategory,
  type EntityPageBlockConfig,
} from "@th/core/use-cases/entity-pages";

import {
  PageFieldsEditor,
  type PageFieldsEditorProps,
} from "./PageFieldsEditor";
import { PageThemeEditor } from "./PageThemeEditor";
import {
  PageSettingsSaveProvider,
  usePageSettingsSave,
} from "./page-settings-save";
import { PageBlocksEditor } from "./PageBlocksEditor";
import { EditorHeader } from "./EditorHeader";
import { useBlockHistory } from "./useBlockHistory";
import { formatBlockKind } from "./describe-history-step";
import {
  resolveEntityPageEditorMode,
  type EntityPageEditorMode,
} from "./editor-mode";
import {
  EntityPageContent,
  type EntityPageContentData,
} from "@/app/p/[slug]/_components/EntityPageContent";
import { PUBLIC_PREVIEW_QUERY } from "@/app/p/[slug]/_components/use-viewer-place-arrival-areas";
import {
  ViewModeToggle,
  type EditorViewMode,
} from "@/components/editor/ViewModeToggle";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

type EditorPage = {
  id: string;
  ownerType: PageOwnerType;
  ownerId: string;
  slug: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  visibility: "PUBLIC" | "PRIVATE" | "UNLISTED";
  createdAt: Date;
  updatedAt: Date;
};

type EditorBlock = {
  id: string;
  pageId: string;
  kind: string;
  orderIndex: number;
  data: unknown;
  visible: boolean;
  /** Page surface ("main" | "memberships"); the API defaults it to "main". */
  section?: string;
};

type EditorTheme = Pick<
  PageThemeRecord,
  "colorPrimary" | "colorBg" | "colorText" | "fontKey" | "layoutKey"
> | null;

export interface PageEditorViewProps {
  ownerType: PageOwnerType;
  ownerId: string;
  /** Title shown at the top of the editor. */
  title?: string;
  /** Optional back link. */
  backHref?: string;
  /** When false, hide the editor header (used when the outer shell provides a heading). */
  showLiveHeader?: boolean;
  /** Slot rendered next to the title in the editor header (e.g. verification badge). */
  headerBadge?: ReactNode;
  /** Controls rendered in the header's action group, before "Add Block". */
  headerActions?: ReactNode;
  /** PLACE: the sentence under "Place name" in Page settings (see PageFieldsEditor). */
  placeNameHint?: string;
  /** Owner-specific control rendered as a subsection inside the Page Settings drawer. */
  settingsExtra?: ReactNode;
  /** Uppercase caption for the {@link settingsExtra} subsection. */
  settingsExtraLabel?: string;
  /**
   * When false, hide the Profile/Theme settings disclosure AND the toolbar's
   * aggregate Save that commits it, leaving only the block canvas. Passed by
   * the venue settings route, which hosts those two forms itself; the ORG and
   * HUMAN editors keep the default and are unaffected.
   */
  showSettings?: boolean;
}

// ── Page settings disclosure (collapsible Profile + Theme above the canvas) ──

const SettingsDisclosure = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "$surface",
  width: "100%",
  maxWidth: 960,
  marginHorizontal: "auto",
});

const SettingsToggle = styled(XStack, {
  tag: "button",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
  paddingHorizontal: 20,
  paddingVertical: 14,
  gap: 12,
  cursor: "pointer",
  borderRadius: 0,
  backgroundColor: "$surface",
  borderWidth: 0,
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  pressStyle: {
    backgroundColor: "$surfaceMuted",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$brandSecondary",
    outlineOffset: -2,
  },
});

const SettingsPanel = styled(YStack, {
  borderTopWidth: 2,
  borderTopColor: "$borderColorStrong",
  padding: 24,
  gap: 32,
});

/** Tracks the user's `prefers-reduced-motion` setting (SSR-safe). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const SettingsSubsection = styled(YStack, {
  gap: 16,
});

const LiveEditorWorkspace = styled(XStack, {
  flex: 1,
  alignItems: "flex-start",
  width: "100%",
  minHeight: 0,
  backgroundColor: "$background",
  position: "relative",
});

const LiveEditorMain = styled(YStack, {
  flex: 1,
  minWidth: 0,
});

const LiveEditorRail = styled(YStack, {
  width: 248,
  flexShrink: 0,
  padding: 16,
  gap: 12,
});

const PreviewStage = styled(YStack, {
  width: "100%",
  backgroundColor: "$background",
  minHeight: "calc(100vh - 120px)",
});

/**
 * The one home for the editor's view controls: Edit | Preview on the left,
 * the Desktop | Mobile device check on the right while previewing. It sits at
 * the top of the main column rather than in `EditorHeader` because two of the
 * three routes hide that header (`showLiveHeader={false}`), so a
 * header-hosted toggle would simply not exist for the org and place editors.
 *
 * Its sticky wrapper is a plain `<div>` (see the render) — RNW strips
 * `position: sticky` off styled components, the same reason `EditorHeader`
 * wraps itself that way.
 */
const EditorToolbarRow = styled(XStack, {
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  paddingHorizontal: 16,
  paddingVertical: 12,
  backgroundColor: "$surface",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColorStrong",
});

/**
 * `zIndex` for the sticky toolbar: under `EditorHeader` (100) so the header
 * wins any overlap, under the floating palette (101), far under the
 * (1100).
 *
 * The toolbar's `top` is MEASURED, not a constant. `Header`'s `minHeight: 64`
 * is a floor, not its height — with its `paddingVertical` and real content it
 * renders 70px, and a hard-coded 64 overlapped it by 6px (measured on
 * `/account/page`). A ResizeObserver on the header's sticky wrapper keeps the
 * two stacked correctly at any content or zoom level.
 */
const EDITOR_TOOLBAR_Z = 99;

/**
 * The editable canvas is FULL-BLEED (option A of the responsive trade-off).
 *
 * The public page lays out from the `entity-page` query container that
 * EntityPageContent supplies (its layout rules are `@container entity-page`
 * queries), so the canvas lays out for the CANVAS width, not the window. The
 * canvas is the window less the admin rail and gutters (~150–300px), so it
 * reaches the page's stacked layout earlier than the public page does: the
 * venue's two-column grid stacks below a window of about 990px here, where a
 * visitor's stacks at 900. That is the layout a visitor whose content column
 * is that wide gets, not a lie. Not every rule follows the container yet
 * (the hero's `vw` clamps, the Edit-page chip/menu pair, the org/human grid
 * rules). The venue editor's device switch (WYSIWYG plan step 10) replaces
 * this surface.
 */
const PreviewDesktopFrame = styled(YStack, {
  width: "100%",
  paddingVertical: 24,
});

const MobileDeviceFrame = styled(YStack, {
  marginHorizontal: "auto",
  marginVertical: 32,
  maxWidth: "100%",
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "$surface",
  overflow: "hidden",
});

const MobileFrameBar = styled(XStack, {
  paddingHorizontal: 12,
  paddingVertical: 8,
  gap: 10,
  alignItems: "center",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColorStrong",
  backgroundColor: "$surfaceMuted",
});

const BlockPaletteAside = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "$surface",
  flexShrink: 0,
  overflow: "hidden",
});

const BlockPaletteHeader = styled(YStack, {
  padding: 10,
  gap: 2,
  borderBottomWidth: 2,
  borderBottomColor: "$borderColorStrong",
  backgroundColor: "$surfaceMuted",
});

const BlockPaletteGroup = styled(YStack, {
  padding: 7,
  gap: 4,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview device
// ─────────────────────────────────────────────────────────────────────────────

type PreviewDevice = "desktop" | "mobile";

/**
 * Does this element own the browser's native text-undo?
 *
 * The single source of truth for BOTH the Cmd/Ctrl+Z guard (which bails so
 * native text undo still works inside block-settings inputs) and the focus
 * tracking that tells the user which meaning of the shortcut is currently
 * live. Two copies of this predicate would drift and the UI would lie.
 */
function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const node = el as HTMLElement;
  return (
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT" ||
    node.isContentEditable === true
  );
}

/**
 * Hoisted so the hidden authoring surface never gets a fresh style object on
 * a keystroke (which would re-commit the whole edit tree's style attribute).
 */
const HIDDEN_STYLE: CSSProperties = { display: "none" };

/** CSS width handed to the mobile preview iframe — a real narrow viewport. */
const MOBILE_PREVIEW_WIDTH = 390;
const MOBILE_PREVIEW_HEIGHT = 760;

const BLOCK_CATEGORY_ORDER: BlockConfigCategory[] = [
  "identity",
  "content",
  "events",
  "music",
  "place",
  "organization",
  "universal",
  "custom",
];

const BLOCK_CATEGORY_LABEL_KEYS: Record<BlockConfigCategory, string> = {
  identity: "admin.peBlockCategoryIdentity",
  content: "admin.peBlockCategoryContent",
  events: "admin.peBlockCategoryEvents",
  music: "admin.peBlockCategoryMusic",
  place: "admin.peBlockCategoryPlace",
  organization: "admin.peBlockCategoryOrganization",
  universal: "admin.peBlockCategoryUniversal",
  custom: "admin.peBlockCategoryCustom",
};

const FLOATING_PALETTE_WIDTH = 232;
// The palette is a fixed right-hand pane so it follows scroll down a long block
// canvas. Sticky can't work here: the admin shell's scroll container grows to
// fit content while the window scrolls, so a sticky child never pins. The gutter
// reserve keeps the canvas from sliding under the fixed pane. TOP clears the
// ~90px admin top bar (which scrolls away with the document).
const FLOATING_PALETTE_RESERVE = 272;
const FLOATING_PALETTE_RIGHT = 24;
const FLOATING_PALETTE_TOP = 100;
// Above the sticky EditorHeader (zIndex 100) so the header never occludes the
// palette's title/close control, but below the SAVE/contextual-action bar
// (zIndex 1100) which must stay on top of everything.
const FLOATING_PALETTE_Z = 101;

/**
 * LAST-RESORT entity summary, used ONLY when `getMyPage` returns
 * `entity: null` — an authorized owner whose entity row has gone missing.
 *
 * It is deliberately NOT the normal path any more. `EntityPageContent`
 * branches on the entity for its whole template choice (venue vs artist vs
 * org), its header, and every owner-derived CTA, so a fabricated summary makes
 * the editor disagree with the live page (the "BOOKING ENQUIRY" vs "Book this
 * venue" split). The real summary now travels on `getMyPage` and is used
 * everywhere except this anomaly, where the alternative — refusing to render —
 * would brick the page of an owner who cannot fix the underlying data.
 */
function buildFallbackEntity(page: EditorPage): EntitySummary {
  const fallbackName =
    page.displayName ?? page.slug ?? String(page.ownerType).toLowerCase();
  switch (page.ownerType) {
    case "HUMAN":
      return { type: "HUMAN", id: page.ownerId, name: fallbackName };
    case "PLACE":
      return {
        type: "PLACE",
        id: page.ownerId,
        name: fallbackName,
        city: null,
        region: null,
        formattedAddress: null,
        lat: null,
        lng: null,
      };
    case "ORGANIZATION":
      return {
        type: "ORGANIZATION",
        id: page.ownerId,
        name: fallbackName,
        slug: page.slug ?? page.ownerId,
        trustTier: "UNVERIFIED",
        trustBadgeLabel: null,
      };
  }
}

/**
 * Blocks the CANVAS may render, mirroring `EntityPageShell`'s own filter so the
 * editor and the published page start from the identical block set:
 *
 *  - membership-section blocks never render in the main body (they belong to
 *    the member-gated tab, fetched separately);
 *  - `request_to_play` only renders for a venue actively accepting requests.
 *
 * Hidden blocks are KEPT — the editor dims them and badges them HIDDEN so they
 * can be turned back on, which is the one place the canvas deliberately shows
 * more than the published page.
 *
 * Applied at the RENDER boundary only, never to the array the block editor
 * owns: `managePageBlocks`'s `reorder` rejects a partial id list with
 * `INVALID_BLOCK_ORDER`, so a drag must always be computed over the complete
 * stored set even when some of it never reaches the canvas.
 */
function selectCanvasBlocks(
  blocks: EditorBlock[],
  entity: EntitySummary,
): EditorBlock[] {
  const acceptsRequests = placeAcceptsBookingRequests(entity);
  return blocks.filter(
    (block) =>
      normalizeBlockSection(block.section) !== "memberships" &&
      (acceptsRequests || block.kind !== "request_to_play"),
  );
}

/**
 * Blocks the PREVIEW may render. `selectCanvasBlocks` plus the one filter the
 * canvas deliberately drops: `getPublicPage` returns only `visible` main
 * blocks, so a hidden block must be absent from the preview even though the
 * canvas keeps it (dimmed and badged HIDDEN) so it can be turned back on.
 */
function selectPreviewBlocks(
  blocks: EditorBlock[],
  entity: EntitySummary,
): EditorBlock[] {
  return selectCanvasBlocks(blocks, entity).filter((block) => block.visible);
}

function buildPreviewData(
  page: EditorPage,
  blocks: EditorBlock[],
  theme: EditorTheme,
  entity: EntitySummary,
): EntityPageContentData {
  const previewPage: EntityPageRecord = {
    ...page,
    slug: page.slug ?? "preview",
    allowFollows: true,
    showFollowerCount: false,
    // Editor preview is presentational only; `category` /
    // `templateAppliedCategories` drive server-side template seeding, never
    // rendering, so safe defaults keep the preview type-complete.
    category: null,
    templateAppliedCategories: [],
  };
  const previewTheme: PageThemeRecord | null = theme
    ? {
        id: `${page.id}:preview-theme`,
        pageId: page.id,
        ...theme,
      }
    : null;

  return {
    page: previewPage,
    // Placeholder — BOTH surfaces overwrite it on every render: the canvas
    // with the live drag-projected order through `selectCanvasBlocks`, the
    // preview with `selectPreviewBlocks` (which additionally drops hidden
    // blocks, matching the published page).
    blocks: blocks satisfies PageBlockRecord[],
    theme: previewTheme,
    entity,
  };
}

function buildFieldsPage(page: EditorPage): PageFieldsEditorProps["page"] {
  return {
    ...page,
    slug: page.slug ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PageEditorView({
  ownerType,
  ownerId,
  title = "Edit page",
  backHref,
  showLiveHeader = true,
  headerBadge,
  headerActions,
  placeNameHint,
  settingsExtra,
  settingsExtraLabel,
  showSettings = true,
}: PageEditorViewProps) {
  const t = useTranslations();
  const resolvedTitle =
    title === "Edit page" ? String(t("admin.peDefaultTitle")) : title;
  const validBlockConfigs = useMemo(
    () => getPaletteBlockConfigs(ownerType),
    [ownerType],
  );

  // ── Load page data ──────────────────────────────────────────
  const pageQuery = trpc.entityPages.getMyPage.useQuery(
    { ownerType, ownerId },
    { staleTime: 10_000, retry: 2, enabled: Boolean(ownerId) },
  );

  const { page, blocks, theme, entity } = pageQuery.data ?? {};

  // ── Hooks that must be called unconditionally ────────────────
  const utils = trpc.useUtils();
  const addBlockMutation = trpc.entityPages.managePageBlocks.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
    },
  });

  const handleAddBlock = useCallback(
    (kind: string) => {
      addBlockMutation.mutate({
        ownerType,
        ownerId,
        blockAction: { action: "add", kind },
      });
    },
    [ownerType, ownerId, addBlockMutation],
  );

  // ── Loading state ───────────────────────────────────────────
  if (pageQuery.isLoading) {
    return (
      <YStack padding="$5" gap="$4" alignItems="center" minHeight={200}>
        <Spinner size="lg" />
        <Text variant="body" color="$colorMuted">
          {String(t("admin.peLoading"))}
        </Text>
      </YStack>
    );
  }

  // ── Error / not found ───────────────────────────────────────
  if (pageQuery.isError || !page) {
    return (
      <YStack padding="$5" gap="$4" alignItems="center" minHeight={200}>
        <FileText size={40} color="var(--colorMuted)" />
        <Text variant="h3" color="$colorMuted">
          {String(t("admin.peNoPage"))}
        </Text>
        <Text variant="body" color="$colorMuted" textAlign="center">
          {String(t("admin.peNoPageDescription"))}
        </Text>
      </YStack>
    );
  }

  // ── The editor. One layout, one renderer. ───────────────────
  // The save provider sits ABOVE the layout on purpose: the layout's toolbar
  // CONSUMES the aggregate, and a component cannot read a context it provides
  // in its own render.
  return (
    <PageSettingsSaveProvider>
      <LiveEditorLayout
        title={resolvedTitle}
        backHref={backHref}
        headerBadge={headerBadge}
        headerActions={headerActions}
        placeNameHint={placeNameHint}
        showHeader={showLiveHeader}
        slug={page.slug}
        blockConfigs={validBlockConfigs}
        onAddBlock={handleAddBlock}
        isAddingBlock={addBlockMutation.isPending}
        ownerType={ownerType}
        ownerId={ownerId}
        page={page}
        theme={theme ?? null}
        blocks={blocks ?? []}
        entity={entity ?? null}
        settingsExtra={settingsExtra}
        settingsExtraLabel={settingsExtraLabel}
        showSettings={showSettings}
        t={t}
      />
    </PageSettingsSaveProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AddBlockPalette — right-side palette for the live editor only
// ─────────────────────────────────────────────────────────────────────────────

function AddBlockPalette({
  blockConfigs,
  onAddBlock,
  isAddingBlock,
  width,
  compact = false,
  onClose,
  t,
}: {
  blockConfigs: readonly EntityPageBlockConfig[];
  onAddBlock: (kind: string) => void;
  isAddingBlock: boolean;
  width: number | string;
  compact?: boolean;
  onClose?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const rowMinHeight = compact ? 26 : 44;
  const iconSize = compact ? 11 : 12;
  const rowFontSize = compact ? 11 : 12;
  const groupedConfigs = useMemo(() => {
    const byCategory = new Map<BlockConfigCategory, EntityPageBlockConfig[]>();
    for (const config of blockConfigs) {
      const current = byCategory.get(config.category) ?? [];
      current.push(config);
      byCategory.set(config.category, current);
    }

    return BLOCK_CATEGORY_ORDER.flatMap((category) => {
      const configs = byCategory.get(category);
      return configs && configs.length > 0 ? [{ category, configs }] : [];
    });
  }, [blockConfigs]);

  return (
    <BlockPaletteAside
      tag="aside"
      id="entity-page-block-palette"
      aria-labelledby="entity-page-block-palette-heading"
      width={width}
      maxWidth="100%"
      data-testid="entity-page-add-block-palette"
    >
      <BlockPaletteHeader>
        <XStack alignItems="flex-start" justifyContent="space-between" gap="$2">
          <YStack gap={2} flex={1} minWidth={0}>
            <Text
              id="entity-page-block-palette-heading"
              variant="overline"
              color="$accent"
            >
              {String(t("admin.peBlockPaletteTitle"))}
            </Text>
            <Text
              variant="caption"
              weight="bold"
              style={{ textTransform: "uppercase" }}
            >
              {String(t("admin.peAddBlock"))}
            </Text>
          </YStack>
          {onClose && (
            <Button
              variant="ghost"
              size="$1"
              icon
              onPress={onClose}
              aria-label={String(t("admin.peAddBlockClose"))}
              aria-expanded={true}
              aria-controls="entity-page-block-palette"
            >
              <X size={14} />
            </Button>
          )}
        </XStack>
      </BlockPaletteHeader>

      <YStack data-testid="entity-page-add-block-kind-select">
        {groupedConfigs.map(({ category, configs }) => {
          const categoryLabel = String(t(BLOCK_CATEGORY_LABEL_KEYS[category]));
          return (
            <BlockPaletteGroup key={category}>
              <Text variant="overline" color="$colorMuted">
                {categoryLabel !== BLOCK_CATEGORY_LABEL_KEYS[category]
                  ? categoryLabel
                  : formatBlockKind(category)}
              </Text>
              <YStack gap="$1">
                {configs.map((config) => {
                  const label = String(t(config.labelKey));
                  return (
                    <Button
                      key={config.kind}
                      variant="secondary"
                      size="$1"
                      width="100%"
                      minHeight={rowMinHeight}
                      paddingHorizontal="$2"
                      paddingVertical={compact ? 2 : 6}
                      gap="$1"
                      justifyContent="flex-start"
                      onPress={() => onAddBlock(config.kind)}
                      disabled={isAddingBlock}
                      data-testid={`entity-page-add-block-kind-${config.kind}`}
                    >
                      <Plus size={iconSize} />
                      <Text
                        tag="span"
                        tone="inherit"
                        style={{
                          fontSize: rowFontSize,
                          lineHeight: compact ? "14px" : "16px",
                        }}
                      >
                        {label !== config.labelKey
                          ? label
                          : formatBlockKind(config.kind)}
                      </Text>
                    </Button>
                  );
                })}
              </YStack>
            </BlockPaletteGroup>
          );
        })}
      </YStack>
    </BlockPaletteAside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BlockHistoryToolbar — Undo/Redo, on the toolbar row beside the mode toggle.
//
// These were 34px borderless icon-only ghosts at opacity 0.45, sharing a row
// with 160 characters of prose — in a strict-Swiss surface they read as bullet
// glyphs for that sentence, not as controls. They are now full Swiss action
// buttons in the same grammar as the two segmented controls they sit with.
//
// NOT `ViewModeToggle`: that carries `aria-pressed` toggle-button semantics for
// mutually exclusive modes. Undo and redo are two independent actions.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Swiss action button: 44px, 2px border, radius 0, icon + uppercase label.
 *
 * Disabled is a VARIANT, not `disabled` + the shared Button's global
 * `opacity: 0.45` — a faded ghost is unreadable and says "decoration". The
 * inactive rung keeps a full 2px border and a legible label, both stepped down
 * to `$colorMuted` (7.19:1 on Stub's `$surface`, versus ink's 17.5:1 — a clear
 * step down that still clears AA and the 3:1 non-text floor).
 *
 * It also stays FOCUSABLE and hoverable when inactive (`aria-disabled`, not
 * `disabled`), because the tooltip explaining *why* there is nothing to undo
 * is the whole point and a `disabled` button cannot be reached to read it.
 */
const HistoryActionButton = styled(XStack, {
  tag: "button",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  minHeight: 44,
  paddingHorizontal: "$3",
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  backgroundColor: "transparent",
  cursor: "pointer",
  flexShrink: 0,
  // Matches the segmented controls' non-active segments, so the whole row
  // reads as one family of controls.
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  pressStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
  variants: {
    inactive: {
      true: {
        borderColor: "$colorMuted",
        cursor: "not-allowed",
        hoverStyle: { backgroundColor: "transparent" },
        pressStyle: { backgroundColor: "transparent" },
      },
    },
  } as const,
});

function BlockHistoryToolbar({
  canUndo,
  canRedo,
  busy,
  onUndo,
  onRedo,
  undoAction,
  redoAction,
  editableFocused,
  t,
}: {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Phrase for what undo would revert, from useBlockHistory. */
  undoAction: string | null;
  /** Phrase for what redo would reapply. */
  redoAction: string | null;
  /**
   * An input/textarea/select/contentEditable currently has focus, so the
   * window Cmd/Ctrl+Z handler deliberately bails and the browser's own text
   * undo takes the key instead.
   */
  editableFocused: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const theme = useTheme();
  const inkColor = theme.color?.val;
  const mutedColor = theme.colorMuted?.val;

  const undoEnabled = canUndo && !busy;
  const redoEnabled = canRedo && !busy;
  const undoShortcut = shortcutHint("Z");

  // The accessible name names the SCOPE. "Undo" alone is a misdescription:
  // this publishes an inverse mutation to a live page, not a text rewind.
  const undoName = undoAction
    ? String(t("admin.peUndoAction", { action: undoAction }))
    : String(t("admin.peUndoNothing"));
  const redoName = redoAction
    ? String(t("admin.peRedoAction", { action: redoAction }))
    : String(t("admin.peRedoNothing"));

  // While a field has focus the shortcut genuinely will not reach this button,
  // so say so — and drop `aria-keyshortcuts`, which would otherwise advertise
  // a binding that is not live. The button itself stays fully clickable.
  const undoTooltip = editableFocused
    ? String(t("admin.peUndoWhileTyping", { shortcut: undoShortcut }))
    : undoAction
      ? `${undoName} (${undoShortcut})`
      : undoName;
  const redoTooltip = editableFocused
    ? String(
        t("admin.peUndoWhileTyping", { shortcut: shortcutHint("Z", true) }),
      )
    : redoAction
      ? `${redoName} (${shortcutHint("Z", true)})`
      : redoName;

  const segment = (
    kind: "undo" | "redo",
    enabled: boolean,
    onPress: () => void,
    accessibleName: string,
    tooltip: string,
    shortcuts: string,
  ) => {
    const Icon = kind === "undo" ? Undo2 : Redo2;
    return (
      <Tooltip
        anchor={
          <HistoryActionButton
            inactive={!enabled}
            onPress={() => {
              if (enabled) onPress();
            }}
            data-testid={`entity-page-${kind}`}
            {...({
              type: "button",
              "aria-label": accessibleName,
              // Only advertised when the key actually reaches this button.
              ...(editableFocused ? {} : { "aria-keyshortcuts": shortcuts }),
              ...(enabled ? {} : { "aria-disabled": true }),
            } as Record<string, unknown>)}
          >
            <Icon size={16} color={enabled ? inkColor : mutedColor} />
            <Text
              variant="caption"
              weight="bold"
              tag="span"
              textTransform="uppercase"
              letterSpacing={1.5}
              color={enabled ? "$color" : "$colorMuted"}
            >
              {String(t(kind === "undo" ? "admin.peUndo" : "admin.peRedo"))}
            </Text>
          </HistoryActionButton>
        }
        placement="bottom"
      >
        {tooltip}
      </Tooltip>
    );
  };

  return (
    <XStack
      gap="$2"
      alignItems="center"
      flexWrap="wrap"
      data-testid="entity-page-history-controls"
    >
      {segment(
        "undo",
        undoEnabled,
        onUndo,
        undoName,
        undoTooltip,
        "Meta+Z Control+Z",
      )}
      {segment(
        "redo",
        redoEnabled,
        onRedo,
        redoName,
        redoTooltip,
        "Meta+Shift+Z Control+Y",
      )}
    </XStack>
  );
}

/**
 * MOBILE check. Deliberately an IFRAME, not an in-page device frame.
 *
 * The page's layout rules now query the `entity-page` container, so a
 * 390px-wide DIV would mostly get the phone layout, but not all of it yet:
 * the hero's `vw` clamps, the Edit-page chip/menu pair and the org/human grid
 * rules still follow the viewport. The iframe gives the page a real narrow
 * viewport, and it shows the PUBLISHED page. The venue editor's device switch
 * (WYSIWYG plan step 10) replaces this surface.
 *
 * It loads `/p/<slug>` — the PUBLISHED page — while the Desktop branch renders
 * current in-memory state. That split is the point of the frame bar's notice:
 * the two halves of the device switch genuinely show different things, and the
 * label has to say which. It previously read "LIVE PREVIEW" over saved
 * content, which asserted the opposite. The reload control picks up whatever
 * has since been saved.
 *
 * Only mounted when `/p/<slug>` will actually render — see
 * `canPreviewPublished` in LiveEditorLayout.
 */
function MobilePreviewFrame({
  slug,
  t,
}: {
  slug: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const notice = String(t("admin.pePreviewMobilePublishedNotice"));

  return (
    <MobileDeviceFrame
      data-testid="entity-page-preview-frame-mobile"
      // FLUID up to the target width, never a fixed 394px. A fixed width here
      // contributes to every ancestor's min-content width, and those ancestors
      // are content-sized flex columns — so `maxWidth: "100%"` resolved against
      // a box this frame was itself widening and never clamped. Measured
      // `documentElement.scrollWidth` 436 at a 320px viewport, which dragged
      // the sticky toolbar off-screen with it. Below the cap the iframe simply
      // reports an even narrower viewport, which is still an honest check.
      width="100%"
      maxWidth={MOBILE_PREVIEW_WIDTH + 4}
    >
      <MobileFrameBar alignItems="flex-start">
        <YStack flex={1} minWidth={0} gap={2}>
          <Text variant="overline">{String(t("admin.epMobile"))}</Text>
          {/* Wraps rather than ellipsizing: a truncated honesty notice is not
              an honesty notice. */}
          <Text
            variant="caption"
            color="$colorMuted"
            data-testid="entity-page-preview-mobile-notice"
          >
            {notice}
          </Text>
        </YStack>
        <Button
          variant="ghost"
          size="$1"
          icon
          onPress={() => setReloadKey((n) => n + 1)}
          aria-label={String(t("admin.refresh"))}
        >
          <RefreshCw size={14} />
        </Button>
      </MobileFrameBar>
      <iframe
        key={reloadKey}
        title={notice}
        // `?preview=public`: the frame carries the manager's cookies, so without
        // it the page would probe and show their own arrival areas (load-in, a
        // withheld place's) under a notice that says this is the public page.
        src={`/p/${slug}?${PUBLIC_PREVIEW_QUERY}`}
        // NOT `loading="lazy"`: the frame is only mounted once the owner
        // selects the Mobile check, so deferring the load just leaves them
        // staring at an empty rectangle (measured — it never navigated).
        style={{
          display: "block",
          // Fluid for the same reason as the frame — a fixed 390 leaks into
          // the ancestors' min-content width and overflows narrow viewports.
          width: "100%",
          maxWidth: MOBILE_PREVIEW_WIDTH,
          height: MOBILE_PREVIEW_HEIGHT,
          border: 0,
        }}
      />
    </MobileDeviceFrame>
  );
}

/**
 * The editor's ONE authoring canvas.
 *
 * Renders `EntityPageContent` — the exact component the public route renders —
 * for EVERY layout including "standard", with the editor's per-block chrome
 * injected through `BlockChromeProvider`. There is no second renderer and no
 * flat block list, so the template's own filtering and reordering
 * (PlaceEntityLayout drops `location_map`/`request_to_play`, hoists `links`
 * into the sidebar, re-sorts by priority) is what the owner edits.
 *
 * `EntityPageContent`, NOT `EntityPageShell`: the shell mounts the public
 * page's own action islands, which do not belong over an editing surface.
 *
 * The desktop/mobile device switch is NOT here — it belongs to Preview mode
 * ({@link PagePreviewSurface}). This surface is authoring only.
 */
function WysiwygPageCanvas({
  data,
  blocks,
  ownerType,
  ownerId,
  mode,
  canResize,
  historyBusy,
}: {
  data: EntityPageContentData;
  blocks: EditorBlock[];
  ownerType: PageOwnerType;
  ownerId: string;
  mode: EntityPageEditorMode;
  canResize: boolean;
  historyBusy: boolean;
}) {
  return (
    <PreviewStage data-testid="entity-page-edit-canvas">
      <PreviewDesktopFrame data-testid="entity-page-edit-canvas-frame">
        <PageBlocksEditor
          blocks={blocks}
          ownerType={ownerType}
          ownerId={ownerId}
          mode={mode}
          canResize={canResize}
          historyBusy={historyBusy}
        >
          {(displayBlocks) => (
            <EntityPageContent
              data={{
                ...data,
                blocks: selectCanvasBlocks(
                  displayBlocks,
                  data.entity,
                ) satisfies PageBlockRecord[],
                // The editor never shows the manager's own arrival areas.
                publicPreview: true,
              }}
            />
          )}
        </PageBlocksEditor>
      </PreviewDesktopFrame>
    </PreviewStage>
  );
}

/**
 * Preview mode: the real page render with NO editing chrome, fed from the
 * CURRENT in-memory page/blocks/theme — so unsaved edits preview live. Hidden
 * blocks are dropped here (the canvas keeps them, dimmed, so they can be
 * turned back on) to match what `getPublicPage` actually returns.
 *
 * **Preview is fully INTERACTIVE, deliberately.** The authoring canvas makes
 * block content inert (`EditableBlock` wraps children in
 * `pointerEvents: none`); this surface does not, so live `FollowButton`,
 * `RequestToPlayBlock` and `RateVenueBlock` mount here and an owner can follow
 * their own page or send themselves a booking request from inside the editor.
 * That is accepted, not overlooked: every one of those actions is already
 * reachable from the owner's own public page, so this is a new location rather
 * than a new capability, and a blanket `pointerEvents: none` would remove the
 * main reason to preview — checking that the CTAs actually work.
 *
 * The desktop/mobile switch is NOT here: it sits beside the Edit | Preview
 * toggle in the editor toolbar (one row, one control grammar). Mobile stays an
 * IFRAME of the PUBLISHED page ({@link MobilePreviewFrame}) because it shows
 * the published page, not the draft. The page's layout rules now query the
 * `entity-page` container EntityPageContent supplies, so a narrow DIV would
 * mostly lay out right, but not entirely yet: the hero's `vw` clamps, the
 * Edit-page chip/menu-item pair and the org/human grid rules still follow the
 * viewport. The venue editor's device switch (WYSIWYG plan step 10) replaces
 * this surface.
 */
function PagePreviewSurface({
  data,
  blocks,
  device,
  publishedSlug,
  t,
}: {
  data: EntityPageContentData;
  blocks: EditorBlock[];
  device: PreviewDevice;
  /** Slug to load in the mobile iframe, or null when `/p/<slug>` would 404. */
  publishedSlug: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const previewData = useMemo(
    () => ({
      ...data,
      blocks: selectPreviewBlocks(
        blocks,
        data.entity,
      ) satisfies PageBlockRecord[],
    }),
    [data, blocks],
  );

  return (
    <PreviewStage data-testid="entity-page-preview-surface">
      {device === "mobile" && publishedSlug ? (
        <MobilePreviewFrame slug={publishedSlug} t={t} />
      ) : (
        <PreviewDesktopFrame data-testid="entity-page-preview-frame-desktop">
          {/* A public preview: the manager's own arrival areas stay out. */}
          <EntityPageContent data={{ ...previewData, publicPreview: true }} />
        </PreviewDesktopFrame>
      )}
    </PreviewStage>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PageSettingsDisclosure — collapsible Profile + Theme panel above the canvas
// ─────────────────────────────────────────────────────────────────────────────

function SettingsSectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text variant="overline" color="$colorMuted">
      {children}
    </Text>
  );
}

function PageSettingsDisclosure({
  fieldsPage,
  theme,
  ownerType,
  ownerId,
  extraSection,
  extraSectionLabel,
  placeNameHint,
  t,
}: {
  fieldsPage: PageFieldsEditorProps["page"];
  theme: EditorTheme;
  ownerType: PageOwnerType;
  ownerId: string;
  /** Optional owner-specific control rendered as a third settings subsection. */
  extraSection?: ReactNode;
  extraSectionLabel?: string;
  /** PLACE: the sentence under "Place name" (see PageFieldsEditor). */
  placeNameHint?: string;
  t: ReturnType<typeof useTranslations>;
}) {
  // Default OPEN for a page that has never had its identity filled in — a
  // brand-new org/venue/human lands on the editor with no display name, and
  // burying "what is this page called" behind a collapsed toggle is the wrong
  // first run. Lazy initialiser, so a page that already has a name keeps the
  // collapsed default and re-opening it later is never fought by a re-render.
  const [open, setOpen] = useState(
    () => !(fieldsPage.displayName ?? "").trim(),
  );
  const reducedMotion = usePrefersReducedMotion();
  // lucide-react does not resolve Tamagui token strings ("$color") — they fall
  // back to a near-background colour and vanish. Resolve real values so the
  // chevron affordance is plainly visible in both states.
  const uiTheme = useTheme();
  const iconColor = uiTheme.color?.val;
  const iconMutedColor = uiTheme.colorMuted?.val;

  return (
    <SettingsDisclosure data-testid="entity-page-settings-disclosure">
      <SettingsToggle
        onPress={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="entity-page-settings-panel"
        data-testid="entity-page-settings-toggle"
      >
        <XStack gap={12} alignItems="center" flex={1} minWidth={0}>
          <FileText size={18} color={iconMutedColor} aria-hidden />
          <Text
            variant="body"
            weight="bold"
            style={{ textTransform: "uppercase", letterSpacing: 1 }}
          >
            {String(t("admin.peSettingsTitle"))}
          </Text>
        </XStack>
        <ChevronDown
          size={24}
          strokeWidth={2.5}
          color={iconColor}
          aria-hidden
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: reducedMotion ? "none" : "transform 150ms ease-out",
          }}
        />
      </SettingsToggle>

      {open && (
        <SettingsPanel id="entity-page-settings-panel">
          <SettingsSubsection>
            <SettingsSectionLabel>
              {String(t("admin.peTabProfile"))}
            </SettingsSectionLabel>
            <PageFieldsEditor
              page={fieldsPage}
              ownerType={ownerType}
              ownerId={ownerId}
              placeNameHint={placeNameHint}
            />
          </SettingsSubsection>

          <SettingsSubsection>
            <SettingsSectionLabel>
              {String(t("admin.peTabTheme"))}
            </SettingsSectionLabel>
            <PageThemeEditor
              theme={theme}
              ownerType={ownerType}
              ownerId={ownerId}
            />
          </SettingsSubsection>

          {extraSection ? (
            <SettingsSubsection>
              {extraSectionLabel ? (
                <SettingsSectionLabel>{extraSectionLabel}</SettingsSectionLabel>
              ) : null}
              {extraSection}
            </SettingsSubsection>
          ) : null}
        </SettingsPanel>
      )}
    </SettingsDisclosure>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LiveEditorLayout — header + collapsible settings + WYSIWYG canvas
// ─────────────────────────────────────────────────────────────────────────────

function LiveEditorLayout({
  title,
  backHref,
  headerBadge,
  headerActions,
  placeNameHint,
  showHeader,
  slug,
  blockConfigs,
  onAddBlock,
  isAddingBlock,
  ownerType,
  ownerId,
  page,
  theme,
  blocks,
  entity,
  settingsExtra,
  settingsExtraLabel,
  showSettings,
  t,
}: {
  title: string;
  backHref?: string;
  headerBadge?: ReactNode;
  headerActions?: ReactNode;
  placeNameHint?: string;
  showHeader: boolean;
  slug: string | null;
  blockConfigs: readonly EntityPageBlockConfig[];
  onAddBlock: (kind: string) => void;
  isAddingBlock: boolean;
  ownerType: PageOwnerType;
  ownerId: string;
  page: EditorPage;
  theme: EditorTheme;
  blocks: EditorBlock[];
  /** The owner's REAL entity summary; null only for a missing entity row. */
  entity: EntitySummary | null;
  settingsExtra?: ReactNode;
  settingsExtraLabel?: string;
  showSettings: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const media = useMedia();
  const stackPalette = media.lg;
  // lucide icons need REAL colour values — a Tamagui token string resolves to
  // nothing and the glyph vanishes. The device segments invert with their
  // fill, so both rungs are resolved here.
  const uiTheme = useTheme();
  const inkColor = uiTheme.color?.val;
  const onStructureColor = uiTheme.onStructure?.val;
  // The device check belongs to Preview mode now — the authoring canvas is
  // desktop-only, and a narrow check is a "how does this read?" question.
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");

  // Sticky stacking: the toolbar pins directly under EditorHeader, whose
  // rendered height is measured rather than assumed (see EDITOR_TOOLBAR_Z).
  const headerStickyRef = useRef<HTMLDivElement | null>(null);
  const [headerOffset, setHeaderOffset] = useState(0);
  useEffect(() => {
    const element = headerStickyRef.current;
    if (!element) {
      setHeaderOffset(0);
      return;
    }
    const measure = () =>
      setHeaderOffset(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showHeader]);

  // ── Edit | Preview view mode ────────────────────────────────────────────
  // Preview swaps the main column to the real page render fed with the
  // CURRENT in-memory page/blocks/theme, so unsaved edits preview live. The
  // edit surface stays MOUNTED (display:none) so the settings disclosure,
  // every open block-settings panel and its drafts, and the live undo/redo
  // history all survive the round trip.
  //
  // Seeded from `?view=preview` in a LAZY initialiser rather than an effect,
  // so a deep link never paints the full authoring surface and then swaps.
  // This cannot desync hydration: `PageEditorView` returns a spinner while
  // `getMyPage` is loading and that query has no SSR prefetch, so
  // LiveEditorLayout provably first renders on the CLIENT, after hydration.
  // The mount effect below stays as a backstop in case that ever changes.
  const [viewMode, setViewMode] = useState<EditorViewMode>(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("view") === "preview"
      ? "preview"
      : "edit",
  );
  const isPreviewMode = viewMode === "preview";
  // Aggregate of whatever the settings forms have registered. Empty (and so
  // permanently disabled) until the disclosure mounts them, which is correct:
  // nothing is dirty if nothing is editable.
  const settingsSave = usePageSettingsSave();
  /**
   * Mirror of `viewMode`, updated SYNCHRONOUSLY on every switch so the
   * `popstate` listener and the window `keydown` handler (both async browser
   * events) never read a stale value mid-render.
   */
  const viewModeRef = useRef(viewMode);
  /** Edit-surface scroll position, restored when leaving preview. */
  const editModeScrollYRef = useRef(0);
  /**
   * True while the CURRENT history entry is a preview entry WE pushed on top
   * of the editor URL — exiting can then `history.back()` instead of growing
   * the stack. False when the user deep-linked straight into `?view=preview`
   * (no editor entry behind us), where exit falls back to `replaceState`.
   */
  const pushedPreviewEntryRef = useRef(false);
  /**
   * Re-entrancy guard: set right before OUR OWN `history.back()` so the
   * resulting `popstate` is swallowed (the mode/scroll change was already
   * applied by the toggle path).
   */
  const selfPopRef = useRef(false);
  /**
   * The editor's pathname, captured at mount. A `popstate` that lands on a
   * DIFFERENT pathname is a cross-route navigation owned by Next's router
   * (which unmounts us) — never interpret it as a view-mode change.
   */
  const mountPathnameRef = useRef<string | null>(
    typeof window === "undefined" ? null : window.location.pathname,
  );

  // Shallow URL sync (`?view=preview`) via the native history API — the
  // Next-sanctioned shallow-routing tool; no Next re-navigation.
  //
  // Entering preview PUSHES a new entry (marked `{ thPreview: true }`) so the
  // browser Back button returns to the editor instead of leaving it — the
  // natural inclination on a full-page preview. Exiting pops that entry back
  // off when we pushed it, keeping the stack flat.
  const applyViewModeToUrl = useCallback((mode: EditorViewMode) => {
    if (typeof window === "undefined") return;
    if (mode === "preview") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "preview");
      window.history.pushState(
        { thPreview: true },
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      pushedPreviewEntryRef.current = true;
    } else if (
      pushedPreviewEntryRef.current &&
      new URL(window.location.href).searchParams.get("view") === "preview" &&
      // The CURRENT entry must be the one we stamped. Two ways it may not be:
      //   · a browser-Back traversal already moved location off our entry but
      //     its popstate has not reached the listener yet (Back-then-toggle
      //     race) — the search-param check catches that one;
      //   · a same-document FRAGMENT link inside the preview (the heroes'
      //     "Contact" / "Booking" CTAs) pushed its OWN entry on top of ours,
      //     so the stack is editor → ours → the browser's. `history.back()`
      //     would land on OUR preview entry, leaving the URL saying
      //     `view=preview` while the UI shows Edit — and a reload would then
      //     reopen in the wrong mode. Only the state stamp distinguishes this.
      (window.history.state as { thPreview?: boolean } | null)?.thPreview ===
        true
    ) {
      // We pushed this preview entry from the editor URL and it is still the
      // current one — pop it so enter/exit round trips don't grow the stack.
      pushedPreviewEntryRef.current = false;
      selfPopRef.current = true;
      window.history.back();
    } else {
      // Deep-linked straight into `?view=preview` (no editor entry behind us),
      // a raced traversal that already landed, or a fragment entry stacked on
      // top of ours — rewrite in place. Costs one stale entry in the stack,
      // which is strictly better than desyncing the URL from the UI.
      pushedPreviewEntryRef.current = false;
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      window.history.replaceState(
        {},
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, []);

  /**
   * Core mode switch (state + scroll choreography). `syncUrl: false` is the
   * popstate path — the browser already moved the URL, so touching history
   * again would corrupt the stack.
   */
  const switchViewMode = useCallback(
    (mode: EditorViewMode, opts: { syncUrl: boolean }) => {
      if (mode === viewModeRef.current) return;
      if (typeof window !== "undefined") {
        if (mode === "preview") {
          editModeScrollYRef.current = window.scrollY;
          window.scrollTo({ top: 0 });
        } else {
          // Restore where the owner was in the block list — after the
          // re-render, so the edit surface has its height back.
          const top = editModeScrollYRef.current;
          requestAnimationFrame(() => window.scrollTo({ top }));
        }
      }
      viewModeRef.current = mode;
      setViewMode(mode);
      if (opts.syncUrl) applyViewModeToUrl(mode);
    },
    [applyViewModeToUrl],
  );

  const handleViewModeChange = useCallback(
    (mode: EditorViewMode) => switchViewMode(mode, { syncUrl: true }),
    [switchViewMode],
  );

  // Save clicks the VISIBLE section's save target; preview hides all of them,
  // so the button is dropped rather than shipped as a silent no-op.

  // Backstop for the lazy initialiser above (SSR, or a future prefetch that
  // lets this component render on the server). `pushedPreviewEntryRef` stays
  // false either way: nothing of ours sits behind a deep-linked entry, so
  // exiting rewrites in place instead of navigating away.
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("view") === "preview" &&
      viewModeRef.current === "edit"
    ) {
      switchViewMode("preview", { syncUrl: false });
    }
    // Mount only — a later `?view=` change is the popstate listener's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser Back/Forward over the preview entry: exit (or re-enter) preview in
  // place instead of letting Back feel like it should leave the editor. Pops
  // that land outside this page are left to Next's router.
  useEffect(() => {
    const onPopState = () => {
      if (selfPopRef.current) {
        // Echo of our own history.back() — already handled by the toggle.
        selfPopRef.current = false;
        return;
      }
      if (window.location.pathname !== mountPathnameRef.current) return;
      const wantsPreview =
        new URLSearchParams(window.location.search).get("view") === "preview";
      if (wantsPreview && viewModeRef.current === "edit") {
        // Forward into the preview entry we pushed earlier — the editor entry
        // sits right behind it again, so a toggle-exit may pop.
        pushedPreviewEntryRef.current = true;
        switchViewMode("preview", { syncUrl: false });
      } else if (!wantsPreview && viewModeRef.current === "preview") {
        // Browser Back out of preview → return to the editor.
        pushedPreviewEntryRef.current = false;
        switchViewMode("edit", { syncUrl: false });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [switchViewMode]);

  // The Add Block panel is a real second pane, toggleable from the header.
  const [paletteOpen, setPaletteOpen] = useState(true);
  // Portal target guard: the fixed desktop palette renders into document.body so
  // it pins to the viewport regardless of any transformed/overflow ancestor in
  // the admin shell (a plain `position: fixed` in-tree resolves against a
  // transformed ancestor and scrolls away).
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => setPortalReady(true), []);
  // The REAL entity summary the public page renders from. `getMyPage` ships it
  // byte-identically to `getPublicPage`, which is what makes the canvas agree
  // with the live page (verified/accepts-bookings/geo all present). The
  // fabricated summary is a null-only backstop, never the normal path.
  const canvasEntity = useMemo(
    () => entity ?? buildFallbackEntity(page),
    [entity, page],
  );
  // The page/theme/entity envelope both surfaces render from; each one swaps
  // in its own block selection.
  const contentData = useMemo(
    () => buildPreviewData(page, blocks, theme, canvasEntity),
    [page, blocks, theme, canvasEntity],
  );
  const fieldsPage = useMemo(() => buildFieldsPage(page), [page]);
  // Effective layout mirrors the public page: an explicit valid choice wins,
  // otherwise the per-owner-type default (now "standard" for HUMAN/ORG/PLACE).
  const effectiveLayout =
    normalizeEntityPageLayoutKey(theme?.layoutKey) ??
    resolveDefaultEntityPageLayoutKey(ownerType);
  // ── The gate split ────────────────────────────────────────────────────────
  // The CANVAS is never gated: it renders the real page and every block stays
  // content-editable and hide/show-able for everyone, because the server keeps
  // `edit` (data/visible) and `toggleVisibility` ungated. What `editorMode`
  // now selects is purely which CHROME each block carries —
  //
  //   "full"      → drag handle, column-span, delete (+ the Add-block palette)
  //   "edit-only" → settings + hide/show only
  //
  // — matching the server, which rejects add/delete/reorder with FORBIDDEN
  // while `entityPageEditor` is off. A loading/undefined gate reads as OFF so
  // structural affordances never flash in. This is the whole change in kind:
  // the gate used to swap the RENDERER (a flat list + an iframe); now there is
  // one renderer and the gate only removes affordances from it.
  const { gates } = useFeatureGates();
  const editorGateOn = gates?.entityPageEditor === true;
  const editorMode = resolveEntityPageEditorMode({
    editorGateOn,
    effectiveLayout,
  });
  const isFullEditor = editorMode === "full";
  // Column span only means anything on the freeform "grid" layout — the
  // standard templates and the stacked layout ignore it.
  const canResizeBlocks = isFullEditor && effectiveLayout === "grid";

  // ── Can the mobile check load `/p/<slug>` at all? ─────────────────────────
  // It is an iframe of the PUBLISHED route, so offering it when that route
  // 404s puts a not-found page inside something labelled "preview". Two ways
  // it 404s, both mirrored here from the real gates:
  //   · PRIVATE pages — `getPublicPage` throws PAGE_NOT_FOUND for them
  //     (UNLISTED is fine: it renders, it is just unindexed, so it keeps the
  //     check);
  //   · a HUMAN page while `humanProfilesPublic` is off — `p/[slug]/page.tsx`
  //     calls notFound() for exactly that pair.
  // An unresolved gate reads as OFF, so the segment never flashes in.
  const publishedSlug =
    slug &&
    page.visibility !== "PRIVATE" &&
    (ownerType !== "HUMAN" || gates?.humanProfilesPublic === true)
      ? slug
      : null;

  // Undo/redo history over block actions. Active in BOTH modes: edit-only
  // produces only data/visibility diffs, which the history converges with the
  // ungated `edit` action. The hook truncates its stack on a mid-session
  // full → edit-only flip so stranded STRUCTURAL diffs (whose replay the
  // server would reject) can never be undone across the gate.
  const {
    canUndo,
    canRedo,
    isBusy: historyBusy,
    undo,
    redo,
    undoLabel,
    redoLabel,
  } = useBlockHistory({
    blocks,
    ownerType,
    ownerId,
    mode: editorMode,
  });

  // ── Which Cmd/Ctrl+Z is live right now? ──────────────────────────────────
  // The keydown handler bails while a field has focus, so the SAME keystroke
  // means "rewind my typing" there and "revert a saved block change" one click
  // outside it. Nothing used to signal the difference. Tracked on the document
  // (focusin/focusout bubble; the focus/blur pair does not).
  const [editableFocused, setEditableFocused] = useState(false);
  useEffect(() => {
    // Read the EVENT's target, not `document.activeElement`: on focusout the
    // active element is momentarily <body>, so tabbing between two inputs
    // would flicker the tooltip to the wrong meaning and back.
    const onFocusIn = (event: FocusEvent) =>
      setEditableFocused(isEditableElement(event.target as Element | null));
    const onFocusOut = (event: FocusEvent) =>
      setEditableFocused(
        isEditableElement(event.relatedTarget as Element | null),
      );
    setEditableFocused(isEditableElement(document.activeElement));
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Editor-scoped keyboard shortcuts, all on ONE window listener so they can't
  // race each other:
  //   Cmd/Ctrl+Shift+P → toggle Edit | Preview
  //   Escape           → leave Preview (overlays own Escape)
  //   Cmd/Ctrl+Z       → undo · Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y → redo
  // Undo/redo stays ignored while typing in a field so native text undo still
  // works inside block-settings inputs.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;

      // Cmd/Ctrl+Shift+P → toggle the in-view preview. Checked before the
      // undo/redo branch so it never falls through to it.
      if (mod && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        handleViewModeChange(
          viewModeRef.current === "preview" ? "edit" : "preview",
        );
        return;
      }

      // Escape → leave preview. Any open overlay (block settings dialog, crop
      // dialog, booking sheet…) owns Escape: window keydown listeners fire in
      // REGISTRATION order, so checking the DOM for an open dialog avoids
      // racing a just-opened Modal's stopImmediatePropagation. In edit mode
      // this falls through untouched, so nothing else loses Escape.
      if (event.key === "Escape") {
        if (viewModeRef.current !== "preview") return;
        if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
          return;
        }
        event.preventDefault();
        handleViewModeChange("edit");
        return;
      }

      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;

      // Typing in a field → leave Cmd/Ctrl+Z to the browser's text undo.
      // `editableFocused` mirrors this same predicate into the UI so the
      // button can say which meaning is live.
      if (isEditableElement(document.activeElement)) return;

      // The editor owns Cmd/Ctrl+Z / +Shift+Z / +Y here (not typing in a
      // field), so always swallow the browser's native history shortcut — even
      // while a convergence is busy or the stack end is reached — so it can't
      // reach into block-settings inputs or the page behind the editor.
      const wantRedo = key === "y" || (key === "z" && event.shiftKey);
      event.preventDefault();
      if (historyBusy) return;
      if (wantRedo) {
        if (canRedo) redo();
      } else if (key === "z") {
        if (canUndo) undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canUndo, canRedo, historyBusy, undo, redo, handleViewModeChange]);
  // The standard template ignores block ordering, so adding blocks is a no-op —
  // the palette is hidden alongside the canvas.
  // Desktop: a FIXED right-hand pane so it stays beside the canvas and follows
  // the user down a long block list (never scrolls out of view); it scrolls
  // internally when its own content is taller than the viewport. Narrow screens:
  // an in-flow pane stacked above the canvas. Dismissible via its own close
  // control; a slim "Add block" button brings it back.
  const fixedPaneStyle = {
    position: "fixed",
    top: FLOATING_PALETTE_TOP,
    right: FLOATING_PALETTE_RIGHT,
    maxHeight: `calc(100vh - ${FLOATING_PALETTE_TOP + 24}px)`,
    overflowY: "auto",
    zIndex: FLOATING_PALETTE_Z,
  } as const;
  const fixedButtonStyle = {
    position: "fixed",
    top: FLOATING_PALETTE_TOP,
    right: FLOATING_PALETTE_RIGHT,
    zIndex: FLOATING_PALETTE_Z,
  } as const;

  const paletteContent = paletteOpen ? (
    <AddBlockPalette
      blockConfigs={blockConfigs}
      onAddBlock={onAddBlock}
      isAddingBlock={isAddingBlock || historyBusy}
      width="100%"
      compact={!stackPalette}
      onClose={() => setPaletteOpen(false)}
      t={t}
    />
  ) : (
    <Button
      variant="primary"
      size="$2"
      width="100%"
      onPress={() => setPaletteOpen(true)}
      aria-expanded={false}
      aria-controls="entity-page-block-palette"
    >
      <Plus size={14} />
      {String(t("admin.peAddBlock"))}
    </Button>
  );

  // The palette is authoring chrome — and on desktop it is a FIXED pane, so
  // leaving it up would float it over the preview. Unmounting is safe: it
  // holds no user state beyond `paletteOpen`, which lives up here.
  let paletteSlot: ReactNode = null;
  if (isFullEditor && !isPreviewMode) {
    if (stackPalette) {
      // Narrow screens: in-flow pane stacked above the canvas.
      paletteSlot = (
        <LiveEditorRail width="100%" flexShrink={0} padding={16}>
          {paletteContent}
        </LiveEditorRail>
      );
    } else if (portalReady) {
      // Desktop: portal to body + fixed, so it follows scroll and never scrolls
      // out of view (escapes any transformed/overflow ancestor).
      paletteSlot = createPortal(
        <div style={paletteOpen ? fixedPaneStyle : fixedButtonStyle}>
          <div style={{ width: FLOATING_PALETTE_WIDTH }}>{paletteContent}</div>
        </div>,
        document.body,
      );
    }
  }

  // Reserve a right gutter for the fixed pane on desktop so the canvas never
  // slides under it. Kept whether open or closed for a stable layout — and
  // dropped in preview, where the pane isn't there to slide under.
  const reserveGutter = !stackPalette && isFullEditor && !isPreviewMode;

  return (
    <YStack flex={1}>
      {showHeader && (
        <EditorHeader
          stickyRef={headerStickyRef}
          title={title}
          backHref={backHref}
          headerBadge={headerBadge}
          headerActions={headerActions}
          slug={slug}
          isAddingBlock={isAddingBlock}
          showAddBlock={isFullEditor && !isPreviewMode}
          addBlockOpen={paletteOpen}
          onAddBlockOpenChange={setPaletteOpen}
        />
      )}

      <LiveEditorWorkspace flexDirection={stackPalette ? "column" : "row"}>
        {stackPalette ? paletteSlot : null}
        <LiveEditorMain
          style={
            reserveGutter
              ? {
                  paddingRight: FLOATING_PALETTE_RESERVE,
                  boxSizing: "border-box",
                }
              : undefined
          }
        >
          {/* One toolbar row, rendered unconditionally, so all three routes
              get the same control — two of them hide `EditorHeader`, which is
              why the toggle cannot live there. STICKY, because a full-page
              preview is taller than the viewport and the Edit segment is the
              only visible way back out of it (Escape and Cmd/Ctrl+Shift+P
              work but advertise themselves nowhere on the org and place
              routes, which have no header at all). Plain div wrapper: RNW
              strips `position: sticky` off styled components. */}
          <div
            style={{
              position: "sticky",
              top: headerOffset,
              zIndex: EDITOR_TOOLBAR_Z,
            }}
          >
            <EditorToolbarRow data-testid="entity-page-editor-toolbar">
              {/* View the published page. Page-owned since 2026-08-27 (the
                  floating action bar that used to carry it is gone); hidden
                  until the page has a public slug to open. */}
              {page.slug ? (
                <Button
                  variant="ghost"
                  size="$3"
                  data-testid="entity-page-view-live"
                  onPress={() => {
                    if (!page.slug) return;
                    window.open(
                      `/p/${page.slug}`,
                      "_blank",
                      "noopener,noreferrer",
                    );
                  }}
                >
                  <ExternalLink size={16} aria-hidden />
                  {String(t("pageActions.viewPage"))}
                </Button>
              ) : null}
              {/* The settings panel's ONE Save (Profile + Theme), lifted here
                  2026-08-30 so saving never requires first opening a collapsed
                  disclosure. Edit mode only: preview hides the forms, and a
                  Save whose targets are not on screen is a Save that looks
                  broken. Disabled-until-dirty, and refused outright while a
                  form is failing its own validation (a taken slug). Gone
                  entirely under `showSettings={false}`, where the host owns
                  those forms: it is the only consumer of what they register,
                  so left behind it would commit nothing. */}
              {!isPreviewMode && showSettings ? (
                <Button
                  variant="primary"
                  size="$3"
                  data-testid="entity-page-save"
                  data-entity-page-save="true"
                  disabled={
                    !settingsSave.isDirty ||
                    settingsSave.isPending ||
                    settingsSave.isBlocked
                  }
                  onPress={settingsSave.saveAll}
                >
                  {settingsSave.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <Save size={16} aria-hidden />
                  )}
                  {String(t("admin.peSaveChanges"))}
                </Button>
              ) : null}
              {/* Left cluster: the mode toggle, plus undo/redo while editing.
                  Its own flex row so the pair stays welded to the toggle when
                  the toolbar wraps at narrow widths. */}
              <XStack
                gap={12}
                alignItems="center"
                flexWrap="wrap"
                // Tamagui Stacks default to `flexShrink: 0`, so without these
                // the cluster keeps its MAX-content width and never wraps —
                // measured `documentElement.scrollWidth` 430 at a 320px
                // viewport once undo/redo joined the row.
                flexShrink={1}
                minWidth={0}
              >
                <ViewModeToggle
                  value={viewMode}
                  onChange={handleViewModeChange}
                  groupLabel={String(t("admin.peViewModeLabel"))}
                  testId="entity-page-view-mode-toggle"
                  segments={[
                    {
                      value: "edit",
                      label: String(t("admin.peTabEdit")),
                      testId: "entity-page-view-mode-edit",
                    },
                    {
                      value: "preview",
                      label: String(t("admin.peTabPreview")),
                      testId: "entity-page-view-mode-preview",
                      keyShortcuts: "Meta+Shift+P Control+Shift+P",
                    },
                  ]}
                />
                {/* Editing chrome — absent in preview. Works in both editor
                    modes (edit-only history converges via the ungated `edit`
                    action). */}
                {!isPreviewMode && (
                  <BlockHistoryToolbar
                    canUndo={canUndo}
                    canRedo={canRedo}
                    busy={historyBusy}
                    onUndo={undo}
                    onRedo={redo}
                    undoAction={undoLabel}
                    redoAction={redoLabel}
                    editableFocused={editableFocused}
                    t={t}
                  />
                )}
              </XStack>
              {/* Device check — same control grammar, same row, right-aligned.
                  Preview only (the authoring canvas is desktop-only), and only
                  when `/p/<slug>` will actually render. */}
              {isPreviewMode && publishedSlug && (
                <ViewModeToggle
                  value={previewDevice}
                  onChange={setPreviewDevice}
                  groupLabel={String(t("admin.pePreviewDeviceLabel"))}
                  testId="entity-page-preview-device-toggle"
                  segments={[
                    {
                      value: "desktop",
                      label: String(t("admin.epDesktop")),
                      testId: "entity-page-preview-desktop",
                      icon: (
                        <Monitor
                          size={16}
                          color={
                            previewDevice === "desktop"
                              ? onStructureColor
                              : inkColor
                          }
                        />
                      ),
                    },
                    {
                      value: "mobile",
                      label: String(t("admin.epMobile")),
                      testId: "entity-page-preview-mobile",
                      icon: (
                        <Smartphone
                          size={16}
                          color={
                            previewDevice === "mobile"
                              ? onStructureColor
                              : inkColor
                          }
                        />
                      ),
                    },
                  ]}
                />
              )}
            </EditorToolbarRow>
          </div>

          {/* Authoring surface. Kept MOUNTED while previewing (display:none)
              so the settings disclosure, open block-settings panels and their
              drafts, and the live undo/redo history all survive the trip. */}
          <div
            style={isPreviewMode ? HIDDEN_STYLE : undefined}
            data-testid="entity-page-edit-surface"
          >
            <YStack padding={16} paddingBottom={0} gap={16} width="100%">
              {showSettings ? (
                <PageSettingsDisclosure
                  fieldsPage={fieldsPage}
                  theme={theme}
                  ownerType={ownerType}
                  ownerId={ownerId}
                  extraSection={settingsExtra}
                  extraSectionLabel={settingsExtraLabel}
                  placeNameHint={placeNameHint}
                  t={t}
                />
              ) : null}
              {/* On its OWN line. It used to sit immediately right of the
                  undo/redo pair, which made two faded arrows parse as bullet
                  glyphs for this sentence instead of as a toolbar. It is about
                  the block list below, so it introduces that. */}
              {!isFullEditor && (
                <Text
                  variant="caption"
                  color="$colorMuted"
                  width="100%"
                  data-testid="entity-page-template-hint"
                >
                  {String(
                    t(
                      editorGateOn
                        ? "admin.peStandardTemplateHint"
                        : "admin.peStandardTemplateLockedHint",
                    ),
                  )}
                </Text>
              )}
            </YStack>

            <WysiwygPageCanvas
              data={contentData}
              blocks={blocks}
              ownerType={ownerType}
              ownerId={ownerId}
              mode={editorMode}
              canResize={canResizeBlocks}
              historyBusy={historyBusy}
            />
          </div>

          {isPreviewMode && (
            <PagePreviewSurface
              data={contentData}
              blocks={blocks}
              device={previewDevice}
              publishedSlug={publishedSlug}
              t={t}
            />
          )}
        </LiveEditorMain>

        {stackPalette ? null : paletteSlot}
      </LiveEditorWorkspace>
    </YStack>
  );
}
