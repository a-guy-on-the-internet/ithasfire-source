import { expect, test } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// The consumer shell's three global bands — navbar, page body, footer — share
// ONE horizontal grid: cap 1440, gutters 16 below 641px and 32 at/above it
// (design-system-v2.md §5; `shell-metrics.ts`).
//
// Nothing else can guard this. AppShell.test.tsx mocks Tamagui's `styled` down
// to a bare <div>, so no unit test in this app can see a gutter at all, and the
// bands are styled through three different mechanisms (Tamagui media props on
// the nav and <main>, a CSS custom property on the footer's plain-DOM Swiss
// grid). The last regression was invisible for exactly that reason: the footer
// keyed off `useIsMobile()` (600px) while the other two keyed off `$gtSm`
// (641px), so the three bands agreed everywhere EXCEPT 600–640.
//
// Hence the widths below: 620 is the band that broke, 640/641 straddle the
// breakpoint, 375 is a phone, 1440/1600 are past the cap where the band
// centres and the gutter stops being the whole story.
//
// Read-only: loads `/` and measures. No fixtures, no `resetE2eState()`, no
// mutation of any kind — safe under E2E_USE_LIVE_STACK=1.
// ─────────────────────────────────────────────────────────────────────────────

const WIDTHS = [375, 620, 640, 641, 768, 1440, 1600] as const;

/** Below the 1440 cap the left edge IS the gutter; `$gtSm` is 641. */
const expectedGutter = (width: number) => (width >= 641 ? 32 : 16);

type Edges = {
  navLeft: number;
  navRight: number;
  mainLeft: number;
  mainRight: number;
  footerLeft: number;
  footerRight: number;
  scrollWidth: number;
  innerWidth: number;
};

// One navigation, then resize: the bands are laid out by CSS media queries and
// a matchMedia listener, both of which respond to a viewport change without a
// reload. Seven reloads of the home page cost minutes against a dev server and
// buy nothing.
test("nav, body and footer share one left/right edge at every width", async ({
  page,
}) => {
  test.slow();

  await page.setViewportSize({ width: WIDTHS[0], height: 900 });
  // `domcontentloaded`, not `load`: the home page pulls event posters, and
  // waiting on every image makes this spec a network test.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-content");
  await page.waitForSelector("footer");

  const measured: Record<number, Edges> = {};

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // Navigate fresh at each width rather than measuring a resized page.
    // Resizing alone is not enough to settle this page: the UniverseDust
    // particle canvas keeps its previous pixel width until its own resize
    // handler runs, so `documentElement.scrollWidth` reads the OLD viewport
    // for a frame or two and the overflow assertion below fails at 375 with
    // a number that has nothing to do with the shell grid. A fresh load is
    // also how a reader actually arrives at a width.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#main-content");
    await page.waitForSelector("footer .th-footer-wordmark");
    // Both gutter mechanisms are media-query driven, so the EDGES are correct
    // at first paint. `scrollWidth` is not: the particle canvas and the
    // marquee size themselves from script, so the document is briefly wider
    // than the viewport on a cold render. Poll that one to a stable value
    // instead of sleeping a guessed interval.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
        { message: `horizontal overflow at ${width}px`, timeout: 15_000 },
      )
      .toBe(0);

    measured[width] = await page.evaluate<Edges>(() => {
      const px = (v: string) => parseFloat(v) || 0;

      // The brand IMAGE, not its slot: the slot is allowed to shrink on
      // narrow phones, but the visible lockup is what a reader lines up.
      const brand = document.querySelector<HTMLElement>(
        '[data-testid="web-navbar-brand"] img',
      );
      // Right edge is the row's inner box — the trailing controls are
      // right-aligned inside it, so the box is what defines the band.
      const navRow = document.querySelector<HTMLElement>(
        '[data-testid="web-navbar"]',
      );
      const main = document.querySelector<HTMLElement>("#main-content");
      const footer = document.querySelector<HTMLElement>("footer");
      // Class hooks, not computed-style sniffing. Matching on `font-weight:
      // 900` or a 2px top rule made this spec a description of one footer
      // implementation rather than of the shared-edge contract — it went
      // silently landmark-less the moment the footer was restyled.
      const wordmark = footer?.querySelector<HTMLElement>(
        ".th-footer-wordmark",
      );
      // `.th-footer` owns the horizontal gutter (`--shell-gutter`, published
      // by `.th-shell-band` at the 641 breakpoint), so its inner box IS the
      // footer's band edge. The base row sits inside it with no gutter of
      // its own.
      const bottomBar = footer?.querySelector<HTMLElement>(".th-footer");

      if (!brand || !navRow || !main || !wordmark || !bottomBar) {
        throw new Error("shell band landmarks missing");
      }

      const innerBox = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          left: Math.round(rect.left + px(cs.paddingLeft)),
          right: Math.round(rect.right - px(cs.paddingRight)),
        };
      };

      const nav = innerBox(navRow);
      const body = innerBox(main);
      const bottom = innerBox(bottomBar);

      return {
        navLeft: Math.round(brand.getBoundingClientRect().left),
        navRight: nav.right,
        mainLeft: body.left,
        mainRight: body.right,
        footerLeft: Math.round(wordmark.getBoundingClientRect().left),
        footerRight: bottom.right,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
  }

  for (const width of WIDTHS) {
    const edges = measured[width]!;

    expect(
      { left: edges.navLeft, right: edges.navRight },
      `navbar vs page body at ${width}px`,
    ).toEqual({ left: edges.mainLeft, right: edges.mainRight });

    expect(
      { left: edges.footerLeft, right: edges.footerRight },
      `footer vs page body at ${width}px`,
    ).toEqual({ left: edges.mainLeft, right: edges.mainRight });

    // The gutter itself, so a drift that moves ALL THREE edges together —
    // someone "helpfully" restoring the old 40px footer inset everywhere —
    // still fails. Only meaningful below the cap, where the band is not centred.
    if (width <= 1440) {
      expect(edges.mainLeft, `gutter at ${width}px`).toBe(
        expectedGutter(width),
      );
    }

    expect(edges.scrollWidth, `horizontal overflow at ${width}px`).toBe(
      edges.innerWidth,
    );
  }
});
