import { mkdirSync, writeFileSync } from "node:fs";

import { request as pwRequest } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { ensureBetterAuthTestUserExists } from "./helpers/better-auth-test-user";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { verifySignUpOtp } from "./helpers/verify-sign-up-otp";

/**
 * A moderator writes the page of a place nobody owns, then hands it over
 * (docs/specs/2026-10-14/moderator-place-page.spec.yaml, D6-D8, FR-005..008).
 * Driven in order, one test per actor so each starts from its own cookie jar:
 *
 *  1. the platform ADMIN (a COMMUNITY_MODERATION role) reaches the editor from
 *     the place page's "Edit page" and saves a bio;
 *  2. signed out, the page says it is community-maintained until claimed;
 *  3. a fresh user claims it with a document; while the claim is in review
 *     the moderator editor refuses (CLAIM_PENDING); the ADMIN approves;
 *  4. signed out, the byline now says moderators wrote it (unreviewed);
 *  5. the new owner sees the handover notice and clears it;
 *  6. signed out, no community notice is left.
 * At 320px: the moderator editor, the public notice and the owner's notice
 * show no horizontal overflow (page-level: scrollWidth vs clientWidth).
 *
 * Layout readings and console errors are COLLECTED by tests 1-6 and asserted
 * by test 7, so a layout or console fault fails the run without skipping the
 * handover steps behind it. The fixture's console-error gate still runs: its
 * per-test errors are moved into test 7, after the same ignore list.
 *
 * ── LIVE STACK ONLY ──────────────────────────────────────────────────────
 *
 * `/moderate` and the moderator page writes need a second factor; locally the
 * API's `DEV_BYPASS_STAFF_2FA` stands in for one (see
 * `moderate-listing-schedule.spec.ts`). The claim document goes to the dev
 * MinIO behind the API's presigned URL.
 *
 * ── WHAT A RUN LEAVES BEHIND ─────────────────────────────────────────────
 *
 * One ARCHIVED place (created fresh through `community.createPlace`; owned by
 * the fresh claimant once step 3 lands), its EntityPage, its audit rows, the
 * claim request and document, and one fresh claimant account
 * (`e2e-modpage-<ts>@example.com`). Nothing touches seeded places. The
 * afterAll archives the place through whichever use case its state allows:
 * the owner's `places.updatePlaceStatus` once claimed, the claimant's
 * withdraw plus `community.archivePlace` while a claim is pending, or
 * `community.archivePlace` alone before any claim. It never calls
 * `resetE2eState`.
 */

const API = process.env.E2E_API_BASE_URL || "http://localhost:3001";
const WEB = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
/** `apps/api/src/scripts/seed/ids.ts` — the seeded platform admin. */
const ADMIN = { email: "admin@ithasfire.com", password: "Dev-Login-2026!" };

/**
 * Screenshots and the run's diagnostics go to this directory when set (a
 * drive keeps them in one place); otherwise to each test's output folder.
 */
const SHOTS = process.env.E2E_DRIVE_SHOTS_DIR ?? null;

const RUN = Date.now();
/** Short base-36 suffix: a 13-digit word would overflow the hero at 320px. */
const RUN_TAG = RUN.toString(36).slice(-6);
const PLACE_NAME = `E2E Moderated Room ${RUN_TAG}`;
/**
 * The name the moderator gives it through "Edit place details" (test 1).
 * Long enough to wrap to three lines in the 320px editor canvas, so the top
 * line sits high in the hero, where the scrim is thinnest.
 */
const RENAMED = `E2E Moderated Back Hall ${RUN_TAG}`;
const BIO = `Moderator-written bio ${RUN_TAG}: a back room with a piano.`;
const CLAIMANT = {
  email: `e2e-modpage-${RUN}@example.com`,
  password: "Password123!e2e",
  name: "E2E Place Claimant",
};

/** The handover notice's byline copy (en.ts `communityPlacePage`). */
const BYLINE_CLAIMABLE = "moderators keep this page until the place is claimed";
const BYLINE_UNREVIEWED = "written by moderators";

type OverflowReading = {
  where: string;
  scrollWidth: number;
  clientWidth: number;
  /** The widest elements past the right edge, for the failure message. */
  offenders: string[];
  /** The widest offender and its ancestors, innermost first. */
  chain?: string[];
};

/**
 * Horizontal overflow, read as scrollWidth vs clientWidth (innerWidth lies
 * under device emulation). RECORDED, not asserted, so a layout defect fails
 * the final test instead of skipping the rest of the flow behind it.
 */
