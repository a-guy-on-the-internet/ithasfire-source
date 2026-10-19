"use client";

import { useState, type ReactNode } from "react";
import { styled, XStack, YStack, Stack } from "tamagui";
import { Text, Badge, useTranslations } from "@th/ui";
import { GripVertical, Eye, EyeOff, Trash2, Settings } from "lucide-react";
import { isPinnedBlockKind } from "@th/core/use-cases/entity-pages/block-config";
import { ACCENT } from "@/lib/design-tokens";
import { BlockSettingsPanel } from "./BlockSettingsPanel";
import type { EntityPageEditorMode } from "./editor-mode";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

interface EditableBlockProps {
  id: string;
  kind: string;
  kindLabel: string;
  visible: boolean;
  isPending: boolean;
  /**
   * Which subset of chrome to render. `"full"` (default) shows the whole
   * toolbar — drag handle, span controls, settings, hide/show, delete.
   * `"edit-only"` (standard-template experience) keeps only settings and
   * hide/show: structure is locked, so no drag/span/delete affordances and
   * no drag semantics are announced.
   */
  mode?: EntityPageEditorMode;
  onToggleVisibility: () => void;
  /** Required in `"full"` mode; unused (and hidden) in `"edit-only"`. */
  onDelete?: () => void;
  hasSettings?: boolean;
  /** Block data for the settings panel */
  blockData?: unknown;
  ownerType?: PageOwnerType;
  ownerId?: string;
  columnSpan?: 1 | 2;
  canResize?: boolean;
  onColumnSpanChange?: (columnSpan: 1 | 2) => void;
  /**
   * Drag-handle attributes/listeners from the parent `SortableBlockCell`'s
   * `useSortable`. The sortable/droppable node lives on the outer grid cell so
   * that the FLIP transform (below) can be applied to this card without
   * corrupting dnd-kit's droppable measurements.
   */
  dragHandleProps?: Record<string, unknown>;
  /** True while this block is the active drag source. */
  isDragging?: boolean;
  /** True while undo/redo convergence has frozen reordering. */
  dragDisabled?: boolean;
  /**
   * Ref callback that registers this card's DOM node with the parent's FLIP
   * driver, which animates it from its previous to its new grid position on
   * reorder (measured from real layout — no scale, so mixed spans never shear).
   */
  flipRef?: (el: HTMLElement | null) => void;
  children: ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const BlockWrapper = styled(YStack, {
  name: "EditableBlock",
  position: "relative",
  width: "100%",
  borderWidth: 2,
  borderColor: "transparent",
  borderRadius: 0,
  transition: "border-color 120ms ease-out, opacity 120ms ease-out",
  variants: {
    editing: {
      true: {
        hoverStyle: {
          borderColor: "$brandSecondary",
        },
      },
    },
    hidden: {
      true: {
        opacity: 0.5,
      },
    },
  },
});

/**
 * Hover toolbar. This fill is a FIXED dark navy in every theme (it is not a
 * theme token), so every foreground inside it — the `#FFFFFF` icons/labels and
 * the white-alpha hover/border fills on the buttons below — is CORRECT as-is
 * and must NOT be inverted to ink; ink would be invisible on the navy.
 *
 * Unlike the retired action dock, these cannot derive from `onStructure` either: it
 * tracks a themed `backgroundStrong` fill, whereas this bar is a fixed navy, so
 * a themed foreground could drift away from it. If this fill is ever
 * re-tokenised to a theme surface, migrate the foregrounds to
 * `hexToRgba(onStructure, α)` in the same change.
 */
const EditChrome = styled(XStack, {
  name: "EditableBlockChrome",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 10,
  justifyContent: "space-between",
  alignItems: "center",
  // A narrow block (a 320px phone, a one-column block) is thinner than the
  // label plus the actions: wrap the actions onto a second row instead of
  // pushing them past the block's right edge, which scrolled the page sideways.
  flexWrap: "wrap",
  rowGap: 0,
  columnGap: 6,
  paddingHorizontal: 8,
  // The 44px buttons set the bar's height; padding would only add to it.
  paddingVertical: 0,
  backgroundColor: "rgba(15, 27, 51, 0.85)",
  opacity: 0,
  transition: "opacity 120ms ease-out",
});

/** Every toolbar button's hit area, in px: the 44px minimum tap target. */
export const BLOCK_ACTION_TARGET = 44;

/** Lives inside the fixed-navy EditChrome — white alpha is intentional.
 *  Rendered as a real <button> so every toolbar action is keyboard-operable
 *  (Enter/Space) and announced with its aria-label. */
const ActionButton = styled(Stack, {
  name: "EditableBlockAction",
  tag: "button",
  // A 44px tap target (design rule) around the same 14px icon.
  width: BLOCK_ACTION_TARGET,
  height: BLOCK_ACTION_TARGET,
  padding: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  borderRadius: 0,
  borderWidth: 0,
  backgroundColor: "transparent",
  hoverStyle: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  pressStyle: {
    opacity: 0.7,
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$brandSecondary",
    outlineOffset: -2,
  },
});

/** Lives inside the fixed-navy EditChrome — white alpha is intentional. */
const SpanButton = styled(Stack, {
  name: "EditableBlockSpanAction",
  tag: "button",
  minWidth: BLOCK_ACTION_TARGET,
  height: BLOCK_ACTION_TARGET,
  paddingHorizontal: 6,
  paddingVertical: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.22)",
  backgroundColor: "transparent",
  hoverStyle: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$brandSecondary",
    outlineOffset: -2,
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$brandSecondary",
        borderColor: "$brandSecondary",
      },
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function EditableBlock({
  id,
  kind,
  kindLabel,
  visible,
  isPending,
  mode = "full",
  onToggleVisibility,
  onDelete,
  hasSettings = false,
  blockData,
  ownerType,
  ownerId,
  columnSpan = 2,
  canResize = false,
  onColumnSpanChange,
  dragHandleProps,
  isDragging = false,
  dragDisabled = false,
  flipRef,
  children,
}: EditableBlockProps) {
  const [hovered, setHovered] = useState(false);
  // Focus-within mirror: the chrome fades in for keyboard users the moment any
  // of its buttons receives focus (it is hover-revealed for pointer users).
  const [focusWithin, setFocusWithin] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const editOnly = mode === "edit-only";
  const t = useTranslations();

  // A pinned kind (`track_record`) is reorderable but never hidden or removed
  // (venue-track-record-and-review-switch R6/FR-012). The server refuses both
  // with BLOCK_PINNED; the controls are withheld here so the owner is never
  // offered an action that can only fail. Drag, span and settings stay.
  const pinned = isPinnedBlockKind(kind);

  // The dragged card is mirrored by the portaled <DragOverlay> clone that
  // follows the pointer, so the in-place source only needs to dim into a "drop
  // slot". Sibling displacement is animated by the parent's FLIP driver, which
  // translates this node from its old to its new grid position — never a
  // width/height scale — so a mix of span-1 and span-2 blocks never shears or
  // collapses (the failure mode of dnd-kit's rectSortingStrategy transforms).
  const style = {
    opacity: isDragging ? 0.4 : undefined,
  };
  const chromeShown = (hovered || focusWithin) && !isDragging;

  return (
    <BlockWrapper
      ref={flipRef}
      style={style}
      editing
      hidden={!visible}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...({
        // React focus events bubble, so this tracks :focus-within. Blur only
        // clears when focus leaves the whole card (not between its buttons).
        onFocus: () => setFocusWithin(true),
        onBlur: (event: {
          currentTarget: HTMLElement;
          relatedTarget: Node | null;
        }) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusWithin(false);
          }
        },
      } as Record<string, unknown>)}
      data-testid={`entity-page-editable-block-${id}`}
      {...(isDragging ? { borderColor: "$brandSecondary" } : {})}
    >
      {/* Edit chrome — appears on hover or keyboard focus (hidden on the
          dimmed drag source) */}
      <EditChrome
        style={{
          opacity: chromeShown ? 1 : 0,
          // Hidden = not hittable: a touch tap on a block must not land on an
          // invisible Delete. Hover and focus-within still reveal it (focus
          // reaches buttons under `pointer-events: none`), and a revealed bar
          // takes presses again.
          pointerEvents: chromeShown ? "auto" : "none",
        }}
        data-testid={`entity-page-block-chrome-${id}`}
        data-shown={chromeShown ? "true" : "false"}
      >
        {/* Left side: drag handle (full mode only) + kind label */}
        <XStack gap={6} alignItems="center" flexShrink={1} minWidth={0}>
          {!editOnly && (
            <ActionButton
              {...(dragDisabled ? {} : (dragHandleProps ?? {}))}
              {...({
                "aria-label": `Drag to reorder ${kindLabel}`,
                "aria-disabled": dragDisabled ? true : undefined,
              } as Record<string, unknown>)}
              cursor={dragDisabled ? "not-allowed" : "grab"}
              opacity={dragDisabled ? 0.4 : 1}
            >
              <GripVertical size={14} color="#FFFFFF" />
            </ActionButton>
          )}
          <Text
            variant="overline"
            color="#FFFFFF"
            style={{
              fontWeight: 700,
              minWidth: 0,
              overflowWrap: "anywhere",
            }}
          >
            {kindLabel}
          </Text>
          {!visible && (
            <Badge tone="neutral" size="sm">
              HIDDEN
            </Badge>
          )}
        </XStack>

        {/* Right side: actions (edit-only keeps just settings + hide/show) */}
        <XStack
          gap={2}
          alignItems="center"
          marginLeft="auto"
          // Five 44px targets outgrow a one-column block at 320px: wrap them
          // rather than push the last one past the block's edge.
          flexWrap="wrap"
          justifyContent="flex-end"
          data-testid={`entity-page-block-actions-${id}`}
        >
          {!editOnly && canResize && onColumnSpanChange && (
            <XStack gap={2} alignItems="center">
              <SpanButton
                active={columnSpan === 1}
                onPress={() => onColumnSpanChange(1)}
                aria-label={`Set ${kindLabel} to one column`}
                disabled={isPending}
                data-testid={`entity-page-block-span-${id}-1`}
              >
                <Text variant="caption" color="#FFFFFF" weight="bold">
                  1
                </Text>
              </SpanButton>
              <SpanButton
                active={columnSpan === 2}
                onPress={() => onColumnSpanChange(2)}
                aria-label={`Set ${kindLabel} to two columns`}
                disabled={isPending}
                data-testid={`entity-page-block-span-${id}-2`}
              >
                <Text variant="caption" color="#FFFFFF" weight="bold">
                  2
                </Text>
              </SpanButton>
            </XStack>
          )}
          {hasSettings && (
            <ActionButton
              onPress={() => setSettingsOpen((v) => !v)}
              aria-label={`Settings for ${kindLabel}`}
              {...({ "aria-pressed": settingsOpen } as Record<string, unknown>)}
              disabled={isPending}
            >
              <Settings size={14} color={settingsOpen ? ACCENT : "#FFFFFF"} />
            </ActionButton>
          )}
          {pinned ? (
            <Text
              variant="overline"
              color="#FFFFFF"
              style={{ opacity: 0.8, paddingInline: 6 }}
              data-testid={`entity-page-block-pinned-${id}`}
            >
              {String(t("admin.peBlockPinned"))}
            </Text>
          ) : (
            <ActionButton
              onPress={onToggleVisibility}
              aria-label={visible ? `Hide ${kindLabel}` : `Show ${kindLabel}`}
              {...({ "aria-pressed": visible } as Record<string, unknown>)}
              disabled={isPending}
            >
              {visible ? (
                <Eye size={14} color="#FFFFFF" />
              ) : (
                <EyeOff size={14} color="#FFFFFF" />
              )}
            </ActionButton>
          )}
          {!editOnly && !pinned && onDelete && (
            <ActionButton
              onPress={onDelete}
              aria-label={`Delete ${kindLabel}`}
              disabled={isPending}
            >
              <Trash2 size={14} color={ACCENT} />
            </ActionButton>
          )}
        </XStack>
      </EditChrome>

      {/* The actual block content is inert; the wrapper opens settings. */}
      <YStack
        cursor={hasSettings ? "pointer" : undefined}
        onPress={() => {
          if (hasSettings) setSettingsOpen(true);
        }}
        aria-label={hasSettings ? `Open settings for ${kindLabel}` : undefined}
      >
        <YStack pointerEvents="none">{children}</YStack>
      </YStack>

      {/* Inline settings panel */}
      {settingsOpen && hasSettings && ownerType && ownerId && (
        <BlockSettingsPanel
          blockId={id}
          kind={kind}
          data={blockData}
          ownerType={ownerType}
          ownerId={ownerId}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </BlockWrapper>
  );
}

EditableBlock.displayName = "EditableBlock";
