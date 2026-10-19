"use client";

import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { YStack } from "tamagui";
import { Text, useNotify, Spinner, useTranslations } from "@th/ui";
import { Blocks, GripVertical } from "lucide-react";
import { ACCENT } from "@/lib/design-tokens";
import { Stack } from "tamagui";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { isPinnedBlockKind } from "@th/core/use-cases/entity-pages/block-config";
import { EditableBlock } from "./EditableBlock";
import type { EntityPageEditorMode } from "./editor-mode";
import {
  getBlockLabelKey,
  getDefaultBlockSpan,
} from "@th/core/use-cases/entity-pages";
import { hasEditableSettings } from "./block-settings-registry";

import { BlockRenderModeProvider } from "@/app/p/[slug]/_components/blocks/block-render-context";
import { BlockChromeProvider } from "@/app/p/[slug]/_components/blocks/block-chrome-context";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

interface BlockRecord {
  id: string;
  pageId: string;
  kind: string;
  orderIndex: number;
  data: unknown;
  visible: boolean;
}

export interface PageBlocksEditorProps {
  blocks: BlockRecord[];
  ownerType: PageOwnerType;
  ownerId: string;
  /**
   * Which per-block chrome to inject. `"full"` (default) adds the dnd-kit
   * wiring and the complete toolbar (drag, column span, delete). `"edit-only"`
   * keeps ONLY content-settings + hide/show — the server rejects structural
   * actions while the `entityPageEditor` gate is off, and the standard
   * templates arrange blocks themselves, so structure is not the owner's to
   * change there.
   *
   * NOTE: the mode does NOT choose a renderer. There is exactly one — the real
   * page, supplied by `children`.
   */
  mode?: EntityPageEditorMode;
  /** Column-span controls only mean something on the freeform "grid" layout. */
  canResize?: boolean;
  /**
   * True while an undo/redo convergence is issuing its own mutation sequence.
   * All direct block edits (drag reorder, delete, toggle, span change) are
   * frozen so a competing user action can't race the convergence into a
   * spurious `INVALID_BLOCK_ORDER`.
   */
  historyBusy?: boolean;
  /**
   * The page itself. Called with the order the canvas should currently show
   * (the live drag projection while dragging, the committed order otherwise)
   * and expected to render the REAL page components; the editor injects its
   * chrome into them via `BlockChromeProvider`.
   */
  children: (displayBlocks: BlockRecord[]) => ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block metadata helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatBlockKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getKindLabel(kind: string, t: (key: string) => unknown): string {
  const key = getBlockLabelKey(kind);
  if (!key) return formatBlockKind(kind);
  const label = String(t(key));
  return label !== key ? label : formatBlockKind(kind);
}

function getBlockColumnSpan(block: BlockRecord): 1 | 2 {
  const dataSpan = (block.data as Record<string, unknown> | null)?.columnSpan;
  if (dataSpan === 1 || dataSpan === 2) return dataSpan;
  return getDefaultBlockSpan(block.kind);
}

const NON_CONTENT_DATA_KEYS = new Set(["columnSpan", "dataSource", "heading"]);

function hasMeaningfulBlockData(value: unknown, key?: string): boolean {
  if (key && NON_CONTENT_DATA_KEYS.has(key)) return false;
  if (value == null) return false;

  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value))
    return value.some((item) => hasMeaningfulBlockData(item));

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([entryKey, entryValue]) => hasMeaningfulBlockData(entryValue, entryKey),
    );
  }

  return false;
}