async function readOverflow(
  page: Page,
  where: string,
): Promise<OverflowReading> {
  // Right after `setViewportSize`, JS-driven media queries (the admin top
  // bar's) can still hold the wide layout for a frame or two: one run read
  // 685px there. Give the layout up to 5s to fit, then read whatever it is;
  // an overflow that persists is still recorded.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      { timeout: 5_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  const reading = await page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth;
    const offenders = Array.from(
      document.body.querySelectorAll<HTMLElement>("*"),
    )
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter(({ right }) => right > limit + 0.5)
      .sort((a, b) => b.right - a.right)
      .slice(0, 6)
      .map(({ el, right }) => {
        const id = el.getAttribute("data-testid");
        const cls = (el.getAttribute("class") ?? "")
          .split(/\s+/)
          .slice(0, 2)
          .join(".");
        const text = (el.textContent ?? "").trim().slice(0, 40);
        return `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ""}${cls ? `.${cls}` : ""} right=${Math.round(right)} "${text}"`;
      });
    // The widest offender's ancestors, so the element that is too wide (not
    // just the one that sticks out) is in the reading.
    const widest = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .filter((el) => el.getBoundingClientRect().right > limit + 0.5)
      .sort(
        (a, b) =>
          b.getBoundingClientRect().right - a.getBoundingClientRect().right,
      )[0];
    const chain: string[] = [];
    for (let el = widest; el && el !== document.body; ) {
      const r = el.getBoundingClientRect();
      const cls = (el.getAttribute("class") ?? "")
        .split(/\s+/)
        .slice(0, 2)
        .join(".");
      const id = el.getAttribute("data-testid");
      chain.push(
        `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ""}${cls ? `.${cls}` : ""} left=${Math.round(r.left)} w=${Math.round(r.width)} sw=${el.scrollWidth} cw=${el.clientWidth} ovx=${getComputedStyle(el).overflowX}`,
      );
      el = el.parentElement as HTMLElement;
    }
    // Text can run past a box that itself fits (a long word in a narrow
    // column), so text nodes are read too.
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const right = range.getBoundingClientRect().right;
      if (right > limit + 0.5) {
        const host = n.parentElement;
        const cls = (host?.getAttribute("class") ?? "")
          .split(/\s+/)
          .slice(0, 2)
          .join(".");
        chain.push(
          `text "${n.textContent.trim().slice(0, 30)}" right=${Math.round(right)} in ${host?.tagName.toLowerCase()}.${cls} w=${Math.round(host?.getBoundingClientRect().width ?? 0)}`,
        );
      }
    }
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: limit,
      offenders,
      chain,
    };
  });
  return { where, ...reading };
}

/** React attached to the server HTML: the node carries a fiber key. */
async function expectHydrated(page: Page, testId: string) {
  await expect
    .poll(
      () =>
        page
          .getByTestId(testId)
          .first()
          .evaluate((el) =>
            Object.keys(el).some((k) => k.startsWith("__reactFiber")),
          ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(page.getByText(/hydration failed|did not match/i)).toHaveCount(
    0,
  );
}

/**
 * The shared dev API runs under `tsx watch` and restarts whenever a peer
 * session edits a package (measured 2026-10-15: down ~13 s every minute or
 * two). A page whose reads land in that window renders its "no answer"
 * state, so every navigation first waits for the API to answer.
 */
async function waitForApi() {
  const ctx = await pwRequest.newContext();
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await ctx.get(`${API}/health`, { timeout: 3_000 })).ok();
          } catch {
            return false;
          }
        },
        { timeout: 90_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true);
  } finally {
    await ctx.dispose();
  }
}

/**
 * A direct tRPC call, made once the API answers, and retried ONCE when the
 * connection is refused (a watcher restart landing between the health check
 * and the call). A refused connection never reached the server, so the retry
 * cannot double a mutation; any other failure is thrown as it is.
 */
async function api<T>(call: () => Promise<T>): Promise<T> {
  await waitForApi();
  try {
    return await call();
  } catch (err) {
    if (!String(err).includes("ECONNREFUSED")) throw err;
    await waitForApi();
    return call();
  }
}

async function gotoReady(page: Page, url: string) {
  await waitForApi();
  await page.goto(url);
}

/**
 * The place page's "Edit page" link, which resolves from up to three chained
 * reads with `retry: false`. One reload after the API answers again covers a
 * watcher restart landing on those reads.
 */
async function editPageLink(page: Page) {
  const link = page.getByRole("link", { name: "Edit page" });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await expect(link).toBeVisible({ timeout: 20_000 });
      return link;
    } catch (err) {
      if (attempt === 2) throw err;
      await waitForApi();
      await page.reload();
    }
  }
  return link;
}

/**
 * The hero name's words each sit on one line: the name wraps between words,
 * never inside one (the 320px defect: "MODERAT / ED").
 */
async function expectNameWordsWhole(page: Page, name: string, where: string) {
  const words = await page
    .locator('h1[class*="displayName"]')
    .filter({ hasText: name })
    .first()
    .evaluate((el) => {
      const text = el.firstChild;
      if (text?.nodeType !== Node.TEXT_NODE) return null;
      const range = document.createRange();
      const out: { word: string; lines: number }[] = [];
      let i = 0;
      for (const word of (text.textContent ?? "").split(" ")) {
        const tops = new Set<number>();
        for (let c = 0; c < word.length; c++) {
          range.setStart(text, i + c);
          range.setEnd(text, i + c + 1);
          tops.add(Math.round(range.getBoundingClientRect().top));
        }
        out.push({ word, lines: tops.size });
        i += word.length + 1;
      }
      return out;
    });
  expect(words, `${where}: hero name is one text node`).not.toBeNull();
  for (const { word, lines } of words ?? []) {
    expect(lines, `${where}: "${word}" stays on one line`).toBe(1);
  }
}

