import { test, expect } from "@playwright/test";

const BASE_URL = process.env.STORYBOOK_BASE_URL ?? "http://127.0.0.1:6006";

test.describe("storybook runtime smoke", () => {
  test("loads iframe without console/page errors", async ({ page }) => {
    const errors: string[] = [];

    page.on("pageerror", (err) => {
      errors.push(`pageerror: ${err.message}`);
    });

    page.on("console", (msg) => {
      // Treat runtime errors as failures. Warnings/info are OK.
      if (msg.type() === "error") {
        errors.push(`console.error: ${msg.text()}`);
      }
    });

    // iframe.html loads the preview runtime.
    await page.goto(`${BASE_URL}/iframe.html`, {
      waitUntil: "domcontentloaded",
    });

    // Most common failure mode: module import error -> Storybook shows an error screen.
    await expect(page.locator("body")).toBeVisible();

    // Give the preview a moment to execute and report any runtime problems.
    await page.waitForTimeout(1500);

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
