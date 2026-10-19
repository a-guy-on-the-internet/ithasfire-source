# Audio Player v2 — Waveform, Sticky Mini-Player, Playback Speed

**Date:** 2026-04-25  
**Status:** complete  
**Priority:** P2 (High Value)  
**Depends on:** AudioUpload model, audio-transcoder service, AudioPlayer component  
**Supersedes:** n/a (extends existing audio pipeline)  

---

## Problem

The current audio player is a flat progress bar with no visual representation of the audio content. Users can't see where the interesting parts are, can't speed up spoken content, and lose the player when they scroll past it to read the rest of the event description. This makes audio feel like an afterthought rather than a first-class feature.

---

## Goal

Transform the audio player into a polished, professional-grade experience: a waveform visualization that shows the shape of the audio and fills with color as it plays, a sticky mini-player that persists while scrolling, and playback speed control for spoken content. Architected for cross-platform use (web now, React Native via expo-av later).

---

## Context

| What exists | Where |
|---|---|
| AudioUpload Prisma model | `packages/db/prisma/event.prisma` (lines 431-475) |
| Transcode use case | `apps/audio-transcoder/src/use-cases/transcode-audio.ts` |
| FfmpegTranscoder adapter | `packages/adapters/src/transcoder/ffmpeg/ffmpeg-transcoder.ts` |
| TranscoderPort interface | `packages/ports/src/transcoder.ts` |
| Resolve audio use case | `packages/core/src/use-cases/events/resolve-event-audio.ts` |
| AudioPlayer component | `apps/web/src/components/audio/AudioPlayer.tsx` |
| AudioBlockNodeView (editor) | `apps/web/.../prose-editor/extensions/AudioBlockNodeView.tsx` |
| Hydration hook (preview/public) | `apps/web/src/components/audio/useHydrateAudioBlocks.tsx` |

---

## Data Model

### Prisma additions

```prisma
model AudioUpload {
  // ... existing fields ...

  /// JSON array of normalized amplitudes (0.0–1.0), typically 200 samples.
  /// Computed by the transcoder during HLS conversion via ffmpeg's
  /// astats/ebur128 filter. Null until transcoding completes.
  waveformPeaks     Json?     @db.JsonB
}
```

### Why `waveformPeaks` as JSONB on the model (not a separate file)

- **Size**: 200 floats = ~1.2 KB JSON. Trivial for a JSONB column.
- **Latency**: No extra R2 fetch. The `resolveAudio` query already loads audio upload rows; waveform comes for free.
- **Mobile**: React Native doesn't need to fetch a separate URL — it's in the tRPC response.
- **Indexing**: Not needed. Never queried by value.

### Shape

```typescript
// packages/types/src/repos/audio-uploads.ts
type WaveformPeaks = number[]; // 200 values, each 0.0–1.0
```

---

## Use Cases

### 1. Extract waveform during transcoding

**Where:** `apps/audio-transcoder/src/use-cases/transcode-audio.ts`  
**Port change:** Extend `TranscodeOutput` in `packages/ports/src/transcoder.ts`:

```typescript
export interface TranscodeOutput {
  // ... existing fields ...
  /** Normalized peak amplitudes, typically 200 samples. */
  waveformPeaks: number[];
}
```

**FFmpeg implementation:** After transcoding to HLS, run a second pass on the source file:

```bash
ffmpeg -i source.mp3 -af "aresample=8000,asetnsamples=n=200:p=0" \
  -f null -vn -hide_banner - 2>&1 | parse_peaks
```

Alternative (more reliable): use `ffprobe` with `astats` to extract per-frame RMS, then downsample to 200 bins and normalize to 0.0–1.0. The adapter already has the source file downloaded locally for transcoding, so this adds ~1-2s of processing.

**Repo change:** Extend `MarkAudioTranscodedInput`:

```typescript
export interface MarkAudioTranscodedInput {
  // ... existing fields ...
  waveformPeaks?: number[];
}
```

### 2. Expose waveform in resolveAudio

**Where:** `packages/core/src/use-cases/events/resolve-event-audio.ts`

Add `waveformPeaks` to the output schema:

```typescript
const audioUploadItemSchema = z.object({
  // ... existing fields ...
  waveformPeaks: z.array(z.number()).nullable(),
});
```

This flows through the existing `resolveAudio` tRPC query and the 10s polling interval. No new endpoint needed.

---

## UI / Flow

### Component Architecture

