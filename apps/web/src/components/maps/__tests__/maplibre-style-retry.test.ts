import type maplibregl from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STYLE_RETRY_DELAY_MS,
  installStyleLoadRetry,
  isStyleLoadFailure,
} from "../maplibre-style-retry";

const STYLE_URL = "https://tiles.example.com/styles/streets-dark/style.json";

// The shape MapLibre's AJAXError carries (src/util/ajax.ts): status 0 when
// fetch itself rejects.
const ajaxError = (url: string, status = 0) =>
  Object.assign(new Error(`AJAXError: Failed to fetch (${status}): ${url}`), {
    status,
    statusText: "Failed to fetch",
    url,
  });

function fakeMap() {
  const handlers: Record<string, Array<() => void>> = {};
  const map = {
    setStyle: vi.fn(),
    on: vi.fn((name: string, fn: () => void) => {
      (handlers[name] ??= []).push(fn);
    }),
    remove: () => {
      for (const fn of handlers.remove ?? []) fn();
    },
  };
  return map;
}

const asMap = (map: ReturnType<typeof fakeMap>) =>
  map as unknown as maplibregl.Map;

describe("installStyleLoadRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("absorbs the first style fetch failure and retries the style once after the delay", () => {
    const map = fakeMap();
    const retry = installStyleLoadRetry(asMap(map), STYLE_URL);

    expect(retry({ error: ajaxError(STYLE_URL) })).toBe(true);
    vi.advanceTimersByTime(STYLE_RETRY_DELAY_MS - 1);
    expect(map.setStyle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(map.setStyle).toHaveBeenCalledTimes(1);
    expect(map.setStyle).toHaveBeenCalledWith(STYLE_URL, { diff: false });
  });

  it("retries an HTTP failure of the style too, not only a network one", () => {
    const map = fakeMap();
    const retry = installStyleLoadRetry(asMap(map), STYLE_URL);

    expect(retry({ error: ajaxError(STYLE_URL, 503) })).toBe(true);
    vi.advanceTimersByTime(STYLE_RETRY_DELAY_MS);
    expect(map.setStyle).toHaveBeenCalledTimes(1);
  });

  it("lets the second style failure through to the caller's failure path", () => {
    const map = fakeMap();
    const retry = installStyleLoadRetry(asMap(map), STYLE_URL);

    expect(retry({ error: ajaxError(STYLE_URL) })).toBe(true);
    vi.runAllTimers();
    expect(retry({ error: ajaxError(STYLE_URL, 503) })).toBe(false);
    vi.runAllTimers();
    expect(map.setStyle).toHaveBeenCalledTimes(1);
  });

  it("ignores tile and source errors", () => {
    const map = fakeMap();
    const retry = installStyleLoadRetry(asMap(map), STYLE_URL);

    expect(retry({ error: ajaxError(STYLE_URL), tile: {} })).toBe(false);
    expect(retry({ error: ajaxError(STYLE_URL), sourceId: "openmaptiles" })).toBe(
      false,
    );
    vi.runAllTimers();
    expect(map.setStyle).not.toHaveBeenCalled();
    // The one retry is still available for a real style failure.
    expect(retry({ error: ajaxError(STYLE_URL) })).toBe(true);
  });

  it("ignores errors for other URLs and errors that are not AJAX errors", () => {
    const map = fakeMap();
    const retry = installStyleLoadRetry(asMap(map), STYLE_URL);

    expect(
      retry({ error: ajaxError("https://tiles.example.com/sprites/streets.json") }),
    ).toBe(false);
    expect(retry({ error: new Error("Style is not done loading.") })).toBe(false);
    expect(retry(undefined)).toBe(false);
    vi.runAllTimers();
    expect(map.setStyle).not.toHaveBeenCalled();
  });

  it("matches the style URL with a query string added", () => {
    expect(
      isStyleLoadFailure({ error: ajaxError(`${STYLE_URL}?v=2`) }, STYLE_URL),
    ).toBe(true);
  });

  it("cancels the pending retry when the map is removed", () => {
    const map = fakeMap();
    const retry = installStyleLoadRetry(asMap(map), STYLE_URL);

    expect(retry({ error: ajaxError(STYLE_URL) })).toBe(true);
    map.remove();
    vi.runAllTimers();
    expect(map.setStyle).not.toHaveBeenCalled();
    expect(retry({ error: ajaxError(STYLE_URL) })).toBe(false);
  });
});
