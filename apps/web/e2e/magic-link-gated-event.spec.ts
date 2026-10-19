import type { Browser, Response } from "@playwright/test";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { collectConsoleErrors } from "./helpers/console-errors";
import { createE2eTrpcClient } from "./helpers/trpc";

/**
 * Gated-event invite links (docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml).
 *
 * Replaces the old `?token=` magic-link redeemer spec. The ORGANISER is the
 * Playwright storageState user (the default `page`): the seeded gated-event
 * organiser has no password and cannot sign in, so the seed is told to make
 * the storageState user the org owner (`ownerEmail`). Every GUEST is a separate,
 * signed-out browser context.
 *
 * Live-stack safe: no `resetE2eState`. Each test seeds its own uniquely named
 * event; there is no cleanup route for gated-event seeds, so the rows stay.
 */

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";
const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";
const e2eHeaders = {
  "x-e2e-reset-secret": E2E_SECRET,
  "content-type": "application/json",
};

const DEAD_PASSWORD =
  "This invite link doesn’t work anymore. Ask whoever sent it for a new one, or enter the password.";
const REMOVED_PASSWORD =
  "The organiser reset the invite link, so it no longer lets you in. Ask them for a new one, or enter the password.";

type GatedSeed = {
  orgSlug: string;
  eventId: string;
  eventSlug: string;
  eventPassword: string | null;
};

