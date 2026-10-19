"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getPaletteBlockConfigs } from "@th/core/use-cases/entity-pages";
import { isPinnedBlockKind } from "@th/core/use-cases/entity-pages/block-config";

import { trpc } from "@/trpc";
import { useNotify, useTranslations } from "@th/ui";

import type { EntityPageEditorMode } from "./editor-mode";
import {
  describeHistoryStep,
  formatBlockKind,
  type HistoryBlock,
  type HistoryStepDescription,
  type HistoryStepKind,
} from "./describe-history-step";

// ─────────────────────────────────────────────────────────────────────────────
// Block-editor undo/redo history.
//
// PERSISTENCE MODEL (verified): every block action (add | edit | reorder |
// toggleVisibility | delete) is its OWN immediately-persisted `managePageBlocks`
// mutation that invalidates `getMyPage`. There is no batched SAVE for blocks
// (the SAVE button only commits page settings/theme). So undo/redo cannot just
// rewind client state — it must issue real inverse/forward mutations.
//
// DESIGN — snapshot history + convergent apply:
//   • We observe the AUTHORITATIVE ordered block list (getMyPage → `blocks`),
//     which reflects every committed action regardless of which component
//     triggered it (palette add, settings-panel edit, in-canvas reorder/delete/
//     toggle/span-edit). After each genuine change we push a snapshot.
//   • Undo/redo pick the adjacent snapshot and CONVERGE the server to it: delete
//     extra blocks, (re)create missing ones, edit changed data/visibility, then
//     reorder. One invalidation at the end keeps the UI from flashing and keeps
//     us from recording our own result as a new action.
//
// THE ID PROBLEM (handled): block ids are server-generated. Undo-of-delete /
// redo-of-add must re-create a block, which yields a NEW id. We remap that id
// across the ENTIRE history (every snapshot) so later undo/redo stay consistent.
// ─────────────────────────────────────────────────────────────────────────────

export type { HistoryBlock };

type Snapshot = HistoryBlock[];

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

export interface UseBlockHistoryArgs {
  /** Authoritative ordered block list from getMyPage. */
  blocks: HistoryBlock[];
  ownerType: PageOwnerType;
  ownerId: string;
  /**
   * Current editor mode. History records in BOTH modes, but the stack is
   * truncated whenever the editor drops out of the full experience
   * (`"full"` → `"edit-only"`): only the full editor can push STRUCTURAL
   * diffs (add/delete/reorder), and edit-only convergence is forbidden from
   * replaying them (the server rejects those actions while the
   * `entityPageEditor` gate is off).
   */
  mode: EntityPageEditorMode;
}

export interface UseBlockHistory {
  canUndo: boolean;
  canRedo: boolean;
  isBusy: boolean;
  undo: () => void;
  redo: () => void;
  /**
   * Short human phrase for the action undo would REVERT ("hide \u2018Upcoming
   * events\u2019"), or null when there is nothing to undo. Undo here publishes
   * an inverse mutation to a live page, so the control has to name its scope
   * rather than say a bare "Undo".
   */
  undoLabel: string | null;
  /** Same, for the action redo would REAPPLY. Null when there is no future. */
  redoLabel: string | null;
}

const MAX_HISTORY = 50;

// ── Derived-overlay strip ────────────────────────────────────────────────────
// `getMyPage` expands READ-TIME derived content into `block.data` for a handful
// of kinds (`expandDerivedBlocks` in core/get-my-page.ts): it injects a
// `dataSource` marker plus live server content (upcoming/past `events`,
// `announcements`, a place `address`/`lat`/`lng`, and the performer-stats
// `eligible`/`computedAt`/`metrics`). None of that is user-authored — it is
// re-injected on every read — but the block write schema is a passthrough
// object, so if history snapshotted the overlay it would RE-PERSIST stale
// derived payloads on undo/redo (add/edit convergence writes `data` verbatim).
// That corrupts stored data, amplifies writes, bloats memory, and — because the
// overlay drifts between reads — defeats snapshot dedup (spurious edit mutations
// against derived blocks whenever an unrelated block is undone).
//
// So we snapshot ONLY the authored data: whenever the marker is present we drop
// the marker and every known derived key. Keying the strip on the `dataSource`
// marker keeps us from ever touching genuine authored content (which never
// carries it), and stripping the full union covers any dataSource variant —
// including a forthcoming ORG upcoming-events derivation that reuses the same
// `events` + `dataSource` marker.
const DERIVED_MARKER = "dataSource";
const DERIVED_OVERLAY_KEYS = new Set<string>([
  DERIVED_MARKER,
  // announcements block
  "announcements",
  // location_map (PLACE) block
  "address",
  "lat",
  "lng",
  // shows / past_shows (and ORG upcoming-events) blocks
  "events",
  // stats block (buildPerformerStatsBlockData)
  "eligible",
  "computedAt",
  "metrics",
]);

