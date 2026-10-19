"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { styled, XStack, YStack, useTheme } from "tamagui";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minus,
  Paintbrush,
  Plus,
  Undo2,
} from "lucide-react";

import {
  Text,
  Button,
  Badge,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtCurrency } from "@/lib/format";
import { useIsMobile } from "@/hooks/useIsMobile";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SeatGlyph = {
  seatId: string;
  sectionId: string;
  label: string;
  position: { x: number; y: number };
  radius?: number;
};

type SectionData = {
  sectionId: string;
  label: string;
  color?: string | null;
  capacity: number;
  geometry?: {
    polygons?: Array<Array<{ x: number; y: number }>>;
    origin?: { x: number; y: number };
  } | null;
};

type TicketTypeSummary = {
  id: string;
  name: string;
  priceCents: number;
  capacity: number;
  status: string;
  seatSectionId: string | null;
};

type Assignment = {
  ticketTypeId: string;
  seatSectionId: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled components
// ─────────────────────────────────────────────────────────────────────────────

const EditorContainer = styled(XStack, {
  flex: 1,
  minHeight: 600,
});

const MobileEditorContainer = styled(YStack, {
  flex: 1,
  minHeight: "auto" as never,
});

const Sidebar = styled(YStack, {
  width: 340,
  borderRightWidth: 1,
  borderRightColor: "$borderColor",
  backgroundColor: "$surface",
  overflow: "scroll" as never,
});

const MobileSidebar = styled(YStack, {
  width: "100%",
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
  backgroundColor: "$surface",
  overflow: "scroll" as never,
  maxHeight: 400,
});

const SidebarSection = styled(YStack, {
  padding: 16,
  gap: 12,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
});

const SidebarLabel = styled(Text, {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "$colorMuted",
});

const CanvasArea = styled(YStack, {
  flex: 1,
  position: "relative",
  backgroundColor: "$surfaceMuted",
});

const MobileCanvasArea = styled(YStack, {
  minHeight: 280,
  position: "relative",
  backgroundColor: "$surfaceMuted",
});

const SectionCard = styled(XStack, {
  padding: 12,
  borderWidth: 1,
  borderColor: "$borderColor",
  gap: 12,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  variants: {
    selected: {
      true: {
        borderColor: "$accent",
        backgroundColor: "$surfaceMuted",
      },
    },
  },
});

const ColorDot = styled(YStack, {
  width: 12,
  height: 12,
  borderRadius: 0,
});

const TicketTypeOption = styled(XStack, {
  padding: 8,
  paddingHorizontal: 12,
  gap: 8,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  variants: {
    active: {
      true: {
        backgroundColor: "$surfaceMuted",
      },
    },
  },
});

const Legend = styled(XStack, {
  padding: 8,
  paddingHorizontal: 16,
  gap: 16,
  alignItems: "center",
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
  backgroundColor: "$surface",
  flexWrap: "wrap",
});

// ─────────────────────────────────────────────────────────────────────────────
// Canvas helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_COLORS = [
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
];

const DEFAULT_SEAT_RADIUS = 4;
const FALLBACK_SEAT_COLOR = "#888888";

// ── Canvas view (touch pan/pinch + zoom buttons) ────────────────────────────
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
/** Touch movement (px) beyond which a touch is a pan, not a tap-to-select. */
const TAP_SLOP_PX = 8;

function getSectionColor(
  cache: Record<string, string>,
  sectionId: string,
  index: number,
  explicitColor?: string | null,
): string {
  if (explicitColor) return explicitColor;
  if (!cache[sectionId]) {
    cache[sectionId] = DEFAULT_COLORS[index % DEFAULT_COLORS.length]!;
  }
  return cache[sectionId]!;
}

function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith("#")) return hex;
  let r = 0,
    g = 0,
    b = 0;
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

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export type SeatingLayoutEditorProps = {
  eventId: string;
  placeId: string;
  placeLayoutId: string;
  currency?: string;
};