async function seedGatedEvent(
  request: APIRequestContext,
  gateType: "PASSWORD" | "APPLICATION",
  password = "invite-e2e-secret",
): Promise<GatedSeed> {
  // The storageState user must be email-verified for organiser surfaces.
  const verified = await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
    headers: e2eHeaders,
    data: { email: TEST_EMAIL },
  });
  expect(verified.ok(), `verify-email failed: ${await verified.text()}`).toBe(
    true,
  );
  const res = await request.post(`${API_BASE_URL}/e2e/seed/gated-event`, {
    headers: e2eHeaders,
    data: {
      gateType,
      password,
      ownerEmail: TEST_EMAIL,
      stripeAccountId: `acct_e2e_inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      email: `e2e-gated-${Date.now()}@example.com`,
    },
  });
  expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
  const { seed } = await res.json();
  expect(seed.orgSlug).toBeTruthy();
  return seed;
}

/** A signed-out guest: its own context, with console errors collected. */
async function newGuest(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const collector = collectConsoleErrors(page);
  return { context, page, collector };
}

/**
 * tRPC as the organiser. The API wants a bearer JWT, not the web session
 * cookie: mint one from the storageState session via Better Auth's /token.
 */
async function organiserTrpc(page: Page) {
  const res = await page.request.get(`${API_BASE_URL}/api/auth/token`);
  expect(res.ok(), `token fetch failed: ${res.status()}`).toBeTruthy();
  const { token } = await res.json();
  expect(token).toBeTruthy();
  return createE2eTrpcClient(page.request, API_BASE_URL, {
    bearerToken: token,
  });
}

function inviteToken(url: string): string {
  const token = new URL(url).searchParams.get("invite");
  expect(token, `no ?invite= in ${url}`).toBeTruthy();
  return token as string;
}

async function openTheEvent(page: Page) {
  await page.getByRole("button", { name: "Open the event" }).click();
}

async function expectInside(page: Page) {
  await expect(page.getByText(/general admission/i)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("invite")).toBe(false);
}

async function expectDeadNotice(
  page: Page,
  reason: "dead" | "removed",
  text: string,
) {
  const notice = page.getByTestId("invite-dead-notice");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toHaveAttribute("data-reason", reason);
  await expect(notice).toHaveText(text);
  await expect(page.locator('input[type="password"]')).toBeFocused();
}

/**
 * The shell's client access probe (`POST /api/events/:id/unlocked-view`,
 * GatedEventShell) runs after mount and decides locked / unlocked / removed.
 * The door is server-rendered, so anything that probe decides must be
 * asserted AFTER it answers. Start this BEFORE the navigation.
 */
function waitForAccessProbe(page: Page, eventId: string): Promise<Response> {
  const path = `/api/events/${eventId}/unlocked-view`;
  return page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === path,
    { timeout: 30_000 },
  );
}

async function probeBody(probe: Promise<Response>): Promise<unknown> {
  const res = await probe;
  expect(res.status(), "unlocked-view status").toBe(200);
  return res.json();
}

/** Two frames: the notice copy is set in a rAF after the verdict lands. */
async function nextFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test.describe("Gated event invite links", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "the organiser is the storageState user; guest project has none",
    );
  });

  test("shared link opens a password event for a signed-out guest", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const seed = await seedGatedEvent(request, "PASSWORD");
    const trpc = await organiserTrpc(page);
    const shared = await trpc.events.setSharedInvite.mutate({
      eventId: seed.eventId,
      action: "ENABLE",
    });
    expect(shared.url).toBeTruthy();
    const token = inviteToken(shared.url as string);

    const guest = await newGuest(browser, baseURL);
    try {
      await guest.page.goto(`/events/${seed.eventSlug}?invite=${token}`);
      await expect(guest.page.getByText(/E2E PASSWORD Gated Event/)).toBeVisible();
      await expect(
        guest.page.getByRole("button", { name: "Open the event" }),
      ).toBeVisible();
      await openTheEvent(guest.page);
      await expectInside(guest.page);

      // HttpOnly invite-grant cookie for THIS event, set by the redeem.
      const grant = (await guest.context.cookies()).find(
        (c) => c.name === `th_ei_${seed.eventId}`,
      );
      expect(grant, `no th_ei_${seed.eventId} cookie`).toBeTruthy();
      expect(grant!.httpOnly).toBe(true);

      await guest.page.reload();
      await expectInside(guest.page);
      expect(guest.collector.errors()).toEqual([]);
    } finally {
      await guest.context.close();
    }
  });

  test("personal invite lets one guest in until it is revoked", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const seed = await seedGatedEvent(request, "PASSWORD");
    const trpc = await organiserTrpc(page);
    // Invite allowance (invite-allowance.ts): the SENDER is the storageState
    // user, and its actor bucket allows 10 recipients per rolling 24h while
    // that account is under 7 days old, 50 after that (the freshly seeded org
    // has no track record). The bucket is per sender, so it is shared with
    // every spec that sends invites as this user. This test sends one per
    // run; don't loop it.
    const email = `e2e-invitee-${Date.now()}@example.com`;
    await trpc.events.createGuestInvites.mutate({
      eventId: seed.eventId,
      guests: [{ name: "E2E Invitee", email }],
    });
    const list = await trpc.events.listInvites.query({ eventId: seed.eventId });
    const row = list.guests.find((g) => g.email === email);
    expect(row?.copyUrl).toBeTruthy();
    const inviteUrl = `/events/${seed.eventSlug}?invite=${inviteToken(row!.copyUrl as string)}`;

    const guest = await newGuest(browser, baseURL);
    try {
      await guest.page.goto(inviteUrl);
      await openTheEvent(guest.page);
      await expectInside(guest.page);

      await trpc.events.revokeGuestInvite.mutate({
        eventId: seed.eventId,
        inviteId: row!.id,
      });

      // Revoking takes the guest's access away ("{name} loses access to this
      // event and their link stops working"): the plain URL, with their
      // grant cookie still in the jar, is back at the password door.
      const afterRevoke = waitForAccessProbe(guest.page, seed.eventId);
      await guest.page.goto(`/events/${seed.eventSlug}`);
      const revokedBody = (await probeBody(afterRevoke)) as {
        access?: unknown;
      };
      expect(revokedBody.access, JSON.stringify(revokedBody)).toBe("locked");
      await expect(guest.page.locator('input[type="password"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(guest.page.getByText(/general admission/i)).toHaveCount(0);

      // And the link itself is dead.
      await guest.page.goto(inviteUrl);
      await expectDeadNotice(guest.page, "dead", DEAD_PASSWORD);
      expect(guest.collector.errors()).toEqual([]);
    } finally {
      await guest.context.close();
    }
  });

  test("a fake token shows the dead notice with the password focused", async ({
    request,
    browser,
    baseURL,
  }) => {
    const seed = await seedGatedEvent(request, "PASSWORD");
    const guest = await newGuest(browser, baseURL);
    try {
      await guest.page.goto(
        `/events/${seed.eventSlug}?invite=${"x".repeat(43)}`,
      );
      await expectDeadNotice(guest.page, "dead", DEAD_PASSWORD);
      expect(guest.collector.errors()).toEqual([]);
    } finally {
      await guest.context.close();
    }
  });

  test("Reset and remove locks out shared-link guests, not strangers", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const seed = await seedGatedEvent(request, "PASSWORD", "reset-e2e-secret");
    const trpc = await organiserTrpc(page);
    const shared = await trpc.events.setSharedInvite.mutate({
      eventId: seed.eventId,
      action: "ENABLE",
    });
    const token = inviteToken(shared.url as string);
    const plainUrl = `/events/${seed.eventSlug}`;

    const guest = await newGuest(browser, baseURL);
    const stranger = await newGuest(browser, baseURL);
    try {
      await guest.page.goto(`${plainUrl}?invite=${token}`);
      await openTheEvent(guest.page);
      await expectInside(guest.page);

      // Organiser resets through the builder UI.
      await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
      // Settings → "Access & privacy" group (collapsed by default). Its
      // header button already carries a test id; no deep link exists.
      const accessHeader = page.getByTestId("advanced-section-gate");
      await expect(accessHeader).toBeVisible({ timeout: 30_000 });
      if ((await accessHeader.getAttribute("aria-expanded")) !== "true") {
        await accessHeader.click();
      }
      await expect(accessHeader).toHaveAttribute("aria-expanded", "true");
      const section = page.getByTestId("invite-link-section");
      await expect(section).toBeVisible({ timeout: 30_000 });
      await section.getByTestId("invite-link-reset").click();
      const dialog = page.getByTestId("invite-link-reset-dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("radio", { name: /Keep people who already got in/ }),
      ).toBeChecked();
      await dialog.getByRole("radio", { name: /Remove them too/ }).click();
      await dialog.getByRole("button", { name: "Reset and remove" }).click();
      await expect(dialog).toBeHidden({ timeout: 20_000 });
      // The card now shows a NEW link: one read must both carry an invite
      // token AND differ from the old URL, so an empty field mid-refetch
      // can't pass.
      const urlField = page.getByTestId("invite-link-url");
      await expect
        .poll(
          async () => {
            const v = await urlField.inputValue();
            return v.includes("?invite=") && v !== shared.url ? "new link" : v;
          },
          { timeout: 20_000 },
        )
        .toBe("new link");

      // The guest reloads the plain URL: back at the door, told why.
      const guestProbe = waitForAccessProbe(guest.page, seed.eventId);
      await guest.page.goto(plainUrl);
      expect(await probeBody(guestProbe)).toEqual({
        access: "locked",
        removedByInviteReset: true,
      });
      await expectDeadNotice(guest.page, "removed", REMOVED_PASSWORD);

      // Entering the password clears the notice and unlocks.
      await guest.page.locator('input[type="password"]').fill("reset-e2e-secret");
      await guest.page
        .getByTestId("password-door")
        .getByRole("button", { name: "Enter", exact: true })
        .click();
      await expect(guest.page.getByText(/general admission/i)).toBeVisible({
        timeout: 20_000,
      });
      await expect(guest.page.getByTestId("invite-dead-notice")).toHaveCount(0);

      // A stranger never sees the line: wait for the probe's verdict (the
      // door is server-rendered, so a count-0 check before it would pass at
      // once), then give the rAF that sets the notice copy a chance to run.
      const strangerProbe = waitForAccessProbe(stranger.page, seed.eventId);
      await stranger.page.goto(plainUrl);
      expect(await probeBody(strangerProbe)).toEqual({ access: "locked" });
      await nextFrames(stranger.page);
      await expect(stranger.page.locator('input[type="password"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(stranger.page.getByTestId("invite-dead-notice")).toHaveCount(
        0,
      );
      expect(guest.collector.errors()).toEqual([]);
      expect(stranger.collector.errors()).toEqual([]);
    } finally {
      await guest.context.close();
      await stranger.context.close();
    }
  });

  test("on an application event the shared link counts as approval", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const seed = await seedGatedEvent(request, "APPLICATION");
    const trpc = await organiserTrpc(page);
    const shared = await trpc.events.setSharedInvite.mutate({
      eventId: seed.eventId,
      action: "ENABLE",
    });
    const token = inviteToken(shared.url as string);

    const guest = await newGuest(browser, baseURL);
    try {
      await guest.page.goto(`/events/${seed.eventSlug}?invite=${token}`);
      await openTheEvent(guest.page);
      await expectInside(guest.page);

      // A SIGNED-OUT redeem of the SHARED link writes the invite grant
      // `th_ei_<eventId>`, on an application event too, with no submission
      // row (redeem-event-invite.ts, R4). `th_ea_` is only for a signed-out
      // PERSONAL invite. So: HttpOnly th_ei_ for this event, and no th_ea_.
      const cookies = await guest.context.cookies();
      const grant = cookies.find((c) => c.name === `th_ei_${seed.eventId}`);
      expect(grant, `no th_ei_${seed.eventId} cookie`).toBeTruthy();
      expect(grant!.httpOnly).toBe(true);
      expect(cookies.some((c) => c.name === `th_ea_${seed.eventId}`)).toBe(
        false,
      );

      // The grant alone keeps them in: a reload (no ?invite=) is still inside.
      const reloadProbe = waitForAccessProbe(guest.page, seed.eventId);
      await guest.page.reload();
      expect(
        ((await probeBody(reloadProbe)) as { access?: unknown }).access,
      ).toBe("unlocked");
      await expectInside(guest.page);
      expect(guest.collector.errors()).toEqual([]);
    } finally {
      await guest.context.close();
    }
  });
});
