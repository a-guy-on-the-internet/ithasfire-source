/**
 * FR-012 — fallback QR decoder for browsers without `BarcodeDetector`.
 *
 * The load-bearing test is `decodes a real QR ... with BarcodeDetector
 * deleted`: it deletes the native API exactly as the spec's acceptance
 * criterion words it, renders a real QR bitmap with `qrcode-generator`,
 * hands it to the hook through a stubbed 2D context, and asserts the REAL
 * jsQR decodes it. Nothing about the decode path is mocked in that test.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import qrcode from "qrcode-generator";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CAMERA_DECODER_UNAVAILABLE_MESSAGE,
  useBrowserCamera,
} from "../use-browser-camera";
import {
  QR_ANALYSIS_INTERVAL_MS,
  QR_ANALYSIS_MAX_DUTY_CYCLE,
  loadQrFallbackDecoder,
} from "../qr-decode-fallback";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// Wrap the REAL loader in a spy: tests that want the genuine jsQR path get
// it, and the throttle/failure tests can override per-case.
vi.mock("../qr-decode-fallback", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../qr-decode-fallback")>();
  return { ...actual, loadQrFallbackDecoder: vi.fn(actual.loadQrFallbackDecoder) };
});

// ── Frame-loop harness ────────────────────────────────────────────────────

const FRAME_MS = 1000 / 60;
const VIDEO_EDGE = 640;
const TICKET_CODE = "HF7K2M9Q";

let clock = 0;
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRafId = 1;
let stoppedTracks = 0;
let frameData: Uint8ClampedArray | null = null;
let getImageDataCalls = 0;

/** Advance `frames` display frames, running whatever the hook scheduled. */
async function pumpFrames(frames: number) {
  for (let i = 0; i < frames; i += 1) {
    clock += FRAME_MS;
    await act(async () => {
      const due = rafQueue;
      rafQueue = [];
      for (const entry of due) entry.cb(clock);
      // Let the promise chains inside the detect/decode paths settle.
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

/** Wait until the hook's async start-up has scheduled its first frame. */
async function waitForLoopStart() {
  await waitFor(() => expect(rafQueue.length).toBeGreaterThan(0));
}

function makeStream() {
  return {
    getTracks: () => [
      {
        stop: () => {
          stoppedTracks += 1;
        },
      },
    ],
  } as unknown as MediaStream;
}

/**
 * Render a real QR into an RGBA buffer: white background, black modules,
 * 4-module quiet zone — i.e. what the camera sees when it looks at the
 * forced-white QR surface `OrderDetail.tsx` renders.
 */
function renderQrFrame(text: string, size: number): Uint8ClampedArray {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 4;
  const total = modules + quiet * 2;
  const scale = Math.floor(size / total);
  const drawn = total * scale;
  const offset = Math.floor((size - drawn) / 2);

  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x0 = offset + (col + quiet) * scale;
      const y0 = offset + (row + quiet) * scale;
      for (let y = y0; y < y0 + scale; y += 1) {
        for (let x = x0; x < x0 + scale; x += 1) {
          const idx = (y * size + x) * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
        }
      }
    }
  }
  return data;
}

function Harness(props: { enabled: boolean; onScan: (data: string) => void }) {
  const { videoRef, cameraError } = useBrowserCamera(props);
  return (
    <>
      <video ref={videoRef} data-testid="video" />
      <span data-testid="camera-error">{cameraError ?? ""}</span>
    </>
  );
}

beforeEach(() => {
  clock = 0;
  rafQueue = [];
  nextRafId = 1;
  stoppedTracks = 0;
  getImageDataCalls = 0;
  frameData = null;
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(loadQrFallbackDecoder).mockClear();

  vi.spyOn(performance, "now").mockImplementation(() => clock);

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(() => Promise.resolve(makeStream())) },
  });

  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    get: () => 4,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => VIDEO_EDGE,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => VIDEO_EDGE,
  });

  // jsdom has no canvas backend; stand in for one and serve whatever frame
  // the current test set up.
  HTMLCanvasElement.prototype.getContext = vi.fn(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, width: number, height: number) => {
        getImageDataCalls += 1;
        return {
          data:
            frameData ?? new Uint8ClampedArray(width * height * 4).fill(255),
          width,
          height,
        };
      },
    };
  }) as unknown as HTMLCanvasElement["getContext"];

  delete (window as unknown as Record<string, unknown>).BarcodeDetector;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).BarcodeDetector;
});

