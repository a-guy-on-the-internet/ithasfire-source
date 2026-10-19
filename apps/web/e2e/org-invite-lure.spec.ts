import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { collectConsoleErrors } from "./helpers/console-errors";

/**
 * Org invitation LURE (security review 2026-09-29).
 *
 * The attack: someone gets an invitation token (e.g. by inviting their OWN
 * address) and lures a DIFFERENT signed-in user to /invite/accept?token=…,
 * which used to auto-accept on load and enrol whoever was signed in.
 *
 *   1. Victim (B) opens the link signed in → wrong-account copy, no Accept
 *      button, NO membership.
 *   2. Invitee (A) opens it → confirm screen names the org, nothing accepted
 *      before the click; Accept → membership exists.
 *
 * Live-stack safe: seeds via /e2e/seed/invite-lure and deletes exactly that
 * via /e2e/cleanup/invite-lure. Never calls resetE2eState.
 *
 * Run: cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test
 *        e2e/org-invite-lure.spec.ts --project=guest --workers=1 --reporter=list
 */

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";
const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

type LureSeed = {
  orgId: string;
  orgName: string;
  token: string;
  password: string;
  inviter: { humanId: string };
  invitee: { humanId: string; email: string };
  victim: { humanId: string; email: string };
};

let seed: LureSeed | null = null;

async function signedInPage(
  browser: Browser,
  email: string,
  password: string,
): Promise<{ context: BrowserContext; page: Page; jwt: string }> {
  const context = await browser.newContext({
    viewport: { width: 320, height: 800 },
  });
  const res = await context.request.post(
    `${API_BASE_URL}/api/auth/sign-in/email`,
    {
      headers: {
        "content-type": "application/json",
        origin: WEB_BASE_URL,
        referer: `${WEB_BASE_URL}/sign-in`,
      },
      data: { email, password },
    },
  );
  expect(res.ok(), `sign-in ${email}: ${await res.text()}`).toBeTruthy();
  const tokenRes = await context.request.get(`${API_BASE_URL}/api/auth/token`, {
    headers: { origin: WEB_BASE_URL },
  });
  const jwt = (await tokenRes.json())?.token as string;
  expect(jwt, "JWT for membership probe").toBeTruthy();
  return { context, page: await context.newPage(), jwt };
}

/**
 * Membership probe through the real API, as the signed-in user:
 * `orgs.listMembers` answers any member (200) and refuses a non-member with
 * 403. The EXACT status is asserted by callers, so an unauthenticated probe
 * (401) fails the test instead of passing for the wrong reason.
 */
async function listMembersStatus(
  page: Page,
  jwt: string,
  orgId: string,
): Promise<number> {
  const input = encodeURIComponent(
    JSON.stringify({ json: { orgId, limit: 1, offset: 0 } }),
  );
  const res = await page.request.get(
    `${API_BASE_URL}/trpc/orgs.listMembers?input=${input}`,
    { headers: { origin: WEB_BASE_URL, authorization: `Bearer ${jwt}` } },
  );
  return res.status();
}

test.describe("org invitation lure", () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/e2e/seed/invite-lure`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {},
    });
    expect(res.ok(), `seed failed: ${await res.text()}`).toBeTruthy();
    seed = (await res.json()).seed as LureSeed;
  });

  test.afterAll(async ({ request }) => {
    if (!seed) return;
    const res = await request.post(`${API_BASE_URL}/e2e/cleanup/invite-lure`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {
        orgId: seed.orgId,
        humanIds: [
          seed.inviter.humanId,
          seed.invitee.humanId,
          seed.victim.humanId,
        ],
      },
    });
    expect(res.ok(), `cleanup failed: ${await res.text()}`).toBeTruthy();
  });

  test("a different signed-in account cannot be enrolled; the invitee can, only by clicking Accept", async ({
    browser,
  }) => {
    const s = seed!;
    const link = `/invite/accept?token=${encodeURIComponent(s.token)}`;

    // ── 1. Victim (B) is lured to the invitee's link ────────────────────────
    {
      const { context, page, jwt } = await signedInPage(
        browser,
        s.victim.email,
        s.password,
      );
      const console = collectConsoleErrors(page);
      await page.goto(`${WEB_BASE_URL}${link}`);

      await expect(
        page.getByText(/isn't valid for this account/i),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByRole("button", { name: /accept invitation/i }),
      ).toHaveCount(0);
      await expect(page.getByText(s.orgName)).toHaveCount(0);

      // The ONLY console errors allowed are the refused preview itself.
      const unexpected = console
        .errors()
        .filter((e) => !/404|NOT_FOUND|previewInvitation/i.test(e));
      console.detach();
      expect(unexpected).toEqual([]);

      expect(await listMembersStatus(page, jwt, s.orgId)).toBe(403);
      await context.close();
    }

    // ── 2. The real invitee (A) ─────────────────────────────────────────────
    {
      const { context, page, jwt } = await signedInPage(
        browser,
        s.invitee.email,
        s.password,
      );
      const console = collectConsoleErrors(page);
      await page.goto(`${WEB_BASE_URL}${link}`);

      // The confirm screen names the org (heading "Join <org>?").
      await expect(
        page.getByRole("heading", { name: `Join ${s.orgName}?` }),
      ).toBeVisible({ timeout: 20_000 });
      // Nothing accepted before the click.
      expect(await listMembersStatus(page, jwt, s.orgId)).toBe(403);

      await page.getByRole("button", { name: /accept invitation/i }).click();
      await expect(page.getByText(/you.ve been added to/i)).toBeVisible({
        timeout: 20_000,
      });
      expect(await listMembersStatus(page, jwt, s.orgId)).toBe(200);

      // 320px: no horizontal overflow on the accept flow.
      const [scrollW, clientW] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scrollW).toBeLessThanOrEqual(clientW);

      expect(console.errors()).toEqual([]);
      console.detach();
      await context.close();
    }
  });
});
