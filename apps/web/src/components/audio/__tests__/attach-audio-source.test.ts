import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeHls, hlsState, captureException, loadHls } = vi.hoisted(() => {
  const hlsState = {
    supported: true,
    instances: [] as InstanceType<typeof FakeHls>[],
  };
  class FakeHls {
    static Events = { ERROR: "hlsError", MEDIA_ATTACHED: "hlsMediaAttached" } as const;
    static isSupported = () => hlsState.supported;
    config: unknown;
    handlers = new Map<string, ((event: string, data: unknown) => void)[]>();
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    startLoad = vi.fn();
    constructor(config?: unknown) {
      this.config = config;
      hlsState.instances.push(this);
    }
    on(event: string, cb: (event: string, data: unknown) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string, data: unknown) {
      for (const cb of this.handlers.get(event) ?? []) cb(event, data);
    }
  }
  return {
    FakeHls,
    hlsState,
    captureException: vi.fn(),
    loadHls: vi.fn<[], Promise<unknown>>(),
  };
});

// The loader seam, not "hls.js" itself: see load-hls.ts for why.
vi.mock("../load-hls", () => ({ loadHls }));
vi.mock("@sentry/nextjs", () => ({ captureException }));

import { attachAudioSource, isHlsPlaylistUrl } from "../attach-audio-source";

const MP3 = "https://cdn.example.com/audio/abc/original.mp3?X-Amz-Signature=s";
const HLS = "https://cdn.example.com/audio/abc/playlist.m3u8?X-Amz-Signature=s";

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

function makeAudio(native: CanPlayTypeResult = ""): HTMLAudioElement {
  const audio = document.createElement("audio");
  vi.spyOn(audio, "canPlayType").mockReturnValue(native);
  return audio;
}

beforeEach(() => {
  hlsState.supported = true;
  hlsState.instances.length = 0;
  captureException.mockReset();
  loadHls.mockReset();
  loadHls.mockImplementation(() => Promise.resolve(FakeHls));
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  // jsdom implements no playback; a resolved play() keeps the replay quiet.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isHlsPlaylistUrl", () => {
  it.each([
    [HLS, true],
    ["/audio/x/PLAYLIST.M3U8", true],
    ["https://cdn.example.com/a.m3u8#t=3", true],
    [MP3, false],
    ["https://cdn.example.com/a.mp3?next=playlist.m3u8", false],
  ])("%s -> %s", (url, expected) => {
    expect(isHlsPlaylistUrl(url)).toBe(expected);
  });
});

