"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PlaceLayoutDesigner — top-level interactive layout editor
// ─────────────────────────────────────────────────────────────────────────────
// Composed of:
//   DesignerToolbar (left sidebar)  —  tool palette, section list, CSV I/O
//   DesignerCanvas (main area)      —  interactive Canvas 2D rendering
//
// State is managed via useReducer (designerReducer) and threaded through both
// children. Canvas interaction is delegated to the useDesignerCanvas hook.
// ─────────────────────────────────────────────────────────────────────────────

import { useReducer, useState, useCallback, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack } from "tamagui";
import {
  Text,
  Button,
  Tooltip,
  Spinner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { ArrowLeft, Undo2 } from "lucide-react";

import { DesktopOnlyNotice } from "@/components/DesktopOnlyNotice";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getAppErrorCode } from "@/lib/app-error";

import {
  designerReducer,
  createInitialState,
  pointInPolygon,
  tessellatedPolygon,
} from "./reducer";
import { DesignerCanvas } from "./useDesignerCanvas";
import { DesignerToolbar } from "./DesignerToolbar";
import { FloatingConfigPanel } from "./FloatingConfigPanel";
import { designerStateToCsv, glyphsToDesignerState } from "./csv-bridge";
import type { GlyphBlobEnvelope } from "./csv-bridge";
import { detectShapesAndSeats } from "./detect";
import type { DesignerSeat } from "./types";

import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";

// ── Default palette cycle ────────────────────────────────────────────────

const PALETTE = [
  "#4A90D2",
  "#E74C3C",
  "#2ECC71",
  "#F39C12",
  "#9B59B6",
  "#1ABC9C",
  "#E67E22",
  "#3498DB",
  "#E91E63",
  "#00BCD4",
  "#8BC34A",
  "#FF5722",
  "#607D8B",
  "#795548",
  "#CDDC39",
];

const RETURN_TO_EVENT_KEY = "th:returnToEvent";
type ReturnToEventData = { eventId: string; eventTitle: string; slug: string };

// ── Component ────────────────────────────────────────────────────────────

