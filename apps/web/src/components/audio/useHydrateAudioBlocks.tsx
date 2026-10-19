"use client";

import { useEffect, useRef, type RefObject } from "react";
import { traceIgnoredError, isAutoplayBlocked } from "@/lib/trace-ignored-error";
import { downloadAudioFile } from "./downloadAudioFile";
import { attachAudioSource, isHlsPlaylistUrl } from "./attach-audio-source";

export interface HydrateAudioLabels {
  /** Accessible label / tooltip for the per-embed download button. */
  download?: string;
}

/**
 * After `dangerouslySetInnerHTML` renders static prose HTML, this hook finds
 * all `<figure data-type="audio-block">` elements and replaces them in-place
 * with custom players built from vanilla DOM.
 *
 * Uses a MutationObserver to re-hydrate if React re-renders the container
 * (e.g., when `bodyHtml` changes from audioUrlMap resolving).
 */
export function useHydrateAudioBlocks(
  containerRef: RefObject<HTMLElement | null>,
  deps?: unknown[],
  labels?: HydrateAudioLabels,
) {
  const cleanupRef = useRef<(() => void)[]>([]);
  const hydratedRef = useRef(new WeakSet<HTMLElement>());
  // Keep the latest labels in a ref so re-hydration (fired by the
  // MutationObserver) always reads current copy without widening the effect
  // deps — the label strings are stable per locale anyway.
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function hydrate() {
      // Clean up previous players
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
      hydratedRef.current = new WeakSet();

      const figures = container!.querySelectorAll<HTMLElement>(
        'figure[data-type="audio-block"]',
      );

      figures.forEach((figure) => {
        if (hydratedRef.current.has(figure)) return;

        // A figure this hook already turned into a player no longer holds the
        // server-rendered <audio src>: the player's own <audio> is there
        // instead, and the previous run's cleanup has emptied its src. Re-read
        // the spec captured on first hydration rather than the DOM, or every
        // effect re-run over the same DOM (React StrictMode's dev
        // mount -> unmount -> mount, which Next applies to every page) leaves
        // a dead player shell with `<audio src="">`.
        const spec =
          hydratedSpecs.get(figure) ?? readAudioBlockSpec(figure);
        // Mark the figure seen BEFORE the placeholder bail-out. A placeholder
        // (nothing playable yet) left out of `hydratedRef` reads as
        // "un-hydrated" to the observer below on every later DOM mutation, so
        // each mutation re-ran hydrate(), whose own player rebuild mutated the
        // DOM again: an endless microtask loop that froze the tab. A
        // placeholder that later becomes playable arrives as NEW figure
        // elements (React rewrites the innerHTML), which are read fresh.
        hydratedRef.current.add(figure);
        if (!spec) return;
        hydratedSpecs.set(figure, spec);

        // Clear figure and build player
        figure.innerHTML = "";
        figure.removeAttribute("style");
        figure.style.margin = "16px 0";

        const cleanup = mountPlayer(figure, {
          ...spec,
          downloadLabel: labelsRef.current?.download,
        });
        cleanupRef.current.push(cleanup);
      });
    }

    // Initial hydration
    hydrate();

    // Watch for React re-rendering the innerHTML (which destroys our players)
    const observer = new MutationObserver(() => {
      // Check if any un-hydrated audio-block figures appeared
      const figures = container.querySelectorAll<HTMLElement>(
        'figure[data-type="audio-block"]',
      );
      const hasUnhydrated = Array.from(figures).some(
        (f) => !hydratedRef.current.has(f),
      );
      if (hasUnhydrated) {
        hydrate();
      }
    });

    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, ...(deps ?? [])]);
}

// ─── Server-rendered block → player spec ─────────────────────────────────────

/** What a server-rendered `<figure data-type="audio-block">` asks the player to play. */
export interface AudioBlockSpec {
  src: string;
  title: string;
  waveformPeaks: number[] | null;
  allowDownload: boolean;
  sourceUrl: string | null;
}

/**
 * Spec captured the first time a figure is hydrated. Hydration replaces the
 * figure's children, so the original `<audio src>` / `<figcaption>` cannot be
 * read back from the DOM on a later pass. Keyed by element: a React
 * innerHTML update produces new figures, which are read fresh.
 */
const hydratedSpecs = new WeakMap<HTMLElement, AudioBlockSpec>();

/**
 * Read the player spec from a server-rendered audio-block figure (the markup
 * `AudioBlock.renderHTML` emits). Returns null when the block has no playable
 * src (the "processing" placeholder), which stays as rendered.
 */