export function SeatingLayoutEditor({
  eventId,
  placeId,
  currency = "usd",
}: SeatingLayoutEditorProps) {
  const theme = useTheme();
  const { toast } = useNotify();
  const t = useTranslations();
  const fmt = useFormatters();
  const isMobile = useIsMobile();

  // ── Data queries ─────────────────────────────────────────────────────

  const layoutQuery = trpc.placeLayouts.getPlaceLayout.useQuery(
    { placeId },
    { enabled: !!placeId },
  );

  const ticketTypesQuery = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  const utils = trpc.useUtils();

  const assignMutation = trpc.events.assignTicketTypeSections.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      utils.events.listTicketTypesForEdit.invalidate({ eventId });
    },
  });

  // ── State ────────────────────────────────────────────────────────────

  /** Which section is selected in sidebar for assignment. */
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    null,
  );

  /** Paint mode: when a ticket type is selected, clicking sections assigns it. */
  const [paintTicketTypeId, setPaintTicketTypeId] = useState<string | null>(
    null,
  );

  /** Local assignment overrides (before save). Maps ticketTypeId → seatSectionId | null. */
  const [localAssignments, setLocalAssignments] = useState<
    Record<string, string | null>
  >({});

  /** Track expanded sections in sidebar. */
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(),
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Per-instance section color cache (avoids module-level mutation). */
  const sectionColorCache = useRef<Record<string, string>>({});

  // ── Canvas view transform ────────────────────────────────────────────
  // screen = C + pan + zoom * (fit(world) - C): zoom about the canvas
  // centre `C`, then pan in screen pixels. zoom 1 / pan 0 = fit view.
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  /** Fit transform captured by the last draw — gesture math reads this. */
  const fitRef = useRef<{
    fitScale: number;
    offsetX: number;
    offsetY: number;
    worldW: number;
    worldH: number;
    cX: number;
    cY: number;
  } | null>(null);
  /** Active touch gesture (single-finger pan or two-finger pinch). */
  const gestureRef = useRef<{
    mode: "pan" | "pinch";
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    startDist: number;
    startZoom: number;
  } | null>(null);
  /** Suppresses the synthetic click that can follow a pan/pinch gesture. */
  const suppressClickRef = useRef(false);
  /** Active desktop mouse drag-pan (touch pans live in gestureRef). */
  const mousePanRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  /** Mouse button held on the canvas — drives the grab/grabbing cursor. */
  const [isMousePanning, setIsMousePanning] = useState(false);
  /** Bumped by the ResizeObserver to force a canvas redraw. */
  const [resizeTick, setResizeTick] = useState(0);

  /** Seat glyphs fetched from the layout blob URL. */
  const [glyphs, setGlyphs] = useState<SeatGlyph[] | null>(null);

  // ── Fetch seat glyphs from blob URL ──────────────────────────────────

  const glyphBlobUrl = layoutQuery.data?.layout?.glyphBlobUrl ?? null;

  useEffect(() => {
    if (!glyphBlobUrl) {
      setGlyphs(null);
      return;
    }

    let cancelled = false;

    async function fetchGlyphs() {
      try {
        const response = await fetch(glyphBlobUrl!);
        if (!response.ok) {
          throw new Error(`Failed to fetch glyphs: ${response.status}`);
        }
        const data = await response.json();
        const glyphArray: SeatGlyph[] = Array.isArray(data)
          ? data
          : (data?.glyphs ?? []);
        if (!cancelled) {
          setGlyphs(glyphArray);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn(
            "Glyph blob fetch failed, rendering sections only:",
            err,
          );
          setGlyphs(null);
        }
      }
    }

    void fetchGlyphs();
    return () => {
      cancelled = true;
    };
  }, [glyphBlobUrl]);

  // ── Derived data ─────────────────────────────────────────────────────

  const sections: SectionData[] = useMemo(
    () => layoutQuery.data?.layout?.sections ?? [],
    [layoutQuery.data],
  );

  const ticketTypes: TicketTypeSummary[] = useMemo(
    () => ticketTypesQuery.data?.ticketTypes ?? [],
    [ticketTypesQuery.data],
  );

  /** Merged assignments: server data + local overrides. */
  const effectiveAssignments = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const tt of ticketTypes) {
      const local = localAssignments[tt.id];
      map.set(tt.id, local !== undefined ? local : (tt.seatSectionId ?? null));
    }
    return map;
  }, [ticketTypes, localAssignments]);

  /** Reverse map: sectionId → ticketType(s) assigned to it. */
  const sectionAssignments = useMemo(() => {
    const map = new Map<string, TicketTypeSummary[]>();
    for (const tt of ticketTypes) {
      const sectionId = effectiveAssignments.get(tt.id);
      if (sectionId) {
        const existing = map.get(sectionId) ?? [];
        existing.push(tt);
        map.set(sectionId, existing);
      }
    }
    return map;
  }, [ticketTypes, effectiveAssignments]);

  const hasUnsavedChanges = Object.keys(localAssignments).length > 0;

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleSectionClick = useCallback(
    (sectionId: string) => {
      if (paintTicketTypeId) {
        // Paint mode: assign the selected ticket type to this section
        setLocalAssignments((prev) => ({
          ...prev,
          [paintTicketTypeId]: sectionId,
        }));
      } else {
        // Selection mode: toggle sidebar
        setSelectedSectionId((prev) => (prev === sectionId ? null : sectionId));
      }
    },
    [paintTicketTypeId],
  );

  const handleAssignTicketType = useCallback(
    (ticketTypeId: string, seatSectionId: string | null) => {
      setLocalAssignments((prev) => ({
        ...prev,
        [ticketTypeId]: seatSectionId,
      }));
    },
    [],
  );

  const handleTogglePaintMode = useCallback((ticketTypeId: string) => {
    setPaintTicketTypeId((prev) =>
      prev === ticketTypeId ? null : ticketTypeId,
    );
  }, []);

  const handleDiscardChanges = useCallback(() => {
    setLocalAssignments({});
    setPaintTicketTypeId(null);
  }, []);

  const handleSave = useCallback(async () => {
    const assignments: Assignment[] = Object.entries(localAssignments).map(
      ([ticketTypeId, seatSectionId]) => ({ ticketTypeId, seatSectionId }),
    );

    if (assignments.length === 0) return;

    try {
      await assignMutation.mutateAsync({ eventId, assignments });
      setLocalAssignments({});
      setPaintTicketTypeId(null);
      toast.success({
        id: "seating-saved",
        title: t("admin.slSavedTitle") as string,
        message: t("admin.slSavedMessage", {
          count: assignments.length,
        }) as string,
      });
    } catch (error) {
      toast.danger({
        id: "seating-save-failed",
        title: t("admin.slSaveFailed") as string,
        message: formatErrorMessage(error, t),
      });
    }
  }, [localAssignments, eventId, assignMutation, toast]);

  const handleToggleSection = useCallback((sectionId: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  // ── Canvas rendering ─────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || sections.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Compute bounds across all sections (and glyphs if available)
    const seatIndexBounds = layoutQuery.data?.layout?.seatIndexBounds;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    // Use seatIndexBounds from layout if available (covers glyphs)
    if (seatIndexBounds && isFinite(seatIndexBounds.minX)) {
      minX = seatIndexBounds.minX;
      minY = seatIndexBounds.minY;
      maxX = seatIndexBounds.maxX;
      maxY = seatIndexBounds.maxY;
    } else {
      for (const section of sections) {
        const polygons = section.geometry?.polygons ?? [];
        for (const poly of polygons) {
          for (const pt of poly) {
            if (pt.x < minX) minX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y > maxY) maxY = pt.y;
          }
        }
      }
    }

    if (!isFinite(minX)) return;

    const worldW = maxX - minX || 1;
    const worldH = maxY - minY || 1;
    // Mobile gets a slim inset so the layout uses the full canvas width.
    const padding = isMobile ? 12 : 40;
    const availW = rect.width - padding * 2;
    const availH = rect.height - padding * 2;
    const fitScale = Math.min(availW / worldW, availH / worldH);
    const fitOffsetX = padding + (availW - worldW * fitScale) / 2;
    const fitOffsetY = padding + (availH - worldH * fitScale) / 2;
    const cX = rect.width / 2;
    const cY = rect.height / 2;
    const zoom = view.zoom;
    // Apply the user view: zoom about the canvas centre, then pan.
    const scale = fitScale * zoom;
    const offsetX = cX * (1 - zoom) + view.panX + zoom * fitOffsetX;
    const offsetY = cY * (1 - zoom) + view.panY + zoom * fitOffsetY;
    fitRef.current = {
      fitScale,
      offsetX: fitOffsetX,
      offsetY: fitOffsetY,
      worldW,
      worldH,
      cX,
      cY,
    };

    const toScreen = (pt: { x: number; y: number }) => ({
      x: offsetX + (pt.x - minX) * scale,
      y: offsetY + (pt.y - minY) * scale,
    });

    // Build a section → color lookup for glyph rendering
    const sectionColorLookup = new Map<string, string>();
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      sectionColorLookup.set(
        section.sectionId,
        getSectionColor(
          sectionColorCache.current,
          section.sectionId,
          i,
          section.color,
        ),
      );
    }

    // Draw each section polygon
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const polygons = section.geometry?.polygons ?? [];
      const color =
        sectionColorLookup.get(section.sectionId) ?? FALLBACK_SEAT_COLOR;
      const isSelected = selectedSectionId === section.sectionId;
      const assignedTts = sectionAssignments.get(section.sectionId);
      const hasAssignment = assignedTts && assignedTts.length > 0;

      for (const poly of polygons) {
        if (poly.length < 3) continue;

        ctx.beginPath();
        const first = toScreen(poly[0]!);
        ctx.moveTo(first.x, first.y);
        for (let j = 1; j < poly.length; j++) {
          const pt = toScreen(poly[j]!);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();

        // Fill — lighter when glyphs are visible so dots stand out
        const hasGlyphs = glyphs != null && glyphs.length > 0;
        ctx.globalAlpha = isSelected
          ? hasGlyphs
            ? 0.25
            : 0.5
          : hasAssignment
            ? hasGlyphs
              ? 0.12
              : 0.35
            : hasGlyphs
              ? 0.06
              : 0.15;
        ctx.fillStyle = color;
        ctx.fill();

        // Stroke
        ctx.globalAlpha = 1;
        ctx.strokeStyle = isSelected ? color : hasAssignment ? color : "#666";
        ctx.lineWidth = isSelected ? 3 : 1.5;
        ctx.stroke();
      }

      // Draw label at centroid
      if (polygons.length > 0 && polygons[0]!.length >= 3) {
        const poly = polygons[0]!;
        let cx = 0,
          cy = 0;
        for (const pt of poly) {
          cx += pt.x;
          cy += pt.y;
        }
        cx /= poly.length;
        cy /= poly.length;
        const screenCenter = toScreen({ x: cx, y: cy });

        ctx.globalAlpha = 1;
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 3;
        ctx.strokeText(section.label, screenCenter.x, screenCenter.y);
        ctx.fillText(section.label, screenCenter.x, screenCenter.y);

        // Show assigned ticket type name below
        if (hasAssignment) {
          ctx.font = "11px system-ui, sans-serif";
          const ttLabel = assignedTts!.map((at) => at.name).join(", ");
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = 2;
          ctx.strokeText(ttLabel, screenCenter.x, screenCenter.y + 18);
          ctx.fillStyle = "#ddd";
          ctx.fillText(ttLabel, screenCenter.x, screenCenter.y + 18);
        }
      }
    }

    // ── Draw seat glyphs ───────────────────────────────────────────────

    if (glyphs && glyphs.length > 0) {
      ctx.globalAlpha = 1;
      for (const glyph of glyphs) {
        const color =
          sectionColorLookup.get(glyph.sectionId) ?? FALLBACK_SEAT_COLOR;
        const r = (glyph.radius ?? DEFAULT_SEAT_RADIUS) * scale;
        // Clamp rendered radius so dots stay visible at fit but keep
        // growing as the user zooms in.
        const renderR = Math.max(1.5, Math.min(r, 8 * zoom));
        const pos = toScreen(glyph.position);

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, renderR, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(color, 0.7);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 1);
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    } else {
      // Synthesize a seat dot grid per section from bbox + capacity when no
      // glyph blob exists. Matches the SeatMapPicker / PlaceLayoutCanvas
      // behavior so seeded layouts visualize seat density consistently.
      ctx.globalAlpha = 1;
      for (const section of sections) {
        const polygon = section.geometry?.polygons?.[0];
        if (!polygon || polygon.length < 3) continue;
        const xs = polygon.map((p) => p.x);
        const ys = polygon.map((p) => p.y);
        const bx = Math.min(...xs);
        const by = Math.min(...ys);
        const bw = Math.max(...xs) - bx;
        const bh = Math.max(...ys) - by;
        const color =
          sectionColorLookup.get(section.sectionId) ?? FALLBACK_SEAT_COLOR;

        const aspect = bw / Math.max(bh, 1);
        const cols = Math.max(
          1,
          Math.round(Math.sqrt(section.capacity * aspect)),
        );
        const rows = Math.max(1, Math.ceil(section.capacity / cols));
        const cellW = bw / cols;
        const cellH = bh / rows;
        const cellMin = Math.min(cellW, cellH);
        const renderR = Math.max(
          1.5,
          Math.min(cellMin * 0.32 * scale, 8 * zoom),
        );

        let drawn = 0;
        ctx.fillStyle = hexToRgba(color, 0.7);
        ctx.strokeStyle = hexToRgba(color, 1);
        ctx.lineWidth = 0.5;
        for (let r0 = 0; r0 < rows && drawn < section.capacity; r0++) {
          for (let c = 0; c < cols && drawn < section.capacity; c++) {
            const wx = bx + cellW * (c + 0.5);
            const wy = by + cellH * (r0 + 0.5);
            const pos = toScreen({ x: wx, y: wy });
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, renderR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            drawn++;
          }
        }
      }
    }

    // ── Seat count overlay ─────────────────────────────────────────────

    const totalSeats = glyphs
      ? glyphs.length
      : sections.reduce((sum, s) => sum + s.capacity, 0);
    if (totalSeats > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${totalSeats.toLocaleString()} seats`, 8, rect.height - 8);
    }

    // ── Hit testing for canvas clicks ──────────────────────────────────

    function handleCanvasClick(e: MouseEvent) {
      // Ignore the click that concludes a pan/pinch gesture.
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const canvasEl = canvasRef.current;
      if (!canvasEl) return;
      const r = canvasEl.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;

      // Convert screen to world
      const worldX = (mx - offsetX) / scale + minX;
      const worldY = (my - offsetY) / scale + minY;

      // Point-in-polygon test for each section
      for (const section of sections) {
        const polygons = section.geometry?.polygons ?? [];
        for (const poly of polygons) {
          if (pointInPoly(worldX, worldY, poly)) {
            handleSectionClick(section.sectionId);
            return;
          }
        }
      }

      // Clicked outside all sections: deselect
      setSelectedSectionId(null);
    }

    canvas.addEventListener("click", handleCanvasClick);
    return () => canvas.removeEventListener("click", handleCanvasClick);
  }, [
    sections,
    selectedSectionId,
    sectionAssignments,
    handleSectionClick,
    glyphs,
    layoutQuery.data,
    view,
    isMobile,
    resizeTick,
  ]);

  // Resize observer for canvas
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      setResizeTick((tick) => tick + 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Canvas zoom / pan ────────────────────────────────────────────────

  /** Clamp pan so the canvas centre always stays over the layout. */
  const clampPan = useCallback(
    (
      panX: number,
      panY: number,
      zoom: number,
    ): { panX: number; panY: number } => {
      const fit = fitRef.current;
      if (!fit) return { panX, panY };
      const clamp = (v: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, v));
      const fMaxX = fit.offsetX + fit.worldW * fit.fitScale;
      const fMaxY = fit.offsetY + fit.worldH * fit.fitScale;
      return {
        panX: clamp(
          panX,
          -zoom * (fMaxX - fit.cX),
          zoom * (fit.cX - fit.offsetX),
        ),
        panY: clamp(
          panY,
          -zoom * (fMaxY - fit.cY),
          zoom * (fit.cY - fit.offsetY),
        ),
      };
    },
    [],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      setView((v) => {
        const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
        if (zoom === v.zoom) return v;
        // Anchor at the canvas centre: pan scales with the zoom ratio.
        const ratio = zoom / v.zoom;
        return { zoom, ...clampPan(v.panX * ratio, v.panY * ratio, zoom) };
      });
    },
    [clampPan],
  );

  const fitView = useCallback(() => {
    setView({ zoom: 1, panX: 0, panY: 0 });
  }, []);

  // ── Touch gestures: single-finger pan, two-finger pinch ─────────────
  // Tap-to-select still works — taps under the 8px slop fall through to
  // the native click handler; real pans/pinches suppress it.

  const handleCanvasTouchStart = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      if (e.touches.length >= 2) {
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        gestureRef.current = {
          mode: "pinch",
          startX: 0,
          startY: 0,
          lastX: (a.clientX + b.clientX) / 2,
          lastY: (a.clientY + b.clientY) / 2,
          moved: true,
          startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          startZoom: viewRef.current.zoom,
        };
        suppressClickRef.current = true;
      } else if (e.touches.length === 1) {
        const t0 = e.touches[0]!;
        gestureRef.current = {
          mode: "pan",
          startX: t0.clientX,
          startY: t0.clientY,
          lastX: t0.clientX,
          lastY: t0.clientY,
          moved: false,
          startDist: 0,
          startZoom: viewRef.current.zoom,
        };
        suppressClickRef.current = false;
      }
    },
    [],
  );

  const handleCanvasTouchMove = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      if (gesture.mode === "pinch" && e.touches.length >= 2) {
        const a = e.touches[0]!;
        const b = e.touches[1]!;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;
        const canvasEl = canvasRef.current;
        const fit = fitRef.current;
        if (!canvasEl || !fit || gesture.startDist <= 0) return;
        const rect = canvasEl.getBoundingClientRect();
        const mx = midX - rect.left;
        const my = midY - rect.top;
        const midDx = midX - gesture.lastX;
        const midDy = midY - gesture.lastY;
        gesture.lastX = midX;
        gesture.lastY = midY;
        setView((v) => {
          const zoom = Math.max(
            MIN_ZOOM,
            Math.min(MAX_ZOOM, gesture.startZoom * (dist / gesture.startDist)),
          );
          // Anchor the zoom at the pinch midpoint, then follow midpoint drag:
          // pan' = pan + (z - z') * (m - C - pan) / z + Δmid
          const panX =
            v.panX +
            ((v.zoom - zoom) * (mx - fit.cX - v.panX)) / v.zoom +
            midDx;
          const panY =
            v.panY +
            ((v.zoom - zoom) * (my - fit.cY - v.panY)) / v.zoom +
            midDy;
          return { zoom, ...clampPan(panX, panY, zoom) };
        });
        return;
      }

      if (gesture.mode === "pan" && e.touches.length === 1) {
        const t0 = e.touches[0]!;
        if (
          !gesture.moved &&
          Math.hypot(t0.clientX - gesture.startX, t0.clientY - gesture.startY) >
            TAP_SLOP_PX
        ) {
          gesture.moved = true;
          suppressClickRef.current = true;
        }
        if (!gesture.moved) return;
        const dx = t0.clientX - gesture.lastX;
        const dy = t0.clientY - gesture.lastY;
        gesture.lastX = t0.clientX;
        gesture.lastY = t0.clientY;
        setView((v) => ({
          zoom: v.zoom,
          ...clampPan(v.panX + dx, v.panY + dy, v.zoom),
        }));
      }
    },
    [clampPan],
  );

  const handleCanvasTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      if (e.touches.length === 0) gestureRef.current = null;
    },
    [],
  );

  // ── Mouse drag-pan (desktop) ─────────────────────────────────────────
  // The zoom buttons render on desktop too, so a mouse user needs a way to
  // reach corner sections at high zoom. Same 8px slop as touch: drags under
  // it fall through to the native click handler (section select), real
  // drags suppress it. Touch pointers are ignored — gestureRef owns those.

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      mousePanRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      suppressClickRef.current = false;
      setIsMousePanning(true);
    },
    [],
  );

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType !== "mouse") return;
      const drag = mousePanRef.current;
      if (!drag) return;
      if (
        !drag.moved &&
        Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >
          TAP_SLOP_PX
      ) {
        drag.moved = true;
        suppressClickRef.current = true;
      }
      if (!drag.moved) return;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      setView((v) => ({
        zoom: v.zoom,
        ...clampPan(v.panX + dx, v.panY + dy, v.zoom),
      }));
    },
    [clampPan],
  );

  const handleCanvasPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType !== "mouse") return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer may not be captured (e.g. cancel) */
      }
      mousePanRef.current = null;
      setIsMousePanning(false);
    },
    [],
  );

  // ── Loading states ───────────────────────────────────────────────────

  if (layoutQuery.isLoading || ticketTypesQuery.isLoading) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" padding={32}>
        <Text variant="body" tone="muted">
          {String(t("admin.slLoading"))}
        </Text>
      </YStack>
    );
  }

  if (layoutQuery.isError || !layoutQuery.data) {
    return (
      <YStack
        flex={1}
        justifyContent="center"
        alignItems="center"
        padding={32}
        gap={8}
      >
        <Text variant="body" tone="muted">
          {String(t("admin.slErrorTitle"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("admin.slErrorHint"))}
        </Text>
      </YStack>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────

  const sidebarContent = (
    <>
      <SidebarSection>
        <SidebarLabel>{String(t("admin.slSections"))}</SidebarLabel>
        <Text variant="caption" tone="muted">
          {String(t("admin.slSectionsHint"))}
        </Text>
      </SidebarSection>

      {sections.map((section, idx) => {
        const color = getSectionColor(
          sectionColorCache.current,
          section.sectionId,
          idx,
          section.color,
        );
        const isSelected = selectedSectionId === section.sectionId;
        const isExpanded = expandedSections.has(section.sectionId);
        const assignedTts = sectionAssignments.get(section.sectionId) ?? [];

        return (
          <YStack key={section.sectionId}>
            <SectionCard
              selected={isSelected}
              onPress={() => {
                handleSectionClick(section.sectionId);
                handleToggleSection(section.sectionId);
              }}
              data-testid={`section-card-${section.sectionId}`}
            >
              <ColorDot backgroundColor={color} />
              <YStack flex={1} gap={2}>
                <Text
                  style={{ fontSize: 14, fontWeight: "700" }}
                  color="$color"
                >
                  {section.label}
                </Text>
                <Text style={{ fontSize: 11 }} tone="muted">
                  {String(t("admin.slSeats", { count: section.capacity }))}
                  {assignedTts.length > 0
                    ? ` \u00b7 ${assignedTts.map((at) => at.name).join(", ")}`
                    : ""}
                </Text>
              </YStack>
              {isExpanded ? (
                <ChevronDown size={14} color={theme.colorMuted?.val} />
              ) : (
                <ChevronRight size={14} color={theme.colorMuted?.val} />
              )}
            </SectionCard>

            {/* Assignment dropdown — shown when section is expanded */}
            {isExpanded && (
              <YStack
                paddingLeft={24}
                paddingVertical={4}
                borderLeftWidth={2}
                borderLeftColor={color}
                marginLeft={16}
              >
                <Text
                  variant="overline"
                  tone="muted"
                  style={{
                    marginBottom: 4,
                    paddingLeft: 8,
                  }}
                >
                  {String(t("admin.slAssignTicketType"))}
                </Text>

                {/* Unassign option */}
                <TicketTypeOption
                  active={assignedTts.length === 0}
                  onPress={() => {
                    // Unassign all ticket types from this section
                    for (const tt of ticketTypes) {
                      const currentSection = effectiveAssignments.get(tt.id);
                      if (currentSection === section.sectionId) {
                        handleAssignTicketType(tt.id, null);
                      }
                    }
                  }}
                >
                  {assignedTts.length === 0 && (
                    <Check size={12} color={theme.color?.val} />
                  )}
                  <Text
                    style={{ fontSize: 13 }}
                    color={assignedTts.length === 0 ? "$color" : "$colorMuted"}
                  >
                    {String(t("admin.slNoneUnassigned"))}
                  </Text>
                </TicketTypeOption>

                {ticketTypes.map((tt) => {
                  const isAssigned =
                    effectiveAssignments.get(tt.id) === section.sectionId;
                  const assignedElsewhere = effectiveAssignments.get(tt.id);
                  const otherSection =
                    assignedElsewhere && assignedElsewhere !== section.sectionId
                      ? sections.find((s) => s.sectionId === assignedElsewhere)
                      : null;

                  return (
                    <TicketTypeOption
                      key={tt.id}
                      active={isAssigned}
                      onPress={() =>
                        handleAssignTicketType(
                          tt.id,
                          isAssigned ? null : section.sectionId,
                        )
                      }
                    >
                      {isAssigned && (
                        <Check size={12} color={theme.color?.val} />
                      )}
                      <YStack flex={1} gap={1}>
                        <Text
                          style={{ fontSize: 13 }}
                          color={isAssigned ? "$color" : "$colorMuted"}
                        >
                          {tt.name}
                        </Text>
                        <Text style={{ fontSize: 11 }} tone="muted">
                          {tt.priceCents === 0
                            ? String(t("admin.slFree"))
                            : fmtCurrency(fmt, tt.priceCents, currency)}{" "}
                          ·{" "}
                          {String(t("admin.slCapacity", { cap: tt.capacity }))}
                          {otherSection
                            ? ` · ${String(t("admin.slCurrently", { label: otherSection.label }))}`
                            : ""}
                        </Text>
                      </YStack>
                    </TicketTypeOption>
                  );
                })}
              </YStack>
            )}
          </YStack>
        );
      })}

      {/* Paint mode controls */}
      <SidebarSection>
        <SidebarLabel>{String(t("admin.slPaintMode"))}</SidebarLabel>
        <Text variant="caption" tone="muted">
          {String(t("admin.slPaintHint"))}
        </Text>
        <YStack gap={4}>
          {ticketTypes.map((tt) => (
            <Button
              key={tt.id}
              variant={paintTicketTypeId === tt.id ? "primary" : "ghost"}
              size="$2"
              onPress={() => handleTogglePaintMode(tt.id)}
              data-testid={`paint-btn-${tt.id}`}
            >
              <Paintbrush size={12} aria-hidden />
              {tt.name}
            </Button>
          ))}
        </YStack>
      </SidebarSection>
    </>
  );

  const canvasContent = (
    <>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: isMobile ? 280 : 400,
          height: isMobile ? "45vh" : undefined,
          position: "relative",
          cursor: paintTicketTypeId ? "crosshair" : "default",
        }}
      >
        <canvas
          ref={canvasRef}
          onTouchStart={handleCanvasTouchStart}
          onTouchMove={handleCanvasTouchMove}
          onTouchEnd={handleCanvasTouchEnd}
          onTouchCancel={handleCanvasTouchEnd}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            touchAction: "none",
            cursor: paintTicketTypeId
              ? "crosshair"
              : !isMobile && view.zoom > 1
                ? isMousePanning
                  ? "grabbing"
                  : "grab"
                : "default",
          }}
        />

        {/* Zoom controls (44px touch targets) */}
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 10,
            display: "flex",
            flexDirection: "column",
            border: `1px solid ${theme.borderColor?.val ?? "#2A3E66"}`,
            background: theme.surface?.val ?? "#162240",
          }}
        >
          {[
            {
              key: "in",
              icon: <Plus size={18} />,
              action: () => zoomBy(1.4),
              label: String(t("checkout.zoomIn")),
            },
            {
              key: "out",
              icon: <Minus size={18} />,
              action: () => zoomBy(1 / 1.4),
              label: String(t("checkout.zoomOut")),
            },
            {
              key: "fit",
              icon: <Maximize2 size={16} />,
              action: fitView,
              label: String(t("checkout.zoomReset")),
            },
          ].map((btn, i) => (
            <button
              key={btn.key}
              type="button"
              onClick={btn.action}
              aria-label={btn.label}
              title={btn.label}
              style={{
                width: 44,
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                borderTop:
                  i > 0
                    ? `1px solid ${theme.borderColor?.val ?? "#2A3E66"}`
                    : "none",
                borderRadius: 0,
                color: theme.color?.val ?? "#ffffff",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {btn.icon}
            </button>
          ))}
        </div>
      </div>

      {/* Paint mode indicator */}
      {paintTicketTypeId && (
        <XStack
          position="absolute"
          top={12}
          left="50%"
          transform="translateX(-50%)"
          backgroundColor="$brandSecondaryHover"
          paddingHorizontal={16}
          paddingVertical={8}
          gap={8}
          alignItems="center"
          zIndex={10}
        >
          <Paintbrush size={14} color="var(--onBrandSecondary, #FFFFFF)" />
          <Text
            style={{ fontSize: 13, fontWeight: "700" }}
            color="$colorInverted"
          >
            {String(
              t("admin.slPainting", {
                name: ticketTypes.find((tt) => tt.id === paintTicketTypeId)
                  ?.name,
              }),
            )}
          </Text>
          <Button
            variant="ghostInverted"
            size="$1"
            onPress={() => setPaintTicketTypeId(null)}
          >
            {String(t("admin.slExit"))}
          </Button>
        </XStack>
      )}
    </>
  );

  const Wrapper = isMobile ? MobileEditorContainer : EditorContainer;
  const SidebarContainer = isMobile ? MobileSidebar : Sidebar;
  const Canvas = isMobile ? MobileCanvasArea : CanvasArea;

  return (
    <YStack flex={1}>
      <Wrapper>
        {/* On mobile: canvas first, sidebar below. On desktop: sidebar left, canvas right. */}
        {isMobile ? (
          <>
            <Canvas>{canvasContent}</Canvas>
            <SidebarContainer>{sidebarContent}</SidebarContainer>
          </>
        ) : (
          <>
            <SidebarContainer>{sidebarContent}</SidebarContainer>
            <Canvas>{canvasContent}</Canvas>
          </>
        )}
      </Wrapper>

      {/* Bottom bar with save / discard */}
      <Legend>
        <XStack gap={12} alignItems="center" flex={1}>
          <XStack gap={4} alignItems="center">
            <YStack
              width={10}
              height={10}
              backgroundColor="rgba(74,144,210,0.35)"
              borderWidth={1}
              borderColor="#4A90D2"
            />
            <Text style={{ fontSize: 11 }} tone="muted">
              {String(t("admin.slAssigned"))}
            </Text>
          </XStack>
          <XStack gap={4} alignItems="center">
            <YStack
              width={10}
              height={10}
              backgroundColor="rgba(100,100,100,0.15)"
              borderWidth={1}
              borderColor="#666"
            />
            <Text style={{ fontSize: 11 }} tone="muted">
              {String(t("admin.slUnassigned"))}
            </Text>
          </XStack>
        </XStack>

        {hasUnsavedChanges && (
          <XStack gap={8} alignItems="center" flexWrap="wrap">
            <Badge tone="warning" size="sm">
              {String(
                t("admin.slUnsaved", {
                  count: Object.keys(localAssignments).length,
                }),
              )}
            </Badge>
            <Button
              variant="ghost"
              size="$2"
              onPress={handleDiscardChanges}
              data-testid="seating-discard-btn"
            >
              <Undo2 size={12} aria-hidden />
              {String(t("admin.slDiscard"))}
            </Button>
            <Button
              variant="primary"
              size="$2"
              onPress={handleSave}
              disabled={assignMutation.isPending}
              data-testid="seating-save-btn"
            >
              <Check size={12} aria-hidden />
              {assignMutation.isPending
                ? String(t("admin.slSaving"))
                : String(t("admin.slSaveAssignments"))}
            </Button>
          </XStack>
        )}
      </Legend>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helper
// ─────────────────────────────────────────────────────────────────────────────

function pointInPoly(
  x: number,
  y: number,
  polygon: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x,
      yi = polygon[i]!.y;
    const xj = polygon[j]!.x,
      yj = polygon[j]!.y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