type ContrastReading = {
  where: string;
  lines: number;
  /** The top line's centre, as a share of the hero height from its bottom. */
  topLineFromBottomPct: number;
  /** Scrim alpha (black) behind that centre. */
  scrimAlpha: number;
  /** White text over the scrim over a WHITE banner: the worst case. */
  contrast: number;
};

/**
 * The hero name's top line against the scrim, over a white banner (the
 * brightest photo there can be). The banner is painted in the browser, under
 * the scrim; nothing is uploaded. The contrast is worked out from the scrim
 * gradient's computed stops: the scrim composited over white, against white
 * text. The text shadow is left out, so it is a floor.
 */
async function readTopLineContrast(
  page: Page,
  name: string,
  where: string,
): Promise<ContrastReading> {
  const h1 = page
    .locator('[class*="heroOverlay"] h1[class*="displayName"]')
    .filter({ hasText: name })
    .first();
  const reading = await h1.evaluate((el) => {
    const frame = el.closest('[class*="heroFrame"]');
    const hero = frame?.firstElementChild as HTMLElement | null;
    const scrim = hero?.querySelector<HTMLElement>('[class*="heroScrim"]');
    if (!hero || !scrim) throw new Error("no hero or scrim");
    if (!hero.querySelector("[data-e2e-white-banner]")) {
      const white = document.createElement("div");
      white.setAttribute("data-e2e-white-banner", "");
      // ds-color-ok: a test fixture standing in for a bright photo.
      white.style.cssText = "position:absolute;inset:0;background:#fff";
      hero.insertBefore(white, scrim);
    }
    const text = el.firstChild;
    if (text?.nodeType !== Node.TEXT_NODE) throw new Error("name");
    const range = document.createRange();
    const tops = new Map<number, number>();
    for (let c = 0; c < (text.textContent ?? "").length; c++) {
      range.setStart(text, c);
      range.setEnd(text, c + 1);
      const r = range.getBoundingClientRect();
      if (r.width === 0) continue;
      const top = Math.round(r.top);
      tops.set(top, Math.max(tops.get(top) ?? 0, r.bottom));
    }
    const firstTop = Math.min(...tops.keys());
    const centre = (firstTop + (tops.get(firstTop) ?? firstTop)) / 2;
    const hb = hero.getBoundingClientRect();
    const fromBottom = (hb.bottom - centre) / hb.height;
    const stops = [
      ...getComputedStyle(scrim).backgroundImage.matchAll(
        /rgba?\(0, 0, 0(?:, ([\d.]+))?\) ([\d.]+)%/g,
      ),
    ].map((m) => ({ a: m[1] === undefined ? 1 : Number(m[1]), at: Number(m[2]) / 100 }));
    let alpha = stops[stops.length - 1]?.a ?? 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const lo = stops[i]!;
      const hi = stops[i + 1]!;
      if (fromBottom >= lo.at && fromBottom <= hi.at) {
        alpha = lo.a + ((hi.a - lo.a) * (fromBottom - lo.at)) / (hi.at - lo.at);
        break;
      }
    }
    // Black at `alpha` over white, in sRGB, then WCAG relative luminance.
    const v = 1 - alpha;
    const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    return {
      lines: tops.size,
      topLineFromBottomPct: Math.round(fromBottom * 100),
      scrimAlpha: Math.round(alpha * 100) / 100,
      contrast: Math.round((1.05 / (lin + 0.05)) * 100) / 100,
    };
  });
  return { where, ...reading };
}

async function shot(page: Page, name: string, fullPage = true) {
  const path = SHOTS
    ? `${SHOTS}/${name}.png`
    : test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage });
}

/**
 * Sign-in, retried on Better Auth's 429: the run signs in five or six times
 * from one address, and peers' specs share the same limit. Each attempt goes
 * through `api`, so a watcher restart is waited out too.
 */
