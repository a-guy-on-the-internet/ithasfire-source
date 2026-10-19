// Embed SDK smoke test — verifies the JS SDK loads, injects iframes,
// and the modal overlay works. Uses the live dev environment.
import { test, expect } from "@playwright/test";

const DEV_ORIGIN = "https://web-dev.ithasfire.com";

/** Load the SDK onto any page on the dev origin */
async function loadSdk(page: any) {
  await page.goto(DEV_ORIGIN, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ url: "/embed/hf-embed.js" });
  await page.waitForFunction(
    () => typeof (window as any).HF !== "undefined",
    null,
    { timeout: 10000 },
  );
}

test.describe("Embed SDK smoke", () => {
  test("inline widget injects an iframe pointing at the embed route", async ({
    page,
  }) => {
    await loadSdk(page);

    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "w";
      document.body.appendChild(d);
      (window as any).__h = (window as any).HF.createWidget({
        embedId: "00000000-0000-0000-0000-000000000001",
        container: "#w",
        mode: "inline",
        height: 300,
      });
    });

    const iframe = page.locator("#w iframe");
    await expect(iframe).toBeVisible({ timeout: 5000 });

    const src = await iframe.getAttribute("src");
    expect(src).toContain("/embed/00000000-0000-0000-0000-000000000001");

    const hasDestroy = await page.evaluate(
      () => typeof (window as any).__h?.destroy === "function",
    );
    expect(hasDestroy).toBe(true);
  });

  test("modal widget opens overlay with iframe on trigger click", async ({
    page,
  }) => {
    await loadSdk(page);

    await page.evaluate(() => {
      const btn = document.createElement("button");
      btn.id = "trigger";
      document.body.appendChild(btn);
      (window as any).HF.createWidget({
        embedId: "00000000-0000-0000-0000-000000000002",
        container: "#trigger",
        mode: "modal",
      });
    });

    // The SDK replaces the container with its own button. The trigger is the
    // branded "Get Tickets" button rendered as a child of #trigger.
    const triggerBtn = page.locator("#trigger button");
    await expect(triggerBtn).toBeVisible({ timeout: 3000 });

    // No dialog overlay initially
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Click the trigger
    await triggerBtn.click();

    // Overlay (role=dialog) should appear
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Iframe inside modal
    const iframe = dialog.locator("iframe");
    await expect(iframe).toBeVisible({ timeout: 5000 });
    const src = await iframe.getAttribute("src");
    expect(src).toContain("/embed/00000000-0000-0000-0000-000000000002");

    // Close button (aria-label=Close)
    const closeBtn = dialog.locator('button[aria-label="Close"]');
    await expect(closeBtn).toBeVisible();

    // Click close — dialog should disappear
    await closeBtn.click();
    // Wait for the 200ms close animation
    await page.waitForTimeout(300);
    await expect(dialog).toHaveCount(0);
  });

  test("modal trigger button label honours theme.fontColor over auto-contrast", async ({
    page,
  }) => {
    await loadSdk(page);

    await page.evaluate(() => {
      const btn = document.createElement("button");
      btn.id = "trigger-themed";
      document.body.appendChild(btn);
      (window as any).HF.createWidget({
        embedId: "00000000-0000-0000-0000-000000000002",
        container: "#trigger-themed",
        mode: "modal",
        // Dark brand fill → the v1.4.0 auto-contrast label would be WHITE.
        // fontColor must override it to prove "Text" themes the button label.
        theme: { brandColor: "1A1A2E", fontColor: "FF8800" },
      });
    });

    const triggerBtn = page.locator("#trigger-themed button");
    await expect(triggerBtn).toBeVisible({ timeout: 3000 });

    // Label color reflects fontColor (#FF8800), NOT the auto-contrast white.
    await expect(triggerBtn).toHaveCSS("color", "rgb(255, 136, 0)");
    // Fill still comes from brandColor.
    await expect(triggerBtn).toHaveCSS(
      "background-color",
      "rgb(26, 26, 46)",
    );
  });

  test("theme overrides are forwarded as query params", async ({ page }) => {
    await loadSdk(page);

    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "w";
      document.body.appendChild(d);
      (window as any).HF.createWidget({
        embedId: "00000000-0000-0000-0000-000000000003",
        container: "#w",
        mode: "inline",
        theme: {
          brandColor: "FF5733",
          bg: "1a1a2e",
          accentColor: "e0e0e0",
          fontColor: "ffffff",
        },
      });
    });

    const iframe = page.locator("#w iframe");
    await expect(iframe).toBeVisible({ timeout: 5000 });

    const src = await iframe.getAttribute("src");
    expect(src).toContain("brandColor=FF5733");
    expect(src).toContain("bg=1a1a2e");
    expect(src).toContain("accentColor=e0e0e0");
    expect(src).toContain("fontColor=ffffff");
  });

  test("promo code is forwarded as query param", async ({ page }) => {
    await loadSdk(page);

    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "w";
      document.body.appendChild(d);
      (window as any).HF.createWidget({
        embedId: "00000000-0000-0000-0000-000000000004",
        container: "#w",
        mode: "inline",
        promoCode: "EARLYBIRD",
      });
    });

    const iframe = page.locator("#w iframe");
    await expect(iframe).toBeVisible({ timeout: 5000 });

    const src = await iframe.getAttribute("src");
    expect(src).toContain("promo=EARLYBIRD");
  });

  test("destroy() removes the iframe", async ({ page }) => {
    await loadSdk(page);

    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "w";
      document.body.appendChild(d);
      (window as any).__h = (window as any).HF.createWidget({
        embedId: "00000000-0000-0000-0000-000000000005",
        container: "#w",
        mode: "inline",
      });
    });

    const iframe = page.locator("#w iframe");
    await expect(iframe).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => (window as any).__h.destroy());
    await expect(iframe).toHaveCount(0, { timeout: 3000 });
  });
});
