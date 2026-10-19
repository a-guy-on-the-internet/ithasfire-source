import { expect, test } from "./fixtures";

/**
 * Step 8 for the membership-benefit refactor: DRIVE the real app.
 *
 * WHY THIS SPEC FAKES ONE QUERY, AND WHAT THAT COSTS
 * --------------------------------------------------
 * The local dev database predates the memberships feature entirely — no
 * `MembershipTier` table, and two migrations stuck at `finished_at = NULL`.
 * Migrations land via CD and are never applied locally, so `memberships.tiers
 * .list` answers INTERNAL_SERVER_ERROR ("the column ... does not exist") and
 * the page renders an error state. Everything downstream of that is
 * unreachable.
 *
 * So this spec intercepts exactly ONE tRPC procedure and proxies the rest:
 * `route.fetch()` gets the real batch response, and only the
 * `memberships.tiers.list` element is replaced with a fixture. Every other
 * call in that batch — and every call the dialog itself makes
 * (`categories.list`, `places.listHumanPlaces`) — hits the real API against
 * real tables.
 *
 * What that DOES prove, which unit tests cannot: the real component tree
 * renders under the real design system, SSR/hydration succeeds (the console
 * gate in `fixtures.ts` fails on a hydration error — its broad ignore patterns
 * were deliberately removed), the money inputs behave under a real browser's
 * caret, the calculator recomputes live, accessible names don't collide across
 * the page, and the layout survives 320px.
 *
 * What it does NOT prove: that the queries return this shape from a real
 * database, or that the write path persists. Those need the migration applied.
 *
 * NOTE ON SELECTORS: these target the RESOLVED English copy, not i18n keys.
 * The unit tests mock `t()` to echo the key, so a spec written against keys
 * passes there and matches nothing here — which is precisely the gap between
 * "component renders in isolation" and "page works".
 */

// SERIAL, and generous on time. `next dev` compiles this route on first hit,
// and six parallel workers each triggering that compile is what turned a
// working page into six 30s navigation timeouts. This spec is about what the
// page looks like, not how fast it builds.
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

// No hardcoded owner id or admin slug: the Playwright user's uuid differs per
// machine and per CI run, so pinning one here would make this spec pass locally
// and match nothing elsewhere. We navigate by the nav link instead, and the
// stub replaces the response wholesale so it never needs to know the id.
const TIER_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const BENEFIT_ID = "bbbbbbbb-2222-4222-8222-222222222222";

/** One ACTIVE tier carrying one $5-off benefit — the shape `listTiersForOwner` returns. */
const TIERS_FIXTURE = {
  items: [
    {
      id: TIER_ID,
      ownerOrgId: null,
      ownerHumanId: "00000000-0000-4000-8000-000000000001",
      name: "Sustaining Member",
      description: "Keeps the lights on.",
      benefitsDescription: "Two free drinks a month.",
      priceCents: 1000,
      currency: "usd",
      interval: "MONTH",
      stripeProductId: null,
      stripePriceId: null,
      status: "ACTIVE",
      sortOrder: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      benefits: [
        {
          id: BENEFIT_ID,
          tierId: TIER_ID,
          discountKind: "AMOUNT",
          discountValue: 500,
          maxDiscountCents: null,
          categoryId: null,
          placeId: null,
          label: null,
        },
      ],
      memberCount: 3,
      priceLocked: true,
    },
  ],
};

/**
 * Replace ONLY `memberships.tiers.list` in whatever batch it arrives in;
 * everything else in the batch keeps the real API's answer.
 */
async function stubTierList(page: import("@playwright/test").Page) {
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    // Path is `/trpc/<proc>,<proc>,...` — the index of our procedure in that
    // list is the index of its element in the response array.
    const procs = decodeURIComponent(url.pathname.replace("/trpc/", "")).split(
      ",",
    );
    const index = procs.indexOf("memberships.tiers.list");
    if (index === -1) {
      return route.continue();
    }

    const response = await route.fetch();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Non-JSON (an API restart mid-run) — let the real thing through rather
      // than inventing a response and hiding the failure.
      return route.fulfill({ response });
    }

    const payload = Array.isArray(body) ? [...body] : [body];
    payload[index] = { result: { data: { json: TIERS_FIXTURE } } };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

/** The dialog's money field, addressed by its accessible name. */
const amountField = (page: import("@playwright/test").Page) =>
  page.getByLabel(/^Amount off$/i);

