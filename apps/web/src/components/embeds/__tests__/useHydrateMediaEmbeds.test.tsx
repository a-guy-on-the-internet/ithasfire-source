import { StrictMode, useRef } from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useHydrateMediaEmbeds } from "../useHydrateMediaEmbeds";

/**
 * Regression: a media-embed figure the hydrator cannot read (unknown provider,
 * missing data-external-id or data-embed-url) was never marked seen, so the
 * MutationObserver treated it as new on every later DOM mutation. Each
 * re-hydrate rebuilt the valid embed beside it, which mutated the DOM again:
 * an endless microtask loop that froze the tab. This hook shares its body
 * container with the audio hydrator (EventContent's EventBodyContent).
 */

const VALID = `<figure data-type="media-embed" data-provider="youtube" data-source-url="https://www.youtube.com/watch?v=abc123def45" data-embed-url="https://www.youtube-nocookie.com/embed/abc123def45" data-external-id="abc123def45" data-render-mode="link" data-title="Valid clip"></figure>`;
const UNREADABLE = `<figure data-type="media-embed" data-provider="not-a-provider" data-source-url="https://example.com/x" data-render-mode="link"><a href="https://example.com/x">fallback link</a></figure>`;

/**
 * MutationObserver whose callback stops being delivered after CAP calls, so a
 * re-hydrate loop ends as a failing count instead of freezing the worker.
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

function Body({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useHydrateMediaEmbeds(ref, [html]);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

beforeEach(() => {
  observerCallbacks = 0;
  globalThis.MutationObserver = CappedMutationObserver;
});

afterEach(() => {
  cleanup();
  globalThis.MutationObserver = RealMutationObserver;
});

describe.each([
  ["StrictMode", true],
  ["no StrictMode, as in production", false],
])("useHydrateMediaEmbeds (%s)", (_label, strict) => {
  it("an unreadable figure beside a valid embed does not loop re-hydration", async () => {
    const body = <Body html={VALID + UNREADABLE} />;
    const { container } = render(strict ? <StrictMode>{body}</StrictMode> : body);

    // Any later childList mutation inside the body wakes the observer.
    const embed = container.querySelector('[data-testid="media-embed-link"]');
    expect(embed).not.toBeNull();
    container.firstElementChild!.appendChild(document.createTextNode(" "));
    await new Promise((r) => setTimeout(r, 20));

    expect(observerCallbacks).toBeLessThan(5);
    expect(container.querySelectorAll('[data-testid="media-embed-link"]')).toHaveLength(1);
    // The unreadable figure is left exactly as the server rendered it.
    expect(container.textContent).toContain("fallback link");
  }, 5_000);
});
