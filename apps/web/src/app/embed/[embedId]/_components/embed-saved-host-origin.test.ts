import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const computed = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => computed.value,
}));

import {
  embedHostOriginOnRedirectReturn,
  forgetEmbedHostOrigin,
  saveEmbedHostOrigin,
} from "./embed-saved-host-origin";

const KEY = "hf:embed:host-origin:embed-1";
const firstLoad = { loadIsRedirectReturn: false };

/** Chromium and WebKit: the browser names the parent page's origin. */
function ancestorOriginsAre(origins: string[] | undefined) {
  Object.defineProperty(window.location, "ancestorOrigins", {
    configurable: true,
    value: origins,
  });
}

// Without `ancestorOrigins` (Firefox, and this test DOM), a computed origin
// that is not the widget's own came from `document.referrer`.
describe("the host origin across a redirect payment", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    computed.value = "https://host.example";
  });
  afterEach(() => {
    ancestorOriginsAre(undefined);
  });

  it("saved before the payment, it is what the return sends when the computed origin is missing", () => {
    saveEmbedHostOrigin("embed-1", firstLoad);
    computed.value = null;
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe("https://host.example");
  });

  it("and when the computed origin came from the referrer (the payment page's)", () => {
    saveEmbedHostOrigin("embed-1", firstLoad);
    computed.value = "https://pay.example";
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe("https://host.example");
  });

  it("an origin from ancestorOrigins wins over a different saved one", () => {
    window.sessionStorage.setItem(KEY, "https://other.example");
    ancestorOriginsAre(["https://host.example"]);
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe("https://host.example");
  });

  it("the widget as the top-level page sends its own origin, whatever was saved", () => {
    window.sessionStorage.setItem(KEY, "https://other.example");
    computed.value = window.location.origin;
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe(window.location.origin);
  });

  it.each([
    ["not a URL", "host.example"],
    ["a URL with a path", "https://host.example/checkout"],
    ["a trailing slash", "https://host.example/"],
    ["another scheme", "javascript:alert(1)"],
    ["an opaque origin", "null"],
  ])("a malformed saved value is ignored: %s", (_what, saved) => {
    window.sessionStorage.setItem(KEY, saved);
    computed.value = "https://pay.example";
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe("https://pay.example");
    computed.value = null;
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBeNull();
  });

  it("is kept per embed", () => {
    saveEmbedHostOrigin("embed-1", firstLoad);
    computed.value = null;
    expect(embedHostOriginOnRedirectReturn("embed-2")).toBeNull();
  });

  it("an origin that could not be computed is not saved over a good one", () => {
    saveEmbedHostOrigin("embed-1", firstLoad);
    computed.value = null;
    saveEmbedHostOrigin("embed-1", firstLoad);
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe("https://host.example");
  });

  it("on a load that is itself a redirect return, an origin from the referrer is not saved", () => {
    saveEmbedHostOrigin("embed-1", firstLoad);
    computed.value = "https://pay.example";
    saveEmbedHostOrigin("embed-1", { loadIsRedirectReturn: true });
    expect(window.sessionStorage.getItem(KEY)).toBe("https://host.example");
  });

  it("on such a load, an origin from ancestorOrigins is saved", () => {
    ancestorOriginsAre(["https://host.example"]);
    saveEmbedHostOrigin("embed-1", { loadIsRedirectReturn: true });
    expect(window.sessionStorage.getItem(KEY)).toBe("https://host.example");
  });

  it("forgetting removes the saved origin", () => {
    saveEmbedHostOrigin("embed-1", firstLoad);
    forgetEmbedHostOrigin("embed-1");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("storage blocked: nothing throws, and the return sends the computed origin, as before", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
    expect(() => saveEmbedHostOrigin("embed-1", firstLoad)).not.toThrow();
    expect(() => forgetEmbedHostOrigin("embed-1")).not.toThrow();
    computed.value = "https://pay.example";
    expect(embedHostOriginOnRedirectReturn("embed-1")).toBe("https://pay.example");
    set.mockRestore();
    get.mockRestore();
    remove.mockRestore();
  });
});
