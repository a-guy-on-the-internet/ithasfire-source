import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The crop dialog's ACCESSIBILITY contract (NFR-001), which is the part a
 * pointer-driven crop most often gets wrong: the crop surface must be
 * focusable, named, described, and fully operable from the keyboard — and it
 * must NOT trap Tab.
 *
 * The crop maths itself is covered by `image-crop.test.ts`; the canvas export
 * is not testable in jsdom (no 2d context) and is verified in a real browser.
 */

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

vi.mock("lucide-react", () => ({
  ArrowDown: () => <span />,
  ArrowLeft: () => <span />,
  ArrowRight: () => <span />,
  ArrowUp: () => <span />,
  Check: () => <span />,
  Minus: () => <span />,
  Plus: () => <span />,
  RotateCcw: () => <span />,
}));

vi.mock("@th/ui", () => {
  const Panel = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Header = ({ title }: { title?: string }) => <h2>{title}</h2>;
  const Body = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Footer = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Modal = Object.assign(
    ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    { Panel, Header, Body, Footer },
  );
  return {
    Modal,
    Text: ({ children, id }: { children?: ReactNode; id?: string }) => (
      <span id={id}>{children}</span>
    ),
    Spinner: () => <span role="progressbar" />,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    } & Record<string, unknown>) => (
      <button
        type="button"
        disabled={disabled}
        onClick={onPress}
        aria-label={rest["aria-label"] as string | undefined}
        data-testid={rest["data-testid"] as string | undefined}
      >
        {children}
      </button>
    ),
    RangeSlider: ({
      value,
      onValueChange,
      min,
      max,
      label,
      testId,
    }: {
      value: number;
      onValueChange: (v: number) => void;
      min?: number;
      max?: number;
      label?: string;
      testId?: string;
    }) => (
      <input
        type="range"
        aria-label={label}
        data-testid={testId}
        min={min}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => onValueChange(Number(e.target.value))}
      />
    ),
    useTranslations: () => (key: string) => key,
  };
});

import { ImageCropDialog } from "../ImageCropDialog";

const NATURAL_W = 4000;
const NATURAL_H = 3000;

let clientWidthSpy: PropertyDescriptor | undefined;
/**
 * Whether the stubbed decode reports itself as finished. Flip to `false` to
 * reproduce the window in which the probe image has resolved but the bitmap
 * is not yet drawable — the state that used to export a blank canvas.
 */
let imageComplete = true;
/** Teardown for the canvas spies — see the note in `afterEach`. */
const canvasRestores: Array<() => void> = [];

beforeEach(() => {
  imageComplete = true;
  clientWidthSpy = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  // jsdom reports 0 for every layout box; the crop needs a measured width.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 400,
  });
  // `vitest.setup.ts` already installs a no-op ResizeObserver on window.
  URL.createObjectURL = vi.fn(() => "blob:crop-test");
  URL.revokeObjectURL = vi.fn();
  // jsdom never fires load for a blob URL — resolve synchronously on `src`.
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = "auto";
      naturalWidth = NATURAL_W;
      naturalHeight = NATURAL_H;
      get complete() {
        return imageComplete;
      }
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore ONLY what `stubCanvas` replaced. `vi.restoreAllMocks()` would also
  // tear down `vitest.setup.ts`'s `window.matchMedia` stub, which
  // `usePrefersReducedMotion` calls on mount — every later test in the file
  // then dies on `mq.matches`.
  canvasRestores.splice(0).forEach((restore) => restore());
  if (clientWidthSpy) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthSpy);
  }
});

const jpeg = () => new File(["bytes"], "photo.jpg", { type: "image/jpeg" });

async function renderCrop(aspect = 1) {
  const onCancel = vi.fn();
  const onCropped = vi.fn();
  const onPrepareError = vi.fn();
  render(
    <ImageCropDialog
      file={jpeg()}
      aspect={aspect}
      title="Crop avatar"
      onCancel={onCancel}
      onCropped={onCropped}
      onPrepareError={onPrepareError}
    />,
  );
  const surface = await screen.findByTestId("image-crop-surface");
  return { surface, onCancel, onCropped, onPrepareError };
}

