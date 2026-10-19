import { expect, test } from "./fixtures";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";

const apiBaseUrl =
  process.env.PLAYWRIGHT_API_BASE_URL ?? "http://127.0.0.1:3001";

function uniqueEmail(prefix = "playwright-chargeback"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

test.describe("Chargeback terms gate", () => {
  test("blocks paid checkout until the organizer accepts current terms", async ({
    request,
  }) => {
    const seedRes = await request.post(
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
          acceptChargebackTerms: false,
        },
      },
    );
    expect(seedRes.ok(), await seedRes.text()).toBeTruthy();
    const seedJson = await seedRes.json();
    expect(seedJson.ok).toBe(true);
    const seed = seedJson.seed as {
      email: string;
      password: string;
      humanId: string;
      orgId: string;
      eventId: string;
      ticketTypeId: string;
    };

    const { token } = await signInAndGetToken(request, apiBaseUrl, {
      email: seed.email,
      password: seed.password,
    });
    const trpc = createE2eTrpcClient(request, apiBaseUrl, {
      bearerToken: token,
    });

    const checkoutInput = {
      buyerHumanId: seed.humanId,
      eventId: seed.eventId,
      clientKey: `chargeback-smoke-${Date.now()}`,
      currency: "usd",
      termsAccepted: true,
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: seed.ticketTypeId, qty: 1 }],
    };

    await expect(
      trpc.orders.createCheckout.mutate(checkoutInput),
    ).rejects.toMatchObject({
      shape: expect.objectContaining({
        message: "chargeback_terms_required",
        data: expect.objectContaining({
          code: "PRECONDITION_FAILED",
          httpStatus: 412,
        }),
      }),
    });

    const acceptance = await trpc.orgs.acceptChargebackTerms.mutate({
      orgId: seed.orgId,
    });
    expect(acceptance.ok).toBe(true);
    expect(acceptance.targetType).toBe("ORGANIZATION");
    expect(acceptance.targetId).toBe(seed.orgId);
    expect(acceptance.terms.version).toBeTruthy();

    const checkout = await trpc.orders.createCheckout.mutate({
      ...checkoutInput,
      clientKey: `chargeback-smoke-accepted-${Date.now()}`,
    });
    expect(checkout.orderId).toBeTruthy();
    expect(checkout.clientSecret).toBeTruthy();
  });
});