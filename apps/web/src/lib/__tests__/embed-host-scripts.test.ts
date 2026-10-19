// @vitest-environment jsdom
/**
 * The host-page scripts (public/embed/hf-resize.js and hf-embed.js) are where
 * a widget's `hf:resize` height gets clamped. The widget-side hook is tested
 * elsewhere; these tests evaluate the real script sources so a lowered ceiling
 * (the old 2000px clip) fails here.
 *
 * HF_EMBED_SCRIPT_DIR points the tests at a different copy of the scripts (used
 * to prove the assertions fail against a mutated copy).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "acorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT_DIR =
  process.env.HF_EMBED_SCRIPT_DIR ??
  path.resolve(__dirname, "../../../public/embed");
const ORIGIN = "http://localhost:3000";
const MAX = 50000;

const readScript = (name: string) =>
  readFileSync(path.join(SCRIPT_DIR, name), "utf8");

// Every message listener a script registers is removed after the test, so a
// script evaluated in an earlier test can never answer a later test's message.
let added: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAdd = window.addEventListener.bind(window);

beforeEach(() => {
  added = [];
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "message") added.push([type, listener]);
    realAdd(type, listener, opts);
  }) as typeof window.addEventListener);
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [type, listener] of added) window.removeEventListener(type, listener);
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  delete (window as unknown as { HF?: unknown }).HF;
});

function post(
  iframe: HTMLIFrameElement,
  height: unknown,
  origin: string = ORIGIN,
  source: MessageEventSource | null = iframe.contentWindow,
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source,
      data: { type: "hf:resize", height },
    }),
  );
}

// These ship to arbitrary host pages, so they must stay ES5: prettier's default
// trailingComma "all" or a stray arrow/const would break old engines silently,
// and the jsdom tests below run in a modern engine that cannot notice.
describe("host scripts are ES5", () => {
  it.each(["hf-resize.js", "hf-embed.js"])("%s parses at ecmaVersion 5", (name) => {
    expect(() =>
      parse(readScript(name), { ecmaVersion: 5, sourceType: "script" }),
    ).not.toThrow();
  });
});

describe("hf-resize.js (host auto-resize listener)", () => {
  function setup() {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("src", `${ORIGIN}/embed/abc`);
    document.body.appendChild(iframe);
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    new Function(readScript("hf-resize.js"))();
    return iframe;
  }

  it("applies a tall widget height without clipping it (2700px)", () => {
    const iframe = setup();
    post(iframe, 2700);
    expect(iframe.style.height).toBe("2700px");
  });

  it("caps at the 50000px ceiling", () => {
    const iframe = setup();
    post(iframe, 80000);
    expect(iframe.style.height).toBe(`${MAX}px`);
  });

  it("ignores a message from a different origin", () => {
    const iframe = setup();
    post(iframe, 900);
    post(iframe, 2700, "https://evil.example");
    expect(iframe.style.height).toBe("900px");
  });

  it("ignores a message whose source is not the embed iframe", () => {
    const iframe = setup();
    post(iframe, 900);
    post(iframe, 2700, ORIGIN, window);
    expect(iframe.style.height).toBe("900px");
  });
});

describe("hf-embed.js (SDK)", () => {
  function load() {
    // The SDK derives its origin from its own <script src>; document.currentScript
    // is null under Function(), so it falls back to script[src*="hf-embed"].
    const script = document.createElement("script");
    script.setAttribute("src", `${ORIGIN}/embed/hf-embed.js`);
    document.body.appendChild(script);
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    new Function(readScript("hf-embed.js"))();
    return (
      window as unknown as {
        HF: { createWidget: (o: Record<string, unknown>) => { destroy(): void } };
      }
    ).HF;
  }

  describe("inline mode", () => {
    function inline() {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const HF = load();
      HF.createWidget({ embedId: "abc", container });
      const iframe = container.querySelector("iframe") as HTMLIFrameElement;
      expect(iframe.src).toBe(`${ORIGIN}/embed/abc`);
      return iframe;
    }

    it("applies a tall widget height without clipping it (2700px)", () => {
      const iframe = inline();
      post(iframe, 2700);
      expect(iframe.style.height).toBe("2700px");
    });

    it("caps at the 50000px ceiling", () => {
      const iframe = inline();
      post(iframe, 80000);
      expect(iframe.style.height).toBe(`${MAX}px`);
    });

    it("ignores a different origin", () => {
      const iframe = inline();
      post(iframe, 2700, "https://evil.example");
      expect(iframe.style.height).toBe("600px");
    });
  });

  describe("modal mode", () => {
    const innerHeight = window.innerHeight;
    afterEach(() => {
      Object.defineProperty(window, "innerHeight", {
        value: innerHeight,
        configurable: true,
        writable: true,
      });
    });

    function openModal() {
      window.matchMedia = ((q: string) =>
        ({ matches: false, media: q }) as MediaQueryList) as typeof window.matchMedia;
      // A viewport taller than the ceiling, so the panel height is bounded by
      // MAX_HEIGHT rather than by the viewport.
      Object.defineProperty(window, "innerHeight", {
        value: 100000,
        configurable: true,
        writable: true,
      });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const HF = load();
      HF.createWidget({ embedId: "abc", container, mode: "modal" });
      container.querySelector("button")!.click();
      const iframe = document.body.querySelector(
        '[role="dialog"] iframe',
      ) as HTMLIFrameElement;
      const panel = iframe.parentElement as HTMLElement;
      return { iframe, panel };
    }

    it("sizes the panel to tall content (2700px) and scrolls it", () => {
      const { iframe, panel } = openModal();
      post(iframe, 2700);
      expect(panel.style.height).toBe("2700px");
      expect(panel.style.overflowY).toBe("auto");
    });

    it("caps the panel at the 50000px ceiling", () => {
      const { iframe, panel } = openModal();
      post(iframe, 80000);
      expect(panel.style.height).toBe(`${MAX}px`);
    });
  });
});
