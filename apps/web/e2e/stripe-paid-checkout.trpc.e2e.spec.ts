import { expect, test } from "./fixtures";
import type { APIRequestContext } from "./fixtures";

import { resetE2eState } from "./helpers/e2e-reset";

const apiBaseUrl =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3001";

function uniqueEmail(prefix = "playwright-stripe"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function seedPaidCheckoutFixture(request: APIRequestContext) {
  const res = await request.post(
    `${apiBaseUrl.replace(/\/+$/, "")}/e2e/seed/paid-checkout`,
    {
      headers: {
        "content-type": "application/json",
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
      },
      data: {
        email: uniqueEmail(),
        password: "Test-Account-2026!",
        currency: "usd",
        priceCents: 2500,
        stripeAccountId: "acct_123",
      },
    },
  );

  expect(res.ok(), await res.text()).toBeTruthy();
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.seed as {
    email: string;
    password: string;
    humanId: string;
    orgId: string;
    eventId: string;
    ticketTypeId: string;
    stripeAccountId: string;
  };
}

async function signInAndGetToken(
  request: APIRequestContext,
  email: string,
  password: string,
) {
  const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
  const res = await request.post(
    `${apiBaseUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`,
    {
      headers: {
        "content-type": "application/json",
        origin,
      },
      data: {
        email,
        password,
      },
    },
  );

  expect(res.ok(), await res.text()).toBeTruthy();

  const tokenRes = await request.get(
    `${apiBaseUrl.replace(/\/+$/, "")}/api/auth/token`,
  );
  if (tokenRes.ok()) {
    const tokenJson = await tokenRes.json();
    if (isCompactJwt(tokenJson?.token)) return tokenJson.token as string;
  }

  const json = await res.json();

  // Better Auth typically returns a session + token; we accept a few shapes.
  const token: string | undefined =
    json?.token ??
    json?.accessToken ??
    json?.data?.token ??
    json?.data?.accessToken ??
    json?.session?.token;

  expect(isCompactJwt(token)).toBeTruthy();
  return token as string;
}

function isCompactJwt(token: unknown): token is string {
  return typeof token === "string" && token.split(".").length === 3;
}

test.describe("Stripe paid checkout (tRPC -> API -> stripe-mock)", () => {
  test.skip(
    process.env.PLAYWRIGHT_PROJECT_NAME === "guest",
    "requires authenticated storageState",
  );

  test("orders.createCheckout returns clientSecret and is idempotent", async ({
    page,
  }) => {
    // Make environment deterministic.
    await resetE2eState(page.request, apiBaseUrl);

    // Create the domain graph (event + ticket type + payee ready for charges).
    const seed = await seedPaidCheckoutFixture(page.request);

    // Sign in to get a Bearer token so authedProcedure passes.
    const token = await signInAndGetToken(
      page.request,
      seed.email,
      seed.password,
    );

    const clientKey = `pw-client-${Date.now()}`;
    const inputJson = {
      buyerHumanId: seed.humanId,
      eventId: seed.eventId,
      clientKey,
      currency: "usd",
      termsAccepted: true,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    };

    const trpcUrl = `${apiBaseUrl.replace(/\/+$/, "")}/trpc/orders.createCheckout?batch=1`;
    const body = { 0: { json: inputJson } };

    const res1 = await page.request.post(trpcUrl, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      data: body,
    });
    expect(res1.ok(), await res1.text()).toBeTruthy();
    const json1 = await res1.json();
    const out1 = json1?.[0]?.result?.data?.json as {
      orderId: string;
      clientSecret: string | null;
    };
    expect(out1?.orderId).toBeTruthy();
    expect(out1?.clientSecret).toBeTruthy();

    // Repeat the exact same call with the same clientKey to prove idempotency.
    const res2 = await page.request.post(trpcUrl, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      data: body,
    });
    expect(res2.ok(), await res2.text()).toBeTruthy();
    const json2 = await res2.json();
    const out2 = json2?.[0]?.result?.data?.json as {
      orderId: string;
      clientSecret: string | null;
    };

    expect(out2.orderId).toBe(out1.orderId);
    expect(out2.clientSecret).toBe(out1.clientSecret);
  });
});
