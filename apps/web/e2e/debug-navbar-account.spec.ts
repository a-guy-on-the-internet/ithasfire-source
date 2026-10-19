import { test } from "./fixtures";

test("debug: navbar account exists", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");

  // Capture a bit of structure for troubleshooting.
  console.log("URL:", page.url());

  const navbarAccount = page.getByTestId("navbar-account");
  console.log("navbar-account count:", await navbarAccount.count());

  // Print a small excerpt of the page for inspection.
  const html = await page.content();
  console.log("HTML excerpt:\n", html.slice(0, 4000));
});
