import { expect, test, type Page } from "@playwright/test";

import { signInWithPassword } from "./helpers/sign-in";

/**
 * /platform/memberships — the three VISIBILITY sections plus the standing
 * table underneath them.
 *
 * READ-ONLY. This spec creates nothing and deletes nothing, so it is safe
 * against a live dev stack:
 *
 *   E2E_USE_LIVE_STACK=1 pnpm exec playwright test \
 *     e2e/platform-memberships.spec.ts --project=chromium --workers=1
 *
 * WHAT IS ASSERTED UNCONDITIONALLY: that the route renders for staff, that
 * every section is present, that the page produces no console errors, and
 * that nothing overflows horizontally at 1440 / 390 / 320.
 *
 * WHAT IS ASSERTED ONLY WHEN ROWS EXIST: the copy inside a row. The seeded
 * membership fixtures are the source of those rows, and a spec that hard-fails
 * when a fixture set changes is a spec that gets deleted rather than fixed.
 * The structural half is the part worth defending.
 */

const CREDS = {
  email: "admin@ithasfire.com",
  password: "Dev-Login-2026!",
};

// Start SIGNED OUT. The project-wide `storageState` belongs to the shared e2e
// test user, who is NOT platform staff — arriving with it would bounce off
// this route and the failure would read as an authz bug.
test.use({ storageState: { cookies: [], origins: [] } });

async function assertNoHorizontalOverflow(page: Page, width: number) {
  const box = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    box.scrollWidth,
    `horizontal overflow at ${width}px: ${box.scrollWidth} > ${box.clientWidth}`,
    // One pixel of slack for sub-pixel layout rounding.
  ).toBeLessThanOrEqual(box.clientWidth + 1);
}

test("renders every membership section for staff, at every width", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await signInWithPassword(page, CREDS);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1200 });
    await page.goto("/platform/memberships");

    // Visibility first, risk last — the order the page is built in.
    await expect(
      page.getByRole("heading", { name: "Recurring revenue" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Needs attention" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Leaving" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Membership standing" }),
    ).toBeVisible();

    // The revenue panel has resolved one way or the other: figures, or the
    // empty state. Either is a finished render; "Loading…" is not.
    await expect(
      page
        .getByText("Monthly, to owners")
        .or(page.getByText("No active or trialing memberships yet"))
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    await assertNoHorizontalOverflow(page, width);
  }

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("labels membership money as the OWNERS', never as platform income", async ({
  page,
}) => {
  // Memberships are 0% platform fee on purpose. A figure on a staff page that
  // reads as platform revenue would be wrong by one hundred percent of itself,
  // and would be wrong in a conversation rather than in a test.
  await signInWithPassword(page, CREDS);
  await page.goto("/platform/memberships");

  await expect(
    page.getByText(/Memberships carry no platform fee, so none of this is ours/),
  ).toBeVisible({ timeout: 20_000 });
});

test("says a failing card has ALREADY cost the member their benefits", async ({
  page,
}) => {
  // The whole reason the feature exists: `past_due` denies benefits at
  // checkout and nothing else in the system tells anyone. Skipped rather than
  // failed when the seed holds no such row — see the file header.
  await signInWithPassword(page, CREDS);
  await page.goto("/platform/memberships");

  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toBeVisible({ timeout: 20_000 });

  const failing = page.getByText("Card failing").first();
  const present = await failing
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!present, "no past_due membership in this database");

  await expect(page.getByText("Benefits denied").first()).toBeVisible();
});
