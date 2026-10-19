import { expect, test } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Guards commit 6ea2ccdbc: the checkout "flush" shell (no gutters, no top
// padding on a phone) is a CSS media query now, not a JS-gated Tamagui variant
// keyed off `useIsMobile()` (false during SSR, so the server painted the padded
// shell and hydration snapped it flush: 0.045-0.067 layout shift at 320px).
//
// A JavaScript-disabled context renders exactly the server HTML + CSS, so if
// `#main-content` is flush here, it is flush at first paint. 600-640px
// intentionally KEEPS the padded shell (the media query stops at 599.98px).
//
// READ-ONLY: discovers a checkout URL from the home page's event links and measures.
// No seed data, no `resetE2eState()`, no /e2e/seed/* calls. Must be run against
// a running stack with E2E_USE_LIVE_STACK=1, or the harness wipes the dev DB:
//
//   E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
//     e2e/checkout-flush-shell-js-off.spec.ts --project=guest --reporter=list
//
// NOT CI COVERAGE: .github/workflows/e2e.yml runs only its E2E_ALLOWLIST,
// which does not include this spec. It is a manual, live-stack guard.
//
// Project: `guest`. Checkout has no sign-in redirect and is rendered as the
// viewer, so a signed-out visitor sees the same shell; skipping the
// auth.setup storageState dependency keeps the spec hermetic.
//
// Fixtures: the `consoleErrors` fixture only attaches Playwright page
// listeners (CDP side), so it works with JS disabled and the auto-assertion
// stays on. With no scripts running it sees only browser-level errors (failed
// resource loads and the like), so do not read it as console coverage.
// ─────────────────────────────────────────────────────────────────────────────

test.use({ javaScriptEnabled: false });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const origin = baseURL.replace(/\/+$/, "");

/** Max home-page events to probe before giving up (each probe is one SSR). */
const MAX_PROBES = 12;

test("checkout shell is flush at 320 and padded at 620 with JS off", async ({
  page,
  request,
}) => {
  test.slow();

  // ── Discover a checkout URL through a public read path ──────────────────
  // The home page is server-rendered and links to published events. (The
  // dynamic sitemap was removed in 2491c2f3d, so /sitemap.xml is not usable.)
  // 60s timeouts: a cold Turbopack compile can outlast the default.
  const home = await request.get(`${origin}/`, { timeout: 60_000 });
  test.skip(!home.ok(), `GET / returned ${home.status()}`);

  const slugs = Array.from(
    new Set(
      Array.from(
        (await home.text()).matchAll(/href="(\/events\/[^"#?]+)[^"]*"/g),
      )
        .map((m) => m[1]!.replace(/^\/events\//, "").replace(/\/+$/, ""))
        .filter(
          (s) =>
            s &&
            !/^(checkout|category|search|resale|new)(\/|$)/.test(s),
        ),
    ),
  ).slice(0, MAX_PROBES);

  // A checkout URL is usable if it renders a checkout page: 200 (no
  // redirect), the app shell (`id="main-content"`), and the checkout body
  // (`checkout-wrapper`, from Checkout.tsx). Gated events and old slugs
  // redirect, and unknown slugs 404; skipping those is not a failure of this
  // guard.
  // The probe deliberately does NOT look for `th-shell-flush`: if the flush
  // class goes missing, a page is still selected and the `toHaveClass`
  // assertion below FAILS, instead of every probe being rejected and the
  // test skipping.
  let checkoutPath: string | null = null;
  for (const slug of slugs) {
    const path = `/events/checkout/${slug}`;
    const res = await request.get(`${origin}${path}`, {
      maxRedirects: 0,
      timeout: 60_000,
    });
    if (res.status() !== 200) continue;
    const html = await res.text();
    if (html.includes('id="main-content"') && html.includes("checkout-wrapper")) {
      checkoutPath = path;
      break;
    }
  }
  test.skip(
    !checkoutPath,
    `no event linked from the home page (of ${slugs.length} probed) renders a checkout page; seed a published, ungated event with tickets`,
  );

  // ── 320: flush ──────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(checkoutPath!, { waitUntil: "domcontentloaded" });
  const main = page.locator("#main-content");
  await expect(main).toHaveClass(/\bth-shell-flush\b/);

  const padding = () =>
    main.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        left: cs.paddingLeft,
        right: cs.paddingRight,
        top: cs.paddingTop,
      };
    });

  expect(await padding(), "padding at 320px").toEqual({
    left: "0px",
    right: "0px",
    top: "0px",
  });

  // clientWidth vs scrollWidth: `innerWidth` lies under device emulation.
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll, "horizontal overflow at 320px").toBeLessThanOrEqual(
    overflow.client,
  );

  // ── 620: padded shell kept, by design ───────────────────────────────────
  await page.setViewportSize({ width: 620, height: 900 });
  await page.goto(checkoutPath!, { waitUntil: "domcontentloaded" });
  await expect(main).toHaveClass(/\bth-shell-flush\b/);

  const wide = await padding();
  expect(wide.left, "padding-left at 620px").not.toBe("0px");
  expect(wide.right, "padding-right at 620px").not.toBe("0px");
});
