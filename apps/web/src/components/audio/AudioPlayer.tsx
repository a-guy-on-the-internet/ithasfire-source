"use client";

import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { XStack, YStack, styled } from "tamagui";
import { Music, Play, Pause, X, Download } from "lucide-react";
import { Text } from "@th/ui";
import { traceIgnoredError, isAutoplayBlocked } from "@/lib/trace-ignored-error";
import { attachAudioSource, isHlsPlaylistUrl } from "./attach-audio-source";
import { downloadAudioFile } from "./downloadAudioFile";

// ─── Constants ───────────────────────────────────────────────────────────────

const SPEEDS = [1, 1.25, 1.5, 2] as const;
const WAVEFORM_BAR_GAP = 1; // px between bars

/**
 * The player's vertical geometry, EXPORTED because the prose editor renders a
 * loading skeleton that has to be this player's exact silhouette — otherwise
 * the block changes height on the poll tick that resolves a source and
 * everything below it jumps mid-edit. Sharing the numbers is the only thing
 * that stops the two drifting; they already drifted by 10px once.
 *
 * See `AudioBlockNodeView.tsx`. Change a number here, not there.
 */
export const AUDIO_PLAYER_METRICS = {
  /** `PlayerContainer` border — counted twice, top and bottom. */
  frameBorderWidth: 2,
  /** `InfoBar` box height, INCLUDING its own bottom border (border-box). */
  infoBarMinHeight: 44,
  /**
   * Mirrors the `paddingVertical: "$2"` token on both info rows — the space
   * scale is 4/8/12/16/24/32/48/72, so `$2` is 8. Read by the parity test,
   * which also asserts both rows still declare `$2`; if that token moves,
   * this number moves with it.
   */
  infoBarPaddingVertical: 8,
  infoBarBorderBottomWidth: 2,
  /**
   * The tallest thing `InfoBar` normally contains: the speed toggle, at
   * 14px line box + $1 padding x2 + 2px border x2 = 26. `minHeight` only
   * governs while this fits inside it — 26 + 16 padding + 2 border = 44,
   * exactly. The 10px drift was a 10px label with NO explicit lineHeight,
   * which inherited `variant="body"`'s 24px line box and pushed the bar to
   * 54. Both labels now carry their own line box; keep it that way.
   */
  infoBarContentMax: 26,
  /**
   * The download button is sized to `infoBarContentMax`, NOT to a comfortable
   * tap target, so the info bar is 44 in every state. At 32 it pushed the bar
   * to 50 whenever it showed — reachable by clipboard paste (`allowDownload`
   * round-trips through HTML but `sourceUrl`/`status` do not, so a pasted
   * figure resolves from skeleton straight to a download-enabled player) and
   * by any poll tick that returns an entry without a `sourceUrl`. Touch gets
   * its 44px through a coarse-pointer overlay instead — see
   * `.th-audio-hit-44` in `prose-editor.css`.
   */
  downloadButtonSize: 26,
  transportBarMinHeight: 56,
  /** `PlayBtn` — the square the editor skeleton's play slot stands in for. */
  playButtonSize: 56,
} as const;

/** Total resolved player height. The skeleton must equal this. */
export const AUDIO_PLAYER_HEIGHT =
  AUDIO_PLAYER_METRICS.frameBorderWidth * 2 +
  AUDIO_PLAYER_METRICS.infoBarMinHeight +
  AUDIO_PLAYER_METRICS.transportBarMinHeight;

// ─── Styled Components ───────────────────────────────────────────────────────

const PlayerContainer = styled(YStack, {
  position: "relative",
  borderWidth: AUDIO_PLAYER_METRICS.frameBorderWidth,
  borderColor: "$borderColor",
  borderRadius: 0,
  overflow: "hidden",
  backgroundColor: "$surface",
});

const InfoBar = styled(XStack, {
  backgroundColor: "$backgroundHover",
  borderBottomWidth: AUDIO_PLAYER_METRICS.infoBarBorderBottomWidth,
  borderBottomColor: "$borderColor",
  paddingVertical: "$2",
  paddingHorizontal: "$3",
  gap: "$3",
  alignItems: "center",
  minHeight: AUDIO_PLAYER_METRICS.infoBarMinHeight,
});

const TransportBar = styled(XStack, {
  paddingRight: "$3",
  gap: 0,
  alignItems: "center",
  minHeight: AUDIO_PLAYER_METRICS.transportBarMinHeight,
  // minWidth:0 lets flex children (progress + time) actually shrink below
  // their intrinsic width when the player is in a narrow column. Without
  // it the time label + waveform refuse to compress and the bar overflows.
  minWidth: 0,
  width: "100%",
});

