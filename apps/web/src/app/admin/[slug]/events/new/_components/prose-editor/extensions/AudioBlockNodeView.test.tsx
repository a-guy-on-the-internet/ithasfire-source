import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// The node view needs styled View shims, a translator, and a stub AudioPlayer so
// we can assert player-vs-failure-card behaviour without a full TipTap/Tamagui
// runtime. Two things the mocks deliberately DO carry, because getting them
// wrong hid real bugs: the translator's true miss behaviour, and the geometry
// declarations both files must agree on.

const recorded = vi.hoisted(() => ({
  /** Every `styled()` config, from BOTH AudioPlayer and the node view. */
  styledConfigs: [] as Record<string, unknown>[],
  /** Every props object the Spinner was rendered with. */
  spinnerProps: [] as Record<string, unknown>[],
  /** Every props object a `@th/ui` Text was rendered with. */
  textProps: [] as Record<string, unknown>[],
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  // Forward the props a DOM element can actually carry. An earlier shim dropped
  // EVERYTHING, so `data-testid` / `role` / `aria-*` set on a styled component
  // were invisible and assertions had to be weakened to "find the copy
  // somewhere on screen". Layout props are still dropped — React would warn
  // about `borderWidth` on a raw <div>.
  const DOM_PREFIX = /^(?:data-|aria-)/;
  const KEEP = new Set(["role", "title", "className", "id", "style"]);
  const forwardable = (props: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (KEEP.has(key) || DOM_PREFIX.test(key)) out[key] = value;
    }
    return out;
  };
  const makeShim = (tag: string) => {
    const Shim = ({
      children,
      ...rest
    }: { children?: ReactNode } & Record<string, unknown>) =>
      React.createElement(tag, forwardable(rest), children);
    return Shim;
  };
  const View = makeShim("div");
  return {
    XStack: View,
    YStack: View,
    Stack: View,
    Text: View,
    styled: (_base: unknown, config?: Record<string, unknown>) => {
      if (config) recorded.styledConfigs.push(config);
      return makeShim((config?.tag as string) ?? "div");
    },
  };
});

vi.mock("@th/ui", () => ({
  Text: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => {
    recorded.textProps.push({ ...rest, children });
    return <span>{children}</span>;
  },
  Spinner: (props: Record<string, unknown>) => {
    recorded.spinnerProps.push(props);
    return <span data-testid="spinner" />;
  },
  // THE REAL CONTRACT: `createTranslator` returns THE KEY on a miss
  // (`packages/locale/src/create-translator.ts`), it does NOT return undefined.
  // A mock returning undefined manufactured a value the product never produces
  // and made five copy assertions pass against code that actually rendered
  // "ADMIN.ABUPLOADING" on screen. Do not "simplify" this back.
  useTranslations: () => (key: string) => key,
}));

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children }: { children?: ReactNode }) => (
    <div data-testid="node-view-wrapper">{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  Trash2: () => <span data-testid="icon-trash" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
  Clock: () => <span data-testid="icon-clock" />,
  Download: () => <span data-testid="icon-download" />,
  Play: () => <span data-testid="icon-play" />,
  // Imported by the REAL AudioPlayer module, which we load for its metrics.
  Music: () => <span data-testid="icon-music" />,
  Pause: () => <span data-testid="icon-pause" />,
  X: () => <span data-testid="icon-x" />,
}));

vi.mock("./media-layout", () => ({
  audioLayoutStyle: () => ({}),
}));

