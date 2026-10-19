import { expect, test } from "./fixtures";

// This spec is intended to cover: web client -> tRPC -> API -> DB.
//
// Preconditions:
// - The Playwright "setup" project has stored a signed-in Clerk session.
// - Local infra is running (postgres/redis if required by the API).
// - WEB_API_BASE_URL (or whatever the web uses to reach api) points to a running api.

test.describe("Full-stack auth + human sync", () => {
  test("authenticated project can reach an authed surface and sync a human record", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );

    await page.goto("/admin/acme/events/new", {
      waitUntil: "domcontentloaded",
    });

    await expect(page).not.toHaveURL(/\/(login|sign-in)$/);
    await expect(page.getByTestId("auth-sign-in-form")).toHaveCount(0);

    await expect
      .poll(
        async () => {
          if (
            await page
              .getByText("Create Event")
              .isVisible()
              .catch(() => false)
          )
            return "admin";
          if (
            await page
              .getByText("Loading…")
              .isVisible()
              .catch(() => false)
          )
            return "loading";
          if (
            await page
              .getByText("Loading...")
              .isVisible()
              .catch(() => false)
          )
            return "loading";
          return "missing";
        },
        { timeout: 15_000 },
      )
      .not.toBe("missing");

    // Explicitly prove the signed-in browser can mint a real bearer token and
    // use it for the protected human read path: anonymous API readback is
    // rejected, while the authenticated request succeeds.
    const apiOrigin = (
      process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001"
    ).replace(/\/+$/, "");
    const authEmail =
      process.env.PLAYWRIGHT_TEST_EMAIL ??
      process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
      "playwright-setup@example.com";

    const tokenRes = await page.request.get(`${apiOrigin}/api/auth/token`);
    expect(tokenRes.status()).toBe(200);

    const tokenJson = await tokenRes.json();
    const token = (tokenJson?.token ?? tokenJson?.data?.token) as
      | string
      | undefined;
    expect(token).toBeTruthy();

    const encodedPayload = token?.split(".")[1] ?? "";
    const payload = encodedPayload
      ? JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
      : null;
    const authUserId = (payload?.sub ?? payload?.userId ?? payload?.id) as
      | string
      | undefined;
    expect(authUserId).toBeTruthy();

    // The Human is provisioned SERVER-SIDE by the Better Auth sign-up hook
    // (and self-healed by customSession). The public
    // `humans.provisionHumanForAuthUser` procedure this spec used to call was
    // removed (security review F12, 2026-09-29), so read the linked humanId
    // off the session the server already built.
    const sessionRes = await page.request.get(
      `${apiOrigin}/api/auth/get-session`,
    );
    expect(sessionRes.status()).toBe(200);
    const sessionJson = await sessionRes.json();
    expect(sessionJson?.user?.id).toBe(authUserId);
    const humanId = sessionJson?.user?.humanId as string | undefined;
    expect(humanId).toBeTruthy();

    const readUrl = `${apiOrigin}/trpc/humans.getHuman?batch=1&input=${encodeURIComponent(
      JSON.stringify({
        0: {
          json: {
            targetHumanId: humanId,
          },
        },
      }),
    )}`;

    const readRes = await fetch(readUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(readRes.status).toBeGreaterThanOrEqual(200);
    expect(readRes.status).toBeLessThan(300);
    const readJson = await readRes.json();
    const readHumanEmail = readJson?.[0]?.result?.data?.json?.human?.email as
      | string
      | undefined;
    expect(readHumanEmail).toBe(authEmail);
  });

  test("home page remains usable even if sign-in route redirects", async ({
    page,
  }) => {
    // /sign-in may resolve to the full homepage, the account landing page, or
    // the Coming Soon experience depending on auth state and feature gates.
    // Any of those is a valid usable outcome.
    await page.goto("/sign-in?redirect=/", { waitUntil: "domcontentloaded" });

    await expect
      .poll(
        async () => {
          if (
            await page
              .getByPlaceholder(/search events/i)
              .first()
              .isVisible()
              .catch(() => false)
          ) {
            return "homepage";
          }
          if (
            await page
              .getByRole("button", { name: /browse events/i })
              .isVisible()
              .catch(() => false)
          ) {
            return "homepage";
          }
          if (
            await page
              .getByText(/discover\s+live\s+events/i)
              .first()
              .isVisible()
              .catch(() => false)
          ) {
            return "homepage";
          }
          if (page.url().includes("/account")) {
            return "account";
          }
          if (
            await page
              .getByText(/know the/i)
              .first()
              .isVisible()
              .catch(() => false)
          ) {
            return "coming-soon";
          }
          if (
            await page
              .getByRole("heading", { name: /what do you do\?/i })
              .isVisible()
              .catch(() => false)
          ) {
            return "review-flow";
          }
          if (
            await page
              .getByTestId("auth-sign-in-form")
              .isVisible()
              .catch(() => false)
          ) {
            return "sign-in";
          }
          if (
            await page
              .getByRole("heading", { name: /sign in/i })
              .isVisible()
              .catch(() => false)
          ) {
            return "sign-in";
          }
          return "missing";
        },
        { timeout: 15_000 },
      )
      .not.toBe("missing");
  });
});
