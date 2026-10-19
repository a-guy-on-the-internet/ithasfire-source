"use client";

import { useEffect, useState } from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { XStack, YStack, styled } from "tamagui";
import { Trash2, AlertCircle, Clock, Download, Play } from "lucide-react";
import { Text, Spinner, useTranslations } from "@th/ui";

import type { AudioBlockAttributes, AudioUploadStatus } from "./AudioBlock";
import { audioLayoutStyle } from "./media-layout";
import {
  AudioPlayer,
  AUDIO_PLAYER_METRICS,
} from "@/components/audio/AudioPlayer";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/** Processing timeout threshold in milliseconds (5 minutes). */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Status stripe: the 4px rail down the left of the whole block.
 *
 * A transcode failure that still plays is AMBER, not red — the embed works, we
 * just couldn't build the optimized version. Only a failure with nothing
 * playable reddens. Exported (with the resolver below) so the three branches
 * can be asserted directly; they are the block's only persistent status
 * signal, and in the failed-with-source path the stripe plus a 24px strip are
 * the entire failure signal.
 */
export type AudioStatusKind = "failed" | "working" | "none";

export const AUDIO_STATUS_RAIL_COLOR: Record<AudioStatusKind, string> = {
  failed: "$danger",
  working: "$support",
  // Always 4px, transparent when idle: a border that appears and disappears
  // would shift the media 4px sideways the moment a file resolves.
  none: "transparent",
};

export function audioStatusKind(
  status: AudioUploadStatus,
  hasSource: boolean,
): AudioStatusKind {
  if (status === "FAILED") return hasSource ? "working" : "failed";
  // READY with nothing playable is a real terminal state, not an idle one:
  // presigning can fail, and a row can outlive the object it points at. It
  // used to fall through to "none", which left the block spinning "Uploading"
  // forever behind a transparent rail — the one signal that is supposed to
  // always be showing showed nothing.
  if (status === "READY") return hasSource ? "none" : "failed";
  return "working";
}

/**
 * Deterministic silhouette waveform.
 *
 * NEVER `Math.random()`: the editor re-resolves audio attrs on a 10s poll, so
 * this component re-renders while the file is still transcoding. A skeleton
 * whose bars reshuffle on every tick reads as *new data arriving* — it claims
 * progress that has not happened. A fixed formula gives the same picture every
 * render, which is the honest signal: nothing has changed yet.
 */
const SKELETON_BAR_COUNT = 44;
const SKELETON_BARS: readonly number[] = Array.from(
  { length: SKELETON_BAR_COUNT },
  (_, i) => {
    const wave = Math.sin(i * 0.7) * 0.5 + Math.sin(i * 0.23) * 0.35;
    return Math.round((0.28 + Math.abs(wave) * 0.6) * 100);
  },
);

// ─── Styled Components ───────────────────────────────────────────────────────

/**
 * Outermost box. Carries the selection ring as an `outline` (not an absolutely
 * positioned bordered div) so the ring surrounds the edit rail as well as the
 * media, and never sits *inside* the frame competing with it.
 */
const EditorWrapper = styled(YStack, {
  marginVertical: "$4",
});

/**
 * Status stripe. The 4px rail sits OUTSIDE every segment's own 2px ink border,
 * so the edit rail, the notice strip and the media all start at the same x —
 * putting the 4px on one segment only makes the stack jog sideways.
 *
 * Always 4px wide, `transparent` when there is no status: appearing/disappearing
 * border width would shift the media 4px horizontally the moment a file resolves.
 */
const StatusColumn = styled(YStack, {
  borderLeftWidth: 4,
  borderLeftColor: "transparent",
});

/**
 * Editor chrome rail. Sits ABOVE the media instead of floating over it, so
 * nothing can collide with the player's own controls or the skeleton's spinner.
 * `borderBottomWidth: 0` welds it to the 2px top border of whatever renders
 * below — one continuous frame, never a doubled 4px rule.
 */