// The real AudioPlayer (rendered below) attaches its src through
// attachAudioSource; hls.js is replaced at its loader seam.
const fakeHls = vi.hoisted(() => {
  const instances: {
    loadSource: unknown;
    attachMedia: unknown;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  class FakeHls {
    static Events = { ERROR: "hlsError", MEDIA_ATTACHED: "hlsMediaAttached" } as const;
    static isSupported = () => true;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    startLoad = vi.fn();
    on = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  return { FakeHls, instances };
});
vi.mock("@/components/audio/load-hls", () => ({
  loadHls: () => Promise.resolve(fakeHls.FakeHls),
}));

const audioPlayerSpy = vi.fn();
vi.mock("@/components/audio/AudioPlayer", async () => {
  // Load the real module so `AUDIO_PLAYER_METRICS` is the genuine geometry (and
  // its styled() configs land in `recorded.styledConfigs` for the parity test).
  // Only the component itself is stubbed.
  const actual = await vi.importActual<
    typeof import("@/components/audio/AudioPlayer")
  >("@/components/audio/AudioPlayer");
  return {
    ...actual,
    AudioPlayer: (props: {
      src: string;
      waveformPeaks?: number[] | null;
      allowDownload?: boolean;
      downloadUrl?: string | null;
    }) => {
      audioPlayerSpy(props);
      return <div data-testid="audio-player" data-src={props.src} />;
    },
  };
});

import {
  AudioBlockNodeView,
  audioStatusKind,
  AUDIO_STATUS_RAIL_COLOR,
} from "./AudioBlockNodeView";
import {
  AUDIO_PLAYER_METRICS,
  AUDIO_PLAYER_HEIGHT,
} from "@/components/audio/AudioPlayer";
import type { AudioBlockAttributes } from "./AudioBlock";
import type { NodeViewProps } from "@tiptap/react";

// Minimal NodeViewProps stub — only the fields the component reads.
function makeProps(
  attrs: Partial<AudioBlockAttributes>,
  overrides: { isEditable?: boolean } = {},
): NodeViewProps {
  return {
    node: { attrs: { audioUploadId: "a1", ...attrs } },
    selected: false,
    deleteNode: vi.fn(),
    updateAttributes: vi.fn(),
    editor: { isEditable: overrides.isEditable ?? true },
  } as unknown as NodeViewProps;
}

describe("AudioBlockNodeView — transcode-failure handling", () => {
  it("FAILED with a playable source: renders the player + non-blocking notice, omits the waveform", () => {
    audioPlayerSpy.mockClear();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "FAILED",
          sourceUrl: "https://cdn.example/audio/original.mp3",
          // Peaks would normally be absent on failure; assert we drop them even
          // if a stale value lingers in attrs.
          waveformPeaks: [0.1, 0.2, 0.3],
        })}
      />,
    );

    // Player still renders off the raw source — exactly once.
    const players = screen.getAllByTestId("audio-player");
    expect(players).toHaveLength(1);
    expect(players[0]).toHaveAttribute(
      "data-src",
      "https://cdn.example/audio/original.mp3",
    );

    // Waveform peaks are suppressed on failure.
    expect(audioPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ waveformPeaks: null }),
    );

    // The failure reads as ONE welded strip, not a second stacked state bar:
    // neither the processing skeleton nor the blocking failure frame renders.
    expect(
      screen.getByTestId("audio-block-transcode-warning"),
    ).toBeInTheDocument();
    expect(screen.getByText(/playing the original/i)).toBeInTheDocument();
    expect(screen.queryByTestId("audio-block-skeleton")).not.toBeInTheDocument();
    expect(screen.queryByTestId("audio-block-failed")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/remove it and upload again/i),
    ).not.toBeInTheDocument();

    // Amber, not red: the embed plays, we just couldn't optimize it.
    expect(screen.getByTestId("audio-block-status-column")).toHaveAttribute(
      "data-status",
      "working",
    );
  });

  it("FAILED with no source: shows the blocking failure state and no player", () => {
    audioPlayerSpy.mockClear();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "FAILED",
          sourceUrl: null,
          hlsPlaylistUrl: null,
        })}
      />,
    );

    expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
    expect(audioPlayerSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("audio-block-transcode-warning"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("audio-block-failed")).toBeInTheDocument();
    expect(screen.getByText(/processing failed/i)).toBeInTheDocument();
    expect(screen.getByText(/remove it and upload again/i)).toBeInTheDocument();
    // Nothing to transport — no play-slot silhouette on the blocking card.
    expect(screen.queryByTestId("icon-play")).not.toBeInTheDocument();
    expect(screen.getByTestId("audio-block-status-column")).toHaveAttribute(
      "data-status",
      "failed",
    );
  });

  it("threads allowDownload + the direct sourceUrl into the player", () => {
    audioPlayerSpy.mockClear();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "READY",
          sourceUrl: "https://cdn.example/audio/ready.mp3",
          hlsPlaylistUrl: "https://cdn.example/audio/playlist.m3u8",
          allowDownload: true,
        })}
      />,
    );

    // Download target is the direct file, never the HLS playlist.
    expect(audioPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDownload: true,
        downloadUrl: "https://cdn.example/audio/ready.mp3",
      }),
    );
  });

  it("defaults allowDownload to false when the attr is absent", () => {
    audioPlayerSpy.mockClear();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "READY",
          sourceUrl: "https://cdn.example/audio/ready.mp3",
        })}
      />,
    );

    expect(audioPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ allowDownload: false }),
    );
  });

  it("READY with a source: plays, shows no failure UI, and clears the status stripe", () => {
    audioPlayerSpy.mockClear();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "READY",
          sourceUrl: "https://cdn.example/audio/ready.mp3",
          waveformPeaks: [0.5, 0.6],
        })}
      />,
    );

    expect(screen.getByTestId("audio-player")).toBeInTheDocument();
    expect(audioPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ waveformPeaks: [0.5, 0.6] }),
    );
    expect(
      screen.queryByTestId("audio-block-transcode-warning"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("audio-block-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("audio-block-status-column")).toHaveAttribute(
      "data-status",
      "none",
    );
  });
});

