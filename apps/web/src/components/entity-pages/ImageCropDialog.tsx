"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { XStack, YStack } from "tamagui";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import {
  Button,
  Modal,
  RangeSlider,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centeredView,
  clampView,
  croppedFileName,
  outputContentType,
  outputSize,
  sourceRect,
  zoomAnchored,
  type CropBox,
  type CropView,
} from "./image-crop";

// ─────────────────────────────────────────────────────────────────────────────
// ImageCropDialog
//
// A client-side crop step that sits BETWEEN file selection and the presigned
// upload. It never talks to the network: it hands back a `File`, and the
// caller feeds that file into whichever existing upload hook it already used
// (`usePageImageUpload`, `useAvatarUpload`) so the cropped bytes go through
// the SAME HEIC prep + content-type + size-cap validation as an uncropped
// pick. No server-side transform exists and none is added.
//
// Accessibility (NFR-001): every gesture has a keyboard equivalent —
//   · arrow keys pan (Shift = 1px precision)
//   · the zoom slider is a native <input type="range">
//   · "+" / "-" zoom, Home resets
// The crop surface is a focusable `group` wired to a visible instruction line
// via `aria-describedby`, so a keyboard/AT user is told what the keys do
// rather than having to discover them. Motion: the only transition is the
// zoom easing, which `usePrefersReducedMotion` disables.
//
// Every gesture ALSO has a button equivalent (pan arrows, zoom +/-, recentre).
// Arrow keys alone are not enough: NVDA/JAWS do not auto-switch to focus mode
// for `role="group"`, so a browse-mode screen-reader user who tabs to the crop
// surface and presses an arrow navigates the DOCUMENT, not the crop. Zoom
// already had non-arrow paths; panning did not, which left that user stuck
// with the centred framing.
// ─────────────────────────────────────────────────────────────────────────────

/** Tallest the crop viewport is allowed to get; width follows the aspect. */
const MAX_BOX_HEIGHT = 300;
/** Arrow-key pan step, and the fine step when Shift is held. */
const PAN_STEP = 12;
const PAN_STEP_FINE = 1;
/** Zoom step for the +/- buttons and keys. */
const ZOOM_STEP = 0.2;
/** Wheel delta → zoom units. */
const WHEEL_ZOOM_FACTOR = 0.0025;
/** JPEG/WebP encode quality for the cropped output. */
const OUTPUT_QUALITY = 0.92;

/**
 * Whether the browser considers `node` to deserve a visible focus ring.
 *
 * The crop surface's ring is an INLINE style (it has to be — the box's size
 * and cursor are computed), and an inline style cannot express
 * `:focus-visible`, so the pseudo-class is queried directly instead. Without
 * this, clicking the image with a mouse paints the accent ring, which reads as
 * an error state rather than a focus affordance.
 *
 * Defaults to `true` when the pseudo-class is unsupported (older engines,
 * jsdom): showing a ring to a mouse user is a cosmetic miss, hiding it from a
 * keyboard user is an accessibility failure.
 */
