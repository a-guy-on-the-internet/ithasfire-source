import { test, expect } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Place Review Form E2E (permanent route: /review-a-place)
//
// These are guest-only (no auth). The Place Review form used to be embedded in
// the pre-launch "Coming Soon" homepage; that gate has been removed and the
// form now lives permanently at /review-a-place. These tests exercise the form
// stepper + submission there.
// ─────────────────────────────────────────────────────────────────────────────

test.use({ storageState: undefined });

const REVIEW_FORM_ROUTE = "/review-a-place";

// ── Autocomplete / stats stubs ───────────────────────────────────────────────
// tRPC httpBatchLink batches multiple queries into a single HTTP request.
// The venue autocomplete + trusted-venue lookups fire real tRPC queries; stub
// them so the guest form flow is deterministic regardless of DB state. We only
// patch the placeReviews.* portions of each batched response and pass the rest
// through untouched.
async function stubPlaceReviewQueries(page: import("@playwright/test").Page) {
  await page
    .context()
    .addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);

  await page.route(
    (url) =>
      /placeReviews\.globalStats|placeReviews\.listDirectory|placeReviews\.getTrustedVenuesNearPlace/.test(
        url.pathname,
      ),
    async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const procsPart = pathname.replace(/^\/trpc\//, "");
      const procs = procsPart.split(",");

      let response: Awaited<ReturnType<typeof route.fetch>> | undefined;
      try {
        response = await route.fetch();
      } catch {
        response = undefined;
      }

      let body: any[] = [];
      try {
        body = response ? await response.json() : [];
      } catch {
        body = [];
      }

      if (!Array.isArray(body)) {
        body = procs.map(() => ({ result: { data: { json: null } } }));
      }

      const patch = (
        procName: string,
        valueFactory: (existing: any) => any,
      ) => {
        const idx = procs.indexOf(procName);
        if (idx === -1) return;
        const existing = body[idx]?.result?.data?.json;
        body[idx] = {
          result: {
            data: {
              json: valueFactory(existing),
            },
          },
        };
      };

      patch(
        "placeReviews.globalStats",
        (existing) =>
          existing ?? {
            venuesRated: 0,
            totalReviews: 0,
            contributors: 0,
          },
      );
      patch(
        "placeReviews.listDirectory",
        (existing) => existing ?? { places: [] },
      );
      patch(
        "placeReviews.getTrustedVenuesNearPlace",
        (existing) =>
          existing ?? {
            venues: [],
            city: "",
          },
      );

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );
}

async function dismissCookieBannerIfPresent(
  page: import("@playwright/test").Page,
) {
  const essentialOnly = page.getByRole("button", { name: /essential only/i });
  const acceptAll = page.getByRole("button", { name: /accept all/i });

  try {
    await Promise.race([
      essentialOnly.waitFor({ state: "visible", timeout: 2_000 }),
      acceptAll.waitFor({ state: "visible", timeout: 2_000 }),
    ]);
  } catch {
    return;
  }

  if (await essentialOnly.isVisible().catch(() => false)) {
    await essentialOnly.click();
    return;
  }

  if (await acceptAll.isVisible().catch(() => false)) {
    await acceptAll.click();
  }
}

async function openReviewForm(page: import("@playwright/test").Page) {
  await stubPlaceReviewQueries(page);
  await page.goto(REVIEW_FORM_ROUTE);
  await dismissCookieBannerIfPresent(page);
  await expect(
    page.getByRole("form", { name: /place review form/i }),
  ).toBeVisible();
}