```
AudioPlayer (shared, cross-platform ready)
├── WaveformDisplay (SVG bars, fills with accent color)
├── ProgressBar (fallback when no waveform data)
├── PlayButton (play/pause toggle)
├── TimeDisplay (current / duration, tabular-nums)
├── SpeedToggle (cycles 1x → 1.25x → 1.5x → 2x)
└── <audio> element (hidden, web) / expo-av Sound (mobile)

MiniStickyPlayer (web only, viewport-pinned)
├── Compact layout: play/pause + title + mini progress + time + speed
└── Appears via IntersectionObserver when main player scrolls out of view
```

### A. Waveform Display

- **Input**: `waveformPeaks: number[]` (200 values, 0.0–1.0)
- **Rendering**: SVG with 200 vertical `<rect>` bars. Each bar width = container width / 200, height = peak * max height.
- **Progress fill**: Bars left of the playhead render in `$accentHard` (steel blue). Bars right render in `$borderColor` (muted). The split point is `(currentTime / duration) * 200`.
- **Interaction**: Click/drag on the waveform to seek (same as current ProgressBar but mapped to bar positions). Touch-friendly — each bar is a valid seek target.
- **Fallback**: When `waveformPeaks` is null (legacy uploads, processing), render the existing flat ProgressBar.
- **Swiss style**: No rounded bar caps. Bars are sharp rectangles with 1px gap between them. Container has 2px border, 0 border-radius.

### B. Mini Sticky Player

- **Trigger**: `IntersectionObserver` on the main player element. When it leaves the viewport (scrolled past), the mini player slides up from the bottom with `transform: translateY(0)` transition (200ms ease-out).
- **Layout**: Fixed-position bar at viewport bottom, 48px height, full viewport width. Contains: play/pause (left), title (truncated, center), mini progress bar (thin 2px line), time, speed button, close X.
- **Z-index**: Above page content, below modals.
- **Dismiss**: Close button, or scrolling the main player back into view.
- **Scope**: Only one mini player at a time (if multiple audio blocks exist, the last one scrolled past wins).
- **Mobile web**: Same behavior, but play button and close button are minimum 44x44.
- **Not for React Native**: Mobile apps will use the OS media controls (lock screen / notification) via expo-av instead.

### C. Playback Speed Toggle

- **Button**: Small pill in the info bar showing current speed (e.g., "1x"). Cycles on click: 1x → 1.25x → 1.5x → 2x → 1x.
- **Implementation**: `audio.playbackRate = speed`. Persisted in `useState` per player instance (not cross-page persistent).
- **Visual**: When speed !== 1x, the button highlights in `$brandSecondary` (orange) to signal non-default state.
- **Mobile**: Same behavior with expo-av's `Sound.setRateAsync(rate, shouldCorrectPitch: true)`.

### D. Updated AudioPlayer Props

```typescript
export interface AudioPlayerProps {
  src: string;
  title?: string;
  waveformPeaks?: number[] | null;
}
```

The `AudioBlockNodeView` (editor) passes waveform from the resolved audio attrs. The `useHydrateAudioBlocks` hook extracts it from a `data-waveform` attribute on the `<figure>` element (added by `renderHTML`).

---

## Acceptance Criteria

- [ ] Transcoder extracts waveform peaks (200 samples, 0-1 normalized) and stores in `AudioUpload.waveformPeaks`
- [ ] `resolveAudio` returns waveform data to the frontend
- [ ] Waveform renders as SVG bars filling with accent color during playback
- [ ] Click/drag on waveform seeks to the corresponding time position
- [ ] Fallback to flat progress bar when waveform data is not available
- [ ] Mini sticky player appears when the main player scrolls out of view
- [ ] Mini sticky player disappears when the main player scrolls back into view or user dismisses
- [ ] Playback speed cycles through 1x / 1.25x / 1.5x / 2x
- [ ] Speed button highlights orange when not at 1x
- [ ] Waveform displays identically in editor, preview tab, and public event page
- [ ] E2E test: upload audio → verify waveform renders after transcoding
- [ ] Keyboard: ArrowLeft/Right seeks, Space toggles play/pause on focused waveform

---

## Open Questions

- **Waveform sample count**: 200 is a good balance between visual fidelity and payload size. Should we support responsive sample counts (fewer bars on mobile, more on desktop) or always render 200 and let SVG scale?
- **Waveform extraction method**: `ffprobe astats` vs `ffmpeg showwavespic` vs raw PCM analysis. Need to benchmark which is fastest and most reliable on short files (< 30s) vs long files (> 10min).
- **Mini player scope**: Should it work on the public event detail page too, or only in the admin editor/preview? Public pages have their own scroll context and footer that might conflict.
- **Offline waveform backfill**: Should we run a one-time job to compute waveform data for existing transcoded uploads, or only compute for new uploads going forward?