const PlayBtn = styled(XStack, {
  width: AUDIO_PLAYER_METRICS.playButtonSize,
  height: AUDIO_PLAYER_METRICS.playButtonSize,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  backgroundColor: "$accentHard",
  borderRightWidth: 2,
  borderRightColor: "$borderColor",
  flexShrink: 0,
  hoverStyle: {
    backgroundColor: "$brandSecondary",
  },
});

const SpeedBtn = styled(XStack, {
  paddingHorizontal: "$2",
  paddingVertical: "$1",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  minWidth: 40,
  hoverStyle: {
    borderColor: "$accentHard",
  },
});

/**
 * Download control — chrome icon button. Square-ish tap target that matches
 * the speed toggle's border language but stays visually quiet (it's a frame
 * affordance, not transport). 44px hit area via padding on touch.
 */
const DownloadBtn = styled(XStack, {
  width: AUDIO_PLAYER_METRICS.downloadButtonSize,
  height: AUDIO_PLAYER_METRICS.downloadButtonSize,
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
  transition: "border-color 150ms ease-out",
  hoverStyle: {
    borderColor: "$accentHard",
  },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineColor: "$brandSecondary",
    outlineStyle: "solid",
  },
});

// ─── Waveform Display ────────────────────────────────────────────────────────

function WaveformDisplay({
  peaks,
  currentTime,
  duration,
  onSeek,
}: {
  peaks: number[];
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [hoverBarIdx, setHoverBarIdx] = useState(-1);

  const fraction = duration > 0 ? Math.min(currentTime / duration, 1) : 0;
  const barCount = peaks.length;

  // Observe container width for responsive bar sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const barWidth =
    barCount > 0 && containerWidth > 0
      ? Math.max(
          1,
          (containerWidth - (barCount - 1) * WAVEFORM_BAR_GAP) / barCount,
        )
      : 2;

  const getTimeFromEvent = useCallback(
    (clientX: number) => {
      const el = containerRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      return (
        Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration
      );
    },
    [duration],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      onSeek(getTimeFromEvent(e.clientX));
    },
    [getTimeFromEvent, onSeek],
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => onSeek(getTimeFromEvent(e.clientX));
    const handleUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, getTimeFromEvent, onSeek]);

  // Determine which bar index the playhead is at
  const playheadBar = fraction * barCount;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      tabIndex={0}
      onMouseMove={(e) => {
        if (isDragging) return;
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const ratio = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left) / rect.width),
        );
        setHoverBarIdx(Math.floor(ratio * barCount));
      }}
      onMouseLeave={() => setHoverBarIdx(-1)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onSeek(Math.min(currentTime + 5, duration));
        if (e.key === "ArrowLeft") onSeek(Math.max(currentTime - 5, 0));
        if (e.key === " ") {
          e.preventDefault(); /* handled by parent */
        }
      }}
      style={{
        flex: 1,
        height: 56,
        cursor: "pointer",
        position: "relative",
        display: "flex",
        alignItems: "center",
        paddingBottom: 4,
        paddingTop: 4,
        paddingLeft: 12,
        paddingRight: 4,
      }}
    >
      <svg
        width="100%"
        height="48"
        preserveAspectRatio="none"
        style={{ overflow: "visible", display: "block" }}
      >
        {peaks.map((peak, i) => {
          const halfH = 22; // max half-height (mirrored total = 44px)
          const centerY = 24; // vertical center
          const h = Math.max(1, peak * halfH);
          const x = i * (barWidth + WAVEFORM_BAR_GAP);

          const isFilled = i < playheadBar;
          // Hover forward: highlight bars between playhead and cursor
          const isHoverForward =
            hoverBarIdx >= 0 &&
            hoverBarIdx > playheadBar &&
            i >= playheadBar &&
            i <= hoverBarIdx;
          // Hover backward: dim bars between cursor and playhead to show seek-back preview
          const isHoverBackward =
            hoverBarIdx >= 0 &&
            hoverBarIdx < playheadBar &&
            i >= hoverBarIdx &&
            i < playheadBar;
          const fillColor = isHoverBackward
            ? "var(--accentHover, #B93312)" // would-be-unfilled after seek
            : isFilled
              ? "var(--accentHard, #B93312)"
              : isHoverForward
                ? "var(--accentHover, #B93312)"
                : "var(--borderColor, #211C16)";

          return (
            <g key={i}>
              {/* Top bar — grows upward from center */}
              <rect
                x={x}
                y={centerY - h}
                width={barWidth}
                height={h}
                fill={fillColor}
                style={{ transition: isDragging ? "none" : "fill 50ms linear" }}
              />
              {/* Bottom bar — mirrors downward from center */}
              <rect
                x={x}
                y={centerY + 1}
                width={barWidth}
                height={h}
                fill={fillColor}
                style={{ transition: isDragging ? "none" : "fill 50ms linear" }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Flat Progress Bar (fallback when no waveform) ───────────────────────────

function FlatProgressBar({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fraction = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  const getTimeFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      return (
        Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration
      );
    },
    [duration],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      onSeek(getTimeFromEvent(e.clientX));
    },
    [getTimeFromEvent, onSeek],
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => onSeek(getTimeFromEvent(e.clientX));
    const handleUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, getTimeFromEvent, onSeek]);

  return (
    <div
      ref={trackRef}
      onMouseDown={handleMouseDown}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onSeek(Math.min(currentTime + 5, duration));
        if (e.key === "ArrowLeft") onSeek(Math.max(currentTime - 5, 0));
      }}
      style={{
        flex: 1,
        height: 56,
        cursor: "pointer",
        position: "relative",
        display: "flex",
        alignItems: "center",
        paddingLeft: 16,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 16,
          right: 0,
          height: 4,
          backgroundColor: "var(--borderColor, #211C16)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 16,
          width: `calc(${fraction * 100}% - ${16 * fraction}px)`,
          height: 4,
          backgroundColor: "var(--accentHard, #B93312)",
          transition: isDragging ? "none" : "width 100ms linear",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `calc(16px + ${fraction * 100}% - ${16 * fraction}px - 6px)`,
          width: 12,
          height: 12,
          backgroundColor: isDragging
            ? "var(--brandSecondary, #E2481D)"
            : "var(--accentHard, #B93312)",
          border: "2px solid var(--surface, #FDFAF3)",
          transition: isDragging ? "none" : "left 100ms linear",
        }}
      />
    </div>
  );
}