describe("AudioBlockNodeView — status stripe", () => {
  it.each([
    ["PENDING" as const, false, "working" as const],
    ["PENDING" as const, true, "working" as const],
    ["UPLOADED" as const, false, "working" as const],
    ["UPLOADED" as const, true, "working" as const],
    ["TRANSCODING" as const, false, "working" as const],
    ["TRANSCODING" as const, true, "working" as const],
    // A transcode failure whose original still plays is amber, not red.
    ["FAILED" as const, true, "working" as const],
    ["FAILED" as const, false, "failed" as const],
    ["READY" as const, true, "none" as const],
    // READY with nothing playable is terminal, not idle — presigning failed,
    // or the row outlived its object.
    ["READY" as const, false, "failed" as const],
  ])("%s (hasSource=%s) → %s", (status, hasSource, kind) => {
    expect(audioStatusKind(status, hasSource)).toBe(kind);
  });

  it("READY with no source shows the dead end instead of spinning forever", () => {
    audioPlayerSpy.mockClear();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "READY",
          sourceUrl: null,
          hlsPlaylistUrl: null,
        })}
      />,
    );

    // Not the skeleton: the pipeline says it finished, so "Uploading" behind a
    // spinner would be a lie that never resolves.
    expect(screen.queryByTestId("audio-block-skeleton")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
    expect(screen.getByTestId("audio-block-failed")).toBeInTheDocument();
    expect(screen.getByTestId("audio-block-status-column")).toHaveAttribute(
      "data-status",
      "failed",
    );
  });

  it("maps each kind to a distinct token, with idle transparent so the media never shifts", () => {
    expect(AUDIO_STATUS_RAIL_COLOR.failed).toBe("$danger");
    expect(AUDIO_STATUS_RAIL_COLOR.working).toBe("$support");
    expect(AUDIO_STATUS_RAIL_COLOR.none).toBe("transparent");
  });
});

describe("AudioBlockNodeView — editor rail", () => {
  it("renders the rail in edit mode", () => {
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "READY",
          sourceUrl: "https://cdn.example/audio/ready.mp3",
        })}
      />,
    );

    expect(screen.getByTestId("audio-block-edit-rail")).toBeInTheDocument();
    expect(screen.getByTestId("audio-block-delete")).toBeInTheDocument();
  });

  it("renders no rail — and no delete — when the editor is read-only", () => {
    render(
      <AudioBlockNodeView
        {...makeProps(
          {
            status: "READY",
            sourceUrl: "https://cdn.example/audio/ready.mp3",
          },
          { isEditable: false },
        )}
      />,
    );

    expect(
      screen.queryByTestId("audio-block-edit-rail"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("audio-block-delete")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("audio-block-download-toggle"),
    ).not.toBeInTheDocument();
    // The media itself still renders read-only.
    expect(screen.getByTestId("audio-player")).toBeInTheDocument();
  });

  it("hides the download toggle until a source resolves", () => {
    render(
      <AudioBlockNodeView
        {...makeProps({ status: "TRANSCODING", sourceUrl: null })}
      />,
    );

    // Delete is always available in edit mode; "allow download" is not — it
    // would be a control with nothing behind it.
    expect(screen.getByTestId("audio-block-delete")).toBeInTheDocument();
    expect(
      screen.queryByTestId("audio-block-download-toggle"),
    ).not.toBeInTheDocument();
  });

  it("shows the download toggle once a source resolves, carrying switch semantics", () => {
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "READY",
          sourceUrl: "https://cdn.example/audio/ready.mp3",
          allowDownload: true,
        })}
      />,
    );

    const toggle = screen.getByTestId("audio-block-download-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleName(/downloads allowed/i);
    // Real <button>, keyboard-reachable, and NOT a form submit — the prose
    // editor lives inside the event builder's form.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
  });

  it("the delete control is a real, labelled button", () => {
    const props = makeProps({
      status: "READY",
      sourceUrl: "https://cdn.example/audio/ready.mp3",
    });
    render(<AudioBlockNodeView {...props} />);

    const del = screen.getByTestId("audio-block-delete");
    expect(del.tagName).toBe("BUTTON");
    expect(del).toHaveAttribute("type", "button");
    expect(del).toHaveAccessibleName(/remove audio/i);
  });

  it("carries no label of its own — the media below already names itself", () => {
    render(
      <AudioBlockNodeView
        {...makeProps({ status: "TRANSCODING", sourceUrl: null })}
      />,
    );

    // "Audio" is the default media title. It must appear ONCE (in the
    // skeleton's info row), not twice 30px apart.
    expect(screen.getAllByText("Audio")).toHaveLength(1);
  });
});

