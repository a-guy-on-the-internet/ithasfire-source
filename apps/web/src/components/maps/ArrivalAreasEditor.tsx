"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import nextDynamic from "next/dynamic";
import { Map as MapIcon, X } from "lucide-react";
import { Alert, Button, Spinner, Text, useNotify, useTranslations } from "@th/ui";

import { isMapEnabled } from "@/config/maps";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import { ArrivalAreaForm } from "./ArrivalAreaForm";
import { ArrivalAreaList, areaFlagKeys } from "./ArrivalAreaList";
import type {
  EditorMapHandle,
  EditorMapStatus,
  EditorTool,
} from "./ArrivalAreasEditorMap";
import { ArrivalAreasLegend } from "./ArrivalAreasLayer";
import {
  buildCreateInput,
  buildUpdatePatch,
  describeArrivalAreaError,
  draftFromArea,
  editorAreaFromRow,
  formFieldsFromArea,
  listedRowSupersedes,
  removeListedArea,
  reorderListedAreas,
  upsertListedArea,
  hasFormErrors,
  isDraftDirty,
  moveId,
  newDraft,
  revalidatePlacePage,
  toDisplayArea,
  usablePin,
  validateAreaForm,
  type AreaDraft,
  type AreaFormErrors,
  type ArrivalAreaShape,
  type ArrivalAreasEditorParent,
  type DescribedAreaError,
  type EditorArrivalArea,
} from "./arrival-areas-editor.helpers";
import styles from "./arrival-areas-editor.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// ArrivalAreasEditor (arrival-areas FR-001, FR-002, FR-005, FR-014, FR-016,
// NFR-001, NFR-003..NFR-006; board option A sections 3 and 5).
//
// Draw a lot (polygon) or street parking (line) on the map, then fill in the
// selected area's form. Wide containers put the form beside the map; under
// 600px of viewport the map opens FULL SCREEN with a bottom tool bar and the
// form as a sheet. The area list under it is the keyboard twin of the map.
//
// Reusable for event-only areas (plan step 8b): `parent` is `{ placeId }` or
// `{ eventId }`. Only a PLACE parent purges the public place page after a
// change (NFR-001).
//
// Every rule lives in core. Here: one draft at a time, never overwritten
// silently (NFR-004: a stale save comes back as a conflict, the person's
// text stays in the form and the list refreshes).
//
// Gate off (FR-017) → renders nothing.
// ─────────────────────────────────────────────────────────────────────────────

// MapLibre and Terra Draw load only when the map is shown: a settings visitor
// with the gate off, or on a phone before opening the map, never downloads
// them. Client only (both touch `window` at import). React 19 passes `ref`
// as a prop, so the handle reaches the forwardRef component inside.
const ArrivalAreasEditorMap = nextDynamic(
  () =>
    import("./ArrivalAreasEditorMap").then((m) => ({
      default: m.ArrivalAreasEditorMap,
    })),
  { ssr: false },
);

export type ArrivalAreasEditorProps = {
  parent: ArrivalAreasEditorParent;
  /**
   * The level of the area form's heading, one below the section heading the
   * mount wraps the editor in (settings: h3 section → 4; moderator: h2 → 3).
   * Inside the full-screen frame (its title is an h2) the form uses 3.
   */
  formHeadingLevel?: 3 | 4;
};

/**
 * Whether the viewport is at least `px` wide: null until measured. Unlike
 * `useMinViewportWidth` (which assumes wide), nothing that depends on the
 * answer renders before it is known, so a phone never starts the MapLibre
 * download for an inline map it will not show.
 */