// ── Acceptance criterion ──────────────────────────────────────────────────

describe("useBrowserCamera — FR-012 fallback decoder", () => {
  it("decodes a real QR through jsQR with BarcodeDetector deleted", async () => {
    // The spec's literal wording. Assert the precondition rather than
    // assuming it — if a future jsdom ever ships BarcodeDetector this test
    // must fail loudly instead of quietly testing the native path.
    delete (window as unknown as Record<string, unknown>).BarcodeDetector;
    expect("BarcodeDetector" in window).toBe(false);

    frameData = renderQrFrame(TICKET_CODE, VIDEO_EDGE);
    const onScan = vi.fn();
    render(<Harness enabled onScan={onScan} />);

    await waitForLoopStart();
    await pumpFrames(4);

    expect(onScan).toHaveBeenCalledWith(TICKET_CODE);
    expect(vi.mocked(loadQrFallbackDecoder)).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("camera-error")).toHaveTextContent("");
  });

  it("never reaches for the fallback when BarcodeDetector exists", async () => {
    const detect = vi.fn(() => Promise.resolve([]));
    (window as unknown as Record<string, unknown>).BarcodeDetector = class {
      detect = detect;
    };

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(30);

    expect(detect).toHaveBeenCalled();
    expect(vi.mocked(loadQrFallbackDecoder)).not.toHaveBeenCalled();
    // And no frame was ever grabbed for a JS decode.
    expect(getImageDataCalls).toBe(0);
  });

  it("keeps jsqr behind a dynamic import in every scan component", () => {
    // Bundle guard: a static `import ... from "jsqr"` anywhere in this
    // folder would put ~47 KB gzip into the chunk every browser downloads,
    // native BarcodeDetector or not.
    const dir = join(__dirname, "..");
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .map((f) => readFileSync(join(dir, f), "utf8"));

    for (const src of sources) {
      expect(src).not.toMatch(/^\s*import[^\n]*["']jsqr["']/m);
    }
    const fallback = readFileSync(join(dir, "qr-decode-fallback.ts"), "utf8");
    expect(fallback).toMatch(/await import\("jsqr"\)/);
  });
});

// ── NFR-003 throttle ──────────────────────────────────────────────────────

describe("useBrowserCamera — analysis throttle (NFR-003)", () => {
  it("caps fallback decode attempts at 10 per simulated second", async () => {
    const decode = vi.fn(() => null);
    vi.mocked(loadQrFallbackDecoder).mockResolvedValueOnce({ decode });

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();

    // 60 display frames ≈ 1s of wall clock.
    await pumpFrames(60);

    expect(decode.mock.calls.length).toBeLessThanOrEqual(10);
    expect(decode.mock.calls.length).toBeGreaterThanOrEqual(9);
    // The loop still woke every frame — that's what makes it stop when the
    // tab backgrounds — it just declined to analyse most of them.
    expect(decode.mock.calls.length).toBeLessThan(60);
  });

  it("caps native BarcodeDetector detect() calls at 10 per simulated second", async () => {
    const detect = vi.fn(() => Promise.resolve([]));
    (window as unknown as Record<string, unknown>).BarcodeDetector = class {
      detect = detect;
    };

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(60);

    expect(detect.mock.calls.length).toBeLessThanOrEqual(10);
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("leaves at least the throttle interval between consecutive decodes", async () => {
    const stamps: number[] = [];
    vi.mocked(loadQrFallbackDecoder).mockResolvedValueOnce({
      decode: () => {
        stamps.push(clock);
        return null;
      },
    });

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(60);

    expect(stamps.length).toBeGreaterThan(1);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(
        QR_ANALYSIS_INTERVAL_MS,
      );
    }
  });

  it("backs off proportionally when a decode is expensive (duty-cycle governor)", async () => {
    // Real measured jsQR cost on a 640-edge frame is 35-205 ms. A flat 10 fps
    // at that cost pins a core, so an expensive decode must widen the gap.
    const DECODE_COST_MS = 90;
    const starts: number[] = [];
    vi.mocked(loadQrFallbackDecoder).mockResolvedValueOnce({
      decode: () => {
        starts.push(clock);
        clock += DECODE_COST_MS; // the mocked `performance.now` reads `clock`
        return null;
      },
    });

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(180);

    expect(starts.length).toBeGreaterThan(2);
    const span = starts[starts.length - 1] - starts[0];
    const spent = (starts.length - 1) * DECODE_COST_MS;
    // Never more than the configured share of wall-clock time in the decoder.
    expect(spent / span).toBeLessThanOrEqual(QR_ANALYSIS_MAX_DUTY_CYCLE + 0.01);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(
        DECODE_COST_MS / QR_ANALYSIS_MAX_DUTY_CYCLE,
      );
    }
  });

  it("still runs at the full 10 fps when decodes are cheap", async () => {
    const starts: number[] = [];
    vi.mocked(loadQrFallbackDecoder).mockResolvedValueOnce({
      decode: () => {
        starts.push(clock);
        clock += 4; // a cheap decode must not be punished by the governor
        return null;
      },
    });

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(60);

    // ~1s of frames, cheap decodes → the 10 fps floor, not the governor.
    expect(starts.length).toBeGreaterThanOrEqual(8);
    expect(starts.length).toBeLessThanOrEqual(10);
  });
});

// ── NFR-006 catch-and-degrade ─────────────────────────────────────────────

describe("useBrowserCamera — decoder init failure (NFR-006)", () => {
  it("reports to Sentry, releases the camera, and explains the degrade", async () => {
    const bang = new Error("Failed to fetch dynamically imported module");
    vi.mocked(loadQrFallbackDecoder).mockRejectedValueOnce(bang);

    render(<Harness enabled onScan={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-error")).toHaveTextContent(
        CAMERA_DECODER_UNAVAILABLE_MESSAGE,
      ),
    );

    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      bang,
      expect.objectContaining({
        tags: expect.objectContaining({
          feature: "web-scan-camera",
          reason: "fallback-decoder-init",
        }),
      }),
    );
    // Never leave a live-but-dead viewfinder burning battery.
    expect(stoppedTracks).toBeGreaterThan(0);
    await pumpFrames(30);
    expect(getImageDataCalls).toBe(0);
  });

  it("tolerates transient frame failures, then degrades and reports", async () => {
    let calls = 0;
    vi.mocked(loadQrFallbackDecoder).mockResolvedValueOnce({
      decode: () => {
        calls += 1;
        throw new Error("drawImage failed");
      },
    });

    render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(60);

    // 5 consecutive failures is the give-up threshold, not 1.
    expect(calls).toBe(5);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "fallback-decoder-frame" }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("camera-error")).toHaveTextContent(
        CAMERA_DECODER_UNAVAILABLE_MESSAGE,
      ),
    );
  });

  it("does not let a throwing reporter change scan behaviour", async () => {
    vi.mocked(Sentry.captureException).mockImplementation(() => {
      throw new Error("sentry is down");
    });
    vi.mocked(loadQrFallbackDecoder).mockRejectedValueOnce(new Error("nope"));

    render(<Harness enabled onScan={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-error")).toHaveTextContent(
        CAMERA_DECODER_UNAVAILABLE_MESSAGE,
      ),
    );
  });
});