/**
 * jsdom has no 2d context and no `toBlob`, so the export path is unreachable
 * without stubbing both. The stub is deliberately thin — the geometry it is
 * handed is covered by `image-crop.test.ts`; what matters here is WHICH image
 * gets drawn and whether a not-yet-drawable one is allowed through at all.
 */
function stubCanvas() {
  const drawImage = vi.fn();
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage,
    } as unknown as CanvasRenderingContext2D);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
    ) {
      callback(new Blob(["encoded"], { type: type ?? "image/png" }));
    } as HTMLCanvasElement["toBlob"]);
  canvasRestores.push(
    () => context.mockRestore(),
    () => toBlob.mockRestore(),
  );
  return { drawImage };
}

const transformOf = (surface: HTMLElement) =>
  surface.querySelector("img")!.style.transform;

describe("ImageCropDialog — keyboard operability (NFR-001)", () => {
  it("exposes the crop surface as a focusable, named, described control", async () => {
    const { surface } = await renderCrop();
    expect(surface.getAttribute("role")).toBe("group");
    expect(surface.getAttribute("tabindex")).toBe("0");
    expect(surface.getAttribute("aria-label")).toBe("common.cropRegionLabel");

    const describedBy = surface.getAttribute("aria-describedby")!;
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "common.cropKeyboardHint",
    );
  });

  it("pans with the arrow keys", async () => {
    const { surface } = await renderCrop();
    // 4000x3000 at cover-scale 0.1 in a 300x300 box → x centred at -50.
    expect(transformOf(surface)).toBe("translate(-50px, 0px)");

    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(transformOf(surface)).toBe("translate(-38px, 0px)");

    fireEvent.keyDown(surface, { key: "ArrowLeft" });
    expect(transformOf(surface)).toBe("translate(-50px, 0px)");
  });

  it("offers a finer step with Shift", async () => {
    const { surface } = await renderCrop();
    fireEvent.keyDown(surface, { key: "ArrowRight", shiftKey: true });
    expect(transformOf(surface)).toBe("translate(-49px, 0px)");
  });

  it("never pans past the edge of the image", async () => {
    const { surface } = await renderCrop();
    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(surface, { key: "ArrowRight" });
    }
    // Clamped at 0 — the crop box can never show a gap.
    expect(transformOf(surface)).toBe("translate(0px, 0px)");
  });

  it("zooms with +/- and recentres with Home", async () => {
    const { surface } = await renderCrop();
    const zoom = screen.getByTestId("image-crop-zoom") as HTMLInputElement;
    expect(zoom.value).toBe("1");

    fireEvent.keyDown(surface, { key: "+" });
    expect(Number(zoom.value)).toBeGreaterThan(1);

    fireEvent.keyDown(surface, { key: "Home" });
    expect(zoom.value).toBe("1");
    expect(transformOf(surface)).toBe("translate(-50px, 0px)");
  });

  it("leaves Tab alone so focus is never trapped", async () => {
    const { surface } = await renderCrop();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    surface.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("labels the zoom slider so it is reachable and announced", async () => {
    await renderCrop();
    expect(
      screen.getByLabelText("common.cropZoomLabel").getAttribute("type"),
    ).toBe("range");
  });

  // Arrow KEYS are not enough on their own: NVDA/JAWS do not auto-switch to
  // focus mode for `role="group"`, so a browse-mode user pressing an arrow
  // navigates the document instead of the crop. Zoom already had button and
  // slider paths; panning had none, which left that user with only the
  // centred framing.
  it("offers a button equivalent for every pan direction", async () => {
    const { surface } = await renderCrop();
    expect(transformOf(surface)).toBe("translate(-50px, 0px)");

    fireEvent.click(screen.getByLabelText("common.cropPanRight"));
    expect(transformOf(surface)).toBe("translate(-38px, 0px)");

    fireEvent.click(screen.getByLabelText("common.cropPanLeft"));
    expect(transformOf(surface)).toBe("translate(-50px, 0px)");

    // Vertical: 4000x3000 at cover-scale in a 300x300 box is exactly as tall
    // as the box, so both vertical buttons clamp to 0 rather than moving.
    // Presence is the contract here; the maths is `image-crop.test.ts`'s job.
    expect(screen.getByLabelText("common.cropPanUp")).toBeTruthy();
    expect(screen.getByLabelText("common.cropPanDown")).toBeTruthy();
  });

  it("keeps a recentre button alongside the pan controls", async () => {
    const { surface } = await renderCrop();
    fireEvent.click(screen.getByLabelText("common.cropPanRight"));
    expect(transformOf(surface)).toBe("translate(-38px, 0px)");

    fireEvent.click(screen.getByLabelText("common.cropReset"));
    expect(transformOf(surface)).toBe("translate(-50px, 0px)");
  });
});