// ─── Mini Sticky Player ──────────────────────────────────────────────────────

function MiniStickyPlayer({
  isPlaying,
  currentTime,
  duration,
  title,
  speed,
  onTogglePlay,
  onSeek,
  onCycleSpeed,
  onDismiss,
}: {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  title: string;
  speed: number;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onCycleSpeed: () => void;
  onDismiss: () => void;
}) {
  const fraction = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  return createPortal(
    <div
      style={{
        position: "fixed",
        // Sits ON TOP of the consumer shell's fixed bottom nav when there is
        // one (it publishes its measured height on <html>); 0 everywhere else.
        // Plus the event page's docked price bar, which publishes ITS height
        // the same way while it is on screen (event-content.css) — the two
        // used to share this edge and the player covered the price.
        bottom:
          "calc(var(--consumer-bottom-nav-height, 0px) + var(--event-price-bar-height, 0px))",
        left: 0,
        right: 0,
        height: 48,
        backgroundColor: "var(--surface, #FDFAF3)",
        borderTop: "2px solid var(--borderColor, #211C16)",
        display: "flex",
        alignItems: "center",
        zIndex: 9000,
        transition: "transform 200ms ease-out",
      }}
    >
      {/* Progress line across the top */}
      <div
        style={{
          position: "absolute",
          top: -2,
          left: 0,
          right: 0,
          height: 2,
          backgroundColor: "var(--borderColor, #211C16)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${fraction * 100}%`,
            backgroundColor: "var(--accentHard, #B93312)",
            transition: "width 200ms linear",
          }}
        />
      </div>

      {/* Play/Pause */}
      <button
        onClick={onTogglePlay}
        aria-label={isPlaying ? "Pause" : "Play"}
        style={{
          width: 48,
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "var(--accentHard, #B93312)",
          border: "none",
          cursor: "pointer",
          borderRight: "2px solid var(--borderColor, #211C16)",
        }}
      >
        {/* --accentHard is dark in every theme (#B93312 Stub / #2A4578 Ember),
            so the transport glyph rides --onStructure. */}
        {isPlaying ? (
          <Pause
            size={18}
            color="var(--onStructure, #FDFAF3)"
            strokeWidth={2.5}
          />
        ) : (
          <Play
            size={18}
            color="var(--onStructure, #FDFAF3)"
            strokeWidth={2.5}
            fill="var(--onStructure, #FDFAF3)"
          />
        )}
      </button>

      {/* Title */}
      <div
        style={{
          flex: 1,
          paddingLeft: 12,
          paddingRight: 8,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--color, #211C16)",
        }}
      >
        {title}
      </div>

      {/* Time */}
      <div
        style={{
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 700,
          color: "var(--colorMuted, #5C544A)",
          paddingRight: 8,
          flexShrink: 0,
        }}
      >
        {formatTime(currentTime)} / {duration ? formatTime(duration) : "--:--"}
      </div>

      {/* Speed */}
      <button
        onClick={onCycleSpeed}
        style={{
          padding: "2px 6px",
          border: `2px solid ${speed !== 1 ? "var(--brandSecondary, #E2481D)" : "var(--borderColor, #211C16)"}`,
          backgroundColor:
            speed !== 1 ? "var(--brandSecondary, #E2481D)" : "transparent",
          color:
            speed !== 1
              ? "var(--onBrandSecondary, #FFFFFF)"
              : "var(--color, #211C16)",
          fontSize: 10,
          fontWeight: 700,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {speed}x
      </button>

      {/* Dismiss */}
      <button
        onClick={onDismiss}
        aria-label="Close mini player"
        style={{
          width: 48,
          height: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "transparent",
          border: "none",
          cursor: "pointer",
          borderLeft: "2px solid var(--borderColor, #211C16)",
        }}
      >
        <X size={16} color="var(--colorMuted, #5C544A)" />
      </button>
    </div>,
    document.body,
  );
}

// ─── Time formatting ─────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AudioPlayerProps {
  src: string;
  title?: string;
  /** Normalized amplitude peaks (0-1), typically 200 values. When provided, renders a waveform instead of a flat bar. */
  waveformPeaks?: number[] | null;
  /** Enable the mini sticky player when the main player scrolls out of view. */
  enableStickyPlayer?: boolean;
  /** When true (and a direct `downloadUrl` exists), show a download button. */
  allowDownload?: boolean;
  /**
   * Direct file URL to download. Must be the raw audio file, NOT the HLS
   * playlist — a `.m3u8` isn't a single downloadable asset. When absent the
   * download button is hidden even if `allowDownload` is true.
   */
  downloadUrl?: string | null;
  /** Accessible label / tooltip for the download button (i18n-provided). */
  downloadLabel?: string;
}

/**
 * Standalone audio player matching the Ithas Fire Swiss design.
 * Features: waveform visualization, playback speed, mini sticky player.
 */
export function AudioPlayer({
  src,
  title = "Audio",
  waveformPeaks,
  enableStickyPlayer = true,
  allowDownload = false,
  downloadUrl,
  downloadLabel = "Download audio",
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const isSeekingRef = useRef(false);
  const [speed, setSpeed] = useState(1);
  const [showMiniPlayer, setShowMiniPlayer] = useState(false);
  const [miniDismissed, setMiniDismissed] = useState(false);

  const hasWaveform = waveformPeaks && waveformPeaks.length > 0;

  // Only offer a download when explicitly allowed AND a direct file URL is
  // present. A `.m3u8` playlist isn't a single downloadable asset, so exclude
  // it defensively even if it somehow arrives as the download target.
  const canDownload = Boolean(
    allowDownload && downloadUrl && !isHlsPlaylistUrl(downloadUrl),
  );

  // ── Audio event listeners ──
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      if (!isSeekingRef.current) setCurrentTime(audio.currentTime);
    };
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, [src]);

  // ── Source: direct file, native HLS, or hls.js ──
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    return attachAudioSource(audio, src);
  }, [src]);

  // ── IntersectionObserver for sticky mini-player ──
  useEffect(() => {
    if (!enableStickyPlayer) return;
    const el = playerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show mini player when main player is NOT visible AND audio is playing
        const outOfView = !entry.isIntersecting;
        setShowMiniPlayer(outOfView && isPlaying);
        // Reset dismiss when player comes back into view
        if (entry.isIntersecting) setMiniDismissed(false);
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enableStickyPlayer, isPlaying]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      document.querySelectorAll("audio").forEach((el) => {
        if (el !== audio && !el.paused) el.pause();
      });
      audio.play().catch(traceIgnoredError("audio.play", isAutoplayBlocked));
    }
  }, [isPlaying]);

  const handleSeek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    isSeekingRef.current = true;
    setCurrentTime(time);
    audio.currentTime = time;
    requestAnimationFrame(() => {
      isSeekingRef.current = false;
    });
  }, []);

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => {
      const idx = SPEEDS.indexOf(prev as (typeof SPEEDS)[number]);
      const next = SPEEDS[(idx + 1) % SPEEDS.length];
      const audio = audioRef.current;
      if (audio) audio.playbackRate = next;
      return next;
    });
  }, []);

  return (
    <>
      <div ref={playerRef}>
        <PlayerContainer>
          <InfoBar>
            <Music
              size={14}
              color="var(--accentHard)"
              style={{ flexShrink: 0 }}
            />
            <Text
              tag="span"
              style={{
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
              weight="bold"
              // Size and line-height travel together. Without this the label
              // keeps `variant="body"`'s 24px line box while rendering at 12px.
              lineHeight={16}
            >
              {title}
            </Text>

            {/* Download (opt-in per embed, direct file only) */}
            {canDownload && downloadUrl && (
              <DownloadBtn
                onPress={() => {
                  void downloadAudioFile(downloadUrl, title);
                }}
                aria-label={downloadLabel}
                data-testid="audio-block-download"
                // 26px visual, 44px hit box on touch. Height must NOT be used
                // for the tap target — it is what the info bar's 44px is made
                // of. See AUDIO_PLAYER_METRICS.downloadButtonSize.
                className="th-audio-hit-44"
                {...({
                  role: "button",
                  tabIndex: 0,
                  title: downloadLabel,
                } as unknown as Record<string, unknown>)}
              >
                <Download size={14} color="var(--color)" />
              </DownloadBtn>
            )}

            {/* Speed toggle */}
            <SpeedBtn
              onPress={cycleSpeed}
              aria-label={`Playback speed: ${speed}x`}
              {...(speed !== 1
                ? {
                    borderColor: "$brandSecondary",
                    backgroundColor: "$brandSecondary",
                  }
                : {})}
            >
              <Text
                tag="span"
                style={{ fontSize: 10, fontWeight: 700 }}
                color={speed !== 1 ? "$onBrandSecondary" : "$color"}
                // A 10px label claiming `variant="body"`'s 24px line box made
                // this button 36px and silently inflated InfoBar to 54 —
                // 10px taller than its declared 44, and 10px taller than the
                // editor skeleton that mirrors it. 14 + 4x2 + 2x2 = 26.
                lineHeight={14}
              >
                {speed}x
              </Text>
            </SpeedBtn>
          </InfoBar>

          <TransportBar>
            <PlayBtn
              onPress={togglePlay}
              aria-label={isPlaying ? "Pause" : "Play"}
              data-testid="audio-block-play"
              {...({ role: "button", tabIndex: 0 } as unknown as Record<
                string,
                unknown
              >)}
            >
              {/* PlayBtn fills with $accentHard — dark in every theme — so the
                  glyph rides $onStructure (stays legible on the
                  $brandSecondary hover fill too). */}
              {isPlaying ? (
                <Pause
                  size={22}
                  color="var(--onStructure, #FDFAF3)"
                  strokeWidth={2.5}
                />
              ) : (
                <Play
                  size={22}
                  color="var(--onStructure, #FDFAF3)"
                  strokeWidth={2.5}
                  fill="var(--onStructure, #FDFAF3)"
                />
              )}
            </PlayBtn>

            {hasWaveform ? (
              <WaveformDisplay
                peaks={waveformPeaks}
                currentTime={currentTime}
                duration={duration}
                onSeek={handleSeek}
              />
            ) : (
              <FlatProgressBar
                currentTime={currentTime}
                duration={duration}
                onSeek={handleSeek}
              />
            )}

            <XStack
              paddingLeft="$2"
              gap="$1"
              alignItems="center"
              flexShrink={0}
            >
              <Text
                tag="span"
                style={{
                  fontSize: 11,
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 700,
                }}
                color="$colorMuted"
              >
                {formatTime(currentTime)}
              </Text>
              <Text tag="span" style={{ fontSize: 11 }} color="$colorMuted">
                /
              </Text>
              <Text
                tag="span"
                style={{
                  fontSize: 11,
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 700,
                }}
                color="$colorMuted"
              >
                {duration ? formatTime(duration) : "--:--"}
              </Text>
            </XStack>

            {/* src is attached by the effect above (attachAudioSource), so
                an HLS-only block plays through hls.js outside Safari. */}
            <audio ref={audioRef} preload="metadata" />
          </TransportBar>
        </PlayerContainer>
      </div>

      {/* Mini sticky player — portaled to body */}
      {showMiniPlayer && !miniDismissed && (
        <MiniStickyPlayer
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          title={title}
          speed={speed}
          onTogglePlay={togglePlay}
          onSeek={handleSeek}
          onCycleSpeed={cycleSpeed}
          onDismiss={() => setMiniDismissed(true)}
        />
      )}
    </>
  );
}