// ── Lifecycle / enabled-gate semantics (unchanged public contract) ────────

describe("useBrowserCamera — lifecycle", () => {
  it("never opens the camera while disabled", async () => {
    render(<Harness enabled={false} onScan={vi.fn()} />);
    await pumpFrames(10);

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(vi.mocked(loadQrFallbackDecoder)).not.toHaveBeenCalled();
  });

  it("stops the stream and the decode loop when disabled", async () => {
    const decode = vi.fn(() => null);
    vi.mocked(loadQrFallbackDecoder).mockResolvedValue({ decode });

    const { rerender } = render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(20);
    const beforeDisable = decode.mock.calls.length;
    expect(beforeDisable).toBeGreaterThan(0);

    rerender(<Harness enabled={false} onScan={vi.fn()} />);
    await pumpFrames(30);

    expect(stoppedTracks).toBeGreaterThan(0);
    expect(decode.mock.calls.length).toBe(beforeDisable);
    expect(rafQueue).toHaveLength(0);
  });

  it("stops decoding after unmount", async () => {
    const decode = vi.fn(() => null);
    vi.mocked(loadQrFallbackDecoder).mockResolvedValue({ decode });

    const { unmount } = render(<Harness enabled onScan={vi.fn()} />);
    await waitForLoopStart();
    await pumpFrames(20);
    const beforeUnmount = decode.mock.calls.length;

    unmount();
    await pumpFrames(30);

    expect(decode.mock.calls.length).toBe(beforeUnmount);
    expect(stoppedTracks).toBeGreaterThan(0);
    expect(rafQueue).toHaveLength(0);
  });

  it("surfaces a getUserMedia denial without claiming the decoder failed", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    render(<Harness enabled onScan={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-error")).toHaveTextContent(
        "Permission denied",
      ),
    );
    expect(vi.mocked(loadQrFallbackDecoder)).not.toHaveBeenCalled();
  });

  it("clears a stale error when the camera is re-armed", async () => {
    // `cameraError` was set and never cleared, so ONE transient failure — the
    // device busy in another tab, a decoder chunk that missed on a venue's
    // patchy wifi — left a red "camera unavailable" line under a viewfinder
    // that was, by then, working. It stayed for the life of the page, and the
    // camera re-arms after every single verdict.
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      new Error("Permission denied"),
    );

    const { rerender } = render(<Harness enabled onScan={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("camera-error")).toHaveTextContent(
        "Permission denied",
      ),
    );

    // Disable (a verdict is up), then re-arm — the operator granted access, or
    // the other tab let go.
    rerender(<Harness enabled={false} onScan={vi.fn()} />);
    rerender(<Harness enabled onScan={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("camera-error")).toHaveTextContent(""),
    );
  });
});