async function chooseRoleAndAdvanceToVenue(
  page: import("@playwright/test").Page,
  roleName: string | RegExp = /musician/i,
) {
  await expect(
    page.getByRole("heading", { name: /what do you do\?/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: roleName }).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();
  await expect(
    page.getByRole("heading", { name: /where did you play\?/i }),
  ).toBeVisible();
}

function choiceLocator(
  page: import("@playwright/test").Page,
  name: string | RegExp,
) {
  return page
    .locator("button, [role='radio']")
    .filter({ hasText: name })
    .first();
}

async function completeRequiredFlowToReview(
  page: import("@playwright/test").Page,
  placeName: string,
  city: string,
) {
  await chooseRoleAndAdvanceToVenue(page);

  await page.getByPlaceholder(/search or type a place/i).fill(placeName);
  await page.getByPlaceholder(/city/i).fill(city);
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  await expect(
    page.getByRole("heading", { name: /how much did they pay you\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /100.*250/i).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  await expect(
    page.getByRole("heading", { name: /how were you paid\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /guarantee/i).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  await expect(
    page.getByRole("heading", {
      name: /did the place help get people there\?/i,
    }),
  ).toBeVisible();
  await choiceLocator(page, /they went all out/i).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  await expect(
    page.getByRole("heading", { name: /how was the pa \/ sound system\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /dialed in/i).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  await expect(
    page.getByRole("heading", { name: /was it your crowd\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /my people/i).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  await expect(
    page.getByRole("heading", { name: /would you play here again\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /absolutely/i).click();
  await page
    .getByRole("button", { name: /continue to next question/i })
    .click();

  const genreQuestion = page.getByRole("heading", {
    name: /what kind of music do you play\?/i,
  });
  const skipOptional = page.getByRole("button", {
    name: /skip optional questions/i,
  });
  const reviewHeading = page.getByRole("heading", {
    name: /review your answers/i,
  });
  const nextQuestion = page.getByRole("button", {
    name: /continue to next question/i,
  });

  for (let i = 0; i < 5; i++) {
    if (await reviewHeading.isVisible().catch(() => false)) break;

    if (await skipOptional.isVisible().catch(() => false)) {
      await skipOptional.click();
      break;
    }

    if (await genreQuestion.isVisible().catch(() => false)) {
      await nextQuestion.click();
      await page.waitForTimeout(400);
      continue;
    }

    if (await nextQuestion.isVisible().catch(() => false)) {
      await nextQuestion.click();
      await page.waitForTimeout(400);
      continue;
    }

    await page.waitForTimeout(400);
  }

  await expect(reviewHeading).toBeVisible({ timeout: 10_000 });
}

test.describe("Place Review Form", () => {
  test("renders the review form on its permanent route", async ({ page }) => {
    await openReviewForm(page);

    await expect(
      page.getByRole("heading", { name: /what do you do\?/i }),
    ).toBeVisible();
  });

  test("About You requires a role selection before advancing", async ({
    page,
  }) => {
    await openReviewForm(page);

    await page
      .getByRole("button", { name: /continue to next question/i })
      .click();
    await expect(page.getByText(/pick at least one/i)).toBeVisible();
  });

  test("the review flow moves forward and back through the new early questions", async ({
    page,
  }) => {
    await openReviewForm(page);
    await chooseRoleAndAdvanceToVenue(page);

    const venueInput = page.getByPlaceholder(/search or type a place/i);
    await venueInput.fill("Test Venue E2E");
    await page.getByPlaceholder(/city/i).fill("Nashville");
    await page
      .getByRole("button", { name: /continue to next question/i })
      .click();

    await expect(
      page.getByRole("heading", { name: /how much did they pay you\?/i }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: /go back to previous question/i })
      .click();
    await expect(
      page.getByRole("heading", { name: /where did you play\?/i }),
    ).toBeVisible();
    await expect(venueInput).toHaveValue("Test Venue E2E");

    await page
      .getByRole("button", { name: /continue to next question/i })
      .click();
    await expect(
      page.getByRole("heading", { name: /how much did they pay you\?/i }),
    ).toBeVisible();
  });

  test("full form submission shows the current success screen", async ({
    page,
    consoleErrors,
  }) => {
    // The UI path is mocked here; a background session-complete call can still
    // emit known dev-only noise that is unrelated to this guest-flow assertion.
    consoleErrors.ignore();
    await stubPlaceReviewQueries(page);

    await page.route(
      (url) => url.pathname.includes("placeReviews.submit"),
      async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const procs = pathname.replace(/^\/trpc\//, "").split(",");
        const idx = procs.indexOf("placeReviews.submit");
        const body = procs.map((_, i) =>
          i === idx
            ? {
                result: {
                  data: {
                    json: {
                      reviewId: "11111111-1111-4111-8111-111111111111",
                      placeId: "22222222-2222-4222-8222-222222222222",
                      createdStubPlace: false,
                    },
                  },
                },
              }
            : { result: { data: { json: null } } },
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      },
    );

    await openReviewForm(page);
    await completeRequiredFlowToReview(page, "E2E Jazz Club", "Austin");
    await page.getByRole("button", { name: /submit review/i }).click();

    await expect(page.getByText("THANK YOU")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/your review helps every performer who plays next/i),
    ).toBeVisible();
    await page.getByRole("button", { name: /rate another place/i }).click();
    await expect(
      page.getByRole("heading", { name: /what do you do\?/i }),
    ).toBeVisible();
  });

  test("new venue submission returns createdStubPlace and triggers success", async ({
    page,
  }) => {
    await stubPlaceReviewQueries(page);

    await page.route(
      (url) => url.pathname.includes("placeReviews.submit"),
      async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const procs = pathname.replace(/^\/trpc\//, "").split(",");
        const idx = procs.indexOf("placeReviews.submit");
        const body = procs.map((_, i) =>
          i === idx
            ? {
                result: {
                  data: {
                    json: {
                      reviewId: "eeee4444-eeee-4eee-8eee-eeeeeeeeeeee",
                      placeId: "ffff5555-ffff-4fff-8fff-ffffffffffff",
                      createdStubPlace: true,
                    },
                  },
                },
              }
            : { result: { data: { json: null } } },
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      },
    );

    await openReviewForm(page);
    const submitResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("placeReviews.submit") &&
        response.request().method() === "POST",
    );

    await completeRequiredFlowToReview(page, "Brand New E2E Venue", "Portland");
    await page.getByRole("button", { name: /submit review/i }).click();

    const submitResponse = await submitResponsePromise;
    const submitResponseBody = await submitResponse.json();
    await expect(page.getByText("THANK YOU")).toBeVisible({ timeout: 10_000 });

    const submitResult = Array.isArray(submitResponseBody)
      ? submitResponseBody.find(
          (r: any) => r?.result?.data?.json?.createdStubPlace !== undefined,
        )
      : submitResponseBody;
    expect(submitResult).toBeDefined();
    expect(submitResult.result.data.json.createdStubPlace).toBe(true);
    expect(submitResult.result.data.json.placeId).toBeTruthy();
  });

  test("country dropdown shows options and state field appears after selecting a country", async ({
    page,
  }) => {
    await openReviewForm(page);
    await chooseRoleAndAdvanceToVenue(page);

    // Type a custom venue name (no autocomplete match → showLocationFields = true)
    await page
      .getByPlaceholder(/search or type a place/i)
      .fill("E2E Venue Unique XYZ");

    // City field should appear; type 2+ chars to trigger the country Reveal
    const cityInput = page.getByPlaceholder(/city/i);
    await expect(cityInput).toBeVisible({ timeout: 5_000 });
    await cityInput.fill("Austin");

    // Country combobox appears after city has 2+ chars (via Reveal animation ~280ms)
    const countryInput = page.getByRole("combobox", { name: /country/i });
    await expect(countryInput).toBeVisible({ timeout: 2_000 });

    // Wait for the Reveal animation + overflow unlock (durationMs 280 + 20ms buffer)
    await page.waitForTimeout(400);

    // Focus the country input — dropdown should open with default suggestions
    await countryInput.click();

    const countryListbox = page.getByRole("listbox", {
      name: /country suggestions/i,
    });
    await expect(countryListbox).toBeVisible({ timeout: 2_000 });

    // Assert the real user-visible behavior: the suggestions list opens and remains interactive.

    // "United States" is the first entry in COUNTRIES
    const usOption = countryListbox.getByRole("option", {
      name: "United States",
    });
    await expect(usOption).toBeVisible();
    await usOption.click();

    // Input should display the selected country name
    await expect(countryInput).toHaveValue("United States");

    // State/region autocomplete should now appear and support searchable options.
    const stateField = page.getByRole("combobox", { name: /state or region/i });
    await expect(stateField).toBeVisible({ timeout: 2_000 });
    await stateField.click();
    await stateField.fill("Cal");

    const stateListbox = page.getByRole("listbox", {
      name: /state or region suggestions/i,
    });
    await expect(stateListbox).toBeVisible({ timeout: 2_000 });

    const californiaOption = stateListbox.getByRole("option", {
      name: /california/i,
    });
    await expect(californiaOption).toBeVisible();
    await stateField.press("ArrowDown");
    await stateField.press("Enter");
    await expect(stateField).toHaveValue("California");
  });
});