function useViewportAtLeast(px: number): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${px}px)`);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [px]);
  return matches;
}

/** The editor's mount check, for a page that wraps it in its own section. */
export function useArrivalAreasEditorEnabled(): boolean {
  const { gates } = useFeatureGates();
  return gates?.arrivalAreas === true;
}

export function ArrivalAreasEditor(props: ArrivalAreasEditorProps) {
  const enabled = useArrivalAreasEditorEnabled();
  if (!enabled) return null;
  return <ArrivalAreasEditorBody {...props} />;
}

type Notice = {
  tone: "warning" | "danger" | "info";
  title?: string;
  body: string;
};

/** Narrower than this, the editor opens full screen (board section 5). */
const FULL_SCREEN_BELOW_PX = 600;

function ArrivalAreasEditorBody({ parent, formHeadingLevel = 4 }: ArrivalAreasEditorProps) {
  const t = useTranslations();
  const tr = useCallback(
    (key: string, values?: Record<string, string | number>) => String(t(key, values)),
    [t],
  );
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const uid = useId();
  const labelInputId = `${uid}-label`;

  const viewportWide = useViewportAtLeast(FULL_SCREEN_BELOW_PX);
  const wide = viewportWide === true;
  const placeId = parent.placeId ?? null;
  const input = useMemo(
    () =>
      parent.placeId !== undefined
        ? { placeId: parent.placeId }
        : { eventId: parent.eventId as string },
    [parent.placeId, parent.eventId],
  );

  const listQuery = trpc.arrivalAreas.listForEditor.useQuery(input, {
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const serverAreas: EditorArrivalArea[] = useMemo(
    () => listQuery.data?.areas ?? [],
    [listQuery.data],
  );
  const limit = listQuery.data?.limit ?? 10;
  // The pin core measures THIS editor's shapes from (FR-005): the true pin
  // for an owner and for a moderator at a place that publishes its address;
  // null when the place has no pin, or for a moderator at a place that hides
  // it (core then refuses every shape: NO_PIN). The one pin source.
  const pin = usablePin(listQuery.data?.pin?.lat, listQuery.data?.pin?.lng);
  // Why there is no pin: a withheld address is not fixed by setting one.
  const addressWithheld = listQuery.data?.addressWithheld === true;
  const noPinKey = addressWithheld
    ? "arrivalAreasEditor.noPinWithheld"
    : "arrivalAreasEditor.noPin";

  // ── Editor state ─────────────────────────────────────────────────────────
  const [draft, setDraftState] = useState<AreaDraft | null>(null);
  // The committed draft, for a handler that reads it after an await.
  const draftRef = useRef<AreaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // Bumped whenever the working shape is REPLACED (not when the person edits
  // it): the map re-loads Terra Draw's store only on a new key.
  const [workingVersion, setWorkingVersion] = useState(0);
  const [tool, setTool] = useState<EditorTool>("select");
  const [drawState, setDrawState] = useState({ drawing: false, canUndo: false });
  const [mapStatus, setMapStatus] = useState<EditorMapStatus>("loading");
  const [formNotice, setFormNotice] = useState<Notice | null>(null);
  const [listNotice, setListNotice] = useState<Notice | null>(null);
  const [submitErrors, setSubmitErrors] = useState<AreaFormErrors>({});
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [overlayStatus, setOverlayStatus] = useState<string | null>(null);

  const mapRef = useRef<EditorMapHandle>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const overlayTitleRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);

  const replaceDraft = useCallback((next: AreaDraft | null) => {
    setDraftState(next);
    setWorkingVersion((v) => v + 1);
    setSubmitErrors({});
    setFormNotice(null);
  }, []);

  const dirty = isDraftDirty(draft);

  // The list in the order on screen (an in-flight reorder shows at once).
  const areas = useMemo(() => {
    if (!pendingOrder) return serverAreas;
    const byId = new Map(serverAreas.map((a) => [a.id, a]));
    const ordered = pendingOrder
      .map((id) => byId.get(id))
      .filter((a): a is EditorArrivalArea => Boolean(a));
    return ordered.length === serverAreas.length ? ordered : serverAreas;
  }, [serverAreas, pendingOrder]);

  // A fresh list refreshes a CLEAN draft's baseline (FR-014 flags, the
  // updatedAt token). A dirty draft keeps the person's work; its baseline
  // moves only through a conflict.
  // Only a NEWER row replaces it: an older one is the pre-save list still in
  // flight, and adopting it reverted the form and armed a false conflict.
  useEffect(() => {
    if (!draft?.areaId || !draft.base || dirty) return;
    const row = serverAreas.find((a) => a.id === draft.areaId);
    if (!row) return;
    const verdict = listedRowSupersedes(row, draft.base);
    if (!verdict) return;
    if (verdict === "envelope") {
      setDraftState({
        ...draft,
        base: { ...draft.base, outsideEnvelope: row.outsideEnvelope },
      });
      return;
    }
    const sameShape = JSON.stringify(row.geometry) === JSON.stringify(draft.geometry);
    setDraftState(draftFromArea(row));
    if (!sameShape) setWorkingVersion((v) => v + 1);
  }, [serverAreas, draft, dirty]);

  const atLimit = serverAreas.length >= limit;
  const redrawTarget =
    draft?.areaId && !draft.geometry && !draft.base?.geometryWithheld ? draft : null;
  const mapReady = mapStatus === "ready";
  const canDrawNew = mapReady && !!pin && (!!redrawTarget || (!atLimit && !dirty));

  // ── Focus helpers ────────────────────────────────────────────────────────
  const focusForm = useCallback(() => {
    requestAnimationFrame(() => formHeadingRef.current?.focus());
  }, []);

  const openSheet = useCallback(() => {
    setSheetOpen(true);
    focusForm();
  }, [focusForm]);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    requestAnimationFrame(() => doneRef.current?.focus());
  }, []);

  const showDraft = useCallback(() => {
    if (fullScreen) {
      openSheet();
    } else if (!wide) {
      // A phone has no form outside the frame: open it on the sheet.
      setFullScreen(true);
      setSheetOpen(true);
      focusForm();
    } else {
      focusForm();
    }
  }, [fullScreen, wide, openSheet, focusForm]);

  // ── Success feedback ─────────────────────────────────────────────────────
  // The booking toggle's pattern: a title and the propagation window (owner
  // ruling Q19). Toasts sit under the full-screen frame, so there the same
  // words go in the frame's own status line.
  const announce = useCallback(
    (titleKey: string) => {
      const title = tr(titleKey);
      const note = tr("arrivalAreasEditor.savedNote");
      if (fullScreen) {
        setOverlayStatus(`${title}. ${note}`);
      } else {
        toast.success({ id: "arrival-area-saved", title, message: note });
      }
    },
    [fullScreen, toast, tr],
  );

  /**
   * Right after a mutation resolves: write its result into the list cache
   * (so nothing reads the pre-mutation list), purge the public place page
   * (NFR-001), then refetch for the server's own view of the rest.
   */
  const afterMutation = useCallback(
    (write: (areas: readonly EditorArrivalArea[]) => EditorArrivalArea[]) => {
      utils.arrivalAreas.listForEditor.setData(input, (old) =>
        old ? { ...old, areas: write(old.areas) } : old,
      );
      if (placeId) revalidatePlacePage(placeId);
      void utils.arrivalAreas.listForEditor.invalidate(input);
    },
    [placeId, utils, input],
  );

  const errorNotice = useCallback(
    (described: DescribedAreaError, err: unknown): Notice =>
      described.kind === "other"
        ? { tone: "danger", body: formatErrorMessage(err, (k) => String(t(k))) }
        : { tone: "danger", body: tr(described.key, described.values) },
    [t, tr],
  );

  /**
   * NFR-004: someone else changed (or removed) the row. The person's text
   * stays in the form; the baseline moves to the row as it now is, so the
   * next Save is a deliberate choice, never a silent overwrite.
   */
  const handleConflict = useCallback(
    async (described: DescribedAreaError, areaId: string) => {
      let current = described.current ?? null;
      let fresh: EditorArrivalArea[] | null = null;
      try {
        const data = await utils.arrivalAreas.listForEditor.fetch(input, {
          staleTime: 0,
        });
        fresh = data.areas;
      } catch {
        fresh = null;
      }
      const row = fresh?.find((a) => a.id === areaId) ?? null;
      if (row) current = row;
      else if (fresh) current = null;
      void utils.arrivalAreas.listForEditor.invalidate(input);
      // Decided from the draft as it is now, outside the updater: an updater
      // must stay pure (React may run it twice).
      const d = draftRef.current;
      if (!d || d.areaId !== areaId) {
        // The person moved on to another area: nothing to rebase.
      } else if (!current) {
        // Gone: keep the work as a NEW area the person can save again.
        setDraftState({ ...d, areaId: null, base: null, geometryDirty: true });
      } else {
        const base: EditorArrivalArea = {
          ...(d.base as EditorArrivalArea),
          ...current,
        };
        const geometryReplaced = !d.geometryDirty;
        setDraftState({
          ...d,
          base,
          geometry: geometryReplaced ? base.geometry : d.geometry,
        });
        if (geometryReplaced) setWorkingVersion((v) => v + 1);
      }
      setFormNotice(
        current
          ? {
              tone: "warning",
              title: tr("arrivalAreasEditor.conflictTitle"),
              body: tr("arrivalAreasEditor.conflictBody", { label: current.label }),
            }
          : {
              tone: "warning",
              title: tr("arrivalAreasEditor.conflictTitle"),
              body: tr("arrivalAreasEditor.conflictRemoved"),
            },
      );
    },
    [utils, input, tr],
  );

  // ── Mutations ────────────────────────────────────────────────────────────
  const createMutation = trpc.arrivalAreas.create.useMutation();
  const updateMutation = trpc.arrivalAreas.update.useMutation();
  const reorderMutation = trpc.arrivalAreas.reorder.useMutation();
  const removeMutation = trpc.arrivalAreas.remove.useMutation();
  const saving = createMutation.isPending || updateMutation.isPending;
  const listBusy = reorderMutation.isPending || removeMutation.isPending;

  const saveOnce = useCallback(async () => {
    if (!draft || saving) return;
    const errors = validateAreaForm(draft.fields);
    if (hasFormErrors(errors)) {
      setSubmitErrors(errors);
      requestAnimationFrame(() => document.getElementById(labelInputId)?.focus());
      return;
    }
    setFormNotice(null);
    setOverlayStatus(null);
    if (draft.areaId === null) {
      if (!draft.geometry) {
        setFormNotice({ tone: "warning", body: tr("arrivalAreasEditor.drawFirst") });
        return;
      }
      try {
        const row = await createMutation.mutateAsync(
          buildCreateInput(parent, draft.fields, draft.geometry),
        );
        afterMutation((areas) => upsertListedArea(areas, row));
        // Same shape as on screen: keep the working key, no redraw.
        setDraftState(draftFromArea(editorAreaFromRow(row)));
        announce("arrivalAreasEditor.savedTitle");
      } catch (err) {
        setFormNotice(errorNotice(describeArrivalAreaError(err, { addressWithheld }), err));
      }
      return;
    }
    const base = draft.base as EditorArrivalArea;
    const patch = buildUpdatePatch(draft);
    if (Object.keys(patch).length === 0) return;
    try {
      const row = await updateMutation.mutateAsync({
        ...parent,
        arrivalAreaId: draft.areaId,
        expectedUpdatedAt: base.updatedAt,
        patch,
      });
      afterMutation((areas) => upsertListedArea(areas, row));
      setDraftState((d) =>
        d && d.areaId === row.id ? draftFromArea(editorAreaFromRow(row, base)) : d,
      );
      announce("arrivalAreasEditor.savedTitle");
    } catch (err) {
      const described = describeArrivalAreaError(err, { addressWithheld });
      if (described.kind === "conflict" || described.kind === "notFound") {
        await handleConflict(
          described.kind === "notFound" ? { ...described, current: null } : described,
          draft.areaId,
        );
        return;
      }
      setFormNotice(errorNotice(described, err));
    }
  }, [
    draft,
    saving,
    labelInputId,
    tr,
    createMutation,
    updateMutation,
    parent,
    announce,
    afterMutation,
    errorNotice,
    handleConflict,
    addressWithheld,
  ]);

  // One save at a time. `isPending` only flips on the next render, so a
  // second call in the same tick (the button's press and the form's submit
  // from one tap, measured on a touch device: two rows created) would pass
  // the check above. The ref holds until the first call settles.
  const savingRef = useRef(false);
  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await saveOnce();
    } finally {
      savingRef.current = false;
    }
  }, [saveOnce]);

  const remove = useCallback(
    async (area: EditorArrivalArea) => {
      setListNotice(null);
      setOverlayStatus(null);
      try {
        await removeMutation.mutateAsync({
          ...parent,
          arrivalAreaId: area.id,
          expectedUpdatedAt: area.updatedAt,
        });
        afterMutation((areas) => removeListedArea(areas, area.id));
        if (draft?.areaId === area.id) {
          replaceDraft(null);
          if (fullScreen) closeSheet();
          // The form is gone: focus lands on the count, which now says one
          // fewer, instead of falling to <body>.
          else requestAnimationFrame(() => countRef.current?.focus());
        }
        announce("arrivalAreasEditor.removedTitle");
      } catch (err) {
        const described = describeArrivalAreaError(err);
        void utils.arrivalAreas.listForEditor.invalidate(input);
        const notice: Notice =
          described.kind === "conflict"
            ? {
                tone: "warning",
                title: tr("arrivalAreasEditor.conflictTitle"),
                body: tr("arrivalAreasEditor.removeConflict"),
              }
            : described.kind === "notFound"
              ? { tone: "info", body: tr("arrivalAreasEditor.alreadyRemoved") }
              : errorNotice(described, err);
        if (described.kind === "notFound" && draft?.areaId === area.id) {
          replaceDraft(null);
        }
        if (draft?.areaId === area.id && described.kind !== "notFound") {
          setFormNotice(notice);
        } else {
          setListNotice(notice);
        }
      }
    },
    [
      removeMutation,
      parent,
      draft,
      replaceDraft,
      fullScreen,
      closeSheet,
      announce,
      afterMutation,
      utils,
      input,
      tr,
      errorNotice,
    ],
  );

  const move = useCallback(
    async (index: number, delta: -1 | 1) => {
      const ids = areas.map((a) => a.id);
      const next = moveId(ids, index, delta);
      if (!next) return;
      setListNotice(null);
      setOverlayStatus(null);
      setPendingOrder(next);
      try {
        const rows = await reorderMutation.mutateAsync({ ...parent, orderedIds: next });
        // The cache holds the new order before the optimistic one is dropped
        // in `finally`, so the list never flashes back to the old order.
        afterMutation((areas) => reorderListedAreas(areas, rows));
        announce("arrivalAreasEditor.reorderedTitle");
      } catch (err) {
        const described = describeArrivalAreaError(err);
        await utils.arrivalAreas.listForEditor.invalidate(input);
        setListNotice(
          described.kind === "conflict"
            ? { tone: "warning", body: tr("arrivalAreasEditor.reorderConflict") }
            : errorNotice(described, err),
        );
      } finally {
        setPendingOrder(null);
      }
    },
    [areas, reorderMutation, parent, announce, afterMutation, utils, input, tr, errorNotice],
  );

  // ── Selection and tools ──────────────────────────────────────────────────
  const blockForUnsaved = useCallback(() => {
    setFormNotice({ tone: "warning", body: tr("arrivalAreasEditor.unsavedBlock") });
    showDraft();
  }, [tr, showDraft]);

  const selectArea = useCallback(
    (id: string, from: "list" | "map") => {
      if (draft?.areaId === id) {
        if (fullScreen) openSheet();
        else if (from === "list") focusForm();
        return;
      }
      if (dirty) {
        blockForUnsaved();
        return;
      }
      const area = serverAreas.find((a) => a.id === id);
      if (!area) return;
      replaceDraft(draftFromArea(area));
      setTool("select");
      if (!wide && !fullScreen) {
        // A row tapped on a phone opens the map with its form ready.
        setFullScreen(true);
        setSheetOpen(true);
        focusForm();
        return;
      }
      if (fullScreen) openSheet();
      else focusForm();
    },
    [
      draft,
      dirty,
      fullScreen,
      wide,
      serverAreas,
      replaceDraft,
      blockForUnsaved,
      openSheet,
      focusForm,
    ],
  );

  const chooseTool = useCallback(
    (next: EditorTool) => {
      if (next === "select") {
        setTool("select");
        return;
      }
      if (!redrawTarget) {
        if (dirty) {
          blockForUnsaved();
          return;
        }
        if (draft) replaceDraft(null);
      }
      setSheetOpen(false);
      setTool(next);
    },
    [redrawTarget, dirty, draft, replaceDraft, blockForUnsaved],
  );

  const onShapeDrawn = useCallback(
    (shape: ArrivalAreaShape) => {
      setDraftState((d) => {
        if (d?.areaId && !d.geometry) {
          return { ...d, geometry: shape, geometryDirty: true };
        }
        const next = newDraft(shape);
        return next;
      });
      setWorkingVersion((v) => v + 1);
      setSubmitErrors({});
      setFormNotice(null);
      setTool("select");
      showDraft();
    },
    [showDraft],
  );

  const onShapeChanged = useCallback((shape: ArrivalAreaShape) => {
    // A reshape that lands while a save is in flight would be replaced by the
    // saved row and lost without a word; the map is static then too.
    if (savingRef.current) return;
    setDraftState((d) => (d ? { ...d, geometry: shape, geometryDirty: true } : d));
  }, []);

  const dismissDraft = useCallback(() => {
    if (!draft) return;
    if (dirty && draft.base) {
      replaceDraft(draftFromArea(draft.base));
      return;
    }
    replaceDraft(null);
    if (fullScreen) closeSheet();
  }, [draft, dirty, replaceDraft, fullScreen, closeSheet]);

  // ── Full screen ──────────────────────────────────────────────────────────
  const openFullScreen = useCallback(() => {
    setOverlayStatus(null);
    setFullScreen(true);
    requestAnimationFrame(() => overlayTitleRef.current?.focus());
  }, []);

  const closeFullScreen = useCallback(() => {
    setFullScreen(false);
    setSheetOpen(false);
    setTool("select");
    requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  // Leaving the phone width (rotation, a resized window) closes the frame.
  useEffect(() => {
    if (wide && fullScreen) {
      setFullScreen(false);
      setSheetOpen(false);
    }
  }, [wide, fullScreen]);

  // Body scroll lock + Escape + a simple focus trap while full screen.
  useEffect(() => {
    if (!fullScreen) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [fullScreen]);

  // Escape steps back one layer: the sheet, then the frame. On the document,
  // not the frame, so it still works when focus fell to <body> (the control
  // that held it was removed). Terra Draw's own Escape cancels a shape being
  // drawn, so a drawing in progress is left to it.
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (drawState.drawing) return;
      event.preventDefault();
      if (sheetOpen) closeSheet();
      else closeFullScreen();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullScreen, drawState.drawing, sheetOpen, closeSheet, closeFullScreen]);

  const onOverlayKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const container = overlayRef.current;
    if (!container) return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onDone = () => {
    if (drawState.drawing) {
      mapRef.current?.finishShape();
      return;
    }
    if (draft && !sheetOpen) {
      openSheet();
      return;
    }
    closeFullScreen();
  };

  // ── Rendering ────────────────────────────────────────────────────────────
  const displayAreas = useMemo(() => areas.map(toDisplayArea), [areas]);

  const selectedId = draft?.areaId ?? null;
  const countLine = tr("arrivalAreasEditor.count", {
    count: serverAreas.length,
    limit,
  });

  const toolLabel = (which: EditorTool | "undo", short: boolean) => {
    const keys = {
      select: ["arrivalAreasEditor.toolSelect", "arrivalAreasEditor.toolSelectShort"],
      polygon: ["arrivalAreasEditor.toolPolygon", "arrivalAreasEditor.toolPolygonShort"],
      linestring: ["arrivalAreasEditor.toolLine", "arrivalAreasEditor.toolLineShort"],
      undo: ["arrivalAreasEditor.toolUndo", "arrivalAreasEditor.toolUndoShort"],
    } as const;
    return tr(keys[which][short ? 1 : 0]);
  };

  const renderTools = (short: boolean) => (
    <div
      className={short ? styles.bottomBar : styles.tools}
      role="toolbar"
      aria-label={tr("arrivalAreasEditor.toolbarLabel")}
    >
      {(["select", "polygon", "linestring"] as const).map((which) => (
        <button
          key={which}
          type="button"
          className={styles.tool}
          aria-pressed={tool === which}
          aria-label={short ? toolLabel(which, false) : undefined}
          disabled={which === "select" ? !mapReady : !canDrawNew}
          onClick={() => chooseTool(which)}
          data-testid={`arrival-areas-tool-${which}`}
        >
          {toolLabel(which, short)}
        </button>
      ))}
      <button
        type="button"
        className={styles.tool}
        aria-label={short ? toolLabel("undo", false) : undefined}
        disabled={!drawState.canUndo}
        onClick={() => mapRef.current?.undoPoint()}
        data-testid="arrival-areas-tool-undo"
      >
        {toolLabel("undo", short)}
      </button>
    </div>
  );

  const hintText =
    tool === "polygon"
      ? tr("arrivalAreasEditor.hintPolygon")
      : tool === "linestring"
        ? tr("arrivalAreasEditor.hintLine")
        : redrawTarget
          ? tr("arrivalAreasEditor.hintRedraw", { label: redrawTarget.fields.label })
          : draft?.geometry && !saving
            ? tr("arrivalAreasEditor.hintReshape")
            : null;

  const mapMessage = !pin
    ? tr(noPinKey)
    : !isMapEnabled || mapStatus === "unavailable"
      ? tr("arrivalAreasEditor.mapUnavailable")
      : mapStatus === "outOfCoverage"
        ? tr("arrivalAreasEditor.noCoverage")
        : null;

  const renderMap = (inOverlay: boolean) => (
    <div className={inOverlay ? styles.overlayMap : styles.mapFrame}>
      {pin && isMapEnabled ? (
        <ArrivalAreasEditorMap
          ref={mapRef}
          pin={pin}
          areas={areas}
          editingId={draft?.areaId ?? null}
          working={{ key: `${workingVersion}`, shape: draft?.geometry ?? null }}
          tool={tool}
          interactive={!saving}
          onShapeDrawn={onShapeDrawn}
          onShapeChanged={onShapeChanged}
          onSelectArea={(id) => selectArea(id, "map")}
          onDrawState={setDrawState}
          onStatus={setMapStatus}
          label={tr("arrivalAreasEditor.mapLabel")}
          fullScreen={inOverlay}
        />
      ) : null}
      {mapMessage ? (
        <p className={styles.mapMessage} role="status" data-testid="arrival-areas-map-message">
          {mapMessage}
        </p>
      ) : mapStatus === "loading" ? (
        <div className={styles.mapMessage} aria-busy="true">
          <Spinner size="sm" />
        </div>
      ) : hintText && !(inOverlay && sheetOpen) ? (
        <div className={styles.hint} aria-live="polite" data-testid="arrival-areas-hint">
          <span>{hintText}</span>
          {drawState.drawing && !inOverlay ? (
            <button
              type="button"
              className={styles.textButton}
              onClick={() => mapRef.current?.finishShape()}
              style={{ minHeight: 32, padding: "4px 10px" }}
            >
              {tr("arrivalAreasEditor.finishShape")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const renderFlags = (): ReactNode => {
    if (!draft?.base) return null;
    const keys = areaFlagKeys(draft.base).filter(
      (k) => k !== "arrivalAreasEditor.flagNoShape" || !draft.geometry,
    );
    if (keys.length === 0) return null;
    return (
      <>
        {keys.map((key) => (
          <p key={key} className={styles.flag}>
            {tr(key === "arrivalAreasEditor.flagNoShape" ? "arrivalAreasEditor.flagNoShapeLong" : key)}
          </p>
        ))}
      </>
    );
  };

  function renderForm(): ReactNode {
    if (!draft) return null;
    return (
      <ArrivalAreaForm
        ref={formHeadingRef}
        // Stable across a create (the version holds), so the form, its focus
        // and the sheet's scroll survive the new area getting its id.
        key={workingVersion}
        draft={draft}
        dirty={dirty}
        saving={saving}
        removing={removeMutation.isPending}
        onChange={(fields) => setDraftState((d) => (d ? { ...d, fields } : d))}
        onSave={() => void save()}
        onDismiss={dismissDraft}
        onRemove={() => draft.base && void remove(draft.base)}
        notice={
          formNotice ? (
            <Alert
              tone={formNotice.tone}
              role="alert"
              title={formNotice.title}
              description={formNotice.body}
              compact
              testID="arrival-area-form-notice"
            />
          ) : null
        }
        flags={renderFlags()}
        submitErrors={submitErrors}
        onClearSubmitError={(field) =>
          setSubmitErrors((prev) => {
            const next = { ...prev };
            delete next[field];
            return next;
          })
        }
        labelInputId={labelInputId}
        headingLevel={fullScreen ? 3 : formHeadingLevel}
      />
    );
  }

  const listNoticeEl = listNotice ? (
    <Alert
      tone={listNotice.tone}
      role="alert"
      title={listNotice.title}
      description={listNotice.body}
      compact
      onDismiss={() => setListNotice(null)}
      testID="arrival-areas-list-notice"
    />
  ) : null;

  const listBlock = (
    <>
      {listNoticeEl}
      {areas.length > 0 ? (
        <ArrivalAreaList
          areas={areas}
          selectedId={selectedId}
          onSelect={(id) => selectArea(id, "list")}
          onMove={(index, delta) => void move(index, delta)}
          onRemove={(area) => void remove(area)}
          busy={listBusy || saving}
        />
      ) : (
        <div className={styles.empty} data-testid="arrival-areas-empty">
          <Text variant="body" weight="bold">
            {tr("arrivalAreasEditor.emptyTitle")}
          </Text>
          <p className={styles.muted}>{tr("arrivalAreasEditor.emptyBody")}</p>
        </div>
      )}
    </>
  );

  // ── States: loading / error ──────────────────────────────────────────────
  if (listQuery.isLoading || viewportWide === null) {
    return (
      <div className={styles.root} aria-busy="true" data-testid="arrival-areas-editor-loading">
        <Spinner size="sm" />
        <p className={styles.muted}>{tr("arrivalAreasEditor.loading")}</p>
      </div>
    );
  }

  if (!listQuery.data) {
    return (
      <div className={styles.root} data-testid="arrival-areas-editor-error">
        <Alert
          tone="danger"
          role="alert"
          title={tr("arrivalAreasEditor.loadErrorTitle")}
          description={
            listQuery.error ? formatErrorMessage(listQuery.error, (k) => String(t(k))) : undefined
          }
          actions={
            <Button variant="secondary" size="$3" onPress={() => void listQuery.refetch()}>
              {tr("arrivalAreasEditor.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  const limitLine =
    atLimit && !redrawTarget ? (
      <p className={styles.muted} data-testid="arrival-areas-limit">
        {tr("arrivalAreasEditor.limitReached", { limit })}
      </p>
    ) : null;

  // ── Wide: map + form side by side, the list under them ───────────────────
  if (wide) {
    return (
      <div className={styles.root} data-testid="arrival-areas-editor">
        <div className={styles.metaRow}>
          <span ref={countRef} tabIndex={-1} className={styles.count}>
            {countLine}
          </span>
        </div>
        {limitLine}
        <div className={styles.workspace}>
          <div className={styles.mapCol}>
            {renderTools(false)}
            {renderMap(false)}
            <div className={styles.mapFoot}>
              <ArrivalAreasLegend areas={displayAreas} />
              <p className={styles.guideNote}>
                <span className={styles.guideSwatch} aria-hidden="true" />
                {tr("arrivalAreasEditor.osmGuide")}
              </p>
            </div>
          </div>
          <div className={styles.formCol}>
            {draft ? (
              renderForm()
            ) : (
              <p className={styles.muted} data-testid="arrival-areas-select-prompt">
                {tr(
                  areas.length > 0
                    ? "arrivalAreasEditor.selectPrompt"
                    : "arrivalAreasEditor.drawPrompt",
                )}
              </p>
            )}
          </div>
        </div>
        {listBlock}
      </div>
    );
  }

  // ── Narrow: the list inline, the map full screen ─────────────────────────
  const overlayTitle =
    tool === "polygon"
      ? toolLabel("polygon", false)
      : tool === "linestring"
        ? toolLabel("linestring", false)
        : tr("arrivalAreasEditor.heading");

  return (
    <div className={styles.root} data-testid="arrival-areas-editor">
      <div className={styles.metaRow}>
        <span ref={countRef} tabIndex={-1} className={styles.count}>
          {countLine}
        </span>
      </div>
      {limitLine}
      {listBlock}
      <div className={styles.actions}>
        <button
          ref={openerRef}
          type="button"
          className={styles.textButton}
          onClick={openFullScreen}
          disabled={!pin}
          data-testid="arrival-areas-open-map"
        >
          <MapIcon size={16} aria-hidden style={{ verticalAlign: "-3px", marginRight: 8 }} />
          {tr("arrivalAreasEditor.openEditor")}
        </button>
      </div>
      {!pin ? <p className={styles.muted}>{tr(noPinKey)}</p> : null}
      {fullScreen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={overlayRef}
              className={styles.overlay}
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${uid}-overlay-title`}
              onKeyDown={onOverlayKeyDown}
              data-testid="arrival-areas-fullscreen"
            >
              <div className={styles.topBar}>
                <button
                  type="button"
                  className={styles.barButton}
                  data-tone="ink"
                  aria-label={tr("arrivalAreasEditor.closeEditor")}
                  onClick={closeFullScreen}
                  data-testid="arrival-areas-close-map"
                >
                  <X size={20} aria-hidden />
                </button>
                <h2
                  id={`${uid}-overlay-title`}
                  ref={overlayTitleRef}
                  tabIndex={-1}
                  className={styles.topTitle}
                >
                  {overlayTitle}
                </h2>
                <button
                  ref={doneRef}
                  type="button"
                  className={styles.barButton}
                  onClick={onDone}
                  data-testid="arrival-areas-done"
                >
                  {tr(
                    !drawState.drawing && draft && !sheetOpen
                      ? "arrivalAreasEditor.details"
                      : "arrivalAreasEditor.done",
                  )}
                </button>
              </div>
              {renderMap(true)}
              {/* Below the map, not over it: the frame shrinks and MapLibre
                  refits. Laid over the canvas, the sheet left the strip of
                  map above it unpainted (measured at 320 in Chromium). */}
              {sheetOpen && draft ? (
                <div
                  className={styles.sheet}
                  role="group"
                  aria-label={tr("arrivalAreasEditor.sheetLabel")}
                  data-testid="arrival-areas-sheet"
                >
                  <div className={styles.sheetHead}>
                    <button
                      type="button"
                      className={styles.barButton}
                      data-tone="ink"
                      onClick={closeSheet}
                    >
                      {tr("arrivalAreasEditor.sheetClose")}
                    </button>
                  </div>
                  {renderForm()}
                </div>
              ) : null}
              {overlayStatus ? (
                <p className={styles.statusBar} role="status" data-testid="arrival-areas-status">
                  {overlayStatus}
                </p>
              ) : null}
              {renderTools(true)}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** For tests: the form fields an area loads with. */
export { formFieldsFromArea };
