"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { YStack, XStack } from "tamagui";
import { Text, Spinner, Button, Tooltip } from "@th/ui";
import { useTranslations } from "@th/ui";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SeatGlyph = {
  seatId: string;
  sectionId: string;
  label: string;
  position: { x: number; y: number };
  radius?: number;
  width?: number;
  height?: number;
  rotationDeg?: number;
  metadata?: Record<string, unknown>;
};

type SeatSection = {
  sectionId: string;
  label: string;
  color?: string | null;
  capacity: number;
  geometry?: {
    polygons?: Array<Array<{ x: number; y: number }>>;
    origin?: { x: number; y: number };
    rotation?: number;
    scale?: number;
  } | null;
};

type StageLayout = {
  kind: string;
  label?: string | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

type SeatIndexBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type Viewport = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

type PlaceLayoutCanvasProps = {
  glyphBlobUrl: string | null;
  sections: SeatSection[];
  stage: StageLayout | null;
  seatIndexBounds: SeatIndexBounds;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const ZOOM_FACTOR = 1.15;
const STAGE_COLOR = "rgba(100, 100, 100, 0.15)";
const STAGE_BORDER_COLOR = "rgba(100, 100, 100, 0.4)";
const FALLBACK_SEAT_COLOR = "#888888";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PlaceLayoutCanvas({
  glyphBlobUrl,
  sections,
  stage,
  seatIndexBounds,
}: PlaceLayoutCanvasProps) {
  const t = useTranslations();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [glyphs, setGlyphs] = useState<SeatGlyph[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Viewport state stored in ref to avoid re-renders during pan/zoom
  const viewportRef = useRef<Viewport>({ offsetX: 0, offsetY: 0, scale: 1 });
  const [, forceRender] = useState(0);

  // Pan state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  // Build section color lookup
  const sectionColorMap = useRef(new Map<string, string>());
  useEffect(() => {
    const map = new Map<string, string>();
    for (const section of sections) {
      map.set(section.sectionId, section.color ?? FALLBACK_SEAT_COLOR);
    }
    sectionColorMap.current = map;
  }, [sections]);

  // ── Fetch glyph blob ─────────────────────────────────────────────────
  useEffect(() => {
    // No blob URL → skip fetch, render sections/stage only
    if (!glyphBlobUrl) {
      setGlyphs(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchGlyphs() {
      setIsLoading(true);
      setLoadError(null);

      try {
        const response = await fetch(glyphBlobUrl!);
        if (!response.ok) {
          throw new Error(`Failed to fetch glyphs: ${response.status}`);
        }
        const data = await response.json();
        // The blob may be a raw SeatGlyph[] or an envelope { glyphs: [...] }
        const glyphArray: SeatGlyph[] = Array.isArray(data)
          ? data
          : (data?.glyphs ?? []);
        if (!cancelled) {
          setGlyphs(glyphArray);
        }
      } catch (err) {
        if (!cancelled) {
          // Non-fatal: sections/stage still render without glyphs
          console.warn(
            "Glyph blob fetch failed, rendering sections only:",
            err,
          );
          setGlyphs(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchGlyphs();
    return () => {
      cancelled = true;
    };
  }, [glyphBlobUrl]);

  // Track whether we still need to fit-to-bounds (used to defer if canvas isn't sized yet)
  const needsFitRef = useRef(false);

  // ── Fit viewport to bounds ───────────────────────────────────────────
  const fitToBounds = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const canvasW = canvas.width / dpr;
    const canvasH = canvas.height / dpr;

    // Canvas hasn't been sized by ResizeObserver yet — defer
    if (canvasW <= 0 || canvasH <= 0) {
      needsFitRef.current = true;
      return;
    }

    needsFitRef.current = false;

    const boundsWidth = seatIndexBounds.maxX - seatIndexBounds.minX;
    const boundsHeight = seatIndexBounds.maxY - seatIndexBounds.minY;

    if (boundsWidth <= 0 || boundsHeight <= 0) return;

    const padding = 40;

    const scaleX = (canvasW - padding * 2) / boundsWidth;
    const scaleY = (canvasH - padding * 2) / boundsHeight;
    const scale = Math.min(scaleX, scaleY, MAX_SCALE);

    const centerX = (seatIndexBounds.minX + seatIndexBounds.maxX) / 2;
    const centerY = (seatIndexBounds.minY + seatIndexBounds.maxY) / 2;

    viewportRef.current = {
      scale,
      offsetX: canvasW / 2 - centerX * scale,
      offsetY: canvasH / 2 - centerY * scale,
    };
    forceRender((n) => n + 1);
  }, [seatIndexBounds]);

  // ── Draw ─────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    const { offsetX, offsetY, scale } = viewportRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Draw section polygons
    for (const section of sections) {
      if (!section.geometry?.polygons) continue;
      const color = section.color ?? FALLBACK_SEAT_COLOR;
      for (const polygon of section.geometry.polygons) {
        if (polygon.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(polygon[0]!.x, polygon[0]!.y);
        for (let i = 1; i < polygon.length; i++) {
          ctx.lineTo(polygon[i]!.x, polygon[i]!.y);
        }
        ctx.closePath();
        ctx.fillStyle = hexToRgba(color, 0.08);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.3);
        ctx.lineWidth = 1 / scale;
        ctx.stroke();
      }
    }

    // Draw stage
    if (stage) {
      const { minX, minY, maxX, maxY } = stage.bounds;
      ctx.fillStyle = STAGE_COLOR;
      ctx.strokeStyle = STAGE_BORDER_COLOR;
      ctx.lineWidth = 2 / scale;
      ctx.beginPath();
      ctx.rect(minX, minY, maxX - minX, maxY - minY);
      ctx.fill();
      ctx.stroke();

      if (stage.label) {
        ctx.fillStyle = "rgba(80, 80, 80, 0.7)";
        const fontSize = Math.max(10 / scale, 2);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(stage.label, (minX + maxX) / 2, (minY + maxY) / 2);
      }
    }

    // Draw glyphs
    if (glyphs && glyphs.length > 0) {
      // Compute adaptive radius based on seat density so the preview
      // looks correct regardless of the coordinate system scale.
      const boundsW = seatIndexBounds.maxX - seatIndexBounds.minX;
      const boundsH = seatIndexBounds.maxY - seatIndexBounds.minY;
      const area = boundsW * boundsH;
      const adaptiveRadius = Math.max(
        1,
        Math.min(boundsW * 0.015, Math.sqrt(area / glyphs.length) * 0.35),
      );

      for (const glyph of glyphs) {
        const color =
          sectionColorMap.current.get(glyph.sectionId) ?? FALLBACK_SEAT_COLOR;
        const r = adaptiveRadius;

        ctx.beginPath();
        ctx.arc(glyph.position.x, glyph.position.y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(color, 0.7);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 1);
        ctx.lineWidth = 0.5 / scale;
        ctx.stroke();
      }
    }

    // When no glyphs are available, synthesize a seat dot grid per
    // section from its bounding box + capacity, so the preview shows
    // seat density rather than an empty canvas. Seeded layouts never
    // have a glyph blob, so without this they'd render as just polygons.
    if (!glyphs) {
      for (const section of sections) {
        if (!section.geometry?.polygons) continue;
        const polygon = section.geometry.polygons[0];
        if (!polygon || polygon.length < 3) continue;

        const xs = polygon.map((p) => p.x);
        const ys = polygon.map((p) => p.y);
        const bx = Math.min(...xs);
        const by = Math.min(...ys);
        const bw = Math.max(...xs) - bx;
        const bh = Math.max(...ys) - by;
        const color = section.color ?? FALLBACK_SEAT_COLOR;

        // Choose a column count proportional to the bbox aspect ratio
        // so the dot grid roughly fills the section.
        const aspect = bw / Math.max(bh, 1);
        const cols = Math.max(
          1,
          Math.round(Math.sqrt(section.capacity * aspect)),
        );
        const rows = Math.max(1, Math.ceil(section.capacity / cols));
        const cellW = bw / cols;
        const cellH = bh / rows;
        const dotR = Math.max(1, Math.min(cellW, cellH) * 0.32);

        let drawn = 0;
        ctx.fillStyle = hexToRgba(color, 0.7);
        ctx.strokeStyle = hexToRgba(color, 1);
        ctx.lineWidth = 0.5 / scale;
        for (let r0 = 0; r0 < rows && drawn < section.capacity; r0++) {
          for (let c = 0; c < cols && drawn < section.capacity; c++) {
            ctx.beginPath();
            ctx.arc(
              bx + cellW * (c + 0.5),
              by + cellH * (r0 + 0.5),
              dotR,
              0,
              Math.PI * 2,
            );
            ctx.fill();
            ctx.stroke();
            drawn++;
          }
        }

        // Compute polygon centroid for the label overlay
        let cx = 0;
        let cy = 0;
        for (const pt of polygon) {
          cx += pt.x;
          cy += pt.y;
        }
        cx /= polygon.length;
        cy /= polygon.length;

        // Section label sits above the dot grid centroid
        const labelFontSize = Math.max(12 / scale, 3);
        ctx.fillStyle = hexToRgba(color, 0.95);
        ctx.font = `bold ${labelFontSize}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(section.label, cx, by - labelFontSize * 0.8);
      }
    }

    ctx.restore();

    // Draw seat count overlay
    const totalSeats = glyphs
      ? glyphs.length
      : sections.reduce((sum, s) => sum + s.capacity, 0);
    if (totalSeats > 0) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${totalSeats.toLocaleString()} seats`, 8, h - 8);
    }
  }, [glyphs, sections, stage, seatIndexBounds]);

  // ── Canvas sizing ────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        // If fitToBounds was deferred because the canvas had no size, flush it now
        if (needsFitRef.current && width > 0 && height > 0) {
          fitToBounds();
        }

        draw();
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
    // `isLoading` is in the dep list because while loading we render a
    // spinner-only branch where the canvas/container aren't mounted yet.
    // Without re-running once loading flips, the ResizeObserver would
    // never attach and the canvas would stay at the default 300×150.
  }, [draw, fitToBounds, isLoading]);

  // Auto-fit once loading finishes (with or without glyphs)
  useEffect(() => {
    if (!isLoading && canvasRef.current) {
      fitToBounds();
    }
  }, [isLoading, fitToBounds]);

  // Redraw on viewport change
  useEffect(() => {
    draw();
  });

  // ── Pan handlers ─────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!isPanningRef.current) return;

      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      panStartRef.current = { x: e.clientX, y: e.clientY };

      viewportRef.current = {
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + dx,
        offsetY: viewportRef.current.offsetY + dy,
      };
      draw();
    },
    [draw],
  );

  const handlePointerUp = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  // ── Zoom handlers ────────────────────────────────────────────────────
  const zoomAtPoint = useCallback(
    (clientX: number, clientY: number, zoomIn: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      const { offsetX, offsetY, scale } = viewportRef.current;
      const factor = zoomIn ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));

      // Zoom toward mouse position
      viewportRef.current = {
        scale: newScale,
        offsetX: mouseX - (mouseX - offsetX) * (newScale / scale),
        offsetY: mouseY - (mouseY - offsetY) * (newScale / scale),
      };
      draw();
    },
    [draw],
  );

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      zoomAtPoint(e.clientX, e.clientY, e.deltaY < 0);
    },
    [zoomAtPoint],
  );

  const handleZoomIn = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, true);
    forceRender((n) => n + 1);
  }, [zoomAtPoint]);

  const handleZoomOut = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, false);
    forceRender((n) => n + 1);
  }, [zoomAtPoint]);

  const handleFit = useCallback(() => {
    fitToBounds();
  }, [fitToBounds]);

  // ── Loading / error states ───────────────────────────────────────────
  if (isLoading) {
    return (
      <YStack
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        justifyContent="center"
        alignItems="center"
        gap="$3"
        padding="$6"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.canvasLoadingSeatData"))}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      overflow="hidden"
    >
      {/* Warn about glyph fetch failure, but still render canvas */}
      {loadError && (
        <XStack
          position="absolute"
          top={8}
          left={8}
          right={8}
          zIndex={10}
          backgroundColor="$red2"
          borderRadius="$0"
          padding="$2"
          justifyContent="center"
        >
          <Text variant="caption" tone="error">
            {loadError}
          </Text>
        </XStack>
      )}
      {/* Canvas container */}
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          cursor: isPanningRef.current ? "grabbing" : "grab",
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            touchAction: "none",
          }}
        />
      </div>

      {/* Zoom controls */}
      <XStack
        position="absolute"
        bottom={12}
        right={12}
        gap="$1"
        padding="$1"
        borderRadius="$0"
        backgroundColor="rgba(255, 255, 255, 0.9)"
        borderWidth={2}
        borderColor="$borderColor"
      >
        <Tooltip
          anchor={
            <Button
              variant="ghost"
              size="$2"
              icon
              onPress={handleZoomIn}
              aria-label={t("admin.canvasZoomIn") as string}
            >
              <ZoomIn size={16} />
            </Button>
          }
          placement="top"
        >
          {String(t("admin.canvasZoomIn"))}
        </Tooltip>
        <Tooltip
          anchor={
            <Button
              variant="ghost"
              size="$2"
              icon
              onPress={handleZoomOut}
              aria-label={t("admin.canvasZoomOut") as string}
            >
              <ZoomOut size={16} />
            </Button>
          }
          placement="top"
        >
          {String(t("admin.canvasZoomOut"))}
        </Tooltip>
        <Tooltip
          anchor={
            <Button
              variant="ghost"
              size="$2"
              icon
              onPress={handleFit}
              aria-label={t("admin.canvasFitToView") as string}
            >
              <Maximize size={16} />
            </Button>
          }
          placement="top"
        >
          {String(t("admin.canvasFitToView"))}
        </Tooltip>
      </XStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  // Handle shorthand and non-hex gracefully
  if (!hex.startsWith("#")) return hex;

  let r = 0;
  let g = 0;
  let b = 0;

  if (hex.length === 4) {
    r = parseInt(hex[1]! + hex[1]!, 16);
    g = parseInt(hex[2]! + hex[2]!, 16);
    b = parseInt(hex[3]! + hex[3]!, 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return hex;
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