describe("attachAudioSource", () => {
  it("sets a direct file as the src and loads no hls.js", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, MP3);
    expect(audio.getAttribute("src")).toBe(MP3);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
  });

  it("hands a playlist straight to a browser with native HLS", async () => {
    const audio = makeAudio("maybe");
    attachAudioSource(audio, HLS);
    expect(audio.getAttribute("src")).toBe(HLS);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
  });

  it("plays a playlist through hls.js without native HLS", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    // Never the raw playlist on an element that cannot play it.
    expect(audio.getAttribute("src")).toBeNull();
    await settle();

    expect(hlsState.instances).toHaveLength(1);
    const [hls] = hlsState.instances;
    expect(hls.loadSource).toHaveBeenCalledWith(HLS);
    expect(hls.attachMedia).toHaveBeenCalledWith(audio);
  });

  it("falls back to the element src when MSE is unsupported", async () => {
    hlsState.supported = false;
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
    expect(audio.getAttribute("src")).toBe(HLS);
  });

  it("cleanup before the import resolves creates and attaches nothing", async () => {
    const audio = makeAudio();
    const detach = attachAudioSource(audio, HLS);
    detach();
    await settle();
    expect(hlsState.instances).toHaveLength(0);
    expect(audio.getAttribute("src")).toBeNull();
  });

  it("cleanup destroys the instance, once", async () => {
    const audio = makeAudio();
    const detach = attachAudioSource(audio, HLS);
    await settle();
    detach();
    detach();
    expect(hlsState.instances[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("ignores non-fatal errors", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    await settle();
    const [hls] = hlsState.instances;
    hls.emit("hlsError", { fatal: false, type: "networkError", details: "fragLoadError" });
    expect(hls.destroy).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("a fatal error destroys, reports once, and fires the element's error event", async () => {
    const audio = makeAudio();
    const onError = vi.fn();
    audio.addEventListener("error", onError);
    const detach = attachAudioSource(audio, HLS);
    await settle();
    const [hls] = hlsState.instances;

    const fatal = { fatal: true, type: "networkError", details: "manifestLoadError" };
    hls.emit("hlsError", fatal);
    hls.emit("hlsError", fatal);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0];
    expect(String(err)).toContain("manifestLoadError");
    // No URL (signed links) in the report.
    expect(JSON.stringify(ctx)).not.toContain("cdn.example.com");
    expect(String(err)).not.toContain("cdn.example.com");
    expect(onError).toHaveBeenCalled();

    // Cleanup after the fatal destroy does not destroy a second time.
    const destroysBefore = hls.destroy.mock.calls.length;
    detach();
    expect(hls.destroy.mock.calls.length).toBe(destroysBefore);
  });

  it("a throwing reporter does not change behaviour", async () => {
    captureException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const audio = makeAudio();
    const onError = vi.fn();
    audio.addEventListener("error", onError);
    attachAudioSource(audio, HLS);
    await settle();
    const [hls] = hlsState.instances;
    expect(() =>
      hls.emit("hlsError", { fatal: true, type: "mediaError", details: "bufferAppendError" }),
    ).not.toThrow();
    expect(hls.destroy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});

/** Give the element a real MediaError code, as a failed native load would. */
function failNatively(audio: HTMLAudioElement, code: number | null) {
  Object.defineProperty(audio, "error", {
    configurable: true,
    value: code === null ? null : { code },
  });
  audio.dispatchEvent(new Event("error"));
}

describe("attachAudioSource: load on play (preload=metadata)", () => {
  it("creates hls.js with autoStartLoad off and loads segments only on play", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    await settle();
    const [hls] = hlsState.instances;
    expect(hls.config).toEqual({ autoStartLoad: false });
    expect(hls.startLoad).not.toHaveBeenCalled();

    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("play"));
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(hls.startLoad).toHaveBeenCalledWith(-1);
  });

  it("cleanup removes the play listener", async () => {
    const audio = makeAudio();
    const detach = attachAudioSource(audio, HLS);
    await settle();
    const [hls] = hlsState.instances;
    detach();
    audio.dispatchEvent(new Event("play"));
    expect(hls.startLoad).not.toHaveBeenCalled();
  });
});

describe("attachAudioSource: a play tapped before hls.js is attached", () => {
  it("is played again once the media is attached", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    // The tap lands while the import is still in flight.
    audio.dispatchEvent(new Event("play"));
    await settle();
    const [hls] = hlsState.instances;
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    expect(play).not.toHaveBeenCalled();

    hls.emit("hlsMediaAttached", {});
    expect(play).toHaveBeenCalledTimes(1);
    expect(hls.startLoad).toHaveBeenCalledWith(-1);

    // Only once.
    hls.emit("hlsMediaAttached", {});
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("is not replayed when it was paused again before attach", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("pause"));
    await settle();
    hlsState.instances[0].emit("hlsMediaAttached", {});
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("nothing is played on attach without a tap", async () => {
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    await settle();
    hlsState.instances[0].emit("hlsMediaAttached", {});
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(hlsState.instances[0].startLoad).not.toHaveBeenCalled();
  });
});

describe("attachAudioSource: hls.js chunk fails to load", () => {
  it("reports once and falls back to the element src", async () => {
    loadHls.mockImplementation(() => Promise.reject(new Error("ChunkLoadError")));
    const audio = makeAudio();
    attachAudioSource(audio, HLS);
    await settle();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1]).toMatchObject({
      tags: { source: "audio-hls", hlsErrorType: "import" },
    });
    expect(audio.getAttribute("src")).toBe(HLS);
  });

  it("disposed before the rejection: no report, no src", async () => {
    let rejectLoad: (err: unknown) => void = () => {};
    loadHls.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectLoad = reject)),
    );
    const audio = makeAudio();
    const detach = attachAudioSource(audio, HLS);
    detach();
    rejectLoad(new Error("ChunkLoadError"));
    await settle();
    expect(captureException).not.toHaveBeenCalled();
    expect(audio.getAttribute("src")).toBeNull();
  });
});

describe("attachAudioSource: native HLS that cannot play the playlist", () => {
  it.each([
    ["source not supported", 4],
    ["decode error", 3],
  ])("moves to hls.js once on %s", async (_label, code) => {
    const audio = makeAudio("maybe");
    const detach = attachAudioSource(audio, HLS);
    expect(audio.getAttribute("src")).toBe(HLS);

    failNatively(audio, code);
    // The failed native src is dropped before hls.js takes over.
    expect(audio.getAttribute("src")).toBeNull();
    await settle();
    expect(hlsState.instances).toHaveLength(1);
    expect(hlsState.instances[0].attachMedia).toHaveBeenCalledWith(audio);

    // One-shot: a second native error does not start a second instance.
    failNatively(audio, code);
    await settle();
    expect(hlsState.instances).toHaveLength(1);

    detach();
    expect(hlsState.instances[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("the synthetic error (no MediaError) does not switch", async () => {
    const audio = makeAudio("maybe");
    attachAudioSource(audio, HLS);
    failNatively(audio, null);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
    expect(audio.getAttribute("src")).toBe(HLS);
  });

  it("an error after metadata loaded does not switch", async () => {
    const audio = makeAudio("maybe");
    attachAudioSource(audio, HLS);
    audio.dispatchEvent(new Event("loadedmetadata"));
    failNatively(audio, 4);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
  });

  it("other media errors (network) do not switch", async () => {
    const audio = makeAudio("maybe");
    attachAudioSource(audio, HLS);
    failNatively(audio, 2);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
  });

  it("without MSE the failed playlist is not handed back to the element", async () => {
    hlsState.supported = false;
    const audio = makeAudio("maybe");
    attachAudioSource(audio, HLS);
    failNatively(audio, 4);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
    expect(audio.getAttribute("src")).toBeNull();
  });

  it("cleanup before any error removes the fallback listener", async () => {
    const audio = makeAudio("maybe");
    const detach = attachAudioSource(audio, HLS);
    detach();
    failNatively(audio, 4);
    await settle();
    expect(hlsState.instances).toHaveLength(0);
  });
});

describe("attachAudioSource: element that already holds a file", () => {
  it("drops the old file before importing hls.js", () => {
    const audio = makeAudio();
    audio.src = MP3;
    attachAudioSource(audio, HLS);
    expect(audio.getAttribute("src")).toBeNull();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });
});
