import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { signUpWithPassword } from "./helpers/sign-in";

test.describe("Full Journey: Paid Checkout + Email Verification", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }

    // 1. Reset DB
    await resetE2eState(
      request,
      process.env.E2E_API_BASE_URL || "http://localhost:3001",
    );
  });

  test("guest can sign up, verify email, and buy a ticket", async ({
    page,
    request,
  }) => {
    const apiBaseUrl = process.env.E2E_API_BASE_URL || "http://localhost:3001";

    // 2. Seed Paid Event
    const seedRes = await request.post(`${apiBaseUrl}/e2e/seed/paid-checkout`, {
      headers: {
        "x-e2e-reset-secret":
          process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
        "content-type": "application/json",
      },
      data: {},
    });
    if (!seedRes.ok()) {
      console.error("Seed failed:", await seedRes.text());
    }
    expect(seedRes.ok()).toBeTruthy();
    const { seed } = await seedRes.json();
    const eventSlug = seed.eventSlug;
    expect(eventSlug).toBeTruthy();

    // 3. Sign up via UI
    const uniqueId = Date.now();
    const email = `shopper-${uniqueId}@example.com`;
    const password = "Password123!";
    const username = `shopper${uniqueId}`;
    const displayName = "Shopper McTest";

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`, which also waits for the form to dismiss
    // and the URL to leave /sign-up.
    await signUpWithPassword(page, {
      displayName,
      username,
      email,
      password,
    });

    // 4. Verify email via Mailpit
    const mailpit = createMailpitClient({ request });
    const verificationEmail = await mailpit.waitForEmailTo(email);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);

    // Verify email by navigating to the verification URL
    // Better Auth's verify-email endpoint redirects to callbackURL after verification
    await page.goto(verificationUrl);
    // Wait for redirect to complete (should land on home page after verification)
    await page.waitForURL((url) => !url.pathname.includes("verify-email"), {
      timeout: 10_000,
    });
    await mailpit.clear();

    // 5. Sign in via API and get JWT token
    //    This bypasses the UI sign-in (which has session/cookie issues in E2E)
    //    and directly authenticates via the API, returning a JWT for tRPC calls.
    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email,
      password,
    });
    expect(token).toBeTruthy();

    // Debug: decode JWT payload to see claims (base64 decode middle part)
    const [, payloadB64] = token.split(".");
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    console.log("[E2E DEBUG] JWT payload:", payloadJson);

    // Create tRPC client with the JWT token for authenticated requests
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    // 6. Visit Event Page
    await page.goto(`/events/${eventSlug}`);
    await expect(
      page.getByRole("heading", { name: "E2E Paid Checkout Event" }),
    ).toBeVisible();

    // 7. Start checkout from the event page
    await page.getByRole("link", { name: /get tickets/i }).click();
    await page.waitForURL(
      (url) => url.pathname.endsWith(`/events/checkout/${eventSlug}`),
      { timeout: 15_000 },
    );

    await page
      .getByRole("button", { name: /increase general admission quantity/i })
      .click();
    await expect(page.getByText(/selected tickets/i)).toBeVisible();

    // 8. Hold tickets via tRPC (authenticated with JWT)
    const holdResult = await trpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    expect(holdResult.holdExpiresAt).toBeTruthy();

    // 9. Create checkout (payment intent)
    const checkoutData = await trpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-checkout-${Date.now()}`,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    });
    expect(checkoutData.orderId).toBeTruthy();
    expect(checkoutData.clientSecret).toBeTruthy();

    // 10. Confirm the PaymentIntent in Stripe.
    //     Stripe should deliver the webhook to our API via `stripe listen --forward-to ...`.
    const paymentIntentId = checkoutData.clientSecret?.split("_secret_")[0]!;
    expect(paymentIntentId).toBeTruthy();

    await confirmStripePaymentIntent({
      stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
      paymentIntentId: paymentIntentId!,
    });

    // 11. Poll for Order Completion
    //     The webhook processes asynchronously, so wait until the order succeeds.
    await expect
      .poll(
        async () => {
          try {
            const order = await trpc.orders.getMyOrder.query({
              orderId: checkoutData.orderId,
            });
            return order.status;
          } catch (err) {
            return null;
          }
        },
        {
          message: "Order did not become SUCCEEDED",
          timeout: 30_000,
          intervals: [500, 1000],
        },
      )
      .toBe("SUCCEEDED");

    // 12. Verify tickets were minted via tRPC
    const ticketsResponse = await trpc.orders.listMyOrderTickets.query({
      orderId: checkoutData.orderId,
    });
    expect(ticketsResponse.tickets.length).toBeGreaterThan(0);

    // 13. Verify Tickets via Email
    const ticketEmail = await mailpit.waitForEmailTo(email, {
      timeoutMs: 20_000,
    });
    expect(ticketEmail.Subject ?? "").toContain("Your tickets are ready");
    const ticketEmailBody = `${ticketEmail.HTML ?? ""}\n${ticketEmail.Text ?? ""}`;
    const publicAppUrl = (
      process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000"
    ).replace(/\/+$/, "");
    for (const ticket of ticketsResponse.tickets) {
      const qrUrl = `${publicAppUrl}/tickets/qr/${ticket.code}`;
      expect(ticketEmailBody).toContain(ticket.code);
      expect(ticketEmailBody).toContain(qrUrl);
    }
  });
});
