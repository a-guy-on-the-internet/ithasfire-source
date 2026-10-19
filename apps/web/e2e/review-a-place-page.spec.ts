import { test, expect, type Page } from "./fixtures";

test.use({ storageState: undefined });

async function primeGuestPage(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem("th_review_form_state");
    localStorage.removeItem("th_review_session_token");
  });
  await page
    .context()
    .addCookies([
      { name: "th-consent", value: "all", domain: "localhost", path: "/" },
    ]);
}

function choiceLocator(page: Page, name: string | RegExp) {
  return page.locator("button, [role='radio']").filter({ hasText: name }).first();
}

async function advance(page: Page) {
  await page.getByRole("button", { name: /continue to next question/i }).click();
}

async function chooseRoleAndAdvanceToVenue(page: Page) {
  await expect(
    page.getByRole("heading", { name: /what do you do\?/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /musician/i }).click();
  await advance(page);
  await expect(
    page.getByRole("heading", { name: /where did you play\?/i }),
  ).toBeVisible();
}

async function completeRequiredFlowToReview(
  page: Page,
  placeName: string,
  city: string,
) {
  await chooseRoleAndAdvanceToVenue(page);

  const placeInput = page.getByPlaceholder(/search or type a place/i);
  if ((await placeInput.inputValue()) !== placeName) {
    await placeInput.fill(placeName);
  }
  await page.getByPlaceholder(/city/i).fill(city);
  await advance(page);

  await expect(
    page.getByRole("heading", { name: /how much did they pay you\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /100.*250/i).click();
  await advance(page);

  await expect(
    page.getByRole("heading", { name: /how were you paid\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /guarantee/i).click();
  await advance(page);

  await expect(
    page.getByRole("heading", {
      name: /did the place help get people there\?/i,
    }),
  ).toBeVisible();
  await choiceLocator(page, /they went all out/i).click();
  await advance(page);

  await expect(
    page.getByRole("heading", { name: /how was the pa \/ sound system\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /dialed in/i).click();
  await advance(page);

  await expect(
    page.getByRole("heading", { name: /was it your crowd\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /my people/i).click();
  await advance(page);

  await expect(
    page.getByRole("heading", { name: /would you play here again\?/i }),
  ).toBeVisible();
  await choiceLocator(page, /absolutely/i).click();
  await advance(page);

  const reviewHeading = page.getByRole("heading", {
    name: /review your answers/i,
  });
  const skipOptional = page.getByRole("button", {
    name: /skip optional questions/i,
  });
  const genreQuestion = page.getByRole("heading", {
    name: /what kind of music do you play\?/i,
  });

  for (let i = 0; i < 5; i++) {
    if (await reviewHeading.isVisible().catch(() => false)) break;

    if (await skipOptional.isVisible().catch(() => false)) {
      await skipOptional.click();
      break;
    }

    if (await genreQuestion.isVisible().catch(() => false)) {
      await advance(page);
      await page.waitForTimeout(400);
      continue;
    }

    const nextQuestion = page.getByRole("button", {
      name: /continue to next question/i,
    });
    if (await nextQuestion.isVisible().catch(() => false)) {
      await nextQuestion.click();
      await page.waitForTimeout(400);
      continue;
    }

    await page.waitForTimeout(400);
  }

  await expect(reviewHeading).toBeVisible({ timeout: 10_000 });
}

function extractSubmitInput(postData: unknown) {
  if (
    postData &&
    typeof postData === "object" &&
    "0" in postData &&
    typeof (postData as Record<string, unknown>)["0"] === "object"
  ) {
    return ((postData as Record<string, { json?: unknown }>)["0"]?.json ??
      undefined) as Record<string, unknown> | undefined;
  }

  if (
    postData &&
    typeof postData === "object" &&
    "json" in postData
  ) {
    return (postData as { json?: Record<string, unknown> }).json;
  }

  return postData as Record<string, unknown> | undefined;
}

test.describe("Review a Place page", () => {
  test("renders the standalone form and applies place prefill", async ({
    page,
  }) => {
    await primeGuestPage(page);
    await page.goto(
      "/review-a-place?name=Taylor%20Rae&email=taylor%40example.com&place=The%20Blue%20Room&campaign=launch-outreach-2026-06",
    );

    await expect(
      page.getByRole("form", { name: /place review form/i }),
    ).toBeVisible();
    await chooseRoleAndAdvanceToVenue(page);
    await expect(page.getByPlaceholder(/search or type a place/i)).toHaveValue(
      "The Blue Room",
    );
  });

  test("submits campaign attribution and shows page success CTA", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();
    await primeGuestPage(page);

    let submitInput: Record<string, unknown> | undefined;
    await page.route(
      (url) => url.pathname.includes("placeReviews.submit"),
      async (route) => {
        submitInput = extractSubmitInput(route.request().postDataJSON());
        const pathname = new URL(route.request().url()).pathname;
        const procs = pathname.replace(/^\/trpc\//, "").split(",");
        const idx = procs.indexOf("placeReviews.submit");
        const body = procs.map((_, i) =>
          i === idx
            ? {
                result: {
                  data: {
                    json: {
                      reviewId: "33333333-3333-4333-8333-333333333333",
                      placeId: "44444444-4444-4444-8444-444444444444",
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

    await page.goto(
      "/review-a-place?name=Taylor%20Rae&email=taylor%40example.com&place=The%20Blue%20Room&campaign=launch-outreach-2026-06",
    );

    await completeRequiredFlowToReview(page, "The Blue Room", "Nashville");
    await page.getByRole("button", { name: /submit review/i }).click();

    await expect(page.getByText("THANK YOU")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("link", { name: /browse upcoming events/i }),
    ).toHaveAttribute("href", "/");
    expect(submitInput?.sourceAttribution).toEqual({
      campaign: "launch-outreach-2026-06",
      channel: "email",
    });
    expect(submitInput?.source).toBe("SURVEY");
  });
});