describe("ImageCropDialog — export safety", () => {
  it("draws from the decoded probe image, not the rendered <img>", async () => {
    const { drawImage } = stubCanvas();
    const { surface, onCropped } = await renderCrop();

    fireEvent.click(screen.getByTestId("image-crop-apply"));
    await waitFor(() => expect(onCropped).toHaveBeenCalledTimes(1));

    expect(drawImage).toHaveBeenCalledTimes(1);
    // The DOM <img> runs its OWN load cycle off the same object URL. Drawing
    // it is what produced a blank export when the user clicked Apply before
    // that second load finished.
    const drawn = drawImage.mock.calls[0]![0] as HTMLImageElement;
    expect(drawn).not.toBe(surface.querySelector("img"));
    expect(drawn.naturalWidth).toBe(NATURAL_W);

    const file = onCropped.mock.calls[0]![0] as File;
    expect(file.name).toBe("photo-cropped.jpg");
  });

  // The regression this guards: `ctx.drawImage` with a not-yet-drawable image
  // returns WITHOUT drawing and WITHOUT throwing, and a blank JPEG is a valid
  // small JPEG — so the type check, size cap, presign, PUT and finalize all
  // pass and the user silently gets a blank avatar.
  it("refuses to export an image that is not drawable, instead of uploading a blank one", async () => {
    const { drawImage } = stubCanvas();
    imageComplete = false;
    const { onCropped, onCancel, onPrepareError } = await renderCrop();

    fireEvent.click(screen.getByTestId("image-crop-apply"));
    await waitFor(() => expect(onPrepareError).toHaveBeenCalledTimes(1));

    expect(drawImage).not.toHaveBeenCalled();
    expect(onCropped).not.toHaveBeenCalled();
    // Surfaced to the user (toast) and the dialog closes — never a silent pass.
    expect(onCancel).toHaveBeenCalled();
    expect((onPrepareError.mock.calls[0]![0] as Error).message).toBe(
      "image_not_ready",
    );
  });
});

describe("ImageCropDialog — framing", () => {
  it("uses the requested aspect for the crop box", async () => {
    const { surface } = await renderCrop(3);
    // Box width caps at 300 * 3 = 900, but the container measures 400.
    expect(surface.style.width).toBe("400px");
    expect(surface.style.height).toBe(`${400 / 3}px`);
  });

  it("shows a preparing state before the image decodes", async () => {
    render(
      <ImageCropDialog
        file={jpeg()}
        aspect={1}
        title="Crop avatar"
        onCancel={vi.fn()}
        onCropped={vi.fn()}
      />,
    );
    expect(screen.getByText("common.cropPreparing")).toBeTruthy();
    // Let the decode settle inside act() so the state update is not orphaned.
    await screen.findByTestId("image-crop-surface");
  });

  it("renders nothing when there is no file", async () => {
    render(
      <ImageCropDialog
        file={null}
        aspect={1}
        title="Crop avatar"
        onCancel={vi.fn()}
        onCropped={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("image-crop-surface")).toBeNull();
    });
  });
});