/** Strip the read-time derived overlay from a block's data so history snapshots
 *  (and the mutations `convergeTo` derives from them) only ever carry authored
 *  content. No-op unless the `dataSource` marker is present. */
function stripDerivedOverlay(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  const obj = data as Record<string, unknown>;
  if (!(DERIVED_MARKER in obj)) return data;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (DERIVED_OVERLAY_KEYS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/** Order-insensitive-key stable stringify so re-normalised server data compares
 *  equal regardless of object key ordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function dataEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function toSnapshot(blocks: HistoryBlock[]): Snapshot {
  return blocks.map((b) => ({
    id: b.id,
    kind: b.kind,
    // Snapshot authored data only — never the read-time derived overlay.
    data: stripDerivedOverlay(b.data),
    visible: b.visible,
  }));
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.kind !== y.kind || x.visible !== y.visible) {
      return false;
    }
    if (!dataEqual(x.data, y.data)) return false;
  }
  return true;
}

export function useBlockHistory({
  blocks,
  ownerType,
  ownerId,
  mode,
}: UseBlockHistoryArgs): UseBlockHistory {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const mutation = trpc.entityPages.managePageBlocks.useMutation();
  const mutateAsync = mutation.mutateAsync;

  const snapshotsRef = useRef<Snapshot[]>([]);
  const indexRef = useRef<number>(-1);
  const applyingRef = useRef<boolean>(false);
  // Set after a half-applied convergence: the NEXT observed server state is
  // re-anchored in place (replaces the current snapshot) instead of being
  // recorded as a fresh action, so a partial failure never pushes a phantom
  // entry or truncates the redo future.
  const reanchorRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  // The classified STEPS, not the rendered strings: keeping wording out of
  // this callback lets `syncFlags` stay dependency-free (it is a dep of the
  // recording effect, so an unstable identity would re-run it every render)
  // while the phrasing still re-renders on a locale change.
  const [undoStep, setUndoStep] = useState<HistoryStepDescription | null>(null);
  const [redoStep, setRedoStep] = useState<HistoryStepDescription | null>(null);

  const syncFlags = useCallback(() => {
    const snaps = snapshotsRef.current;
    const i = indexRef.current;
    const hasUndo = i > 0;
    const hasRedo = i >= 0 && i < snaps.length - 1;
    setCanUndo(hasUndo);
    setCanRedo(hasRedo);
    setUndoStep(hasUndo ? describeHistoryStep(snaps[i - 1]!, snaps[i]!) : null);
    setRedoStep(hasRedo ? describeHistoryStep(snaps[i]!, snaps[i + 1]!) : null);
  }, []);

  // ── Record snapshots on genuine (non-undo/redo) changes ──────────────────
  useEffect(() => {
    // Ignore the echo of our own undo/redo convergence.
    if (applyingRef.current) return;

    const snap = toSnapshot(blocks);

    // Re-anchor after a partial-apply failure: overwrite the current snapshot
    // with server truth (keeping index + redo future intact) rather than
    // recording a phantom new action.
    if (reanchorRef.current) {
      reanchorRef.current = false;
      if (indexRef.current >= 0) {
        const next = snapshotsRef.current.slice();
        next[indexRef.current] = snap;
        snapshotsRef.current = next;
        syncFlags();
        return;
      }
    }

    if (indexRef.current < 0) {
      snapshotsRef.current = [snap];
      indexRef.current = 0;
      syncFlags();
      return;
    }

    const current = snapshotsRef.current[indexRef.current];
    if (current && snapshotsEqual(current, snap)) return;

    // Genuine new action: drop any redo future, push, cap depth.
    const next = snapshotsRef.current.slice(0, indexRef.current + 1);
    next.push(snap);
    if (next.length > MAX_HISTORY) next.shift();
    snapshotsRef.current = next;
    indexRef.current = next.length - 1;
    syncFlags();
  }, [blocks, syncFlags]);

  // ── Truncate history when the editor drops to edit-only ──────────────────
  // A mid-session `"full"` → `"edit-only"` flip (platform admin turns the
  // `entityPageEditor` gate off, or the layout switches back to "standard")
  // can strand STRUCTURAL diffs in the stack. Undoing across the flip would
  // half-apply: the convergence's `edit` steps succeed but `add`/`delete`/
  // `reorder` are rejected with FORBIDDEN. So the stack is re-seeded from the
  // current server state — from here on, only diffs reachable in edit-only
  // (data/visibility, converged via the always-allowed `edit`) can enter it.
  const prevModeRef = useRef<EntityPageEditorMode>(mode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === "full" && mode === "edit-only") {
      snapshotsRef.current = [toSnapshot(blocks)];
      indexRef.current = 0;
      syncFlags();
    }
  }, [mode, blocks, syncFlags]);

  /** Rewrite a re-created block's id across every stored snapshot. */
  const remapHistory = useCallback((remap: Map<string, string>) => {
    if (remap.size === 0) return;
    snapshotsRef.current = snapshotsRef.current.map((snap) =>
      snap.map((b) => {
        const newId = remap.get(b.id);
        return newId ? { ...b, id: newId } : b;
      }),
    );
  }, []);

  /** Transform the live server state (== `from`) into `target` with the minimal
   *  set of managePageBlocks operations, remapping any re-created block ids. */
  const convergeTo = useCallback(
    async (from: Snapshot, target: Snapshot) => {
      const targetById = new Map(target.map((b) => [b.id, b]));
      const fromById = new Map(from.map((b) => [b.id, b]));
      const remap = new Map<string, string>();

      // 1. Delete blocks that shouldn't exist in the target. A PINNED kind is
      //    never deleted (R6/FR-012): the server refuses with BLOCK_PINNED,
      //    and a throw here would strand the convergence half-applied. A
      //    snapshot without it can only come from before the kind was seeded,
      //    so it is skipped and stays live.
      let deletedAny = false;
      for (const b of from) {
        if (isPinnedBlockKind(b.kind)) continue;
        if (!targetById.has(b.id)) {
          await mutateAsync({
            ownerType,
            ownerId,
            blockAction: { action: "delete", blockId: b.id },
          });
          deletedAny = true;
        }
      }

      // 2. Re-create blocks present in target but not live (server assigns a
      //    new id → remap the old snapshot id across all history).
      for (const b of target) {
        if (!fromById.has(b.id)) {
          const res = await mutateAsync({
            ownerType,
            ownerId,
            blockAction: {
              action: "add",
              kind: b.kind,
              data: b.data,
              visible: b.visible,
            },
          });
          const newId = res.block?.id;
          if (newId) remap.set(b.id, newId);
        }
      }

      const liveId = (targetId: string) => remap.get(targetId) ?? targetId;

      // 3. Edit blocks present in both whose data/visibility differs (minimal
      //    patch so a visibility toggle never re-sends data, etc.).
      for (const b of target) {
        const f = fromById.get(b.id);
        if (!f) continue;
        const dataChanged = !dataEqual(f.data, b.data);
        // Hiding a pinned block is refused server-side too; the visibility
        // half of a pinned diff is dropped, the data half still applies.
        const visibleChanged =
          f.visible !== b.visible && !isPinnedBlockKind(b.kind);
        if (!dataChanged && !visibleChanged) continue;
        await mutateAsync({
          ownerType,
          ownerId,
          blockAction: {
            action: "edit",
            blockId: b.id,
            ...(dataChanged && { data: b.data }),
            ...(visibleChanged && { visible: b.visible }),
          },
        });
      }

      // 4. Reorder to the target order (only when structure or order changed).
      //    The order sent must cover EVERY live block (the server rejects an
      //    id set that differs from the page's with INVALID_BLOCK_ORDER), and
      //    step 1 leaves a pinned block live even when the target snapshot
      //    predates it — so any such block is spliced back in at the index it
      //    holds on the page.
      const orderedTarget: Snapshot = target.slice();
      from.forEach((b, i) => {
        if (isPinnedBlockKind(b.kind) && !targetById.has(b.id)) {
          orderedTarget.splice(Math.min(i, orderedTarget.length), 0, b);
        }
      });
      const orderedLiveIds = orderedTarget.map((b) => liveId(b.id));
      let reorderNeeded = deletedAny || remap.size > 0;
      if (!reorderNeeded) {
        for (let i = 0; i < orderedTarget.length; i++) {
          if (from[i]?.id !== orderedTarget[i]!.id) {
            reorderNeeded = true;
            break;
          }
        }
      }
      if (reorderNeeded && orderedLiveIds.length > 0) {
        await mutateAsync({
          ownerType,
          ownerId,
          blockAction: {
            action: "reorder",
            orderedBlockIds: orderedLiveIds,
          },
        });
      }

      remapHistory(remap);
    },
    [ownerType, ownerId, mutateAsync, remapHistory],
  );

  const step = useCallback(
    async (direction: -1 | 1) => {
      if (applyingRef.current) return;
      const from = snapshotsRef.current[indexRef.current];
      const targetIndex = indexRef.current + direction;
      const target = snapshotsRef.current[targetIndex];
      if (!from || !target) return;

      applyingRef.current = true;
      setIsBusy(true);
      try {
        await convergeTo(from, target);
        // Clamp in case the stack was truncated (mode flip) mid-convergence,
        // so a stale index can't leave the undo/redo flags pointing past it.
        indexRef.current = Math.min(
          targetIndex,
          snapshotsRef.current.length - 1,
        );
        syncFlags();
        await utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
      } catch (err) {
        // Convergence is a non-atomic mutation sequence — a mid-sequence failure
        // half-applies. Be honest that only PART of the change went through, and
        // re-anchor the stack to server truth (the next observed state replaces
        // the current snapshot in place; index + redo future are preserved).
        reanchorRef.current = true;
        toast.danger({
          id: "block-history-failed",
          title: String(
            t(
              direction === -1
                ? "admin.peUndoPartial"
                : "admin.peRedoPartial",
            ),
          ),
          message: String(t("admin.peHistoryPartialBody")),
        });
        // Re-sync UI from the (unchanged) index; server truth is refetched below.
        syncFlags();
        await utils.entityPages.getMyPage
          .invalidate({ ownerType, ownerId })
          .catch(() => {});
      } finally {
        applyingRef.current = false;
        if (mountedRef.current) setIsBusy(false);
      }
    },
    [convergeTo, syncFlags, utils, ownerType, ownerId, toast, t],
  );

  const undo = useCallback(() => {
    if (!isBusy) void step(-1);
  }, [isBusy, step]);
  const redo = useCallback(() => {
    if (!isBusy) void step(1);
  }, [isBusy, step]);

  // ── Naming the pending action ────────────────────────────────────────────
  // Block names come from the palette configs' `labelKey` (never invented
  // here); a kind with no config — gated out of the palette but still on the
  // page — falls back to the humanised kind.
  const labelKeyByKind = useMemo(() => {
    const map = new Map<string, string>();
    for (const config of getPaletteBlockConfigs(ownerType)) {
      map.set(config.kind, config.labelKey);
    }
    return map;
  }, [ownerType]);

  const describe = useCallback(
    (step: HistoryStepDescription | null): string | null => {
      if (!step || step.kind === "none") return null;
      if (step.kind === "mixed") {
        return String(t("admin.peHistoryActionMixed"));
      }

      const actionKey: Record<
        Exclude<HistoryStepKind, "none" | "mixed">,
        string
      > = {
        add: "admin.peHistoryActionAdd",
        delete: "admin.peHistoryActionDelete",
        edit: "admin.peHistoryActionEdit",
        show: "admin.peHistoryActionShow",
        hide: "admin.peHistoryActionHide",
        reorder: "admin.peHistoryActionReorder",
      };

      // Several blocks (or a reorder) → one generic noun, never a list.
      let name: string;
      if (step.multiple || !step.blockKind) {
        name = String(t("admin.peHistoryTargetBlocks"));
      } else if (step.blockTitle) {
        // A user-authored heading beats the kind name — it is what the owner
        // actually sees on the page.
        name = `\u2018${step.blockTitle}\u2019`;
      } else {
        const labelKey = labelKeyByKind.get(step.blockKind);
        const label = labelKey ? String(t(labelKey)) : null;
        name =
          label && label !== labelKey
            ? `\u2018${label}\u2019`
            : `\u2018${formatBlockKind(step.blockKind)}\u2019`;
      }

      return String(t(actionKey[step.kind], { name }));
    },
    [t, labelKeyByKind],
  );

  const undoLabel = useMemo(() => describe(undoStep), [describe, undoStep]);
  const redoLabel = useMemo(() => describe(redoStep), [describe, redoStep]);

  return { canUndo, canRedo, isBusy, undo, redo, undoLabel, redoLabel };
}
