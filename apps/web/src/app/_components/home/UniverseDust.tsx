"use client";

import { useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";

import { isPrintDocumentRoute } from "@/lib/print-route";
import { isUnderPath } from "@/middleware/path-match";

/* ─── Config ────────────────────────────────────────────────────────────── */

/**
 * Base count before device-capability scaling.
 * `getParticleCount()` halves this on mobile / low-core devices.
 */
const BASE_PARTICLE_COUNT = 500;
const RESIZE_DEBOUNCE_MS = 200;

/** Flow-field / twinkle time advance per animated frame (matches prototype). */
const TIME_STEP = 0.0016;

/** Bright cohort — larger, brighter, carries the 4-point cross sparkle. */
const BRIGHT_CHANCE = 0.07;
/** Rare warm accent specks (~4.5% of the non-bright cohort — respects the ≤5% accent budget). */
const ACCENT_CHANCE = 0.045;
/** Punched ticket-disc rings instead of filled dots. */
const CONFETTI_CHANCE = 0.02;
/** Grains that draw a short flow-aligned trail. */
const TRAIL_CHANCE = 0.34;
/** Grains that carry a soft radial halo (bright stars always do). */
const HALO_CHANCE = 0.12;

const SIZE_MIN = 0.55;
const SIZE_MAX = 2.3;
const TWINKLE_SPEED_MIN = 0.006;
const TWINKLE_SPEED_MAX = 0.016;
/** Finite lifespan (frames) → fade in/out + uniform respawn keeps grain coverage even. */
const LIFE_MIN = 320;
const LIFE_MAX = 760;

const PARTICLE_PARALLAX_FACTOR = 0.032;
const SCROLL_EASING = 0.08;

const TAU = Math.PI * 2;

/* ─── Theme palettes ────────────────────────────────────────────────────── */

type Rgb = readonly [number, number, number];

interface DustPalette {
  /**
   * Speck colours — MUST be the same length in every palette so a particle's
   * `colorIndex` stays valid when the theme swaps mid-flight.
   */
  specks: readonly Rgb[];
  /** Rare accent speck colour (the theme's orange). */
  accent: Rgb;
  /** Registration / crop-mark + perforation ink colour. */
  mark: Rgb;
  /** Crop-mark & registration-crosshair stroke alpha. */
  markAlpha: number;
  /** Ticket-perforation dotted tear-line alpha. */
  perfAlpha: number;
  /**
   * Per-theme speck opacity multiplier — dark-on-light needs a nudge to read
   * as strongly as light-on-dark at the same alpha.
   */
  opacityMult: number;
}

/** Every palette must expose exactly this many speck colours (see `colorIndex`). */
const SPECK_COLOR_COUNT = 3;

// Hex values below mirror the canonical theme palettes in
// packages/ui/src/ui/tamagui/tokens/colors.ts (stubTheme / ember darkTheme).
// They are literal here because this is a <canvas> 2D context — canvas
// fillStyle/strokeStyle cannot resolve CSS `var()` custom properties.

/** Ember (navy #0F1B33 canvas) — gold print grain + #FF5721 accent. */
const EMBER_PALETTE: DustPalette = {
  specks: [
    [0xab, 0x86, 0x49], // #AB8649 gold
    [0xae, 0x88, 0x4d], // #AE884D gold
    [0xe7, 0xce, 0x96], // #E7CE96 pale gold
  ],
  accent: [0xff, 0x57, 0x21], // #FF5721 — ember accent (colors.ts darkTheme.accent)
  mark: [0xe7, 0xce, 0x96], // #E7CE96 pale gold — print furniture on navy
  markAlpha: 0.1,
  perfAlpha: 0.06,
  opacityMult: 1,
};

/** Stub (warm cream #F6F0E4 canvas) — warm-ink print grain + #E2481D accent. */
const STUB_PALETTE: DustPalette = {
  specks: [
    [0x21, 0x1c, 0x16], // #211C16 ink (colors.ts stubTheme.color)
    [0x5c, 0x54, 0x4a], // #5C544A warm muted ink (stubTheme.colorMuted)
    [0x8a, 0x7a, 0x5f], // #8A7A5F sepia mid — canvas-only tint between ink and cream
  ],
  accent: [0xe2, 0x48, 0x1d], // #E2481D — burnt orange (stubTheme.accent)
  mark: [0x21, 0x1c, 0x16], // #211C16 ink — print furniture on cream
  markAlpha: 0.11,
  perfAlpha: 0.07,
  opacityMult: 1.15,
};

/**
 * Resolve the active palette from `<html data-theme="…">` (set at SSR by the
 * root layout, updated live by AppThemeProvider). Stub is the shipped default
 * and the safe fallback for any unknown/missing value.
 */
const resolvePalette = (): DustPalette =>
  document.documentElement.dataset.theme === "ember"
    ? EMBER_PALETTE
    : STUB_PALETTE;

/**
 * Determine a reasonable particle count for this device.
 * Mobile viewports and machines with few logical cores get half the base count
 * to keep GPU/CPU overhead low on phones and budget laptops.
 */
const getParticleCount = (): number => {
  const isMobileViewport =
    typeof window !== "undefined" && window.innerWidth < 768;
  const lowCores =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number" &&
    navigator.hardwareConcurrency <= 4;

  return isMobileViewport || lowCores
    ? Math.round(BASE_PARTICLE_COUNT * 0.5)
    : BASE_PARTICLE_COUNT;
};

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface Particle {
  x: number;
  y: number;
  size: number;
  /** Normalized size (0…1) — bigger grains drift a touch faster (parallax). */
  depth: number;
  /** Base opacity before density / twinkle / life modulation. */
  baseOpacity: number;
  twinklePhase: number;
  twinkleSpeed: number;
  /** Index into the active palette's `specks` (same length in every theme). */
  colorIndex: number;
  /** Rare warm speck drawn in the theme's accent orange. */
  isAccent: boolean;
  /** Bright cohort — larger, brighter, and carries the 4-point cross sparkle. */
  isBright: boolean;
  /** Punched ticket-disc ring instead of a filled dot. */
  isConfetti: boolean;
  hasHalo: boolean;
  hasTrail: boolean;
  /** Current age in advanced frames; respawns uniformly when it reaches maxLife. */
  life: number;
  maxLife: number;
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

const rand = (min: number, max: number) => Math.random() * (max - min) + min;

const mod = (value: number, base: number) => ((value % base) + base) % base;

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

const wrapDrawCoordinate = (value: number, limit: number, padding: number) => {
  const span = limit + padding * 2;
  return mod(value + padding, span) - padding;
};

/**
 * Coherent flow field — one shared vector field, so the whole grain field
 * drifts like a slow current rather than each speck wandering randomly.
 */
const flowAngle = (x: number, y: number, t: number) => {
  const a =
    Math.sin(x * 0.0055 + t) +
    Math.cos(y * 0.0065 - t * 0.7) +
    Math.sin(x * 0.003 + y * 0.004 + t * 0.4);
  return a * 0.9;
};

/**
 * Large soft tonal field — modulates grain size + opacity so density
 * "breathes" in patches (the halftone tell).
 */
const densityField = (x: number, y: number) =>
  clamp(
    0.5 +
      0.34 * Math.sin(x * 0.006 + 1.3) * Math.cos(y * 0.007 - 0.6) +
      0.16 * Math.sin(x * 0.013 - 0.4) * Math.sin(y * 0.011 + 0.9),
    0,
    1,
  );

/** Life envelope: fade in over the first 12%, hold, fade out over the last 22%. */
const lifeAlpha = (p: Particle) => {
  const f = p.life / p.maxLife;
  if (f < 0.12) return f / 0.12;
  if (f > 0.78) return (1 - f) / 0.22;
  return 1;
};

/**
 * Registration / crop marks at the corners of an inset print area, plus one
 * registration crosshair at top center — replaces the old full lattice with
 * sparse Swiss print structure. Anchored (no scroll parallax): print furniture
 * reads better fixed to the frame.
 */
const drawMarks = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  palette: DustPalette,
) => {
  const ix = Math.round(w * 0.06);
  const iy = Math.round(h * 0.09);
  const len = 14;
  const gap = 6;
  const [r, g, b] = palette.mark;

  ctx.save();
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${palette.markAlpha})`;
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";

  const corner = (cx: number, cy: number, sx: number, sy: number) => {
    ctx.beginPath();
    ctx.moveTo(cx + sx * gap, cy);
    ctx.lineTo(cx + sx * (gap + len), cy);
    ctx.moveTo(cx, cy + sy * gap);
    ctx.lineTo(cx, cy + sy * (gap + len));
    ctx.stroke();
  };
  corner(ix, iy, 1, 1);
  corner(w - ix, iy, -1, 1);
  corner(ix, h - iy, 1, -1);
  corner(w - ix, h - iy, -1, -1);

  // Registration crosshair, top center — one small target.
  const cx = Math.round(w / 2);
  const cy = iy;
  const radius = 5;
  ctx.beginPath();
  ctx.moveTo(cx - radius - 3, cy);
  ctx.lineTo(cx + radius + 3, cy);
  ctx.moveTo(cx, cy - radius - 3);
  ctx.lineTo(cx, cy + radius + 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.stroke();
  ctx.restore();
};

/** A single faint ticket-perforation tear line — the hint of the stub motif. */
const drawPerforation = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  palette: DustPalette,
) => {
  const [r, g, b] = palette.mark;
  const y = Math.round(h * 0.66);
  const ix = Math.round(w * 0.06);
  const step = 11;

  ctx.save();
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${palette.perfAlpha})`;
  for (let x = ix; x <= w - ix; x += step) {
    ctx.beginPath();
    ctx.arc(x, y, 0.9, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

const createParticle = (w: number, h: number): Particle => {
  const isBright = Math.random() < BRIGHT_CHANCE;
  // Accent specks stay small-to-mid and never join the bright cohort — a
  // sparse warm signal, not a headline.
  const isAccent = !isBright && Math.random() < ACCENT_CHANCE;
  // Punched-disc confetti — a small ring, distinct from bright & accent.
  const isConfetti = !isBright && !isAccent && Math.random() < CONFETTI_CHANCE;
  const size = isBright ? rand(1.4, SIZE_MAX) : rand(SIZE_MIN, 1.5);
  // Depth: smaller grains sit "further back" and drift a touch slower, so the
  // field reads with parallax depth.
  const depth = clamp((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN), 0, 1);
  const maxLife = rand(LIFE_MIN, LIFE_MAX);

  return {
    x: Math.random() * w,
    y: Math.random() * h,
    size,
    depth,
    baseOpacity: rand(0.1, isBright ? 0.5 : 0.34),
    twinklePhase: Math.random() * TAU,
    twinkleSpeed: rand(TWINKLE_SPEED_MIN, TWINKLE_SPEED_MAX),
    colorIndex: Math.floor(Math.random() * SPECK_COLOR_COUNT),
    isAccent,
    isBright,
    isConfetti,
    hasHalo: isBright || Math.random() < HALO_CHANCE,
    hasTrail: Math.random() < TRAIL_CHANCE,
    // Random initial age so the field doesn't fade in/out in lockstep.
    life: Math.random() * maxLife,
    maxLife,
  };
};

/* ─── Component ─────────────────────────────────────────────────────────── */

/**
 * Renders a subtle, animated print-grain canvas overlay behind the home page.
 *
 * Concept: newsprint / riso grain riding a slow coherent flow field. Many small
 * specks, their size + opacity modulated by a slow large-scale density field so
 * coverage gently "breathes" in patches (the halftone tell). A shared flow field
 * drifts the whole field like a slow current; finite per-grain lifespans fade
 * in/out and respawn uniformly so the flow never advects the field onto its
 * streamlines and depletes the canvas. Sparse Swiss print furniture — corner
 * crop marks, a registration crosshair, and one faint ticket-perforation tear
 * line — replaces the old lattice. A small share of grains render as punched
 * ticket-disc rings.
 *
 * Theme-aware: warm-ink grain on Stub (cream), gold grain on Ember (navy). A
 * rare accent cohort glints in the theme's orange, and bright grains carry a
 * faint 4-point registration sparkle.
 *
 * Performance:
 * - Particle count is halved on mobile viewports and low-core devices.
 * - Animation pauses when the tab is hidden (`visibilitychange`).
 * - Animation pauses when the canvas scrolls out of view (`IntersectionObserver`).
 * - Resize is debounced to avoid thrashing during drag-resizes.
 * - Theme check + palette selection are hoisted outside the per-particle loop.
 * - Theme toggles swap the palette in place (MutationObserver on `data-theme`)
 *   without re-initializing particles, so the switch feels seamless.
 *
 * The canvas is absolutely positioned and non-interactive (pointer-events: none).
 */
/**
 * Route prefixes that render an opaque application shell over the whole
 * viewport (admin, platform ops, moderation, seller). The backdrop is invisible
 * there, and because the canvas is `position: fixed` the IntersectionObserver
 * below can NEVER pause it — a fixed element is always "in view" — so without
 * this gate the rAF loop burns main-thread time on every click in those dense
 * surfaces. Marketing, auth and consumer routes are unaffected (particle state
 * still persists across sign-in ↔ home, which is why this lives in the root
 * layout).
 *
 * `/embed` is here for a stronger reason than "invisible anyway": those pages
 * render INSIDE a third-party iframe. Our decorative branding has no business
 * drifting across someone else's site — they style the widget through the
 * `--hf-*` theme overrides, and a starfield we inject over their page is not
 * something they opted into. The perf argument is also worse here than on the
 * app shells: an embed is a small iframe the host may mount several of, each
 * one running an unpausable rAF loop on their page, not ours.
 */
const OPAQUE_SHELL_ROUTES = [
  "/admin",
  "/platform",
  "/sell",
  "/moderate",
  "/embed",
];

export const UniverseDust = () => {
  const pathname = usePathname();
  const hiddenBehindAppShell =
    !!pathname &&
    OPAQUE_SHELL_ROUTES.some((prefix) => isUnderPath(pathname, prefix));

  // Printable documents (`…/print`). A <canvas> is REPLACED CONTENT, not a
  // background, so it prints — a decorative starfield would land on a ticket
  // sheet. Unmounting here rather than hiding it with a
  // `@media print { canvas { display: none } }` rule in the print stylesheet is
  // deliberate: Next does not unload a route's stylesheet on client-side
  // navigation, so that rule would outlive the print route and suppress every
  // canvas on any page the user visited next.
  if (isPrintDocumentRoute(pathname)) return null;

  if (hiddenBehindAppShell) return null;

  return <UniverseDustCanvas />;
};

UniverseDust.displayName = "UniverseDust";

const UniverseDustCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const prefersReducedMotionRef = useRef(false);
  const scrollTargetRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  /** Flow-field / twinkle clock — advanced only on animated frames. */
  const timeRef = useRef(0);
  /** Active theme palette — read by the rAF loop, swapped by the theme observer. */
  const paletteRef = useRef<DustPalette>(STUB_PALETTE);
  /** true while tab is visible AND canvas is in the viewport */
  const activeRef = useRef(true);

  const initParticles = useCallback((w: number, h: number) => {
    particlesRef.current = Array.from({ length: getParticleCount() }, () =>
      createParticle(w, h),
    );
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    paletteRef.current = resolvePalette();

    const readScrollY = () =>
      window.scrollY ||
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      0;

    let scrollListening = false;

    const onScroll = () => {
      scrollTargetRef.current = readScrollY();
    };

    const setScrollListening = (enabled: boolean) => {
      if (enabled && !scrollListening) {
        onScroll();
        scrollOffsetRef.current = scrollTargetRef.current;
        window.addEventListener("scroll", onScroll, { passive: true });
        scrollListening = true;
        return;
      }

      if (!enabled && scrollListening) {
        window.removeEventListener("scroll", onScroll);
        scrollListening = false;
      }

      if (!enabled) {
        scrollTargetRef.current = 0;
        scrollOffsetRef.current = 0;
      }
    };

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const syncReducedMotionPreference = () => {
      prefersReducedMotionRef.current = reducedMotionQuery.matches;
      setScrollListening(!reducedMotionQuery.matches);
    };

    /* ── Resize (debounced) ──────────────────────────────────────────── */

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const applyResize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement?.getBoundingClientRect();
      const w = rect?.width ?? window.innerWidth;
      const h = rect?.height ?? window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initParticles(w, h);
    };

    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyResize, RESIZE_DEBOUNCE_MS);
    };

    applyResize();
    window.addEventListener("resize", onResize);

    // Track parent layout changes — initial mount measurements during SPA
    // transitions can read a stale (taller) parent size, which would inflate
    // body scrollHeight and leave phantom space below the page footer.
    const parent = canvas.parentElement;
    const parentResizeObserver =
      parent && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(onResize)
        : null;
    if (parent && parentResizeObserver) {
      parentResizeObserver.observe(parent);
    }

    syncReducedMotionPreference();
    if (typeof reducedMotionQuery.addEventListener === "function") {
      reducedMotionQuery.addEventListener(
        "change",
        syncReducedMotionPreference,
      );
    } else {
      reducedMotionQuery.addListener(syncReducedMotionPreference);
    }

    /* ── Visibility / intersection gating ─────────────────────────────── */

    let tabVisible = !document.hidden;
    let inViewport = true;

    const reconcileActive = () => {
      const shouldRun = tabVisible && inViewport;
      if (shouldRun && !activeRef.current) {
        activeRef.current = true;
        rafRef.current = requestAnimationFrame(animate);
      } else if (!shouldRun) {
        activeRef.current = false;
        cancelAnimationFrame(rafRef.current);
      }
    };

    const onVisibility = () => {
      tabVisible = !document.hidden;
      reconcileActive();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const observer = new IntersectionObserver(
      ([entry]) => {
        inViewport = entry.isIntersecting;
        reconcileActive();
      },
      { threshold: 0 },
    );
    observer.observe(canvas);

    /* ── Theme observer ───────────────────────────────────────────────── */

    // Watch <html data-theme="…"> so a live appearance toggle recolours the
    // field in place — same particles, positions, and phases; only the
    // palette ref swaps. If the loop is paused (hidden tab / out of
    // viewport), force a single static repaint so the canvas doesn't show
    // stale colours when it becomes visible again.
    const themeObserver = new MutationObserver(() => {
      paletteRef.current = resolvePalette();
      if (!activeRef.current) renderFrame(false);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    /* ── Animation loop ───────────────────────────────────────────────── */

    /**
     * Draw one frame. When `advance` is false (paused repaint after a theme
     * swap), the flow clock, particle positions, lifespans, twinkle phases, and
     * scroll easing are all left untouched — the frame is redrawn as-is in the
     * new palette. Under prefers-reduced-motion the same holds every frame, so
     * the field renders static (no drift, no respawn popping, no twinkle).
     */
    const renderFrame = (advance: boolean) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      ctx.clearRect(0, 0, w, h);

      const palette = paletteRef.current;
      const { opacityMult } = palette;
      const prefersReducedMotion = prefersReducedMotionRef.current;
      const moving = advance && !prefersReducedMotion;

      if (moving) {
        timeRef.current += TIME_STEP;

        const scrollDelta = scrollTargetRef.current - scrollOffsetRef.current;
        if (Math.abs(scrollDelta) > 0.1) {
          scrollOffsetRef.current += scrollDelta * SCROLL_EASING;
        } else {
          scrollOffsetRef.current = scrollTargetRef.current;
        }
      }

      const t = timeRef.current;

      // Print furniture — anchored to the frame, no scroll parallax.
      drawMarks(ctx, w, h, palette);
      drawPerforation(ctx, w, h, palette);

      const particleParallaxY = prefersReducedMotion
        ? 0
        : scrollOffsetRef.current * PARTICLE_PARALLAX_FACTOR;

      for (const p of particlesRef.current) {
        // Flow direction at this grain — also used for the trail vector, so it
        // must be computed whether or not we advance (t is frozen when paused).
        const ang = flowAngle(p.x, p.y, t);

        if (moving) {
          // Age → respawn uniformly when spent (keeps coverage even).
          p.life++;
          if (p.life >= p.maxLife) {
            p.life = 0;
            p.x = Math.random() * w;
            p.y = Math.random() * h;
          }

          // Gentle nudge along the shared flow field (depth scales speed →
          // parallax). Weak on purpose — a coherent drift, not a current.
          const spd = 0.1 + 0.28 * p.depth;
          p.x += Math.cos(ang) * spd;
          p.y += Math.sin(ang) * spd * 0.7;
          if (p.x < -4) p.x = w + 4;
          if (p.x > w + 4) p.x = -4;
          if (p.y < -4) p.y = h + 4;
          if (p.y > h + 4) p.y = -4;

          p.twinklePhase += p.twinkleSpeed;
        }

        const d = densityField(p.x, p.y);
        const size = p.size + d * 0.85; // halftone tonal ramp
        const twinkle = 0.55 + 0.45 * ((Math.sin(p.twinklePhase) + 1) / 2);
        const op = clamp(
          p.baseOpacity *
            (0.35 + 0.95 * d) *
            twinkle *
            opacityMult *
            lifeAlpha(p),
          0,
          1,
        );
        if (op < 0.02) continue;

        const drawY = wrapDrawCoordinate(p.y + particleParallaxY, h, size + 4);

        const [r, g, b] = p.isAccent
          ? palette.accent
          : palette.specks[p.colorIndex];

        if (p.hasHalo && op > 0.14) {
          // Radial-gradient glow — subtle falloff, not a bokeh orb.
          const haloRadius = size * (p.isBright ? 3.2 : 2.2);
          const halo = ctx.createRadialGradient(
            p.x,
            drawY,
            0,
            p.x,
            drawY,
            haloRadius,
          );
          halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${op * 0.09})`);
          halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
          ctx.beginPath();
          ctx.arc(p.x, drawY, haloRadius, 0, TAU);
          ctx.fillStyle = halo;
          ctx.fill();
        }

        if (p.hasTrail && op > 0.12) {
          // Trail direction derives from the flow angle (no random velocity).
          const trailLen = 4 + 8 * p.depth;
          ctx.beginPath();
          ctx.moveTo(p.x, drawY);
          ctx.lineTo(
            p.x - Math.cos(ang) * trailLen,
            drawY - Math.sin(ang) * trailLen * 0.7,
          );
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${op * 0.28})`;
          ctx.lineWidth = Math.max(0.5, size * 0.55);
          ctx.lineCap = "round";
          ctx.stroke();
        }

        if (p.isBright) {
          // 4-point cross sparkle — thin perpendicular hairlines, reads as a
          // Swiss print registration mark rather than a lens flare.
          const arm = size * 3.2;
          ctx.beginPath();
          ctx.moveTo(p.x - arm, drawY);
          ctx.lineTo(p.x + arm, drawY);
          ctx.moveTo(p.x, drawY - arm);
          ctx.lineTo(p.x, drawY + arm);
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${op * 0.32})`;
          ctx.lineWidth = 0.6;
          ctx.lineCap = "butt";
          ctx.stroke();
        }

        if (p.isConfetti) {
          // Punched ticket disc — a small ring, not a filled dot.
          ctx.beginPath();
          ctx.arc(p.x, drawY, size * 1.6, 0, TAU);
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${op * 0.7})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, drawY, size, 0, TAU);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${op})`;
          ctx.fill();
        }
      }
    };

    /* ── View-transition gating ───────────────────────────────────────── */
    /**
     * During a same-document view transition the page is painted from STATIC
     * snapshots in the top layer, so this canvas is not what the user sees —
     * but rAF keeps firing underneath. Advancing the simulation through that
     * window meant the field jumped forward by the whole transition duration
     * the instant the snapshot lifted, which read as the dust flicking in and
     * out. Measured: ~121 draws/sec baseline, 14 draws during a 170ms
     * transition, and transitions into `/` run ~600ms in dev — i.e. up to ~70
     * frames of drift hidden behind the snapshot.
     *
     * So keep PAINTING (a blank frame would be worse) but stop ADVANCING, so
     * the live canvas still matches the snapshot when it is removed.
     *
     * `matches()` throws on a selector the browser doesn't know, so probe once
     * rather than per frame; unsupported browsers simply behave as before.
     */
    let supportsActiveViewTransition = false;
    try {
      document.documentElement.matches(":active-view-transition");
      supportsActiveViewTransition = true;
    } catch {
      supportsActiveViewTransition = false;
    }

    const viewTransitionActive = () =>
      supportsActiveViewTransition &&
      document.documentElement.matches(":active-view-transition");

    const animate = () => {
      if (!activeRef.current) return;
      renderFrame(!viewTransitionActive());
      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      activeRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      parentResizeObserver?.disconnect();
      setScrollListening(false);
      if (typeof reducedMotionQuery.removeEventListener === "function") {
        reducedMotionQuery.removeEventListener(
          "change",
          syncReducedMotionPreference,
        );
      } else {
        reducedMotionQuery.removeListener(syncReducedMotionPreference);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [initParticles]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // The canvas's width/height attributes and inline width/height styles
      // are set imperatively in useEffect after measuring the parent — they
      // legitimately can't match SSR, which has no viewport to measure.
      suppressHydrationWarning
      style={{
        // Fixed so the canvas covers the viewport from a single mount in
        // the root layout, persisting particle state across every route
        // transition (including sign-in/sign-up ↔ home).
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: -1,
      }}
    />
  );
};

UniverseDustCanvas.displayName = "UniverseDustCanvas";
