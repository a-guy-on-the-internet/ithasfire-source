import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoordinatesSelectorMap } from "../CoordinatesSelectorMap";

type Handler = (e: { originalEvent?: unknown }) => void;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: { originalEvent?: unknown }) => void>,
  flyTo: vi.fn(),
}));

vi.mock("maplibre-gl", () => {
  class FakeMap {
    dragPan = { enable: vi.fn(), disable: vi.fn() };
    dragRotate = { enable: vi.fn(), disable: vi.fn() };
    scrollZoom = { enable: vi.fn(), disable: vi.fn() };
    touchZoomRotate = { enable: vi.fn(), disable: vi.fn() };
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
    keyboard = { enable: vi.fn(), disable: vi.fn() };
    flyTo = mocks.flyTo;
    on(name: string, fn: Handler) {
      mocks.handlers[name] = fn;
    }
    getCenter() {
      return { lat: 36.1, lng: -86.8 };
    }
    remove() {}
  }
  return { default: { Map: FakeMap } };
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("../maplibre-missing-image", () => ({
  installMissingImageFallback: vi.fn(),
  transformLocalMapLibreRequest: vi.fn(),
}));
vi.mock("@/config/maps", () => ({
  coordinatesPickerZoom: 15,
  isMapEnabled: true,
  mapStyleLight: "style",
  usCentroid: { lat: 39, lng: -98 },
}));
vi.mock("@th/ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@th/ui");
  return { ...actual, useTranslations: () => (key: string) => key };
});

describe("CoordinatesSelectorMap moveend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.flyTo.mockReset();
    for (const k of Object.keys(mocks.handlers)) delete mocks.handlers[k];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const mount = () => {
    const onChange = vi.fn();
    render(
      <CoordinatesSelectorMap
        latitude={36.1}
        longitude={-86.8}
        interactive={false}
        onPositionChangeAction={onChange}
      />,
    );
    return onChange;
  };

  it("ignores a programmatic moveend (flyTo on mount, resize)", () => {
    const onChange = mount();
    expect(mocks.flyTo).toHaveBeenCalled();
    act(() => mocks.handlers.moveend!({}));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a user-initiated moveend once after the debounce", () => {
    const onChange = mount();
    act(() => mocks.handlers.moveend!({ originalEvent: new Event("mouseup") }));
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ lat: 36.1, lng: -86.8 });
  });

  it("a programmatic moveend does not cancel a pending user move", () => {
    const onChange = mount();
    act(() => mocks.handlers.moveend!({ originalEvent: new Event("wheel") }));
    act(() => mocks.handlers.moveend!({}));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