describe("AudioBlockNodeView — processing skeleton", () => {
  it.each([
    ["PENDING" as const, "Uploading"],
    ["UPLOADED" as const, "Uploading"],
    ["TRANSCODING" as const, "Transcoding"],
  ])("renders the %s phase label", (status, copy) => {
    render(<AudioBlockNodeView {...makeProps({ status, sourceUrl: null })} />);

    const skeleton = screen.getByTestId("audio-block-skeleton");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute("role", "status");
    expect(skeleton).toHaveAttribute("aria-live", "polite");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    // Real English, not the raw i18n key — the translator returns the key on a
    // miss, so this is the assertion that catches an unregistered key.
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/^admin\.ab/i)).not.toBeInTheDocument();
    // The spinner is one of the two moving parts while work is outstanding.
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    // The silhouette carries the player's play-slot so the block resolves in place.
    expect(screen.getByTestId("icon-play")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
  });

  it("swaps the spinner for a clock and reads 'Still working' past the timeout", () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "TRANSCODING",
          sourceUrl: null,
          uploadStartedAt: sixMinutesAgo,
        })}
      />,
    );

    expect(screen.getByTestId("icon-clock")).toBeInTheDocument();
    expect(screen.queryByTestId("spinner")).not.toBeInTheDocument();
    expect(screen.getByText(/still working/i)).toBeInTheDocument();
    // …with the elapsed time, so "still working" is falsifiable.
    expect(screen.getByText(/6m/)).toBeInTheDocument();
    expect(screen.queryByText(/transcoding/i)).not.toBeInTheDocument();
  });

  it("keeps the spinner while the upload is still inside the timeout window", () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    render(
      <AudioBlockNodeView
        {...makeProps({
          status: "TRANSCODING",
          sourceUrl: null,
          uploadStartedAt: oneMinuteAgo,
        })}
      />,
    );

    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("icon-clock")).not.toBeInTheDocument();
    expect(screen.getByText(/transcoding/i)).toBeInTheDocument();
  });

  it("hands the Spinner the reduced-motion flag and strips its nested live region", () => {
    recorded.spinnerProps.length = 0;
    render(
      <AudioBlockNodeView
        {...makeProps({ status: "TRANSCODING", sourceUrl: null })}
      />,
    );

    expect(recorded.spinnerProps).toHaveLength(1);
    const props = recorded.spinnerProps[0];
    // Spinner writes its rotation INLINE and defaults reducedMotion to false —
    // no stylesheet rule can stop it, so the flag has to be passed.
    expect(props).toHaveProperty("reducedMotion");
    expect(typeof props.reducedMotion).toBe("boolean");
    // …and it hardcodes role="status" aria-live="polite" aria-label="spinner",
    // which would nest a second polite live region named "spinner" inside the
    // skeleton's own. The frame owns the announcement.
    expect(props.role).toBe("presentation");
    expect(props["aria-live"]).toBe("off");
    expect(props["aria-hidden"]).toBe(true);
    expect(props.screenReaderLabel).toBe("");
  });
});