function isFocusVisible(node: EventTarget | null): boolean {
  const el = node as Element | null;
  if (!el || typeof el.matches !== "function") return true;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export interface ImageCropDialogProps {
  /**
   * File the user picked. The dialog is open whenever this is non-null;
   * pass `null` to close. Changing it restarts the crop from a centred view.
   */
  file: File | null;
  /** Crop aspect ratio (width / height). `1` for avatars, `3` for banners. */
  aspect: number;
  /** Dialog heading. */
  title: string;
  /** Longest output edge in px. Default 1600. */
  maxOutputWidth?: number;
  /** User dismissed the dialog, or the image could not be prepared. */
  onCancel: () => void;
  /**
   * Cropped result. Pass this straight to the surface's existing upload hook
   * — it is a real `File` and must re-enter the normal validation path.
   */
  onCropped: (file: File) => void;
  /** HEIC conversion / decode failed. The dialog also calls `onCancel`. */
  onPrepareError?: (error: unknown) => void;
}

interface PreparedImage {
  url: string;
  naturalW: number;
  naturalH: number;
  contentType: string;
  name: string;
}

export function ImageCropDialog({
  file,
  aspect,
  title,
  maxOutputWidth = 1600,
  onCancel,
  onCropped,
  onPrepareError,
}: ImageCropDialogProps) {
  const t = useTranslations();
  const reducedMotion = usePrefersReducedMotion();
  const hintId = useId();

  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [containerW, setContainerW] = useState(0);
  // `null` means "not framed yet" — the RENDER falls back to `centeredView`
  // for the current box. Seeding the centre from an effect instead painted one
  // frame at zoom 1 / offset 0,0 before the effect ran (a visible jump on
  // open, and a genuinely flaky assertion in the tests that caught it).
  const [view, setView] = useState<CropView | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  // Callbacks live in refs so the prepare effect can depend on `file` alone —
  // an unstable inline `onCancel` must not restart HEIC conversion.
  const cancelRef = useRef(onCancel);
  const prepareErrorRef = useRef(onPrepareError);
  useEffect(() => {
    cancelRef.current = onCancel;
    prepareErrorRef.current = onPrepareError;
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /**
   * The image the prepare effect already DECODED and awaited — the one the
   * export draws from.
   *
   * It must not be the rendered DOM `<img>`: that element runs its own,
   * separate load cycle off the same object URL, and `ctx.drawImage` with an
   * image whose `complete` is still `false` returns WITHOUT drawing and
   * WITHOUT throwing. `toBlob` would then encode an untouched canvas — a
   * transparent PNG or a black JPEG — which is a perfectly valid small image,
   * so it sails through the type check, the size cap, presign, PUT and
   * finalize and lands as the user's avatar with no error anywhere.
   */
  const decodedRef = useRef<HTMLImageElement | null>(null);

  // ── Prepare (HEIC → JPEG, then decode for natural dimensions) ────────────
  useEffect(() => {
    if (!file) {
      setPrepared(null);
      decodedRef.current = null;
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setPreparing(true);
    setPrepared(null);
    decodedRef.current = null;

    void (async () => {
      try {
        // The crop canvas cannot decode HEIC in Chrome/Firefox at all, so the
        // conversion has to run BEFORE the crop, not only inside the upload
        // hook. It is a no-op for every other type, and running it again
        // downstream is free.
        const ready = await prepareImageForUpload(file);
        objectUrl = URL.createObjectURL(ready);
        const img = new Image();
        img.decoding = "async";
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("image_decode_failed"));
          img.src = objectUrl as string;
        });
        if (cancelled) return;
        // Keep the decoded instance — this is what `handleApply` draws.
        decodedRef.current = img;
        setPrepared({
          url: objectUrl,
          naturalW: img.naturalWidth,
          naturalH: img.naturalHeight,
          contentType: ready.type,
          name: ready.name,
        });
      } catch (error) {
        if (cancelled) return;
        prepareErrorRef.current?.(error);
        cancelRef.current();
      } finally {
        if (!cancelled) setPreparing(false);
      }
    })();

    return () => {
      cancelled = true;
      decodedRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  // ── Measure the crop box ─────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [prepared]);

  const boxW = Math.max(0, Math.min(containerW, MAX_BOX_HEIGHT * aspect));
  const boxH = boxW / aspect;
  const box: CropBox = {
    boxW,
    boxH,
    naturalW: prepared?.naturalW ?? 0,
    naturalH: prepared?.naturalH ?? 0,
  };
  const ready = Boolean(prepared) && boxW > 0 && box.naturalW > 0;

  // Drop the framing whenever a new image is prepared or the box is
  // re-measured, so the render falls back to a fresh centred view. A viewport
  // resize mid-crop therefore restarts from centre — deliberate: the
  // alternative silently rescales the user's framing into something they
  // never chose.
  useEffect(() => {
    setView(null);
  }, [prepared, boxW, boxH]);

  const activeView: CropView = ready
    ? (view ?? centeredView(box))
    : { zoom: MIN_ZOOM, x: 0, y: 0 };

  const viewRef = useRef(activeView);
  viewRef.current = activeView;
  const boxMetricsRef = useRef(box);
  boxMetricsRef.current = box;

  /** Current framing, falling back to the centred view when unframed. */
  const framed = (current: CropView | null, metrics: CropBox): CropView =>
    current ?? centeredView(metrics);

  // ── View mutation ────────────────────────────────────────────────────────
  const applyZoom = useCallback((next: number | ((current: number) => number)) => {
    setView((current) => {
      const metrics = boxMetricsRef.current;
      if (metrics.boxW <= 0 || metrics.naturalW <= 0) return current;
      const base = framed(current, metrics);
      const target = typeof next === "function" ? next(base.zoom) : next;
      return zoomAnchored(base, metrics, target);
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setView((current) => {
      const metrics = boxMetricsRef.current;
      if (metrics.boxW <= 0 || metrics.naturalW <= 0) return current;
      const base = framed(current, metrics);
      return clampView({ ...base, x: base.x + dx, y: base.y + dy }, metrics);
    });
  }, []);

  const panTo = useCallback((x: number, y: number) => {
    setView((current) => {
      const metrics = boxMetricsRef.current;
      if (metrics.boxW <= 0 || metrics.naturalW <= 0) return current;
      return clampView({ ...framed(current, metrics), x, y }, metrics);
    });
  }, []);

  const resetView = useCallback(() => {
    const metrics = boxMetricsRef.current;
    if (metrics.boxW <= 0 || metrics.naturalW <= 0) return;
    setView(centeredView(metrics));
  }, []);

  // ── Pointer gestures (mouse, touch and pen through one code path) ────────
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const pinchRef = useRef<{ startDistance: number; startZoom: number } | null>(
    null,
  );

  const beginDrag = useCallback((pointerId: number, x: number, y: number) => {
    dragRef.current = {
      id: pointerId,
      startX: x,
      startY: y,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!ready) return;
      const pointers = pointersRef.current;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
      if (pointers.size === 1) {
        beginDrag(event.pointerId, event.clientX, event.clientY);
        pinchRef.current = null;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchRef.current = {
          startDistance: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1,
          startZoom: viewRef.current.zoom,
        };
        dragRef.current = null;
      }
    },
    [beginDrag, ready],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      const pinch = pinchRef.current;
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        applyZoom(pinch.startZoom * (distance / pinch.startDistance));
        return;
      }

      const drag = dragRef.current;
      if (drag?.id === event.pointerId) {
        panTo(
          drag.originX + (event.clientX - drag.startX),
          drag.originY + (event.clientY - drag.startY),
        );
      }
    },
    [applyZoom, panTo],
  );

  const endPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      pointers.delete(event.pointerId);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (pointers.size < 2) pinchRef.current = null;
      if (pointers.size === 0) {
        dragRef.current = null;
        setDragging(false);
        return;
      }
      // A pinch that drops to one finger becomes a drag — re-seed the anchor
      // from the finger still down, otherwise the image jumps.
      const [remainingId, point] = [...pointers.entries()][0]!;
      beginDrag(remainingId, point.x, point.y);
    },
    [beginDrag],
  );

  // Wheel needs a non-passive listener to call preventDefault (React's
  // onWheel is registered passively and cannot stop the page scrolling).
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !ready) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyZoom((current) => current - event.deltaY * WHEEL_ZOOM_FACTOR);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom, ready]);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!ready) return;
      const step = event.shiftKey ? PAN_STEP_FINE : PAN_STEP;
      switch (event.key) {
        // Arrows move the IMAGE, matching what dragging does — dragging right
        // and pressing ArrowRight must not disagree.
        case "ArrowLeft":
          panBy(-step, 0);
          break;
        case "ArrowRight":
          panBy(step, 0);
          break;
        case "ArrowUp":
          panBy(0, -step);
          break;
        case "ArrowDown":
          panBy(0, step);
          break;
        case "+":
        case "=":
          applyZoom((current) => current + ZOOM_STEP);
          break;
        case "-":
        case "_":
          applyZoom((current) => current - ZOOM_STEP);
          break;
        case "Home":
          resetView();
          break;
        default:
          // Everything else (notably Tab and Escape) keeps its normal
          // behaviour — a crop surface must never trap focus.
          return;
      }
      event.preventDefault();
    },
    [applyZoom, panBy, ready, resetView],
  );

  // ── Export ───────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    const image = decodedRef.current;
    const metrics = boxMetricsRef.current;
    if (!prepared || !image || !ready || exporting) return;
    setExporting(true);
    try {
      // Belt AND braces. `decodedRef` only ever holds an image whose `onload`
      // has already fired, but a silent blank upload is severe enough that the
      // export refuses to run on anything it cannot prove is drawable. Throwing
      // lands in the catch below → `onPrepareError` → a visible toast, instead
      // of a blank file the user only discovers on their public page.
      if (!image.complete || image.naturalWidth === 0) {
        throw new Error("image_not_ready");
      }

      const rect = sourceRect(viewRef.current, metrics);
      const contentType = outputContentType(prepared.contentType);
      const { width, height } = outputSize(rect, aspect, maxOutputWidth);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, contentType, OUTPUT_QUALITY);
      });
      if (!blob) throw new Error("canvas_encode_failed");

      // `toBlob` silently falls back to PNG for an unsupported type, so trust
      // the blob's own type for the filename rather than what we asked for.
      const actualType = blob.type || contentType;
      onCropped(
        new File([blob], croppedFileName(prepared.name, actualType), {
          type: actualType,
        }),
      );
    } catch (error) {
      prepareErrorRef.current?.(error);
      cancelRef.current();
    } finally {
      setExporting(false);
    }
  }, [aspect, exporting, maxOutputWidth, onCropped, prepared, ready]);

  const scale =
    ready && prepared
      ? (Math.max(boxW / prepared.naturalW, boxH / prepared.naturalH) || 1) *
        activeView.zoom
      : 1;

  return (
    <Modal open={Boolean(file)} onClose={onCancel}>
      <Modal.Panel width={520} data-testid="image-crop-dialog">
        <Modal.Header
          title={title}
          subtitle={String(t("common.cropSubtitle"))}
          onClose={onCancel}
        />
        <Modal.Body>
          {/* Plain div so `clientWidth` is read off a real DOM node — the crop
              maths needs the measured box, not a Tamagui layout guess. */}
          <div ref={containerRef} style={{ width: "100%" }}>
          <YStack width="100%" alignItems="center" gap="$3">
            {/* Hold the placeholder until the box has been MEASURED as well as
                decoded. Rendering the image before `boxW` is known paints one
                frame at the wrong scale and offset — a visible jump. */}
            {preparing || !prepared || !ready ? (
              <XStack
                width="100%"
                height={Math.min(MAX_BOX_HEIGHT, 220)}
                alignItems="center"
                justifyContent="center"
                gap="$2"
                borderWidth={2}
                borderColor="$borderColor"
                backgroundColor="$surfaceMuted"
              >
                <Spinner size="sm" />
                <Text variant="bodySmall" color="$colorMuted">
                  {String(t("common.cropPreparing"))}
                </Text>
              </XStack>
            ) : (
              <div
                ref={boxRef}
                role="group"
                tabIndex={0}
                aria-label={String(t("common.cropRegionLabel"))}
                aria-describedby={hintId}
                data-testid="image-crop-surface"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onKeyDown={handleKeyDown}
                onFocus={(event) => setFocused(isFocusVisible(event.target))}
                onBlur={() => setFocused(false)}
                style={{
                  position: "relative",
                  width: boxW || "100%",
                  height: boxH || undefined,
                  aspectRatio: boxW ? undefined : String(aspect),
                  overflow: "hidden",
                  border: "2px solid var(--borderColor, #211C16)",
                  background: "var(--surfaceMuted, #EFE7D6)",
                  touchAction: "none",
                  cursor: dragging ? "grabbing" : "grab",
                  userSelect: "none",
                  // On-brand focus ring in place of the UA default blue —
                  // this is the control a keyboard user drives, so the ring
                  // has to be unmistakable and match the rest of the form.
                  // Gated on `:focus-visible` (see `isFocusVisible`) so a
                  // mouse click on the image does not paint it.
                  outline: focused
                    ? "2px solid var(--accent, #E2481D)"
                    : "none",
                  outlineOffset: 2,
                }}
              >
                {/* Presentation only — the EXPORT draws from `decodedRef`,
                    never from this element (see the ref's docblock). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={prepared.url}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: prepared.naturalW * scale,
                    height: prepared.naturalH * scale,
                    transform: `translate(${activeView.x}px, ${activeView.y}px)`,
                    transition:
                      reducedMotion || dragging
                        ? "none"
                        : "transform 120ms ease-out, width 120ms ease-out, height 120ms ease-out",
                    maxWidth: "none",
                    pointerEvents: "none",
                  }}
                />
              </div>
            )}

            <XStack width="100%" alignItems="center" gap="$3">
              <Button
                variant="outlined"
                size="$2"
                disabled={!ready || activeView.zoom <= MIN_ZOOM}
                onPress={() => applyZoom((current) => current - ZOOM_STEP)}
                aria-label={String(t("common.cropZoomOut"))}
              >
                <Minus size={14} />
              </Button>
              <YStack flex={1} minWidth={0}>
                <RangeSlider
                  value={activeView.zoom}
                  onValueChange={(next) => applyZoom(next)}
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.01}
                  disabled={!ready}
                  label={String(t("common.cropZoomLabel"))}
                  valueText={`${Math.round(activeView.zoom * 100)}%`}
                  testId="image-crop-zoom"
                />
              </YStack>
              <Button
                variant="outlined"
                size="$2"
                disabled={!ready || activeView.zoom >= MAX_ZOOM}
                onPress={() => applyZoom((current) => current + ZOOM_STEP)}
                aria-label={String(t("common.cropZoomIn"))}
              >
                <Plus size={14} />
              </Button>
            </XStack>

            {/* Pan controls. Deliberately buttons and not "just" the arrow
                keys: a browse-mode screen-reader user never reaches the crop
                surface's key handler at all (see the header comment), and
                without these the framing is not adjustable for them.
                Not disabled at the clamp edges — pressing past an edge is the
                same harmless no-op holding ArrowRight already is. */}
            <XStack width="100%" alignItems="center" gap="$2">
              <XStack gap="$2" flexShrink={0}>
                <Button
                  variant="outlined"
                  size="$2"
                  disabled={!ready}
                  onPress={() => panBy(-PAN_STEP, 0)}
                  aria-label={String(t("common.cropPanLeft"))}
                >
                  <ArrowLeft size={14} />
                </Button>
                <Button
                  variant="outlined"
                  size="$2"
                  disabled={!ready}
                  onPress={() => panBy(0, -PAN_STEP)}
                  aria-label={String(t("common.cropPanUp"))}
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  variant="outlined"
                  size="$2"
                  disabled={!ready}
                  onPress={() => panBy(0, PAN_STEP)}
                  aria-label={String(t("common.cropPanDown"))}
                >
                  <ArrowDown size={14} />
                </Button>
                <Button
                  variant="outlined"
                  size="$2"
                  disabled={!ready}
                  onPress={() => panBy(PAN_STEP, 0)}
                  aria-label={String(t("common.cropPanRight"))}
                >
                  <ArrowRight size={14} />
                </Button>
              </XStack>
              {/* Recentre resets BOTH axes and the zoom, so it belongs with
                  the framing controls rather than crowding the zoom slider. */}
              <XStack flex={1} minWidth={0} justifyContent="flex-end">
                <Button
                  variant="ghost"
                  size="$2"
                  disabled={!ready}
                  onPress={resetView}
                  aria-label={String(t("common.cropReset"))}
                >
                  <RotateCcw size={14} />
                </Button>
              </XStack>
            </XStack>

            <Text
              variant="caption"
              color="$colorMuted"
              {...({ id: hintId } as Record<string, unknown>)}
            >
              {String(t("common.cropKeyboardHint"))}
            </Text>
          </YStack>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="$3" onPress={onCancel}>
            {String(t("common.cancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            disabled={!ready || exporting}
            onPress={() => void handleApply()}
            data-testid="image-crop-apply"
          >
            {exporting ? <Spinner size="sm" /> : <Check size={16} />}
            {String(t("common.cropApply"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
