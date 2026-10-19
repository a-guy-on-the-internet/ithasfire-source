import { StrictMode, useRef } from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProseMirrorDoc } from "@th/schema";

const { FakeHls, hlsState } = vi.hoisted(() => {
  const hlsState = {
    instances: [] as InstanceType<typeof FakeHls>[],
    /** Runs inside attachMedia: lets a test mimic what real hls.js does to the element. */
    onAttach: null as ((media: HTMLMediaElement) => void) | null,
  };
  class FakeHls {
    static Events = { ERROR: "hlsError", MEDIA_ATTACHED: "hlsMediaAttached" } as const;
    static isSupported = () => true;
    loadSource = vi.fn();
    attachMedia = vi.fn((media: HTMLMediaElement) => hlsState.onAttach?.(media));
    destroy = vi.fn();
    startLoad = vi.fn();
    on = vi.fn();
    constructor() {
      hlsState.instances.push(this);
    }
  }
  return { FakeHls, hlsState };
});

// The loader seam, not "hls.js" itself: see load-hls.ts for why.
vi.mock("../load-hls", () => ({ loadHls: () => Promise.resolve(FakeHls) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import {
  proseMirrorDocToHtml,
  type AudioUrlMapEntry,
} from "@/app/admin/[slug]/events/new/_components/prose-editor/prose-utils";
import { useHydrateAudioBlocks } from "../useHydrateAudioBlocks";

/**
 * Regression: the builder Preview (and, in dev, the public event page) showed
 * the hydrated player shell with `<audio src="">` and readyState 0.
 *
 * Cause: hydration replaces the server-rendered figure's children with the
 * custom player, and the effect cleanup empties the player's `audio.src`. A
 * second effect run over the SAME DOM (React StrictMode's dev mount, unmount,
 * mount; or a deps change whose HTML is identical) re-read `<audio src>` from
 * the player it had built, found "", and skipped the figure, leaving a dead
 * shell. The spec captured on first hydration is now reused.
 */

const SOURCE = "http://localhost:9000/th-media/audio/abc/original.mp3?X-Amz-Signature=s";
const HLS = "https://cdn.example.com/audio/abc/playlist.m3u8";

function audioDoc(): ProseMirrorDoc {
  return {
    type: "doc",
    content: [
      {
        type: "audioBlock",
        attrs: { audioUploadId: "au-1", title: "test-audio" },
      },
    ] as ProseMirrorDoc["content"],
  };
}

function twoBlockDoc(): ProseMirrorDoc {
  return {
    type: "doc",
    content: [
      { type: "audioBlock", attrs: { audioUploadId: "au-1", title: "playable" } },
      { type: "audioBlock", attrs: { audioUploadId: "au-2", title: "processing" } },
    ] as ProseMirrorDoc["content"],
  };
}

/**
 * MutationObserver whose callback stops being delivered after CAP calls, so a
 * re-hydrate loop (each pass mutates the DOM, which re-fires the observer)
 * ends as a failing count instead of an endless microtask chain that freezes
 * the worker.
 */
const OBSERVER_CALLBACK_CAP = 50;
let observerCallbacks = 0;
const RealMutationObserver = globalThis.MutationObserver;
class CappedMutationObserver extends RealMutationObserver {
  constructor(cb: MutationCallback) {
    super((records, obs) => {
      observerCallbacks++;
      if (observerCallbacks > OBSERVER_CALLBACK_CAP) {
        obs.disconnect();
        return;
      }
      cb(records, obs);
    });
  }
}

const FAILED_ENTRY: AudioUrlMapEntry = {
  sourceUrl: SOURCE,
  hlsPlaylistUrl: null,
  status: "FAILED",
  waveformPeaks: null,
};

function Body({ html, tick }: { html: string; tick?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useHydrateAudioBlocks(ref, [html, tick]);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

function playerAudios(container: HTMLElement): HTMLAudioElement[] {
  return Array.from(container.querySelectorAll("audio"));
}

/** Instances still alive: created and not yet destroyed. */
function liveHls() {
  return hlsState.instances.filter((h) => h.destroy.mock.calls.length === 0);
}

async function settleImports() {
  await new Promise((r) => setTimeout(r, 0));
}

/** The original could not be signed: only the playlist resolved. */
const HLS_ONLY: AudioUrlMapEntry = {
  sourceUrl: null,
  hlsPlaylistUrl: HLS,
  status: "READY",
  waveformPeaks: null,
};

beforeEach(() => {
  hlsState.instances.length = 0;
  hlsState.onAttach = null;
  observerCallbacks = 0;
  globalThis.MutationObserver = CappedMutationObserver;
  // jsdom does not implement media playback; the player's cleanup pauses.
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  globalThis.MutationObserver = RealMutationObserver;
  vi.restoreAllMocks();
});

describe("useHydrateAudioBlocks", () => {
  it("plays the original file for a FAILED transcode (no HLS)", () => {
    const html = proseMirrorDocToHtml(audioDoc(), {}, { "au-1": FAILED_ENTRY });
    const { container } = render(<Body html={html} />);

    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe(SOURCE);
  });

  it("keeps a live src under StrictMode's double effect run", () => {
    const html = proseMirrorDocToHtml(audioDoc(), {}, { "au-1": FAILED_ENTRY });
    const { container } = render(
      <StrictMode>
        <Body html={html} />
      </StrictMode>,
    );

    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe(SOURCE);
    // The rebuilt player still shows the title, not a blank shell.
    expect(container.textContent).toContain("test-audio");
  });

  it("stays playable across a re-render with a changed dep", () => {
    const html = proseMirrorDocToHtml(audioDoc(), {}, { "au-1": FAILED_ENTRY });
    const { container, rerender } = render(<Body html={html} tick={1} />);
    rerender(<Body html={html} tick={2} />);

    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe(SOURCE);
  });

  it("picks up the new URL when the HTML itself changes", async () => {
    const first = proseMirrorDocToHtml(audioDoc(), {}, { "au-1": FAILED_ENTRY });
    const { container, rerender } = render(<Body html={first} />);
    const next = proseMirrorDocToHtml(
      audioDoc(),
      {},
      { "au-1": { ...FAILED_ENTRY, sourceUrl: null, hlsPlaylistUrl: HLS, status: "READY" } },
    );
    rerender(<Body html={next} />);
    await settleImports();

    // jsdom reports no native HLS, so the playlist goes through hls.js.
    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(liveHls()).toHaveLength(1);
    expect(liveHls()[0].loadSource).toHaveBeenCalledWith(HLS);
    expect(liveHls()[0].attachMedia).toHaveBeenCalledWith(audios[0]);
  });

  it("plays an HLS-only block natively where the browser can", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    const html = proseMirrorDocToHtml(audioDoc(), {}, { "au-1": HLS_ONLY });
    const { container } = render(<Body html={html} />);
    await settleImports();

    expect(playerAudios(container)[0].getAttribute("src")).toBe(HLS);
    expect(hlsState.instances).toHaveLength(0);
  });

  it("an HLS-only block under StrictMode ends with exactly one live hls.js instance", async () => {
    const html = proseMirrorDocToHtml(audioDoc(), {}, { "au-1": HLS_ONLY });
    const { container, unmount } = render(
      <StrictMode>
        <Body html={html} />
      </StrictMode>,
    );
    await settleImports();

    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(liveHls()).toHaveLength(1);
    expect(liveHls()[0].attachMedia).toHaveBeenCalledWith(audios[0]);
    // The first mount's import was cleaned up before it resolved: it never
    // created an instance, so nothing attached to a discarded element.
    expect(hlsState.instances).toHaveLength(1);

    unmount();
    expect(liveHls()).toHaveLength(0);
  });

  it("hls.js rewriting the element (blob: src, <source> child) does not re-hydrate", async () => {
    // What real hls.js does on attach: a blob: MediaSource URL as src, and on
    // ManagedMediaSource (Safari 17+) a <source> child, a childList mutation
    // inside the observed container.
    hlsState.onAttach = (media) => {
      media.setAttribute("src", "blob:http://localhost/ms-1");
      const source = document.createElement("source");
      source.src = "blob:http://localhost/ms-1";
      media.appendChild(source);
    };
    const html = proseMirrorDocToHtml(
      twoBlockDoc(),
      {},
      {
        "au-1": HLS_ONLY,
        "au-2": { sourceUrl: null, hlsPlaylistUrl: null, status: "TRANSCODING" },
      },
    );
    const { container } = render(<Body html={html} />);
    await settleImports();

    // A later observer tick inside the body (the time label while playing).
    playerAudios(container)[0].parentElement!.appendChild(document.createTextNode(" "));
    await settleImports();

    expect(observerCallbacks).toBeLessThan(5);
    expect(hlsState.instances).toHaveLength(1);
    expect(liveHls()).toHaveLength(1);
    expect(playerAudios(container)).toHaveLength(1);
    expect(container.textContent).toContain("processing");
  }, 5_000);

  it("offers download only for the direct file, never the playlist", () => {
    const doc = (allowDownload: boolean): ProseMirrorDoc => ({
      type: "doc",
      content: [
        { type: "audioBlock", attrs: { audioUploadId: "au-1", title: "t", allowDownload } },
      ] as ProseMirrorDoc["content"],
    });
    const hlsOnly = render(
      <Body html={proseMirrorDocToHtml(doc(true), {}, { "au-1": HLS_ONLY })} />,
    );
    expect(hlsOnly.container.querySelector('button[aria-label="Download audio"]')).toBeNull();
    hlsOnly.unmount();

    const direct = render(
      <Body html={proseMirrorDocToHtml(doc(true), {}, { "au-1": FAILED_ENTRY })} />,
    );
    expect(direct.container.querySelector('button[aria-label="Download audio"]')).not.toBeNull();
  });

  it("leaves the processing placeholder alone when nothing is playable", () => {
    const html = proseMirrorDocToHtml(
      audioDoc(),
      {},
      { "au-1": { sourceUrl: null, hlsPlaylistUrl: null, status: "TRANSCODING" } },
    );
    const { container } = render(
      <StrictMode>
        <Body html={html} />
      </StrictMode>,
    );

    expect(playerAudios(container)).toHaveLength(0);
    expect(container.textContent).toContain("test-audio");
  });

  it("a placeholder beside a playable block does not loop re-hydration", async () => {
    const html = proseMirrorDocToHtml(
      twoBlockDoc(),
      {},
      {
        "au-1": FAILED_ENTRY,
        "au-2": { sourceUrl: null, hlsPlaylistUrl: null, status: "TRANSCODING" },
      },
    );
    const { container } = render(
      <StrictMode>
        <Body html={html} />
      </StrictMode>,
    );

    // Any later childList mutation inside the body (the player's own time
    // label updating while it plays does exactly this) wakes the observer.
    const live = playerAudios(container)[0];
    live.parentElement!.appendChild(document.createTextNode(" "));
    await new Promise((r) => setTimeout(r, 20));

    expect(observerCallbacks).toBeLessThan(5);
    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe(SOURCE);
    expect(container.textContent).toContain("processing");
  }, 5_000);
  it("a placeholder beside a playable block does not loop re-hydration (no StrictMode, as in production)", async () => {
    const html = proseMirrorDocToHtml(
      twoBlockDoc(),
      {},
      {
        "au-1": FAILED_ENTRY,
        "au-2": { sourceUrl: null, hlsPlaylistUrl: null, status: "TRANSCODING" },
      },
    );
    const { container } = render(
      <Body html={html} />,
    );

    // Any later childList mutation inside the body (the player's own time
    // label updating while it plays does exactly this) wakes the observer.
    const live = playerAudios(container)[0];
    live.parentElement!.appendChild(document.createTextNode(" "));
    await new Promise((r) => setTimeout(r, 20));

    expect(observerCallbacks).toBeLessThan(5);
    const audios = playerAudios(container);
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe(SOURCE);
    expect(container.textContent).toContain("processing");
  }, 5_000);
});