const EditRail = styled(XStack, {
  height: 30,
  alignItems: "center",
  // No label. The rail is chrome, and the media directly beneath it already
  // names itself ("AUDIO ▸ <title>" in the player's info bar, the same in the
  // skeleton). A second "AUDIO" 30px above that is redundant ink — and a
  // duplicate accessible name when the title falls back to its default.
  justifyContent: "flex-end",
  gap: "$2",
  // Same $3 gutter as the player's own InfoBar, so the rail's buttons line up
  // with the player's speed toggle below them.
  paddingHorizontal: "$3",
  backgroundColor: "$surfaceMuted",
  // This is the player's frame continuing upward, so it is the player's
  // border width — not a 2 that happens to match today.
  borderWidth: AUDIO_PLAYER_METRICS.frameBorderWidth,
  borderColor: "$borderColor",
  borderBottomWidth: 0,
  borderRadius: 0,
});

const RailActions = styled(XStack, {
  gap: "$1",
  alignItems: "center",
  flexShrink: 0,
});

/**
 * Single-line transcode-failure notice. Same weld trick as the rail: 2px frame,
 * open bottom, so it shares one border with the player underneath rather than
 * stacking a second 52px bar below it.
 */
const NoticeStrip = styled(XStack, {
  minHeight: 24,
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$3",
  backgroundColor: "$surfaceMuted",
  // This is the player's frame continuing upward, so it is the player's
  // border width — not a 2 that happens to match today.
  borderWidth: AUDIO_PLAYER_METRICS.frameBorderWidth,
  borderColor: "$borderColor",
  borderBottomWidth: 0,
  borderRadius: 0,
});

/**
 * The player's silhouette. Every dimension is IMPORTED from
 * `AUDIO_PLAYER_METRICS` rather than copied, because copying is what let the
 * two drift: the skeleton resolved to 104px against a 114px player and the
 * block still jumped 10px on the poll tick. Both are 104 now, and neither can
 * move without the other.
 *
 * (The original bug was worse — a 52px `StateBar` became the full player.)
 */
const MediaFrame = styled(YStack, {
  borderWidth: AUDIO_PLAYER_METRICS.frameBorderWidth,
  borderColor: "$borderColor",
  borderRadius: 0,
  overflow: "hidden",
  backgroundColor: "$surface",
});

/**
 * `AudioPlayer`'s `InfoBar`, declaration for declaration. `minHeight` only
 * governs while the tallest child fits inside it — see
 * `AUDIO_PLAYER_METRICS.infoBarContentMax`, which is the invariant that broke.
 */
const FrameInfoRow = styled(XStack, {
  minHeight: AUDIO_PLAYER_METRICS.infoBarMinHeight,
  paddingVertical: "$2",
  paddingHorizontal: "$3",
  gap: "$3",
  alignItems: "center",
  backgroundColor: "$backgroundHover",
  borderBottomWidth: AUDIO_PLAYER_METRICS.infoBarBorderBottomWidth,
  borderBottomColor: "$borderColor",
});

/** `AudioPlayer`'s `TransportBar`. */
const FrameTransportRow = styled(XStack, {
  minHeight: AUDIO_PLAYER_METRICS.transportBarMinHeight,
  paddingRight: "$3",
  alignItems: "center",
  minWidth: 0,
  width: "100%",
});

/** `AudioPlayer`'s `PlayBtn` box — where the real play control lands. */
const SkeletonPlaySlot = styled(XStack, {
  width: AUDIO_PLAYER_METRICS.playButtonSize,
  height: AUDIO_PLAYER_METRICS.playButtonSize,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  backgroundColor: "$surfaceMuted",
  borderRightWidth: 2,
  borderRightColor: "$borderColor",
});

/**
 * The blocking failure card's body row. A styled component like its three
 * siblings, NOT an inline-prop `XStack` — `styled()` configs are what the
 * parity test can see, so a literal hidden here would have been invisible by
 * construction. Same 56 as a transport row: the card and the player are the
 * same height.
 */
const FrameBodyRow = styled(XStack, {
  minHeight: AUDIO_PLAYER_METRICS.transportBarMinHeight,
  alignItems: "center",
  paddingHorizontal: "$3",
  paddingVertical: "$2",
});

const FrameTitleSlot = styled(XStack, {
  flex: 1,
  minWidth: 0,
  justifyContent: "flex-end",
});

// ─── Node View ───────────────────────────────────────────────────────────────