async function signIn(
  ctx: APIRequestContext,
  creds: { email: string; password: string },
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await api(() => signInAndGetToken(ctx, API, creds))).token;
    } catch (err) {
      if (attempt >= 8 || !String(err).includes("Sign-in failed: 429"))
        throw err;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

function trpcFor(ctx: APIRequestContext, token: string) {
  return createE2eTrpcClient(ctx, API, { bearerToken: token });
}

test.describe.serial("moderator writes an unowned place's page", () => {
  test.skip(
    process.env.E2E_USE_LIVE_STACK !== "1",
    "needs the local API's DEV_BYPASS_STAFF_2FA; live stack only",
  );
  test.slow();
  test.use({ storageState: { cookies: [], origins: [] } });

  let placeId: string | null = null;
  let slug: string | null = null;
  /** The place's name now: RENAMED once test 1's facts edit lands. */
  let placeName = PLACE_NAME;
  let claimRequestId: string | null = null;
  let claimApproved = false;
  let claimantSignedUp = false;
  /** Bearer tokens kept for the teardown, so it adds no sign-ins. */
  let adminToken: string | null = null;
  let ownerToken: string | null = null;
  /** 320px readings, asserted together by the last test. */
  const overflow: OverflowReading[] = [];
  /** Hero-name contrast at 320 over a white banner, asserted by test 7. */
  const contrast: ContrastReading[] = [];
  /** Same readings on surfaces this spec does not own; logged, not asserted. */
  const controls: OverflowReading[] = [];
  /**
   * Console errors per test, after the fixture's ignore list, asserted by the
   * last test for the same reason as `overflow`: one noisy page must not
   * skip the steps behind it. `consoleSources` adds where each error came
   * from (page and script URL), which the fixture's text alone lacks.
   */
  const consoleErrorsSeen: string[] = [];
  const consoleSources: string[] = [];
  /**
   * Tests in which a request to the API was refused (a watcher restart, see
   * `waitForApi`). Chrome's "Failed to load resource: net::ERR_CONNECTION_
   * REFUSED" line carries no URL, so it is exempted only in those tests.
   */
  const apiRefusedIn = new Set<string>();
  let exemptedRefusals = 0;

  test.beforeEach(({ page }, testInfo) => {
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const loc = msg.location();
      consoleSources.push(
        `[${testInfo.title.slice(0, 2)}] ${msg.text().slice(0, 140)} | page=${page.url()} | src=${loc.url}:${loc.lineNumber}`,
      );
    });
    page.on("requestfailed", (req) => {
      if (
        req.url().startsWith(API) &&
        (req.failure()?.errorText ?? "").includes("ERR_CONNECTION_REFUSED")
      ) {
        apiRefusedIn.add(testInfo.title);
      }
      consoleSources.push(
        `[${testInfo.title.slice(0, 2)}] requestfailed ${req.failure()?.errorText} ${req.url()}`,
      );
    });
  });

  test.afterEach(({ consoleErrors }, testInfo) => {
    for (const e of consoleErrors.errors()) {
      if (
        apiRefusedIn.has(testInfo.title) &&
        e === "Failed to load resource: net::ERR_CONNECTION_REFUSED"
      ) {
        exemptedRefusals++;
        continue;
      }
      consoleErrorsSeen.push(
        `[${testInfo.title.slice(0, 2)}] ${e.slice(0, 200)}`,
      );
    }
    consoleErrors.ignore();
  });

  test.afterAll(async () => {
    if (!placeId) return;
    const id = placeId;
    const ctx = await pwRequest.newContext();
    const errors: string[] = [];
    /** The token the run already holds, else a fresh sign-in. */
    const as = async (
      cached: string | null,
      creds: { email: string; password: string },
    ) => trpcFor(ctx, cached ?? (await signIn(ctx, creds)));
    try {
      await waitForApi();
      if (claimApproved) {
        // Owned now: the owner retires it through the owner path.
        await (
          await as(ownerToken, CLAIMANT)
        ).places.updatePlaceStatus
          .mutate({
            placeId: id,
            status: "ARCHIVED",
            clientKey: `e2e-modpage-archive-${id}`,
          })
          .catch((e: unknown) => errors.push(`owner archive: ${String(e)}`));
      } else {
        if (claimRequestId && claimantSignedUp) {
          // A pending claim blocks the moderator archive; withdraw it first.
          await (
            await as(ownerToken, CLAIMANT)
          ).places.withdrawPlaceVerification
            .mutate({ requestId: claimRequestId })
            .catch((e: unknown) => errors.push(`withdraw: ${String(e)}`));
        }
        await (await as(adminToken, ADMIN)).community.archivePlace
          .mutate({ placeId: id, clientKey: `e2e-modpage-archive-${id}` })
          .catch((e: unknown) =>
            errors.push(`moderator archive: ${String(e)}`),
          );
      }
    } catch (err) {
      errors.push(`teardown: ${String(err)}`);
    } finally {
      await ctx.dispose();
    }
    if (errors.length > 0) {
      console.error(`[e2e] place ${id} may still be ACTIVE:`, errors);
      throw new Error(errors.join("\n"));
    }
  });

  test("1. the moderator opens the editor from the place page and saves a bio", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const token = await signIn(page.request, ADMIN);
    adminToken = token;
    const admin = trpcFor(page.request, token);

    // A fresh, ACTIVE place nobody owns, made the way moderators make them.
    // A per-run jitter keeps it clear of the 50 m same-name duplicate guard.
    const jitter = (RUN % 1000) / 100_000;
    const created = await api(() =>
      admin.community.createPlace.mutate({
        name: PLACE_NAME,
        address: {
          formatted: "100 E2E Test Alley, Nashville, TN 37203, USA",
          line1: "100 E2E Test Alley",
          city: "Nashville",
          region: "TN",
          postalCode: "37203",
          countryCode: "US",
          lat: 36.1512 + jitter,
          lng: -86.7969 - jitter,
        },
        clientKey: `e2e-modpage-create-${RUN}`,
      }),
    );
    placeId = created.placeId;
    // A const for the closures below: a captured `let` loses its narrowing.
    const newPlaceId = created.placeId;
    expect(created.status).toBe("ACTIVE");

    const probe = await api(() =>
      admin.entityPages.placePageEditAccess.query({
        placeId: newPlaceId,
      }),
    );
    expect(probe).toMatchObject({
      canEditPage: true,
      editorKind: "community_moderator",
    });

    // The page's slug (this is also the editor's first-load read).
    const mine = await api(() =>
      admin.entityPages.getMyPage.query({
        ownerType: "PLACE",
        ownerId: newPlaceId,
      }),
    );
    slug = mine.page.slug;

    // The place page offers "Edit page" to a moderator.
    await gotoReady(page, `/p/${slug}`);
    const editPage = await editPageLink(page);
    await shot(page, "1-place-page-moderator-1280");
    await editPage.click();
    // Wait for either landing, so a 2FA bounce fails with its own message.
    await expect(page).toHaveURL(
      new RegExp(`/moderate/places/${placeId}/page$|/enroll-2fa`),
      { timeout: 30_000 },
    );
    if (new URL(page.url()).pathname.startsWith("/enroll-2fa")) {
      throw new Error(
        "/moderate sent the seeded admin to /enroll-2fa: start the API with " +
          "DEV_BYPASS_STAFF_2FA=1 (apps/api/.env.local) to run this spec.",
      );
    }

    // The editor mounts, badged as the moderator's.
    await expect(page.getByTestId("entity-page-settings-toggle")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Moderator", { exact: true })).toBeVisible();
    // A press that lands before the editor hydrates is lost; press until the
    // disclosure says it is open.
    const toggle = page.getByTestId("entity-page-settings-toggle");
    await expect(async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(toggle).toHaveAttribute("aria-expanded", "true", {
        timeout: 2_000,
      });
    }).toPass({ timeout: 20_000 });
    const bio = page.locator("#entity-page-bio");
    await expect(bio).toBeVisible();
    // The name line points a moderator at the facts edit, not "Identity".
    await expect(
      page.getByText(
        "A place has one name. Change it with Edit place details, at the top.",
      ),
    ).toBeVisible({ timeout: 15_000 });
    await bio.fill(BIO);
    await page.getByTestId("entity-page-save").click();
    await expect(page.getByText("Page updated").first()).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "1-moderator-editor-saved-1280");

    // The block toolbar's buttons are 44px tap targets.
    const targets = page.locator(
      '[data-testid^="entity-page-block-actions-"] button',
    );
    const readTargets = () =>
      targets.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        }),
      );
    const sizes1280 = await readTargets();
    expect(sizes1280.length, "block toolbar buttons").toBeGreaterThan(0);
    for (const { w, h } of sizes1280) {
      expect(Math.min(w, h), "toolbar tap target @1280").toBeGreaterThanOrEqual(
        44,
      );
    }

    // The editor takes the full width here, not /moderate's 960px band.
    const heroWidth = await page
      .locator('h1[class*="displayName"]')
      .first()
      .evaluate(
        (el) =>
          (el.closest('[class*="heroFrame"]') ?? el).getBoundingClientRect()
            .width,
      );
    expect(heroWidth, "moderator canvas hero @1280").toBeGreaterThan(960);

    // The header's "Edit place details" is 44px tall. ("Add Block" is not
    // on a standard-template place editor; it is measured elsewhere.)
    const factsBox1280 = await page
      .getByTestId("moderator-place-facts-edit")
      .boundingBox();
    expect(
      factsBox1280?.height ?? 0,
      "header tap target @1280",
    ).toBeGreaterThanOrEqual(44);

    // Place facts: "Edit place details" opens the community place edit,
    // prefilled, and the canvas shows the new name once it saves.
    await page.getByTestId("moderator-place-facts-edit").click();
    const dialog = page.getByTestId("place-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // Archive is not offered from the page editor.
    await expect(dialog.getByTestId("place-dialog-archive")).toHaveCount(0);
    const nameField = dialog.getByLabel("Name", { exact: true });
    await expect(nameField).toHaveValue(PLACE_NAME, { timeout: 15_000 });
    await shot(page, "1-moderator-facts-dialog-1280", false);
    await nameField.fill(RENAMED);
    await page.getByTestId("place-dialog-submit").click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText("Place updated").first()).toBeVisible();
    await expect(page.getByText(RENAMED).first()).toBeVisible({
      timeout: 15_000,
    });
    placeName = RENAMED;
    const renamed = await api(() =>
      admin.places.getPlacePublic.query({ placeId: newPlaceId }),
    );
    expect(renamed.place.name).toBe(RENAMED);
    await shot(page, "1-moderator-editor-renamed-1280", false);

    // The server holds it.
    const after = await api(() =>
      admin.entityPages.getMyPage.query({
        ownerType: "PLACE",
        ownerId: newPlaceId,
      }),
    );
    expect(after.page.bio).toBe(BIO);

    // 320px: the moderator editor.
    await page.setViewportSize({ width: 320, height: 800 });
    await waitForApi();
    await page.reload();
    await expect(page.getByTestId("entity-page-settings-toggle")).toBeVisible({
      timeout: 30_000,
    });
    overflow.push(await readOverflow(page, "moderator editor @320"));
    await shot(page, "1-moderator-editor-320", false);
    const sizes320 = await readTargets();
    expect(sizes320.length).toBeGreaterThan(0);
    for (const { w, h } of sizes320) {
      expect(Math.min(w, h), "toolbar tap target @320").toBeGreaterThanOrEqual(
        44,
      );
    }
    const factsBox = await page
      .getByTestId("moderator-place-facts-edit")
      .boundingBox();
    expect(factsBox?.height ?? 0, "header tap target @320").toBeGreaterThanOrEqual(
      44,
    );
    // The hero name at 320: each word on one line (no break inside a word).
    await expectNameWordsWhole(page, RENAMED, "moderator editor @320");
    contrast.push(
      await readTopLineContrast(page, RENAMED, "moderator editor @320"),
    );
    if (SHOTS) {
      // Diagnostics: the hero with this step's scrim, then with the base
      // scrim (read from the page's own stylesheet), over the white banner.
      const frame = page
        .locator('[class*="heroFrame"]')
        .filter({ has: page.locator('h1[class*="displayName"]') })
        .first();
      // The editor's sticky header and toolbar cover ~440px at 320: a taller
      // window (same width, same layout) lets the hero sit clear of them.
      const heroShot = async (path: string) => {
        await page.setViewportSize({ width: 320, height: 1400 });
        await frame.evaluate((el) => el.scrollIntoView({ block: "end" }));
        await page.evaluate(() => window.scrollBy(0, 120));
        const box = await frame.boundingBox();
        if (box) await page.screenshot({ path, clip: box });
        await page.setViewportSize({ width: 320, height: 800 });
      };
      await heroShot(`${SHOTS}/1-hero-white-banner-320-after.png`);
      const baseScrim = await frame.evaluate((el) => {
        const scrim = el.querySelector<HTMLElement>('[class*="heroScrim"]');
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            if (
              rule instanceof CSSStyleRule &&
              rule.selectorText.includes("heroScrim") &&
              rule.style.backgroundImage
            ) {
              if (scrim) scrim.style.backgroundImage = rule.style.backgroundImage;
              return rule.style.backgroundImage;
            }
          }
        }
        return null;
      });
      if (baseScrim) {
        const before = await readTopLineContrast(page, RENAMED, "base scrim");
        console.log(
          `[e2e] base scrim @320 over white: top line at ${before.topLineFromBottomPct}% scrim ${before.scrimAlpha} contrast ${before.contrast}:1`,
        );
        await heroShot(`${SHOTS}/1-hero-white-banner-320-before.png`);
        await frame.evaluate((el) => {
          el.querySelector<HTMLElement>('[class*="heroScrim"]')?.style.removeProperty(
            "background-image",
          );
        });
      }
    }
    // The white stand-in banner was only for the contrast reading.
    await page.evaluate(() => {
      document.querySelectorAll("[data-e2e-white-banner]").forEach((n) => n.remove());
    });
    await page
      .getByTestId("moderator-place-facts-edit")
      .scrollIntoViewIfNeeded();
    await shot(page, "1-moderator-editor-320-full", true);
  });

  test("2. signed out, the page is community-maintained until claimed", async ({
    page,
  }) => {
    expect(slug).toBeTruthy();
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, `/p/${slug}`);
    const notice = page.getByTestId("community-place-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("Community-maintained");
    await expect(notice).toContainText(BYLINE_CLAIMABLE);
    await expect(page.getByText(BIO)).toBeVisible();
    await expectHydrated(page, "community-place-notice");
    // Nobody signed in: no editor entry.
    await expect(page.getByRole("link", { name: "Edit page" })).toHaveCount(0);
    await shot(page, "2-public-claimable-1280");

    await page.setViewportSize({ width: 320, height: 800 });
    await waitForApi();
    await page.reload();
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expectHydrated(page, "community-place-notice");
    overflow.push(await readOverflow(page, "public place page @320"));
    await notice.scrollIntoViewIfNeeded();
    await shot(page, "2-public-claimable-320", false);
  });

  test("3. a claim in review freezes the page; the admin approves it", async ({
    page,
  }) => {
    expect(placeId).toBeTruthy();
    const id = placeId!;

    // A fresh claimant, verified by the emailed code.
    const claimantCtx = await pwRequest.newContext();
    await api(() =>
      ensureBetterAuthTestUserExists({
        request: claimantCtx,
        apiBaseUrl: API,
        ...CLAIMANT,
      }),
    );
    claimantSignedUp = true;
    await api(() =>
      verifySignUpOtp({
        request: claimantCtx,
        apiBaseUrl: API,
        email: CLAIMANT.email,
        webOrigin: WEB,
      }),
    );
    const claimantToken = await signIn(claimantCtx, CLAIMANT);
    ownerToken = claimantToken;
    const claimant = trpcFor(claimantCtx, claimantToken);
    const { owners } = await api(() =>
      claimant.events.listEventOwnerEntities.query({}),
    );
    const self = owners.find((o) => o.kind === "human");
    expect(self, "claimant has a human owner entity").toBeTruthy();
    if (self?.kind !== "human") throw new Error("no human owner entity");

    // The claim, proven by a document, through the wizard's own calls:
    // presign, PUT to storage, submit.
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
      "utf8",
    );
    const upload = await api(() =>
      claimant.places.requestClaimDocUpload.mutate({
        placeId: id,
        contentType: "application/pdf",
        sizeBytes: pdf.length,
        fileName: "lease.pdf",
        context: "claim",
      }),
    );
    const put = await claimantCtx.put(upload.uploadUrl, {
      headers: { "Content-Type": "application/pdf" },
      data: pdf,
    });
    expect(put.ok(), `claim doc PUT ${put.status()}`).toBe(true);
    const claim = await api(() =>
      claimant.places.submitPlaceClaim.mutate({
        placeId: id,
        owner: { kind: "human", humanId: self.humanId },
        proof: {
          kind: "document",
          documents: [
            {
              storageKey: upload.key,
              fileName: "lease.pdf",
              contentType: "application/pdf",
              sizeBytes: pdf.length,
            },
          ],
        },
        clientKey: `e2e-modpage-claim-${RUN}`,
      }),
    );
    expect(claim.placeVerification).toBe("PENDING");
    expect(claim.requestId).toBeTruthy();
    claimRequestId = claim.requestId;
    await claimantCtx.dispose();

    // While it is reviewed, the moderator is refused.
    const token = await signIn(page.request, ADMIN);
    adminToken = token;
    const admin = trpcFor(page.request, token);
    const probe = await api(() =>
      admin.entityPages.placePageEditAccess.query({
        placeId: id,
      }),
    );
    expect(probe).toMatchObject({
      canEditPage: false,
      reason: "CLAIM_PENDING",
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, `/moderate/places/${id}/page`);
    await expect(
      page.getByTestId("moderator-place-page-refused-claim_pending"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("entity-page-settings-toggle")).toHaveCount(
      0,
    );
    await shot(page, "3-moderator-refused-claim-pending-1280");

    // The place page no longer offers the moderator an editor.
    await gotoReady(page, `/p/${slug}`);
    await expect(page.getByTestId("community-place-notice")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("link", { name: "Edit page" })).toHaveCount(0);

    // The admin approves through the review procedure.
    const reviewed = await api(() =>
      admin.places.reviewPlaceVerification.mutate({
        requestId: claimRequestId!,
        decision: "APPROVED",
      }),
    );
    expect(reviewed).toBeTruthy();
    claimApproved = true;
    const afterApproval = await api(() =>
      admin.entityPages.placePageEditAccess.query({
        placeId: id,
      }),
    );
    expect(afterApproval).toMatchObject({
      canEditPage: false,
      reason: "OWNED",
    });
  });

  test("4. signed out, the byline says moderators wrote it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, `/p/${slug}`);
    const notice = page.getByTestId("community-place-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText(BYLINE_UNREVIEWED);
    await expect(notice).not.toContainText(BYLINE_CLAIMABLE);
    await expect(page.getByText(BIO)).toBeVisible();
    await expectHydrated(page, "community-place-notice");
    await shot(page, "4-public-unreviewed-1280");
  });

  test("5. the new owner sees the handover notice and clears it", async ({
    page,
  }) => {
    expect(claimApproved).toBe(true);
    const token = await signIn(page.request, CLAIMANT);
    ownerToken = token;
    const owner = trpcFor(page.request, token);

    // The owner reaches their own editor from the place page.
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, `/p/${slug}`);
    const editPage = await editPageLink(page);
    await editPage.click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/[^/]+/places/${placeId}/page$`),
      { timeout: 30_000 },
    );

    const notice = page.getByTestId("community-handover-notice");
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("Moderators wrote parts of this page");
    // The writer line: "<name> · N change(s) · last <date>".
    await expect(notice).toContainText(/· \d+ changes? · last /);
    const keep = page.getByTestId("community-handover-keep");
    const clear = page.getByTestId("community-handover-clear");
    await expect(keep).toHaveText("Keep it");
    await expect(clear).toHaveText("Clear it");
    await shot(page, "5-owner-handover-notice-1280");

    // 320px: the owner's notice.
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(notice).toBeVisible();
    overflow.push(await readOverflow(page, "owner handover notice @320"));
    await notice.scrollIntoViewIfNeeded();
    await shot(page, "5-owner-handover-notice-320", false);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Clear, confirmed in the dialog.
    await clear.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Clear what moderators wrote?");
    await dialog.getByRole("button", { name: "Clear it" }).click();
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByText("Cleared. The main page is back to the template.").first(),
    ).toBeVisible();
    await shot(page, "5-owner-after-clear-1280");

    // The bio is gone on the server (the owner's editor keeps the bio in
    // Venue settings, not on this page; test 6 checks the public page).
    const mine = await api(() =>
      owner.entityPages.getMyPage.query({
        ownerType: "PLACE",
        ownerId: placeId!,
      }),
    );
    expect(mine.page.bio ?? "").toBe("");
    const handover = await api(() =>
      owner.entityPages.communityHandover.query({
        placeId: placeId!,
      }),
    );
    expect(handover.pending).toBeNull();

    // Control at 320px: the owner's editor with no notice, the same
    // PageEditorView canvas the moderator route mounts. Logged, not asserted:
    // it tells a fault in this spec's surfaces from one in the shared canvas.
    await page.setViewportSize({ width: 320, height: 800 });
    await waitForApi();
    await page.reload();
    await expect(page.getByTestId("entity-page-edit-canvas")).toBeVisible({
      timeout: 30_000,
    });
    controls.push(await readOverflow(page, "owner editor, no notice @320"));
    await shot(page, "5-owner-editor-320", false);
  });

  test("6. signed out, no community notice is left", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, `/p/${slug}`);
    await expect(page.getByRole("heading", { name: placeName })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("community-place-notice")).toHaveCount(0);
    await expect(page.getByText(BIO)).toHaveCount(0);
    await shot(page, "6-public-after-clear-1280");

    // Control: the same public page at 320 with no notice on it.
    await page.setViewportSize({ width: 320, height: 800 });
    await waitForApi();
    await page.reload();
    await expect(page.getByRole("heading", { name: placeName })).toBeVisible({
      timeout: 30_000,
    });
    await expectNameWordsWhole(page, placeName, "public place page @320");
    controls.push(
      await readOverflow(page, "public place page, no notice @320"),
    );
    await shot(page, "6-public-after-clear-320", false);
  });

  test("7. the flow logged no console errors, and nothing scrolls sideways at 320px", async ({
    consoleErrors,
  }, testInfo) => {
    // This test opens no page; the fixture is named only to take the
    // context argument (an empty pattern fails lint).
    void consoleErrors;
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(`${SHOTS}/console-sources.txt`, consoleSources.join("\n"));
      writeFileSync(
        `${SHOTS}/overflow.json`,
        JSON.stringify({ overflow, controls, contrast }, null, 2),
      );
    }
    console.log(
      `[e2e] hero name contrast @320 over white: ${contrast.map((c) => `${c.where} lines=${c.lines} top line at ${c.topLineFromBottomPct}% scrim ${c.scrimAlpha} contrast ${c.contrast}:1`).join("; ")}`,
    );
    expect.soft(contrast.length, "contrast readings").toBe(1);
    for (const c of contrast) {
      expect
        .soft(c.contrast, `${c.where}: top line vs scrim over white`)
        .toBeGreaterThanOrEqual(4.5);
    }
    await testInfo.attach("overflow", {
      body: JSON.stringify({ overflow, controls }, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("console-sources", {
      body: consoleSources.join("\n"),
      contentType: "text/plain",
    });
    console.log(
      `[e2e] API restarts hit tests: ${[...apiRefusedIn].join("; ") || "none"} (${exemptedRefusals} refused-connection lines exempted)`,
    );
    const unique = [...new Set(consoleErrorsSeen)];
    expect
      .soft(unique, `console errors during the flow:\n${unique.join("\n")}`)
      .toEqual([]);

    console.log(
      `[e2e] 320px controls: ${controls.map((r) => `${r.where} ${r.scrollWidth}/${r.clientWidth}`).join("; ")}`,
    );
    // Readings come from tests 1, 2 and 5; a missing one means its test
    // stopped early, which that test already reports.
    expect
      .soft(overflow.map((r) => r.where))
      .toEqual([
        "moderator editor @320",
        "public place page @320",
        "owner handover notice @320",
      ]);
    const wide = overflow.filter((r) => r.scrollWidth > r.clientWidth);
    expect(
      wide,
      wide
        .map(
          (r) =>
            `${r.where}: scrollWidth ${r.scrollWidth} > clientWidth ${r.clientWidth}\n    ` +
            r.offenders.join("\n    "),
        )
        .join("\n"),
    ).toEqual([]);
  });
});