function EditorBlockPlaceholder({
  label,
  t,
}: {
  label: string;
  t: (key: string) => unknown;
}) {
  return (
    <YStack
      minHeight={148}
      padding="$5"
      gap="$2"
      alignItems="flex-start"
      justifyContent="center"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      borderStyle="dashed"
      backgroundColor="$surfaceMuted"
      data-testid="entity-page-empty-block-placeholder"
    >
      <Text variant="overline" color="$accent">
        {label}
      </Text>
      <Text variant="body" color="$colorMuted">
        {String(t("admin.peBlockEmptyPlaceholder"))}
      </Text>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag overlay (non-interactive presentational copy that follows the pointer)
// ─────────────────────────────────────────────────────────────────────────────

function BlockDragOverlayCard({ label }: { label: string }) {
  return (
    <YStack
      minHeight={56}
      paddingHorizontal="$4"
      paddingVertical="$3"
      gap="$2"
      flexDirection="row"
      alignItems="center"
      borderWidth={2}
      borderColor="$brandSecondary"
      borderRadius={0}
      backgroundColor="$surface"
      data-testid="entity-page-drag-overlay"
      style={{ cursor: "grabbing" }}
    >
      {/* lucide-react icons take a raw CSS color, not a Tamagui token; ACCENT
          is the design-token-derived value of $brandSecondary used for the
          card border. */}
      <GripVertical size={16} color={ACCENT} />
      <Text variant="overline" color="$color">
        {label}
      </Text>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FLIP driver
//
// Real-DOM First/Last/Invert/Play. Because we measure actual rendered rects (the
// grid does the placement) and only ever translate — never scale — a mix of
// span-1 and span-2 cards reflows smoothly without the shear/collapse that
// dnd-kit's rectSortingStrategy produces (it applies scaleX/scaleY and assumes a
// linear arrayMove of rects that doesn't match CSS grid auto-flow packing).
// ─────────────────────────────────────────────────────────────────────────────

const FLIP_DURATION_MS = 160;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

// Directional drop with MIDPOINT HYSTERESIS.
//
// The projected insertion is chosen by where the dragged card's centre sits
// within the hovered target (the pointer drags the card, so this tracks where
// the user is hovering): centre in the target's UPPER half → open the gap ABOVE
// it (insert before); LOWER half → gap BELOW (insert after). A naive midpoint
// split flip-flops when the centre rests on the midpoint, which is the same
// update-depth loop the old center-core dead-zone guarded against. So the
// above/below decision is sticky: once committed, the centre must cross the FAR
// edge of a small dead band straddling the midpoint before the decision flips
// back.
//
// `MIDPOINT_HYSTERESIS` is the half-height of that band as a fraction of the
// target cell. The old center dead-zone found the flip-flop floor around
// 0.04–0.08; a band of 0.08 (± ~12px on a ~150px cell) sits comfortably above
// it — a ±2px dither at the midpoint never crosses out of the band, so the
// decision stays single/stable — while remaining responsive (a deliberate
// top→bottom sweep flips above→below well before the cell edge). Zero
// oscillation, deterministic drop, 60fps.
const MIDPOINT_HYSTERESIS = 0.08;

type DropSide = "above" | "below";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useFlipReflow() {
  const nodes = useRef(new Map<string, HTMLElement>());
  const firstRects = useRef(new Map<string, DOMRect>());
  const anims = useRef(new Map<string, Animation>());
  const pending = useRef(false);

  const registerFlipNode = useCallback(
    (id: string, el: HTMLElement | null) => {
      if (el) {
        nodes.current.set(id, el);
      } else {
        nodes.current.delete(id);
        // A DOM removal fires neither onfinish nor oncancel, so an in-flight
        // animation for this id would otherwise leak in the anims map. Cancel
        // it explicitly on unregister.
        anims.current.get(id)?.cancel();
        anims.current.delete(id);
      }
    },
    [],
  );

  // Belt-and-suspenders: cancel any survivors when the whole editor unmounts.
  useEffect(() => {
    const running = anims.current;
    return () => {
      running.forEach((anim) => anim.cancel());
      running.clear();
    };
  }, []);

  // Snapshot current (visual) positions immediately before an order change.
  const captureBefore = useCallback(() => {
    const first = firstRects.current;
    first.clear();
    nodes.current.forEach((el, id) =>
      first.set(id, el.getBoundingClientRect()),
    );
    pending.current = true;
  }, []);

  const play = useCallback(() => {
    if (!pending.current) return;
    pending.current = false;

    const first = firstRects.current;
    const reduce = prefersReducedMotion();

    nodes.current.forEach((el, id) => {
      const before = first.get(id);
      // Cancel any in-flight animation so getBoundingClientRect returns the
      // settled layout position for the "Last" measurement.
      const existing = anims.current.get(id);
      if (existing) {
        existing.cancel();
        anims.current.delete(id);
      }
      if (!before || reduce || typeof el.animate !== "function") return;

      const last = el.getBoundingClientRect();
      const dx = before.left - last.left;
      const dy = before.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      const anim = el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
      );
      anims.current.set(id, anim);
      anim.onfinish = () => {
        if (anims.current.get(id) === anim) anims.current.delete(id);
      };
      anim.oncancel = () => {
        if (anims.current.get(id) === anim) anims.current.delete(id);
      };
    });

    first.clear();
  }, []);

  return { registerFlipNode, captureBefore, play };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-block editor chrome
//
// The canvas renders the REAL page (EntityPageContent → owner-type template →
// BlockRenderer). These wrappers are injected at that choke point via
// `BlockChromeProvider`, so a block gets its toolbar exactly where the page
// puts it — no parallel block list, no divergence.
// ─────────────────────────────────────────────────────────────────────────────

type ChromeCommonProps = {
  block: BlockRecord;
  content: ReactNode;
  kindLabel: string;
  isPending: boolean;
  interactionsDisabled: boolean;
  onToggleVisibility: (blockId: string) => void;
};

/**
 * Blocks whose component renders app-authored content even with NO owner data
 * — a CTA card with built-in copy. Substituting the "this block is blank"
 * placeholder for these would be a lie: the published page shows a real card.
 */
const SELF_RENDERING_BLOCK_KINDS = new Set([
  "request_to_play",
  "rate_venue",
  // Pinned + server-injected: its own editor branch says "not editable, stays
  // on the page", which is the truth; "add content in settings" is not.
  "track_record",
]);

/** Empty blocks render nothing on the public page — show a labelled target. */
function blockBody(
  block: BlockRecord,
  content: ReactNode,
  kindLabel: string,
  t: (key: string) => unknown,
): ReactNode {
  const hasContent =
    hasMeaningfulBlockData(block.data) ||
    SELF_RENDERING_BLOCK_KINDS.has(block.kind);
  return hasContent ? (
    content
  ) : (
    <EditorBlockPlaceholder label={kindLabel} t={t} />
  );
}

/** `edit-only` chrome: settings + hide/show, no drag/span/delete, no dnd. */
function PlainBlockChrome({
  block,
  content,
  kindLabel,
  isPending,
  onToggleVisibility,
  ownerType,
  ownerId,
  t,
}: ChromeCommonProps & {
  ownerType: PageOwnerType;
  ownerId: string;
  t: (key: string) => unknown;
}) {
  return (
    <EditableBlock
      id={block.id}
      kind={block.kind}
      kindLabel={kindLabel}
      visible={block.visible}
      isPending={isPending}
      mode="edit-only"
      onToggleVisibility={() => onToggleVisibility(block.id)}
      hasSettings={hasEditableSettings(block.kind)}
      blockData={block.data}
      ownerType={ownerType}
      ownerId={ownerId}
    >
      {blockBody(block, content, kindLabel, t)}
    </EditableBlock>
  );
}

/** `full` chrome: adds the drag handle, column-span control and delete. */
function SortableBlockChrome({
  block,
  content,
  kindLabel,
  isPending,
  interactionsDisabled,
  onToggleVisibility,
  onDelete,
  onColumnSpanChange,
  canResize,
  registerFlipNode,
  ownerType,
  ownerId,
  t,
}: ChromeCommonProps & {
  onDelete: (blockId: string) => void;
  onColumnSpanChange: (block: BlockRecord, columnSpan: 1 | 2) => void;
  canResize: boolean;
  registerFlipNode: (id: string, el: HTMLElement | null) => void;
  ownerType: PageOwnerType;
  ownerId: string;
  t: (key: string) => unknown;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: block.id,
    disabled: interactionsDisabled,
  });

  // One node carries BOTH roles: dnd-kit measures it as the droppable, and the
  // FLIP driver translates it from its old to its new position. Keeping them on
  // the same element is safe here because the FLIP only ever runs BETWEEN
  // committed orders (never during a measure), and the real page layout — not
  // this editor — owns the grid the cards sit in.
  const composedRef = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el as HTMLElement);
      registerFlipNode(block.id, el);
    },
    [setNodeRef, registerFlipNode, block.id],
  );

  return (
    <EditableBlock
      id={block.id}
      kind={block.kind}
      kindLabel={kindLabel}
      visible={block.visible}
      isPending={isPending}
      dragDisabled={interactionsDisabled}
      onToggleVisibility={() => onToggleVisibility(block.id)}
      onDelete={() => onDelete(block.id)}
      hasSettings={hasEditableSettings(block.kind)}
      blockData={block.data}
      ownerType={ownerType}
      ownerId={ownerId}
      columnSpan={getBlockColumnSpan(block)}
      canResize={canResize}
      onColumnSpanChange={(nextSpan) => onColumnSpanChange(block, nextSpan)}
      dragHandleProps={{ ...attributes, ...(listeners ?? {}) }}
      isDragging={isDragging}
      flipRef={composedRef}
    >
      {blockBody(block, content, kindLabel, t)}
    </EditableBlock>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PageBlocksEditor({
  blocks,
  ownerType,
  ownerId,
  mode = "full",
  canResize = false,
  historyBusy = false,
  children,
}: PageBlocksEditorProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // Optimistic local block order (committed on drop) for smooth drag UX.
  const [localBlocks, setLocalBlocks] = useState<BlockRecord[] | null>(null);

  // Live-projected order WHILE dragging. Updated on every `over` change so the
  // grid reflows under the pointer; `dragOrderRef` mirrors it for handlers that
  // must read the latest value synchronously across dnd-kit events.
  const [dragOrder, setDragOrder] = useState<BlockRecord[] | null>(null);
  const dragOrderRef = useRef<BlockRecord[] | null>(null);
  const setDragOrderBoth = useCallback((next: BlockRecord[] | null) => {
    dragOrderRef.current = next;
    setDragOrder(next);
  }, []);

  // Sticky above/below decision for the currently hovered target, so the
  // midpoint hysteresis can require crossing back past the band before it flips.
  const dropDecisionRef = useRef<{ overId: string; side: DropSide } | null>(
    null,
  );

  const displayBlocks = dragOrder ?? localBlocks ?? blocks;

  const { registerFlipNode, captureBefore, play } = useFlipReflow();

  // Play the FLIP after the reflowed order commits to the DOM (before paint).
  useLayoutEffect(() => {
    play();
  }, [displayBlocks, play]);

  // Track the block currently being dragged so we can render it in a DragOverlay
  // instead of transforming it in place (which broke the 2-column grid).
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeBlock = activeId
    ? (displayBlocks.find((b) => b.id === activeId) ?? null)
    : null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const manageMutation = trpc.entityPages.managePageBlocks.useMutation({
    onSuccess: () => {
      setLocalBlocks(null);
      void utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
    },
    onError: (err) => {
      setLocalBlocks(null);
      toast.danger({
        id: "block-action-failed",
        title: String(t("admin.peBlockActionFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  // Freeze all direct edits while an undo/redo convergence is mid-flight so a
  // competing action can't race the convergence's own mutation sequence.
  const interactionsDisabled = historyBusy;

  // A pinned kind is never hidden or deleted (R6/FR-012). `EditableBlock`
  // withholds the controls; this is the second lock, so no other caller of
  // these handlers can send a request the server will refuse with
  // BLOCK_PINNED.
  const isPinnedId = useCallback(
    (blockId: string) => {
      const block = blocks.find((b) => b.id === blockId);
      return block !== undefined && isPinnedBlockKind(block.kind);
    },
    [blocks],
  );

  const handleToggleVisibility = useCallback(
    (blockId: string) => {
      if (interactionsDisabled || isPinnedId(blockId)) return;
      manageMutation.mutate({
        ownerType,
        ownerId,
        blockAction: { action: "toggleVisibility", blockId },
      });
    },
    [ownerType, ownerId, manageMutation, interactionsDisabled, isPinnedId],
  );

  const handleDelete = useCallback(
    (blockId: string) => {
      if (interactionsDisabled || isPinnedId(blockId)) return;
      manageMutation.mutate({
        ownerType,
        ownerId,
        blockAction: { action: "delete", blockId },
      });
    },
    [ownerType, ownerId, manageMutation, interactionsDisabled, isPinnedId],
  );

  const handleColumnSpanChange = useCallback(
    (block: BlockRecord, columnSpan: 1 | 2) => {
      if (interactionsDisabled) return;
      const currentData =
        typeof block.data === "object" &&
        block.data !== null &&
        !Array.isArray(block.data)
          ? (block.data as Record<string, unknown>)
          : {};

      manageMutation.mutate({
        ownerType,
        ownerId,
        blockAction: {
          action: "edit",
          blockId: block.id,
          data: { ...currentData, columnSpan },
        },
      });
    },
    [ownerType, ownerId, manageMutation, interactionsDisabled],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(String(event.active.id));
      dropDecisionRef.current = null;
      // Seed the live order from whatever we're currently showing.
      setDragOrderBoth(localBlocks ?? blocks);
    },
    [localBlocks, blocks, setDragOrderBoth],
  );

  // Reflow siblings live as the pointer crosses positions. The projected
  // insertion is DIRECTIONAL: pointer in the hovered target's upper half opens
  // the gap above it (insert before), lower half opens it below (insert after).
  // CSS grid re-places every card (opening a gap above/below or, for span-1
  // blocks, left/right) and the FLIP driver animates the shift.
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const base = dragOrderRef.current ?? localBlocks ?? blocks;
      const from = base.findIndex((b) => b.id === active.id);
      const to = base.findIndex((b) => b.id === over.id);
      if (from === -1 || to === -1) return;

      const overRect = over.rect;
      const dragRect = active.rect.current?.translated;
      if (!overRect || !dragRect) return;

      // Reference the dragged card's vertical CENTRE. `over` is resolved by
      // closestCenter on this same rect, so the up/down decision and the target
      // cell always share one coordinate basis — the decision can never disagree
      // with which cell dnd-kit picked (which would glitch). As the pointer
      // drags the card up within a target, its centre crosses the target's
      // midpoint → the gap flips from below to above.
      const refY = dragRect.top + dragRect.height / 2;

      const mid = overRect.top + overRect.height / 2;
      const band = overRect.height * MIDPOINT_HYSTERESIS;

      // Directional decision with midpoint hysteresis. On a FRESH target, pick by
      // which side of the midpoint the card's centre is on. On the SAME target,
      // keep the prior decision until the centre crosses the FAR edge of the dead
      // band straddling the midpoint — so a card resting near the midpoint (or a
      // ±2px dither) can't flip-flop the order (no oscillation / update-depth
      // loop).
      const prev = dropDecisionRef.current;
      let side: DropSide;
      if (!prev || prev.overId !== String(over.id)) {
        side = refY < mid ? "above" : "below";
      } else {
        side = prev.side;
        if (side === "above" && refY > mid + band) side = "below";
        else if (side === "below" && refY < mid - band) side = "above";
      }
      dropDecisionRef.current = { overId: String(over.id), side };

      // Map above/below to a linear insertion index. Removing the active element
      // shifts the target's index down by one when the active sits before it.
      const overIdxWithoutActive = from < to ? to - 1 : to;
      let newIndex =
        side === "above" ? overIdxWithoutActive : overIdxWithoutActive + 1;
      newIndex = Math.max(0, Math.min(base.length - 1, newIndex));

      const next = arrayMove(base, from, newIndex);
      // No-op if the projection is unchanged (e.g. staying within the dead band,
      // or the block already sits on the chosen side) — avoids a needless reflow
      // and FLIP restart.
      if (
        next.length === base.length &&
        next.every((b, i) => b.id === base[i]?.id)
      ) {
        return;
      }

      captureBefore();
      setDragOrderBoth(next);
    },
    [localBlocks, blocks, captureBefore, setDragOrderBoth],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    dropDecisionRef.current = null;
    // Animate the cards back to their original order.
    if (dragOrderRef.current) captureBefore();
    setDragOrderBoth(null);
  }, [captureBefore, setDragOrderBoth]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      dropDecisionRef.current = null;

      const finalOrder = dragOrderRef.current;
      const { over } = event;
      const base = localBlocks ?? blocks;

      // Revert to the committed order, animating any reflowed cards back home
      // (consistent with handleDragCancel) rather than snapping them.
      const revertHome = () => {
        if (finalOrder) captureBefore();
        setDragOrderBoth(null);
      };

      // Dropped outside any cell, or we never projected an order.
      if (!finalOrder || !over) {
        revertHome();
        return;
      }

      const unchanged =
        finalOrder.length === base.length &&
        finalOrder.every((b, i) => b.id === base[i]?.id);
      if (unchanged) {
        revertHome();
        return;
      }

      // The live-projected order IS the drop result the user saw — commit it.
      // displayBlocks stays on this same order, so no FLIP fires here.
      setDragOrderBoth(null);
      setLocalBlocks(finalOrder);

      manageMutation.mutate({
        ownerType,
        ownerId,
        blockAction: {
          action: "reorder",
          orderedBlockIds: finalOrder.map((b) => b.id),
        },
      });
    },
    [
      localBlocks,
      blocks,
      ownerType,
      ownerId,
      manageMutation,
      captureBefore,
      setDragOrderBoth,
    ],
  );

  // The chrome wrapper handed to `BlockChromeProvider`. Rebuilt whenever a
  // handler identity changes; the block objects themselves are looked up from
  // `displayBlocks` so a reorder projection is reflected immediately.
  const blockById = useMemo(() => {
    const map = new Map<string, BlockRecord>();
    for (const block of displayBlocks) map.set(block.id, block);
    return map;
  }, [displayBlocks]);

  const renderChrome = useCallback(
    ({ block, content }: { block: { id: string }; content: ReactNode }) => {
      const record = blockById.get(block.id);
      // A block the editor doesn't know about (shouldn't happen — the canvas
      // is fed from the same array) renders bare rather than disappearing.
      if (!record) return content;

      const kindLabel = getKindLabel(record.kind, t);
      const isPending = manageMutation.isPending || interactionsDisabled;

      if (mode === "edit-only") {
        return (
          <PlainBlockChrome
            block={record}
            content={content}
            kindLabel={kindLabel}
            isPending={isPending}
            interactionsDisabled={interactionsDisabled}
            onToggleVisibility={handleToggleVisibility}
            ownerType={ownerType}
            ownerId={ownerId}
            t={t}
          />
        );
      }

      return (
        <SortableBlockChrome
          block={record}
          content={content}
          kindLabel={kindLabel}
          isPending={isPending}
          interactionsDisabled={interactionsDisabled}
          onToggleVisibility={handleToggleVisibility}
          onDelete={handleDelete}
          onColumnSpanChange={handleColumnSpanChange}
          canResize={canResize}
          registerFlipNode={registerFlipNode}
          ownerType={ownerType}
          ownerId={ownerId}
          t={t}
        />
      );
    },
    [
      blockById,
      t,
      mode,
      manageMutation.isPending,
      interactionsDisabled,
      handleToggleVisibility,
      handleDelete,
      handleColumnSpanChange,
      canResize,
      registerFlipNode,
      ownerType,
      ownerId,
    ],
  );

  const canvas = (
    <BlockRenderModeProvider mode="editor">
      <BlockChromeProvider renderChrome={renderChrome}>
        {children(displayBlocks)}
      </BlockChromeProvider>
    </BlockRenderModeProvider>
  );

  const emptyNotice =
    displayBlocks.length === 0 ? (
      <YStack
        paddingVertical="$6"
        marginHorizontal="auto"
        maxWidth={900}
        width="100%"
        alignItems="center"
        gap="$2"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
        borderStyle="dashed"
        data-testid="entity-page-no-blocks"
      >
        <Blocks size={32} color="$colorMuted" />
        <Text variant="body" color="$colorMuted">
          {String(
            t(
              mode === "edit-only"
                ? "admin.peNoBlocksEditOnly"
                : "admin.peNoBlocks",
            ),
          )}
        </Text>
      </YStack>
    ) : null;

  const pendingSpinner = manageMutation.isPending ? (
    <Stack
      style={
        {
          display: "flex",
          justifyContent: "center",
          paddingTop: 8,
        } as Record<string, unknown>
      }
    >
      <Spinner size="sm" />
    </Stack>
  ) : null;

  // ── Edit-only — no dnd wiring at all ───────────────────────────────────────
  // Skipping DndContext entirely (rather than disabling it) means no drag
  // handles, no sortable roles or aria drag announcements, and no FLIP/overlay
  // machinery for a mode where order is server-controlled.
  if (mode === "edit-only") {
    return (
      <YStack gap="$4" data-testid="entity-page-block-canvas">
        {canvas}
        {emptyNotice}
        {pendingSpinner}
      </YStack>
    );
  }

  return (
    <YStack gap="$4" data-testid="entity-page-block-canvas">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        // We physically reorder the DOM on every projected swap, and SortableContext
        // re-measures ALL cells whenever its `items` order changes (measureDroppable
        // containers on itemsHaveChanged) — so droppable rects are already refreshed
        // on each reorder without MeasuringStrategy.Always. Always additionally
        // re-measured every droppable on frames where nothing moved, which was a
        // per-frame layout-thrash loop (measure → reflow → FLIP → measure) and the
        // source of the janky/over-eager drag. Default WhileDragging + the
        // measure-on-reorder above keeps `over` accurate (verified: no boundary
        // oscillation) at a fraction of the cost.
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={displayBlocks.map((b) => b.id)}
          strategy={rectSortingStrategy}
        >
          {canvas}
        </SortableContext>

        {/* Render the drag overlay through a portal to document.body so its
            position:fixed is always viewport-relative. Rendered inline, any
            ancestor that establishes a containing block (transform/filter/
            contain) would offset the overlay from the pointer by ~200px. */}
        {typeof document !== "undefined"
          ? createPortal(
              <DragOverlay dropAnimation={null}>
                {activeBlock ? (
                  <BlockDragOverlayCard
                    label={getKindLabel(activeBlock.kind, t)}
                  />
                ) : null}
              </DragOverlay>,
              document.body,
            )
          : null}
      </DndContext>

      {emptyNotice}
      {pendingSpinner}
    </YStack>
  );
}