async function gotoMemberships(page: import("@playwright/test").Page) {
  // `domcontentloaded` rather than `load`: Next dev keeps long-lived HMR
  // connections open, so "load" is a poor readiness signal. The visible-text
  // assertion below is the real one.
  //
  // Reached via the nav link rather than a literal URL: the admin slug is the
  // Playwright user's own and differs per machine and per CI run, so a
  // hardcoded one would pass here and match nothing elsewhere.
  await page.goto("/admin", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page
    .getByRole("link", { name: /^memberships$/i })
    .first()
    .click({ timeout: 30_000 });
  await expect(page.getByText("Sustaining Member").first()).toBeVisible({
    timeout: 60_000,
  });
}

async function openRowMenuAndBenefits(
  page: import("@playwright/test").Page,
) {
  // Row action lives behind the table's per-row menu.
  const manageBenefits = page.getByRole("menuitem", { name: /manage benefits/i });
  if ((await manageBenefits.count()) === 0) {
    // The action lives behind the row's overflow trigger.
    await page.getByRole("button", { name: /more|actions|menu|⋯|…/i }).first().click();
  }
  await page
    .getByRole("menuitem", { name: /manage benefits/i })
    .or(page.getByRole("button", { name: /manage benefits/i }))
    .first()
    .click();

  await expect(page.getByText(/What this costs you/i)).toBeVisible();
}

async function openBenefitsDialog(page: import("@playwright/test").Page) {
  await gotoMemberships(page);
  await openRowMenuAndBenefits(page);
}

test.beforeEach(async ({ page }) => {
  await stubTierList(page);
});

test("the benefits dialog renders its terms form and the break-even calculator", async ({
  page,
}) => {
  await openBenefitsDialog(page);

  // The existing benefit summarises its own terms — no promo code anywhere.
  await expect(page.getByText(/\$5\.00 off/)).toBeVisible();

  // Terms form.
  for (const label of [
    /Discount type/i,
    /Amount off/i,
    /Never discount more than/i,
    /Checkout label/i,
  ]) {
    await expect(page.getByText(label).first()).toBeVisible();
  }

  // Calculator: two inputs and the fee note, stated not buried.
  await expect(
    page.getByText(/Typical ticket price/i).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/Platform fees on a discounted ticket are still computed on full face price/i),
  ).toBeVisible();
});

test("money input keeps typed character ORDER (react-native-web caret trap)", async ({
  page,
}) => {
  // The failure this exists for: `type="number"` under react-native-web
  // reverses typed characters, so "5.00" lands as "00.5" and the owner saves a
  // discount two orders of magnitude off. Typing character-by-character is the
  // point — a single `fill()` would not reproduce it.
  await openBenefitsDialog(page);

  const amount = amountField(page);
  await amount.click();
  await amount.pressSequentially("5.00", { delay: 50 });

  await expect(amount).toHaveValue("5.00");
});

test("the break-even answer recomputes live as the terms change", async ({
  page,
}) => {
  await openBenefitsDialog(page);

  const answer = page.getByText(/costs you more in discounts than they pay in dues/i).first();
  const ticketsInput = page.getByLabel(/Shows a member uses this at/i);

  // With no terms typed yet the calculator has nothing to price.
  await amountField(page).click();
  await amountField(page).pressSequentially("5.00", { delay: 30 });
  await expect(answer).toBeVisible();

  // Changing attendance must move the owner-net line without a reload.
  const before = await page.locator("body").innerText();
  await ticketsInput.fill("9");
  await expect
    .poll(async () => (await page.locator("body").innerText()) !== before)
    .toBe(true);
});

test("the tier form has NO tax dropdown and DOES have the benefits textarea", async ({
  page,
}) => {
  await gotoMemberships(page);

  await page
    .getByRole("button", { name: /create tier/i })
    .first()
    .click();

  await expect(
    page.getByPlaceholder(/Two free drinks a month, first dibs on tickets/i),
  ).toBeVisible();
  // The dropdown that used to sit here is gone, not merely disabled.
  await expect(
    page.getByText(/What does this tier deliver\?/i),
  ).toHaveCount(0);
});

test("no accessible-name collisions among the dialog's controls", async ({
  page,
}) => {
  // The passkey-rename bug this guards against: two "Save" buttons with
  // identical accessible names on one page, invisible to unit tests that
  // render a component in isolation.
  await openBenefitsDialog(page);

  const names = await page
    .getByRole("button")
    .evaluateAll((nodes) =>
      nodes
        .map((n) => (n.getAttribute("aria-label") ?? n.textContent ?? "").trim())
        .filter((n) => n.length > 0),
    );

  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  expect(duplicates, `duplicate accessible names: ${duplicates.join(", ")}`).toEqual([]);
});

test("survives 320px with no horizontal page overflow", async ({ page }) => {
  // Load at desktop first only to REACH the page (the sidebar nav collapses at
  // 320px), then reload at 320 so what we measure is a genuine cold small-
  // viewport render, not a resized desktop one.
  await gotoMemberships(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sustaining Member").first()).toBeVisible({
    timeout: 60_000,
  });
  await openRowMenuAndBenefits(page);

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });

  // The page body must never scroll sideways; wide content scrolls inside its
  // own container instead.
  expect(
    overflow.scrollWidth,
    `page overflows: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);

  // Page-level scrollWidth is NOT enough — it never sees clipping INSIDE the
  // dialog. This check caught nothing while "Limit where it applies (optional)"
  // was visibly truncated mid-word at 320px. Measure the elements themselves.
  const clipped = await page
    .locator("dialog button, [role='dialog'] button, [role='dialog'] label")
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => n.scrollWidth > n.clientWidth + 1)
        .map((n) => `${(n.textContent ?? "").trim().slice(0, 40)} (${n.scrollWidth}>${n.clientWidth})`),
    );
  expect(clipped, `clipped controls at 320px: ${clipped.join(" | ")}`).toEqual([]);

  // The calculator must be genuinely REACHABLE, not merely present in the DOM
  // — `toBeVisible()` passes for anything not display:none, including content
  // scrolled far out of view.
  const feeNote = page.getByText(
    /Platform fees on a discounted ticket are still computed on full face price/i,
  );
  await feeNote.scrollIntoViewIfNeeded();
  await expect(feeNote).toBeInViewport();
});