export function PlaceLayoutDesigner() {
  const { slug, placeId } = useParams<{ slug: string; placeId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEditMode = searchParams.get("edit") === "true";
  const isMobile = useIsMobile();
  const t = useTranslations();
  const { gates, isLoading: gatesLoading } = useFeatureGates();
  const [state, dispatch] = useReducer(
    designerReducer,
    undefined,
    createInitialState,
  );

  // Redirect when seatingLayouts gate is off
  useEffect(() => {
    if (!gatesLoading && gates && !gates.seatingLayouts) {
      router.replace(`/admin/${slug}/places/${placeId}/settings`);
    }
  }, [gates, gatesLoading, router, slug, placeId]);

  // Auto-cycle section colors
  const [nextSectionColor, setNextSectionColor] = useState(PALETTE[0]!);

  // Background image element (loaded from file)
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);

  // Loading existing layout for re-editing
  const [isLoadingExisting, setIsLoadingExisting] = useState(isEditMode);
  const didLoadRef = useRef(false);

  // Save state
  const [isSaving, setIsSaving] = useState(false);

  const { toast } = useNotify();

  const presignUpload = trpc.placeLayouts.requestPlaceLayoutUpload.useMutation({
    retry: false,
  });
  const replaceLayout = trpc.placeLayouts.replacePlaceLayout.useMutation({
    retry: false,
  });

  // ── Load existing layout for re-editing ────────────────────────────────

  const existingLayoutQuery = trpc.placeLayouts.getPlaceLayout.useQuery(
    { placeId },
    { enabled: isEditMode && !didLoadRef.current, staleTime: 30_000, retry: 1 },
  );

  // Handle query error (e.g. 404 — place has no layout yet)
  useEffect(() => {
    if (!isEditMode || didLoadRef.current) return;
    if (!existingLayoutQuery.error) return;

    // Mark as loaded so the spinner stops — start with a blank canvas
    didLoadRef.current = true;
    setIsLoadingExisting(false);

    const is404 =
      getAppErrorCode(existingLayoutQuery.error) === "PLACE_LAYOUT_NOT_FOUND" ||
      (existingLayoutQuery.error as any)?.data?.httpStatus === 404;

    if (!is404) {
      console.error(
        "Failed to load existing layout:",
        existingLayoutQuery.error,
      );
      toast.danger({
        title: t("admin.designerLoadFailed") as string,
        message: t("admin.designerLoadFailedMsg") as string,
      });
    }
  }, [isEditMode, existingLayoutQuery.error, toast, t]);
  useEffect(() => {
    if (!isEditMode || didLoadRef.current) return;
    if (!existingLayoutQuery.data) return;

    const { layout } = existingLayoutQuery.data;

    // If no glyph blob URL, just load sections (no seats to reconstruct)
    if (!layout.glyphBlobUrl) {
      const result = glyphsToDesignerState({
        glyphs: [],
        sections: layout.sections,
        stage: layout.stage,
      });
      dispatch({
        type: "LOAD_STATE",
        sections: result.sections,
        seats: result.seats,
        stage: result.stage,
      });
      dispatch({ type: "SET_LAYOUT_NAME", name: layout.name });
      didLoadRef.current = true;
      setIsLoadingExisting(false);
      return;
    }

    // Fetch the glyph blob to reconstruct seats
    fetch(layout.glyphBlobUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Glyph fetch failed (${res.status})`);
        return res.json() as Promise<GlyphBlobEnvelope>;
      })
      .then((envelope) => {
        const result = glyphsToDesignerState({
          glyphs: envelope.glyphs,
          sections: layout.sections,
          stage: layout.stage,
        });
        dispatch({
          type: "LOAD_STATE",
          sections: result.sections,
          seats: result.seats,
          stage: result.stage,
        });
        dispatch({ type: "SET_LAYOUT_NAME", name: layout.name });
      })
      .catch((err) => {
        console.error("Failed to load existing layout glyphs:", err);
        toast.danger({
          title: t("admin.designerLoadFailed") as string,
          message: t("admin.designerLoadFailedMsg") as string,
        });
      })
      .finally(() => {
        didLoadRef.current = true;
        setIsLoadingExisting(false);
      });
  }, [isEditMode, existingLayoutQuery.data, toast]);

  // Advance palette color when a new section is created
  useEffect(() => {
    const idx = state.sections.length % PALETTE.length;
    setNextSectionColor(PALETTE[idx]!);
  }, [state.sections.length]);

  const backToLayout = useCallback(
    () => router.push(`/admin/${slug}/places/${placeId}/layout`),
    [router, slug, placeId],
  );

  // ── Return-to-event context (localStorage) ────────────────────────────
  const [returnToEvent, setReturnToEvent] = useState<ReturnToEventData | null>(
    null,
  );

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(RETURN_TO_EVENT_KEY);
      if (raw) setReturnToEvent(JSON.parse(raw) as ReturnToEventData);
    } catch {
      /* ignore */
    }
  }, []);

  const handleReturnToEvent = useCallback(() => {
    if (!returnToEvent) return;
    sessionStorage.removeItem(RETURN_TO_EVENT_KEY);
    router.push(`/admin/${returnToEvent.slug}/events/${returnToEvent.eventId}`);
  }, [returnToEvent, router]);

  // ── Image loading ──────────────────────────────────────────────────────

  const handleLoadImage = useCallback(
    async (file: File) => {
      // Convert HEIC/HEIF (iPhone photos) to JPEG first — browsers can't decode
      // HEIC in <img>/canvas, and this data URL gets serialised into the CSV
      // export, so it must be a renderable format.
      try {
        file = await prepareImageForUpload(file);
      } catch (err) {
        console.error("Background image conversion failed:", err);
        toast.danger({
          title: t("admin.designerLoadFailed") as string,
          message: t("admin.designerLoadFailedMsg") as string,
        });
        return;
      }

      // Read file as base64 data URL so it can be serialised into CSV export
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          // Scale image so its longest side is ~400 world units
          const maxDim = 400;
          const aspect = img.naturalWidth / img.naturalHeight;
          let w: number, h: number;
          if (aspect >= 1) {
            w = maxDim;
            h = maxDim / aspect;
          } else {
            h = maxDim;
            w = maxDim * aspect;
          }

          setBgImage(img);
          dispatch({
            type: "SET_IMAGE",
            image: {
              src: objectUrl,
              dataUrl,
              position: { x: -w / 2, y: -h / 2 }, // centered at origin
              width: w,
              height: h,
              opacity: 0.4,
            },
          });
        };
        img.src = objectUrl;
      };
      reader.readAsDataURL(file);
    },
    [dispatch, toast, t],
  );

  // Clean up object URL when image changes
  const prevImageSrcRef = useRef<string | null>(null);
  useEffect(() => {
    const currentSrc = state.image?.src ?? null;
    if (prevImageSrcRef.current && prevImageSrcRef.current !== currentSrc) {
      URL.revokeObjectURL(prevImageSrcRef.current);
      if (!currentSrc) setBgImage(null);
    }
    prevImageSrcRef.current = currentSrc;
  }, [state.image?.src]);

  // ── Save handler ───────────────────────────────────────────────────────
  // Uploads the designer state as CSV to object storage, then calls
  // replacePlaceLayout to parse and persist it.

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const csv = designerStateToCsv({
        sections: state.sections,
        seats: state.seats,
        stage: state.stage,
        image: state.image,
      });
      const csvBlob = new Blob([csv], { type: "text/csv" });

      // 1. Get a presigned upload URL
      const { key, uploadUrl } = await presignUpload.mutateAsync({
        placeId,
        contentType: "text/csv" as const,
        sizeBytes: csvBlob.size,
      });

      // 2. Upload CSV to object storage
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/csv" },
        body: csvBlob,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload failed (${uploadResponse.status})`);
      }

      // 3. Replace layout — the server-side parser reads the CSV from storage
      const idempotencyKey = crypto.randomUUID();
      const result = await replaceLayout.mutateAsync({
        placeId,
        upload: { ref: key, format: "csv", source: "admin_wizard" },
        options: { idempotencyKey },
      });

      toast.success({
        title: t("admin.designerLayoutSaved") as string,
        message: t("admin.designerLayoutSavedMsg", {
          seatCount: result.seatCount,
          sectionCount: result.sectionCount,
        }) as string,
      });
    } catch (err) {
      console.error("Save layout failed:", err);

      // Detect common infrastructure issues and surface friendlier messages
      const errMsg = err instanceof Error ? err.message : String(err ?? "");
      let userMessage: string;
      if (
        errMsg.includes("file_storage_not_configured") ||
        errMsg.includes("presignPutObject")
      ) {
        userMessage = t("admin.designerSaveNoStorage") as string;
      } else if (errMsg.includes("place_layout_parser_error")) {
        userMessage = t("admin.designerSaveParserError") as string;
      } else {
        userMessage =
          err instanceof Error
            ? err.message
            : (t("admin.designerSaveFailedMsg") as string);
      }

      toast.danger({
        title: t("admin.designerSaveFailed") as string,
        message: userMessage,
      });
    } finally {
      setIsSaving(false);
    }
  }, [state, placeId, presignUpload, replaceLayout, toast]);

  // ── Auto-detection handler ─────────────────────────────────────────────

  const [isDetecting, setIsDetecting] = useState(false);

  const handleDetect = useCallback(async () => {
    if (!state.image?.dataUrl) return;
    setIsDetecting(true);
    try {
      const result = await detectShapesAndSeats(state.image.dataUrl, placeId, {
        imageWorldX: state.image.position.x,
        imageWorldY: state.image.position.y,
        imageWorldW: state.image.width,
        imageWorldH: state.image.height,
      });

      // Convert detected seats into DesignerSeat objects, assigning each
      // to the first detected section whose polygon contains it.
      const detectedSeats: DesignerSeat[] = [];
      let seatCounter = 1;
      for (const s of result.seats) {
        const parentSection = result.sections.find((sec) =>
          pointInPolygon(s.position, tessellatedPolygon(sec)),
        );
        if (!parentSection) continue;

        detectedSeats.push({
          id: `det-seat-${seatCounter}`,
          sectionId: parentSection.sectionId,
          row: "A",
          seat: String(seatCounter),
          position: s.position,
          radius: Math.max(s.radius, state.defaultSeatRadius),
          rotationDeg: 0,
        });
        seatCounter++;
      }

      dispatch({
        type: "MERGE_DETECTED",
        sections: result.sections,
        seats: detectedSeats,
      });
    } catch (err) {
      console.error("Auto-detection failed:", err);
    } finally {
      setIsDetecting(false);
    }
  }, [state.image, placeId, state.defaultSeatRadius, dispatch]);

  // ── Keyboard shortcuts (global) ────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Shift+Ctrl/Cmd+Z → redo
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        dispatch({ type: "REDO" });
        return;
      }
      // Ctrl/Cmd+Z → undo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: "UNDO" });
        return;
      }

      // Ignore tool shortcuts when focused on an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case "v":
          dispatch({ type: "SET_TOOL", tool: "select" });
          break;
        case "h":
          dispatch({ type: "SET_TOOL", tool: "pan" });
          break;
        case "s":
          if (!e.metaKey && !e.ctrlKey) {
            dispatch({ type: "SET_TOOL", tool: "draw_section" });
          }
          break;
        case "p":
          dispatch({ type: "SET_TOOL", tool: "place_seat" });
          break;
        case "l":
          dispatch({ type: "SET_TOOL", tool: "place_line" });
          break;
        case "a":
          if (!e.metaKey && !e.ctrlKey) {
            dispatch({ type: "SET_TOOL", tool: "place_arc" });
          }
          break;
        case "g":
          dispatch({ type: "SET_TOOL", tool: "place_grid" });
          break;
        case "e":
          dispatch({ type: "SET_TOOL", tool: "erase" });
          break;
        case "b":
          dispatch({ type: "SET_TOOL", tool: "draw_box_section" });
          break;
        case "k":
          dispatch({ type: "SET_TOOL", tool: "draw_stroke" });
          break;
        case "o":
          dispatch({ type: "SET_TOOL", tool: "draw_circle_section" });
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Canvas hook ────────────────────────────────────────────────────────

  const canvas = DesignerCanvas({
    state,
    dispatch,
    nextSectionColor,
    backgroundImage: bgImage,
  });

  // ── Render ─────────────────────────────────────────────────────────────

  // Feature gate: seatingLayouts
  if (!gatesLoading && gates && !gates.seatingLayouts) {
    return null;
  }

  // The canvas designer is a desk tool — render the notice INSTEAD of
  // mounting the canvas on phones.
  if (isMobile) {
    return (
      <DesktopOnlyNotice
        title={String(t("admin.designerDesktopRequired"))}
        body={String(t("admin.designerDesktopRequiredDesc"))}
        backLabel={String(t("admin.designerBackToLayout"))}
        onBack={backToLayout}
      />
    );
  }

  if (isLoadingExisting) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding="$6"
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.designerLoadingExisting"))}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack flex={1} width="100%">
      {/* Header */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        paddingHorizontal="$4"
        paddingVertical="$2"
        borderBottomWidth={1}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <XStack gap="$3" alignItems="center">
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={backToLayout}
                aria-label={t("admin.designerBackToLayoutView") as string}
              >
                <ArrowLeft size={18} />
              </Button>
            }
            placement="bottom"
          >
            {String(t("admin.designerBackToLayoutView"))}
          </Tooltip>
          {returnToEvent && (
            <Tooltip
              anchor={
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={handleReturnToEvent}
                >
                  <Undo2 size={14} />
                  {String(t("admin.layoutReturnToEvent"))}
                </Button>
              }
              placement="bottom"
            >
              {returnToEvent.eventTitle}
            </Tooltip>
          )}
          <Text variant="h3">{String(t("admin.designerHeading"))}</Text>
        </XStack>
      </XStack>

      {/* Main area: toolbar + canvas */}
      <XStack flex={1} overflow="hidden">
        <DesignerToolbar
          state={state}
          dispatch={dispatch}
          nextSectionColor={nextSectionColor}
          onNextSectionColorChange={setNextSectionColor}
          controls={canvas.controls}
          onLoadImage={handleLoadImage}
          onSave={handleSave}
          isSaving={isSaving}
          onDetect={handleDetect}
          isDetecting={isDetecting}
        />

        {/* Canvas */}
        <YStack flex={1} position="relative" overflow="hidden">
          <div
            ref={canvas.containerRef}
            style={{
              position: "absolute",
              inset: 0,
              cursor: canvas.cursorStyle,
            }}
          >
            <canvas
              ref={canvas.canvasRef}
              tabIndex={0}
              {...canvas.handlers}
              data-testid="designer-canvas"
              /* Inset: the canvas is flush to its frame, so a positive offset
                 draws the ring outside and the frame clips it. */
              data-focus-inset=""
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                touchAction: "none",
              }}
            />
            <FloatingConfigPanel
              state={state}
              dispatch={dispatch}
              worldToScreen={canvas.worldToScreen}
            />
          </div>
        </YStack>
      </XStack>
    </YStack>
  );
}