export function readAudioBlockSpec(figure: HTMLElement): AudioBlockSpec | null {
  const existingAudio = figure.querySelector("audio");
  const src = existingAudio?.getAttribute("src");
  if (!src) return null;

  const figcaption = figure.querySelector("figcaption");
  const title =
    figcaption?.textContent || figure.getAttribute("data-title") || "Audio";
  const waveformAttr = figure.getAttribute("data-waveform");
  let waveformPeaks: number[] | null = null;
  if (waveformAttr) {
    try {
      waveformPeaks = JSON.parse(waveformAttr);
    } catch {
      /* ignore malformed waveform */
    }
  }

  // Download is opt-in per embed and always targets the DIRECT file
  // (`data-source-url`), never the HLS playlist the <audio src> may hold.
  return {
    src,
    title,
    waveformPeaks,
    allowDownload: figure.getAttribute("data-allow-download") === "true",
    sourceUrl: figure.getAttribute("data-source-url"),
  };
}

// ─── Pure DOM Player ─────────────────────────────────────────────────────────

const SPEEDS = [1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function mountPlayer(
  container: HTMLElement,
  opts: {
    src: string;
    title: string;
    waveformPeaks: number[] | null;
    allowDownload?: boolean;
    sourceUrl?: string | null;
    downloadLabel?: string;
  },
): () => void {
  const { src, title, waveformPeaks, allowDownload, sourceUrl } = opts;
  const downloadLabel = opts.downloadLabel || "Download audio";
  // Offer download only when opted in AND a direct file exists (not an HLS
  // playlist). `sourceUrl` is baked as `data-source-url` by AudioBlock.
  const canDownload = Boolean(
    allowDownload && sourceUrl && !isHlsPlaylistUrl(sourceUrl),
  );
  const root = document.documentElement;
  const v = (prop: string, fallback: string) =>
    getComputedStyle(root).getPropertyValue(prop).trim() || fallback;

  // Every fallback is the STUB value (colors.ts `stubTheme`) — what SSR paints
  // before the injector hydrates. These were pre-v2 (steel-blue/near-black),
  // which flashed the wrong palette on the cream default on first paint.
  const accentHard = v("--accentHard", "#B93312");
  const accentHover = v("--accentHover", "#B93312");
  const borderColor = v("--borderColor", "#211C16");
  const surface = v("--surface", "#FDFAF3");
  const bgHover = v("--backgroundHover", "#EFE7D6");
  const colorMuted = v("--colorMuted", "#5C544A");
  const brandSecondary = v("--brandSecondary", "#E2481D");
  // The AA-safe accent-fill rung. brandSecondary (#E2481D) carries no AA
  // small-text label in either polarity; the speed button's active fill (which
  // holds a "1.5x" label) must ride #B93312 — white on it is 5.92:1.
  const brandSecondaryHover = v("--brandSecondaryHover", "#B93312");
  const textColor = v("--color", "#211C16");
  // Paired foregrounds: onStructure = light-on-dark chrome (accentHard fills);
  // onBrandSecondary = the accent fill's own label color.
  const onStructure = v("--onStructure", "#FDFAF3");
  const onBrandSecondary = v("--onBrandSecondary", "#FFFFFF");

  const player = mk(
    "div",
    `border:2px solid ${borderColor};overflow:hidden;background:${surface};width:100%`,
  );

  // ── Info bar ──
  const infoBar = mk(
    "div",
    `display:flex;align-items:center;gap:12px;padding:8px 12px;min-height:44px;background:${bgHover};border-bottom:2px solid ${borderColor};min-width:0`,
  );
  const icon = mk("span", `color:${accentHard};flex-shrink:0;font-size:14px`);
  icon.textContent = "♫";
  const titleEl = mk(
    "span",
    `font-size:12px;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${textColor}`,
  );
  titleEl.textContent = title;

  let speedIdx = 0;
  const speedBtn = document.createElement("button");
  Object.assign(speedBtn.style, {
    padding: "2px 8px",
    border: `2px solid ${borderColor}`,
    background: "transparent",
    fontSize: "10px",
    fontWeight: "700",
    cursor: "pointer",
    color: textColor,
    fontFamily: "inherit",
  });
  speedBtn.textContent = "1x";
  speedBtn.setAttribute("aria-label", "Playback speed");

  infoBar.append(icon, titleEl);

  // ── Download button (opt-in, direct file only) ──
  let downloadBtn: HTMLButtonElement | null = null;
  if (canDownload && sourceUrl) {
    downloadBtn = document.createElement("button");
    Object.assign(downloadBtn.style, {
      width: "32px",
      height: "32px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      border: `2px solid ${borderColor}`,
      background: "transparent",
      cursor: "pointer",
      color: textColor,
      flexShrink: "0",
      padding: "0",
      transition: "border-color 150ms ease-out",
    });
    downloadBtn.setAttribute("aria-label", downloadLabel);
    downloadBtn.setAttribute("title", downloadLabel);
    // Inline Lucide "download" glyph — keeps the hydrator dependency-free.
    downloadBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>';
    downloadBtn.addEventListener("mouseenter", () => {
      if (downloadBtn) downloadBtn.style.borderColor = accentHard;
    });
    downloadBtn.addEventListener("mouseleave", () => {
      if (downloadBtn) downloadBtn.style.borderColor = borderColor;
    });
    downloadBtn.addEventListener("click", () => {
      void downloadAudioFile(sourceUrl, title);
    });
    infoBar.append(downloadBtn);
  }

  infoBar.append(speedBtn);

  // ── Transport bar ──
  // min-width:0 lets the inner waveform/time elements shrink when the
  // surrounding column is narrow. Without it the bar overflows and the
  // controls clip ("smooshed").
  const transport = mk(
    "div",
    `display:flex;align-items:center;min-height:56px;padding-right:12px;min-width:0;width:100%`,
  );

  const playBtn = document.createElement("button");
  Object.assign(playBtn.style, {
    width: "56px",
    height: "56px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: accentHard,
    border: "none",
    borderRight: `2px solid ${borderColor}`,
    cursor: "pointer",
    flexShrink: "0",
    // accentHard is dark in every theme (#B93312 Stub / #2A4578 Ember), so the
    // glyph rides onStructure — light in every theme.
    color: onStructure,
    fontSize: "22px",
    transition: "background 150ms ease-out",
  });
  playBtn.textContent = "▶";
  playBtn.setAttribute("aria-label", "Play");
  playBtn.addEventListener("mouseenter", () => {
    playBtn.style.background = brandSecondary;
  });
  playBtn.addEventListener("mouseleave", () => {
    playBtn.style.background = accentHard;
  });

  // Progress area
  const progressArea = mk(
    "div",
    `flex:1;min-width:0;height:56px;cursor:pointer;position:relative;display:flex;align-items:center;padding:8px 12px 8px 16px`,
  );

  const hasWaveform = waveformPeaks && waveformPeaks.length > 0;
  let waveformBars: SVGRectElement[] = []; // top bars
  let waveformBottomBars: SVGRectElement[] = []; // bottom bars (mirror)
  let flatFill: HTMLElement | null = null;
  let flatThumb: HTMLElement | null = null;

  if (hasWaveform) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      width: "100%",
      height: "100%",
      overflow: "visible",
      display: "block",
      position: "absolute",
      left: "16px",
      right: "0",
      top: "4px",
      bottom: "4px",
    });

    // Mirror waveform: each peak gets a top bar (above center) and bottom bar (below center)
    const topBars: SVGRectElement[] = [];
    const bottomBars: SVGRectElement[] = [];
    waveformPeaks.forEach(() => {
      const top = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      const bot = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      top.setAttribute("fill", borderColor);
      bot.setAttribute("fill", borderColor);
      svg.appendChild(top);
      svg.appendChild(bot);
      topBars.push(top);
      bottomBars.push(bot);
    });
    waveformBars = topBars;
    waveformBottomBars = bottomBars;
    progressArea.appendChild(svg);

    requestAnimationFrame(() => {
      const w = progressArea.clientWidth - 16;
      if (w <= 0) return;
      const gap = 1;
      const barW = Math.max(
        1,
        (w - (waveformPeaks.length - 1) * gap) / waveformPeaks.length,
      );
      const halfH = 22; // max half-height (total = 44px mirrored)
      const centerY = halfH; // center line
      waveformPeaks.forEach((peak, i) => {
        const h = Math.max(1, peak * halfH);
        const x = String(i * (barW + gap));
        // Top bar: grows upward from center
        topBars[i].setAttribute("x", x);
        topBars[i].setAttribute("y", String(centerY - h));
        topBars[i].setAttribute("width", String(barW));
        topBars[i].setAttribute("height", String(h));
        // Bottom bar: grows downward from center (mirror)
        bottomBars[i].setAttribute("x", x);
        bottomBars[i].setAttribute("y", String(centerY + 1)); // 1px gap at center
        bottomBars[i].setAttribute("width", String(barW));
        bottomBars[i].setAttribute("height", String(h));
      });
    });
  } else {
    progressArea.appendChild(
      mk(
        "div",
        `position:absolute;left:16px;right:0;height:4px;background:${borderColor}`,
      ),
    );
    flatFill = mk(
      "div",
      `position:absolute;left:16px;height:4px;width:0;background:${accentHard};transition:width 100ms linear`,
    );
    flatThumb = mk(
      "div",
      `position:absolute;left:10px;width:12px;height:12px;background:${accentHard};border:2px solid ${surface};transition:left 100ms linear`,
    );
    progressArea.append(flatFill, flatThumb);
  }

  const timeEl = mk(
    "div",
    `padding-left:8px;padding-right:12px;font-size:11px;font-variant-numeric:tabular-nums;font-weight:700;color:${colorMuted};flex-shrink:0;white-space:nowrap`,
  );
  timeEl.textContent = "0:00 / --:--";

  const audio = document.createElement("audio");
  audio.preload = "metadata";
  // An HLS-only block (the original could not be signed) plays through
  // hls.js outside Safari, which points the element at a blob: MediaSource
  // URL and, on Safari 17+'s ManagedMediaSource, appends a <source> child.
  // Neither reaches the observer above as a re-hydrate: it reacts only to
  // un-hydrated figures, and the spec is re-read from `hydratedSpecs`, never
  // from this element's src.
  const detachSource = attachAudioSource(audio, src);

  transport.append(playBtn, progressArea, timeEl, audio);
  player.append(infoBar, transport);
  container.appendChild(player);

  // ── State ──
  let isPlaying = false;
  let dragging = false;
  let hoverBarIdx = -1; // -1 = no hover

  function getBarColor(i: number, playheadBar: number): string {
    // Hover backward: show seek-back preview
    if (
      hoverBarIdx >= 0 &&
      hoverBarIdx < playheadBar &&
      i >= hoverBarIdx &&
      i < playheadBar
    )
      return accentHover;
    if (i < playheadBar) return accentHard; // played
    // Hover forward: show seek-forward preview
    if (
      hoverBarIdx >= 0 &&
      hoverBarIdx > playheadBar &&
      i >= playheadBar &&
      i <= hoverBarIdx
    )
      return accentHover;
    return borderColor; // unplayed
  }

  function updateProgress() {
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    const frac = dur > 0 ? Math.min(cur / dur, 1) : 0;

    if (hasWaveform && waveformPeaks) {
      const playhead = frac * waveformPeaks.length;
      const topBars = waveformBars;
      topBars.forEach((rect, i) => {
        const color = getBarColor(i, playhead);
        rect.setAttribute("fill", color);
        if (waveformBottomBars[i])
          waveformBottomBars[i].setAttribute("fill", color);
      });
    } else if (flatFill && flatThumb) {
      const w = progressArea.clientWidth - 16;
      flatFill.style.width = `${frac * w}px`;
      flatThumb.style.left = `${16 + frac * w - 6}px`;
    }
    timeEl.textContent = `${formatTime(cur)} / ${dur ? formatTime(dur) : "--:--"}`;
  }

  // The waveform SVG is positioned 16px from the progressArea's left edge
  // (matches the `padding:8px 12px 8px 16px` on progressArea). Without
  // accounting for that padding the seek/hover ratio is computed against
  // the full progressArea width — so clicking the visible left edge of bar
  // 0 actually maps to ratio ≈ 16/totalWidth instead of 0, and the
  // playhead lands several seconds past where the cursor was. On a wide
  // player + ~4-minute clip that drifts ~3-4 seconds. Subtract the offset
  // from both numerator and denominator so the bars are the only hit area.
  const PROGRESS_LEFT_PAD = 16;
  function progressXToRatio(clientX: number): number {
    const rect = progressArea.getBoundingClientRect();
    const usable = Math.max(1, rect.width - PROGRESS_LEFT_PAD);
    const x = clientX - rect.left - PROGRESS_LEFT_PAD;
    return Math.max(0, Math.min(1, x / usable));
  }

  // Hover preview on waveform
  if (hasWaveform && waveformPeaks) {
    progressArea.addEventListener("mousemove", (e) => {
      if (dragging) return;
      const ratio = progressXToRatio(e.clientX);
      hoverBarIdx = Math.floor(ratio * waveformPeaks.length);
      updateProgress();
    });
    progressArea.addEventListener("mouseleave", () => {
      hoverBarIdx = -1;
      updateProgress();
    });
  }

  let seekDebounce: number | null = null;

  function seekFromEvent(e: MouseEvent) {
    const ratio = progressXToRatio(e.clientX);
    const newTime = ratio * (audio.duration || 0);
    audio.currentTime = newTime;
    // Manually update the visual immediately — don't wait for timeupdate
    const dur = audio.duration || 0;
    const frac = dur > 0 ? Math.min(newTime / dur, 1) : 0;

    if (hasWaveform && waveformPeaks) {
      const playhead = frac * waveformPeaks.length;
      waveformBars.forEach((rect, i) => {
        const color = getBarColor(i, playhead);
        rect.setAttribute("fill", color);
        if (waveformBottomBars[i])
          waveformBottomBars[i].setAttribute("fill", color);
      });
    } else if (flatFill && flatThumb) {
      const w = progressArea.clientWidth - 16;
      flatFill.style.width = `${frac * w}px`;
      flatThumb.style.left = `${16 + frac * w - 6}px`;
    }
    timeEl.textContent = `${formatTime(newTime)} / ${dur ? formatTime(dur) : "--:--"}`;
  }

  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      audio.pause();
    } else {
      document.querySelectorAll("audio").forEach((a) => {
        if (a !== audio && !a.paused) a.pause();
      });
      audio.play().catch(traceIgnoredError("audio.hydrate.play", isAutoplayBlocked));
    }
  });
  audio.addEventListener("play", () => {
    isPlaying = true;
    playBtn.textContent = "⏸";
  });
  audio.addEventListener("pause", () => {
    isPlaying = false;
    playBtn.textContent = "▶";
  });
  audio.addEventListener("ended", () => {
    isPlaying = false;
    playBtn.textContent = "▶";
    audio.currentTime = 0;
    updateProgress();
  });
  audio.addEventListener("timeupdate", () => {
    if (!dragging) updateProgress();
  });
  audio.addEventListener("loadedmetadata", updateProgress);

  // ── Buffer-stalled detection ────────────────────────────────────────────
  // Without this, seeking into an unloaded section (or hitting a bad
  // signed-URL range) leaves the play head moving but no audio coming out
  // — the user thinks the player is broken. The browser fires `waiting`
  // when it has to pause for data; if `playing`/`canplay` doesn't come
  // back within a window, surface it on the play button.
  let stalledTimer: number | null = null;
  let isStalled = false;
  const setStalled = (v: boolean) => {
    if (isStalled === v) return;
    isStalled = v;
    if (v) {
      // Spinner glyph for the play button. Cheap visual signal — keeps the
      // hydrator dependency-free (no SVG / lucide imports).
      playBtn.textContent = "⟳";
      playBtn.style.cursor = "wait";
      playBtn.setAttribute("aria-label", "Buffering");
    } else {
      playBtn.textContent = isPlaying ? "⏸" : "▶";
      playBtn.style.cursor = "pointer";
      playBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    }
  };
  const armStallWatchdog = () => {
    if (stalledTimer) clearTimeout(stalledTimer);
    // 2 seconds is enough that genuine network jitter doesn't false-fire,
    // but short enough that a real "no data" silence registers visibly.
    stalledTimer = window.setTimeout(() => setStalled(true), 2000);
  };
  const clearStallWatchdog = () => {
    if (stalledTimer) {
      clearTimeout(stalledTimer);
      stalledTimer = null;
    }
    setStalled(false);
  };
  audio.addEventListener("waiting", armStallWatchdog);
  audio.addEventListener("stalled", armStallWatchdog);
  audio.addEventListener("playing", clearStallWatchdog);
  audio.addEventListener("canplaythrough", clearStallWatchdog);
  audio.addEventListener("error", () => setStalled(true));

  progressArea.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    hoverBarIdx = -1;
    seekFromEvent(e);
  });
  const onMove = (e: MouseEvent) => {
    if (dragging) seekFromEvent(e);
  };
  const onUp = () => {
    if (!dragging) return;
    // Keep dragging=true long enough for HLS to buffer to the new position.
    // Stale timeupdate events during buffering would reset the visual.
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = window.setTimeout(() => {
      dragging = false;
    }, 500);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    const spd = SPEEDS[speedIdx];
    audio.playbackRate = spd;
    speedBtn.textContent = `${spd}x`;
    speedBtn.style.borderColor = spd !== 1 ? brandSecondaryHover : borderColor;
    speedBtn.style.background = spd !== 1 ? brandSecondaryHover : "transparent";
    speedBtn.style.color = spd !== 1 ? onBrandSecondary : textColor;
  });

  return () => {
    audio.pause();
    // Destroy hls.js first so it detaches its own MediaSource URL.
    detachSource();
    audio.src = "";
    if (stalledTimer) clearTimeout(stalledTimer);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}

function mk(tag: string, style: string): HTMLElement {
  const e = document.createElement(tag);
  e.setAttribute("style", style);
  return e;
}