describe("AudioBlockNodeView — geometry parity with AudioPlayer", () => {
  // The whole point of the skeleton is that resolving a source changes nothing
  // about the block's height. It drifted twice already: 52 vs 104, then 104 vs
  // 114 when a 10px label silently claimed a 24px line box.

  it("the info bar cannot outgrow its declared minHeight", () => {
    const used =
      AUDIO_PLAYER_METRICS.infoBarContentMax +
      AUDIO_PLAYER_METRICS.infoBarPaddingVertical * 2 +
      AUDIO_PLAYER_METRICS.infoBarBorderBottomWidth;
    // 26 + 16 + 2 = 44. On its own this is arithmetic over four literals in
    // one object and proves nothing about the code — the test below is what
    // ties `infoBarContentMax` to the thing that actually sets it.
    expect(used).toBeLessThanOrEqual(AUDIO_PLAYER_METRICS.infoBarMinHeight);
    // Every control the info bar can hold has to fit the same budget. The
    // download button used to be 32 and pushed the bar to 50 whenever it
    // showed — reachable by clipboard paste and by a poll tick that drops a
    // `sourceUrl`, both of which cross the skeleton→player swap.
    expect(AUDIO_PLAYER_METRICS.downloadButtonSize).toBeLessThanOrEqual(
      AUDIO_PLAYER_METRICS.infoBarContentMax,
    );
  });

  it("both info-bar labels carry their own line box", async () => {
    // THE regression this suite exists for. A label that sets `fontSize` in an
    // inline style but no `lineHeight` keeps `variant="body"`'s 24px line box:
    // the 10px speed label became a 36px button, the info bar 54, the player
    // 114, and the skeleton mirroring it 104 — a 10px jump on the poll tick
    // that resolved a source. Render the REAL player (the module mock stubs
    // only the component) and read what the labels were actually handed.
    const { AudioPlayer: RealAudioPlayer } = await vi.importActual<
      typeof import("@/components/audio/AudioPlayer")
    >("@/components/audio/AudioPlayer");

    recorded.textProps.length = 0;
    render(
      // `enableStickyPlayer: false` keeps us off IntersectionObserver, which
      // jsdom does not implement.
      <RealAudioPlayer
        src="https://cdn.example/audio/ready.mp3"
        title="Soundcheck"
        enableStickyPlayer={false}
      />,
    );

    // Identify the labels by the font size they declare — that IS the rule:
    // a size travels with its line box, and these two set theirs in an inline
    // style where the Text variant's default would otherwise win.
    const labelWithFontSize = (px: number) =>
      recorded.textProps.filter(
        (props) => (props.style as { fontSize?: number } | undefined)?.fontSize === px,
      );

    const speedLabel = labelWithFontSize(10);
    expect(speedLabel).toHaveLength(1);
    expect(speedLabel[0].lineHeight).toBe(14);

    const titleLabel = labelWithFontSize(12);
    expect(titleLabel).toHaveLength(1);
    expect(titleLabel[0].lineHeight).toBe(16);

    // The speed toggle is the tallest thing the info bar holds, and it is what
    // `infoBarContentMax` claims to be: line box + $1 padding x2 + border x2.
    const speedButtonHeight = Number(speedLabel[0].lineHeight) + 4 * 2 + 2 * 2;
    expect(speedButtonHeight).toBe(AUDIO_PLAYER_METRICS.infoBarContentMax);
    expect(Number(titleLabel[0].lineHeight)).toBeLessThanOrEqual(
      AUDIO_PLAYER_METRICS.infoBarContentMax,
    );
  });

  it("resolves to a single total height", () => {
    expect(AUDIO_PLAYER_HEIGHT).toBe(104);
  });

  it("the player's rows and the skeleton's mirror declare identical geometry", () => {
    // `recorded.styledConfigs` holds every styled() config from BOTH modules.
    const infoRows = recorded.styledConfigs.filter(
      (c) =>
        c.backgroundColor === "$backgroundHover" &&
        c.borderBottomWidth === AUDIO_PLAYER_METRICS.infoBarBorderBottomWidth,
    );
    // AudioPlayer.InfoBar + AudioBlockNodeView.FrameInfoRow.
    expect(infoRows).toHaveLength(2);
    expect(new Set(infoRows.map((c) => c.minHeight))).toEqual(
      new Set([AUDIO_PLAYER_METRICS.infoBarMinHeight]),
    );
    // `infoBarPaddingVertical` is a number in the metrics object while the code
    // uses a space TOKEN. Pin the token so the two cannot drift apart: $2 is 8
    // on the 4/8/12/16/24/32/48/72 scale.
    expect(new Set(infoRows.map((c) => c.paddingVertical))).toEqual(
      new Set(["$2"]),
    );
    expect(AUDIO_PLAYER_METRICS.infoBarPaddingVertical).toBe(8);

    const transportRows = recorded.styledConfigs.filter(
      (c) => c.minHeight === AUDIO_PLAYER_METRICS.transportBarMinHeight,
    );
    // AudioPlayer.TransportBar + the node view's FrameTransportRow and
    // FrameBodyRow. Exact, not >=: the count is the only thing that notices a
    // row quietly going back to a literal.
    expect(transportRows).toHaveLength(3);

    const frames = recorded.styledConfigs.filter(
      (c) => c.overflow === "hidden" && c.borderRadius === 0,
    );
    // AudioPlayer.PlayerContainer + AudioBlockNodeView.MediaFrame.
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((c) => c.borderWidth))).toEqual(
      new Set([AUDIO_PLAYER_METRICS.frameBorderWidth]),
    );
  });
});