export function AudioBlockNodeView({
  node,
  selected,
  deleteNode,
  updateAttributes,
  editor,
}: NodeViewProps) {
  const t = useTranslations();
  // `createTranslator` returns THE KEY ITSELF on a miss
  // (`packages/locale/src/create-translator.ts`), so the `t(k) ?? "fallback"`
  // idiom used all over this repo never falls back — it renders
  // "admin.abStillWorking" as copy. Detect the miss by comparing against the
  // key. Scoped to this file on purpose; the broken idiom has ~108 other call
  // sites and fixing them is not this change.
  const tr = (
    key: string,
    fallback: string,
    values?: Record<string, string | number>,
  ): string => {
    const value = String(t(key, values) ?? "");
    return value === key || value === "" ? fallback : value;
  };
  const prefersReducedMotion = usePrefersReducedMotion();
  const attrs = node.attrs as AudioBlockAttributes;
  const isEditable = editor.isEditable;
  const allowDownload = Boolean(attrs.allowDownload);
  // Download must target the direct file, never the HLS playlist — a `.m3u8`
  // isn't a single downloadable asset. `sourceUrl` is the raw upload.
  const downloadUrl = attrs.sourceUrl || null;
  const downloadToggleLabel = allowDownload
    ? tr("admin.abDownloadsAllowed", "Downloads allowed")
    : tr("admin.abAllowDownload", "Allow download");

  // Prefer raw sourceUrl over HLS, as the public page does, so the editor
  // and the event page play the same file. An HLS-only block still plays:
  // AudioPlayer attaches the playlist through hls.js outside Safari.
  // Use `||` so empty strings fall through to the next candidate; `??`
  // would let `""` render as a text-node child of the Tamagui View.
  const audioSrc = attrs.sourceUrl || attrs.hlsPlaylistUrl || null;
  const status = (attrs.status as AudioUploadStatus) ?? "PENDING";
  const title = attrs.title || tr("admin.abDefaultTitle", "Audio");
  const isProcessing =
    status === "PENDING" || status === "UPLOADED" || status === "TRANSCODING";
  // A transcode FAILURE only affects the optimized HLS/waveform output — the
  // raw uploaded source (`sourceUrl`) is never cleared on failure, so it's
  // still playable. Keep the player whenever any source resolved; only fall
  // back to the blocking failure card when there's truly nothing to play.
  const hasPlayer = Boolean(audioSrc);
  const transcodeFailed = status === "FAILED";
  // Surface the failure as a non-blocking notice when the original still plays.
  const showFailedNotice = transcodeFailed && hasPlayer;
  // Block when there is nothing to play AND nothing is still coming. FAILED is
  // the obvious case; READY-with-no-source is the quiet one — the pipeline says
  // it finished and handed us nothing, which is just as terminal and must not
  // render as "still working".
  const isTerminallyUnplayable =
    !hasPlayer && (transcodeFailed || status === "READY");
  const showFailedState = isTerminallyUnplayable;
  // Peaks are absent on failure — omit the waveform gracefully in that case.
  const waveformPeaks = transcodeFailed ? null : attrs.waveformPeaks;

  // Detect stalled processing
  const [isTimedOut, setIsTimedOut] = useState(false);
  useEffect(() => {
    if (!isProcessing || !attrs.uploadStartedAt) {
      setIsTimedOut(false);
      return;
    }
    const started = new Date(attrs.uploadStartedAt).getTime();
    const elapsed = Date.now() - started;
    if (elapsed >= PROCESSING_TIMEOUT_MS) {
      setIsTimedOut(true);
      return;
    }
    const timer = setTimeout(
      () => setIsTimedOut(true),
      PROCESSING_TIMEOUT_MS - elapsed,
    );
    return () => clearTimeout(timer);
  }, [isProcessing, attrs.uploadStartedAt]);

  // Status stripe. Derived by the exported resolver so the three branches are
  // testable on their own, and mirrored onto `data-status` so the render tests
  // can pin the wiring too.
  const statusKind = audioStatusKind(status, hasPlayer);
  const statusRailColor = AUDIO_STATUS_RAIL_COLOR[statusKind];

  // `Date.now()` DOES run on every render, including the server one. It is
  // safe only because the value is read exclusively inside the `isTimedOut`
  // branch, and `isTimedOut` starts false and is set from an effect — so the
  // server and the first client render agree on what they paint. Keep the
  // read out of any branch that can render before hydration.
  const elapsedMinutes = attrs.uploadStartedAt
    ? Math.max(
        1,
        Math.floor(
          (Date.now() - new Date(attrs.uploadStartedAt).getTime()) / 60000,
        ),
      )
    : null;

  const stillWorkingLabel = tr("admin.abStillWorking", "Still working");
  const phaseLabel = isTimedOut
    ? elapsedMinutes
      ? // The unit belongs INSIDE the catalogue. Concatenating "m" here shipped
        // "Aún en proceso · 6m" to Spanish, where bare `m` is the SI symbol for
        // metre — Spanish abbreviates minutes as `min`.
        tr(
          "admin.abStillWorkingMinutes",
          `Still working · ${elapsedMinutes}m`,
          { minutes: elapsedMinutes },
        )
      : stillWorkingLabel
    : status === "TRANSCODING"
      ? tr("admin.abTranscoding", "Transcoding")
      : tr("admin.abUploading", "Uploading");

  // Two moving parts, both suppressed together: reduced motion, and — for
  // everyone — once we've passed the 5 minute mark. Motion that keeps implying
  // "almost there" after the job has visibly stalled is misinformation.
  const showMotion = !prefersReducedMotion && !isTimedOut;

  // Side-column float vs. full-width block layout — shared with image and
  // media-embed nodes, kept in `media-layout.ts` so all three stay in sync.
  const layoutStyle = audioLayoutStyle(attrs.align, attrs.float);

  return (
    <NodeViewWrapper data-testid="audio-block" style={layoutStyle}>
      <EditorWrapper
        {...(selected
          ? {
              // An outline, not an inset bordered div: it surrounds the edit
              // rail too, and it can't sit inside the frame competing with the
              // 2px border that is already there.
              outlineWidth: 2,
              outlineStyle: "solid" as const,
              outlineColor: "$accentHard",
              outlineOffset: 2,
            }
          : {})}
      >
        <StatusColumn
          borderLeftColor={statusRailColor}
          data-status={statusKind}
          data-testid="audio-block-status-column"
        >
          {/* ── Editor rail ──
              Edit-mode chrome lives here, above the media, in DOM order. It
              used to float over the embed on `position: absolute` and covered
              the spinner, the player's music glyph, the title and the speed
              toggle. */}
          {isEditable && (
            <EditRail
              className="th-audio-rail"
              data-testid="audio-block-edit-rail"
            >
              <RailActions>
                {/* Download toggle — only meaningful once a file exists.
                    Offering "allow download" for an asset that has not
                    resolved is a control with nothing behind it. */}
                {hasPlayer && (
                  <button
                    type="button"
                    className="th-audio-rail-btn th-audio-rail-toggle"
                    role="switch"
                    aria-checked={allowDownload}
                    aria-label={downloadToggleLabel}
                    title={downloadToggleLabel}
                    data-testid="audio-block-download-toggle"
                    onClick={() =>
                      updateAttributes({ allowDownload: !attrs.allowDownload })
                    }
                  >
                    <Download size={14} color="currentColor" />
                  </button>
                )}
                <button
                  type="button"
                  className="th-audio-rail-btn th-audio-rail-delete"
                  aria-label={tr("admin.abRemove", "Remove audio")}
                  title={tr("admin.abRemove", "Remove audio")}
                  data-testid="audio-block-delete"
                  onClick={deleteNode}
                >
                  <Trash2 size={14} color="currentColor" />
                </button>
              </RailActions>
            </EditRail>
          )}

          {/* ── Non-blocking transcode-failure notice ──
              One 24px line that shares the frame with the player below it
              (2px border, open bottom) instead of stacking a second bar
              underneath. The amber signal is carried by the status stripe. */}
          {showFailedNotice && (
            <NoticeStrip data-testid="audio-block-transcode-warning">
              <AlertCircle
                size={12}
                // $support (#F59E0B) is a graphic value, not a text value —
                // the glyph may sit on it, the words may not.
                color="var(--support, #F59E0B)"
                style={{ flexShrink: 0 }}
              />
              <Text variant="overline" color="$warningSoft">
                {tr("admin.abPlayingOriginal", "Playing the original")}
              </Text>
            </NoticeStrip>
          )}

          {/* ── Player state: full AudioPlayer ──
               Renders whenever a source resolved, including after a transcode
               FAILURE (the raw upload still plays). Inline `audioSrc` in the
               conditional so TS narrows it to `string` for the non-nullable
               AudioPlayer.src prop. On failure `waveformPeaks` is null, so the
               player simply omits the waveform. */}
          {audioSrc && (
            <AudioPlayer
              src={audioSrc}
              title={title}
              waveformPeaks={waveformPeaks}
              enableStickyPlayer={false}
              allowDownload={allowDownload}
              downloadUrl={downloadUrl}
              downloadLabel={tr("admin.abDownloadAudio", "Download audio")}
            />
          )}

          {/* ── Processing state (no audio yet) ──
               The player's silhouette, not a status bar: same 2px frame, same
               44px info row, same 56px transport row. */}
          {!hasPlayer && !isTerminallyUnplayable && (
            <MediaFrame
              role="status"
              aria-live="polite"
              aria-busy
              data-testid="audio-block-skeleton"
            >
              <FrameInfoRow>
                {isTimedOut ? (
                  <Clock
                    size={14}
                    color="var(--warningSoft, #92400E)"
                    style={{ flexShrink: 0 }}
                  />
                ) : (
                  <Spinner
                    width={14}
                    height={14}
                    borderWidth={2}
                    indicatorColor="$colorMuted"
                    // Spinner writes its rotation as an INLINE style and
                    // defaults `reducedMotion` to false, so no stylesheet rule
                    // stops it. Without this a Reduce Motion user watches the
                    // ring spin for up to five minutes.
                    reducedMotion={prefersReducedMotion}
                    // It also hardcodes role="status" aria-live="polite"
                    // aria-label="spinner". Nested inside MediaFrame's own
                    // live region that is two polite regions, the inner one
                    // announcing the word "spinner". The frame owns the
                    // announcement; the ring is ornament. `stackProps` spreads
                    // AFTER those defaults, so these win.
                    role="presentation"
                    aria-live="off"
                    aria-hidden
                    screenReaderLabel=""
                  />
                )}
                <Text
                  variant="overline"
                  color={isTimedOut ? "$warningSoft" : "$colorMuted"}
                >
                  {phaseLabel}
                </Text>
                <FrameTitleSlot>
                  <Text
                    variant="overline"
                    tone="muted"
                    truncate
                    style={{ maxWidth: "100%" }}
                  >
                    {title}
                  </Text>
                </FrameTitleSlot>
              </FrameInfoRow>

              <FrameTransportRow>
                <SkeletonPlaySlot>
                  {/* Outlined, ~30% ink: the shape of the control that will
                      land here, not a control. */}
                  <Play
                    size={22}
                    color="var(--color, #211C16)"
                    style={{ opacity: 0.3 }}
                  />
                </SkeletonPlaySlot>
                <XStack flex={1} minWidth={0} paddingHorizontal="$3">
                  <div
                    className="th-audio-skel-wave"
                    data-motion={showMotion ? "on" : "off"}
                    aria-hidden="true"
                  >
                    {SKELETON_BARS.map((height, i) => (
                      <span
                        key={i}
                        className="th-audio-skel-bar"
                        style={{
                          height: `${height}%`,
                          animationDelay: `${i * 40}ms`,
                        }}
                      />
                    ))}
                  </div>
                </XStack>
              </FrameTransportRow>
            </MediaFrame>
          )}

          {/* ── Error state (nothing playable) ──
               One box, same frame geometry. No transport skeleton: there is
               genuinely nothing to transport. */}
          {showFailedState && (
            <MediaFrame role="status" data-testid="audio-block-failed">
              <FrameInfoRow>
                <AlertCircle
                  size={14}
                  color="var(--danger, #B91C1C)"
                  style={{ flexShrink: 0 }}
                />
                <Text variant="overline" tone="error">
                  {tr("admin.abProcessingFailed", "Processing failed")}
                </Text>
                <FrameTitleSlot>
                  <Text
                    variant="overline"
                    tone="muted"
                    truncate
                    style={{ maxWidth: "100%" }}
                  >
                    {title}
                  </Text>
                </FrameTitleSlot>
              </FrameInfoRow>
              <FrameBodyRow>
                <Text variant="bodySmall" tone="muted">
                  {tr(
                    "admin.abProcessingFailedBody",
                    "We couldn't process this file. Remove it and upload again.",
                  )}
                </Text>
              </FrameBodyRow>
            </MediaFrame>
          )}
        </StatusColumn>
      </EditorWrapper>
    </NodeViewWrapper>
  );
}