// ── requestVideoFrameCallback path ────────────────────────────────────────

describe("useBrowserCamera — requestVideoFrameCallback", () => {
  it("prefers rVFC over rAF and cancels it on unmount", async () => {
    let vfcId = 1;
    let vfcQueue: Array<{ id: number; cb: (now: number) => void }> = [];
    const cancelVideoFrameCallback = vi.fn((id: number) => {
      vfcQueue = vfcQueue.filter((entry) => entry.id !== id);
    });
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "requestVideoFrameCallback",
      {
        configurable: true,
        writable: true,
        value: (cb: (now: number) => void) => {
          const id = vfcId++;
          vfcQueue.push({ id, cb });
          return id;
        },
      },
    );
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "cancelVideoFrameCallback",
      { configurable: true, writable: true, value: cancelVideoFrameCallback },
    );

    const decode = vi.fn(() => null);
    vi.mocked(loadQrFallbackDecoder).mockResolvedValue({ decode });

    const { unmount } = render(<Harness enabled onScan={vi.fn()} />);
    await waitFor(() => expect(vfcQueue.length).toBeGreaterThan(0));
    expect(rafQueue).toHaveLength(0); // rAF not used when rVFC exists

    for (let i = 0; i < 60; i += 1) {
      clock += FRAME_MS;
      await act(async () => {
        const due = vfcQueue;
        vfcQueue = [];
        for (const entry of due) entry.cb(clock);
        await Promise.resolve();
      });
    }
    expect(decode.mock.calls.length).toBeLessThanOrEqual(10);
    expect(decode.mock.calls.length).toBeGreaterThanOrEqual(9);

    unmount();
    expect(cancelVideoFrameCallback).toHaveBeenCalled();

    // @ts-expect-error -- removing the test-only shim
    delete HTMLVideoElement.prototype.requestVideoFrameCallback;
    // @ts-expect-error -- removing the test-only shim
    delete HTMLVideoElement.prototype.cancelVideoFrameCallback;
  });
});