describe("AudioPlayer — HLS-only source", () => {
  it("plays an .m3u8 through hls.js when the browser has no native HLS", async () => {
    const { AudioPlayer: RealAudioPlayer } = await vi.importActual<
      typeof import("@/components/audio/AudioPlayer")
    >("@/components/audio/AudioPlayer");
    fakeHls.instances.length = 0;
    const playlist = "https://cdn.example/audio/playlist.m3u8";

    const { container, unmount } = render(
      <RealAudioPlayer src={playlist} title="Soundcheck" enableStickyPlayer={false} />,
    );
    await new Promise((r) => setTimeout(r, 0));

    const audio = container.querySelector("audio")!;
    // jsdom has no native HLS, so the element never holds the raw playlist.
    expect(audio.getAttribute("src")).toBeNull();
    expect(fakeHls.instances).toHaveLength(1);
    const [hls] = fakeHls.instances;
    expect(hls.loadSource).toHaveBeenCalledWith(playlist);
    expect(hls.attachMedia).toHaveBeenCalledWith(audio);

    unmount();
    expect(hls.destroy).toHaveBeenCalledTimes(1);
  });

  it("sets a direct file as the src without hls.js", async () => {
    const { AudioPlayer: RealAudioPlayer } = await vi.importActual<
      typeof import("@/components/audio/AudioPlayer")
    >("@/components/audio/AudioPlayer");
    fakeHls.instances.length = 0;
    const file = "https://cdn.example/audio/ready.mp3";

    const { container } = render(
      <RealAudioPlayer src={file} title="Soundcheck" enableStickyPlayer={false} />,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector("audio")!.getAttribute("src")).toBe(file);
    expect(fakeHls.instances).toHaveLength(0);
  });

  it("swaps source when src changes: direct -> playlist -> direct", async () => {
    const { AudioPlayer: RealAudioPlayer } = await vi.importActual<
      typeof import("@/components/audio/AudioPlayer")
    >("@/components/audio/AudioPlayer");
    const load = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => {});
    fakeHls.instances.length = 0;
    const file = "https://cdn.example/audio/ready.mp3";
    const playlist = "https://cdn.example/audio/playlist.m3u8";
    const props = { title: "Soundcheck", enableStickyPlayer: false };

    const { container, rerender } = render(<RealAudioPlayer src={file} {...props} />);
    const audio = container.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe(file);

    // direct -> playlist: the old file stops loading before hls.js arrives.
    rerender(<RealAudioPlayer src={playlist} {...props} />);
    expect(audio.getAttribute("src")).toBeNull();
    expect(load).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeHls.instances).toHaveLength(1);
    const [hls] = fakeHls.instances;
    expect(hls.attachMedia).toHaveBeenCalledWith(audio);

    // playlist -> direct: hls.js is destroyed, the file is the src again.
    rerender(<RealAudioPlayer src={file} {...props} />);
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute("src")).toBe(file);
    load.mockRestore();
  });
});
