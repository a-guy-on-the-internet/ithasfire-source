/**
 * Lifecycle Journey E2E
 *
 * The complete Ithas Fire lifecycle in a single spec:
 *
 *   Sign Up (organizer) → Verify Email → Seed Org + Stripe Connect →
 *   Create Event via Builder UI → Publish → Sign Up (buyer) →
 *   Buy Ticket (tRPC hold + Stripe PI confirm) → Poll Order Success →
 *   Scan Ticket (tRPC) → Assert ACCEPTED
 *
 * This exercises every major subsystem: auth, event builder, checkout,
 * payment processing, ticket minting, and scanning.
 */
import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import {
  createMailpitClient,
  extractFirstUrlFromMailpitMessage,
} from "./helpers/mailpit";
import { confirmStripePaymentIntent } from "./helpers/stripe-webhook";
import { createE2eTrpcClient, signInAndGetToken } from "./helpers/trpc";
import { ensureStripeTestFunds } from "./helpers/stripe-test-funds";
import { signUpWithPassword } from "./helpers/sign-in";

// ── Constants ────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const STRIPE_ACCOUNT_ID =
  process.env.PLAYWRIGHT_E2E_STRIPE_ACCOUNT_ID ??
  process.env.E2E_STRIPE_ACCOUNT_ID ??
  "acct_1SsQuGFPwBURBn1I";

const TICKET_PRICE_CENTS = 3500; // $35.00

test.describe("Lifecycle Journey: Sign Up → Create Event → Buy Ticket → Scan", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== "guest") {
      testInfo.skip(true, "Guest-only journey");
    }
    await resetE2eState(request, API_BASE_URL);
  });

  test("organizer creates event, buyer purchases ticket, organizer scans it", async ({
    page,
    request,
  }) => {
    const uniqueId = Date.now();
    const mailpit = createMailpitClient({ request });

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 1 — Organizer Sign Up via UI
    // ═════════════════════════════════════════════════════════════════════

    const organizerEmail = `organizer-${uniqueId}@example.com`;
    const organizerPassword = "OrganizerPass-2026!";
    const organizerUsername = `organizer${uniqueId}`;
    const organizerDisplayName = "Organizer McTest";

    // Create the account through the UI. The ritual — including the
    // `auth-sign-up-expand-form` disclosure the email form lives behind —
    // is in `helpers/sign-in.ts`.
    await signUpWithPassword(page, {
      displayName: organizerDisplayName,
      username: organizerUsername,
      email: organizerEmail,
      password: organizerPassword,
    });

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 2 — Verify Organizer Email via Mailpit
    // ═════════════════════════════════════════════════════════════════════

    const verificationEmail = await mailpit.waitForEmailTo(organizerEmail);
    const verificationUrl =
      extractFirstUrlFromMailpitMessage(verificationEmail);
    await page.goto(verificationUrl);
    await page.waitForURL((url) => !url.pathname.includes("verify-email"), {
      timeout: 10_000,
    });
    await mailpit.clear();

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 3 — Sign in organizer + Seed Org with Stripe Connect
    // ═════════════════════════════════════════════════════════════════════
    //
    // The seed-event-builder endpoint creates: org, membership (OWNER),
    // fee policy, payout terms, Stripe Connect payee, a DRAFT event, and
    // a ticket type. We pass the organizer's email so the org is linked
    // to their account.

    const { token: organizerToken } = await signInAndGetToken(
      request,
      API_BASE_URL,
      { email: organizerEmail, password: organizerPassword },
    );
    expect(organizerToken).toBeTruthy();

    const seedRes = await request.post(
      `${API_BASE_URL}/e2e/seed/event-builder`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          email: organizerEmail,
          stripeAccountId: STRIPE_ACCOUNT_ID,
          // The event must be currently active for scanning to succeed.
          // Start 1 hour ago, end 2 hours from now.
          startsAt: new Date(Date.now() - 3_600_000).toISOString(),
          endsAt: new Date(Date.now() + 7_200_000).toISOString(),
        },
      },
    );
    expect(seedRes.ok(), `Seed failed: ${await seedRes.text()}`).toBeTruthy();
    const { seed } = await seedRes.json();
    expect(seed.orgSlug).toBeTruthy();
    expect(seed.eventId).toBeTruthy();

    // Ensure Stripe platform account has funds for Connect transfers.
    await ensureStripeTestFunds(request, API_BASE_URL, TICKET_PRICE_CENTS);

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 4 — Create & Publish Event via Builder UI
    // ═════════════════════════════════════════════════════════════════════
    //
    // The seed created a DRAFT event. We'll navigate to the edit page,
    // verify fields, add a paid ticket type, and publish.

    // Navigate to the event editor
    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await expect(page.locator('[data-testid="prose-editor"]')).toBeVisible();

    // Verify DRAFT status
    await expect(page.getByText("DRAFT")).toBeVisible();

    // Verify the seeded event title is present
    const titleInput = page.getByTestId("event-title");
    await expect(titleInput).toHaveValue(seed.eventTitle);

    // The seed already created a "General Admission" ticket type at $15.
    // Add a paid ticket type at our test price ($35).
    const editor = page.getByTestId("ticket-type-editor");
    await expect(editor).toBeVisible();

    await editor.getByTestId("ticket-type-add-btn").click();
    const addForm = editor.getByTestId("ticket-type-add-form");
    await expect(addForm).toBeVisible();

    await page.getByTestId("ticket-type-add-name").fill("E2E Journey Ticket");
    await page
      .getByTestId("ticket-type-add-price")
      .fill((TICKET_PRICE_CENTS / 100).toFixed(2));
    await page.getByTestId("ticket-type-add-capacity").fill("50");

    await editor.getByTestId("ticket-type-add-submit").click();
    await expect(addForm).not.toBeVisible();

    // Confirm the new ticket type appears
    await expect(editor.getByText("E2E Journey Ticket")).toBeVisible();

    // Publish the event
    const publishBtn = page.getByTestId("event-publish-btn");
    await expect(publishBtn).toBeEnabled();
    await publishBtn.click();
    await expect(page.getByText("PUBLISHED")).toBeVisible({ timeout: 10_000 });

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 5 — Buyer Sign Up (via API, not UI — we already tested sign-up)
    // ═════════════════════════════════════════════════════════════════════

    const buyerEmail = `buyer-${uniqueId}@example.com`;
    const buyerPassword = "BuyerPass-2026!";

    // Create buyer via seed (creates human + auth + credential)
    const buyerSeedRes = await request.post(
      `${API_BASE_URL}/e2e/seed/paid-checkout`,
      {
        headers: {
          "x-e2e-reset-secret": E2E_SECRET,
          "content-type": "application/json",
        },
        data: {
          email: buyerEmail,
          password: buyerPassword,
          // Reuse the same event's org for the paid-checkout seed; we only need
          // the human + auth bits. The event itself is the one we just published.
          stripeAccountId: STRIPE_ACCOUNT_ID,
          priceCents: TICKET_PRICE_CENTS,
        },
      },
    );
    expect(
      buyerSeedRes.ok(),
      `Buyer seed failed: ${await buyerSeedRes.text()}`,
    ).toBeTruthy();

    const { token: buyerToken } = await signInAndGetToken(
      request,
      API_BASE_URL,
      {
        email: buyerEmail,
        password: buyerPassword,
      },
    );
    expect(buyerToken).toBeTruthy();

    const buyerTrpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: buyerToken,
    });

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 6 — Visit Event Page & Verify it's Published
    // ═════════════════════════════════════════════════════════════════════

    await page.goto(`/events/${seed.eventSlug}`);
    await expect(
      page.getByRole("heading", { name: seed.eventTitle }),
    ).toBeVisible();

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 7 — Buy Ticket (tRPC hold + checkout + Stripe confirm)
    // ═════════════════════════════════════════════════════════════════════
    //
    // We need the ticketTypeId for "E2E Journey Ticket" that we added
    // via the builder. Query the event's ticket types via the public
    // listEventTicketTypes endpoint.

    const ticketTypesResult = await buyerTrpc.events.listEventTicketTypes.query(
      {
        eventId: seed.eventId,
      },
    );
    expect(ticketTypesResult.ticketTypes.length).toBeGreaterThan(0);

    const journeyTicketType = ticketTypesResult.ticketTypes.find(
      (tt: any) => tt.name === "E2E Journey Ticket",
    );
    expect(
      journeyTicketType,
      "Could not find the 'E2E Journey Ticket' ticket type on the published event",
    ).toBeTruthy();

    // Hold tickets
    const holdResult = await buyerTrpc.orders.updateOrderItems.mutate({
      eventId: seed.eventId,
      items: [{ ticketTypeId: journeyTicketType!.id, qty: 1 }],
    });
    expect(holdResult.order?.id).toBeTruthy();
    expect(holdResult.holdExpiresAt).toBeTruthy();

    // Create checkout (payment intent).
    // buyerHumanId is auto-injected from the auth context by the transport.
    const checkoutData = await buyerTrpc.orders.createCheckout.mutate({
      eventId: seed.eventId,
      clientKey: `e2e-lifecycle-${uniqueId}`,
      items: [{ ticketTypeId: journeyTicketType!.id, qty: 1 }],
    });
    expect(checkoutData.orderId).toBeTruthy();
    expect(checkoutData.clientSecret).toBeTruthy();

    // Extract PaymentIntent ID and confirm via Stripe test mode
    const paymentIntentId = checkoutData.clientSecret!.split("_secret_")[0]!;
    expect(paymentIntentId).toBeTruthy();

    await confirmStripePaymentIntent({
      stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
      paymentIntentId,
    });

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 8 — Poll for Order Completion & Get Tickets
    // ═════════════════════════════════════════════════════════════════════

    await expect
      .poll(
        async () => {
          try {
            const order = await buyerTrpc.orders.getMyOrder.query({
              orderId: checkoutData.orderId,
            });
            return order.status;
          } catch {
            return null;
          }
        },
        {
          message: "Order did not become SUCCEEDED within timeout",
          timeout: 30_000,
          intervals: [500, 1_000],
        },
      )
      .toBe("SUCCEEDED");

    // Fetch minted tickets
    const ticketsResponse = await buyerTrpc.orders.listMyOrderTickets.query({
      orderId: checkoutData.orderId,
    });
    expect(ticketsResponse.tickets.length).toBeGreaterThan(0);

    const ticket = ticketsResponse.tickets[0];
    expect(ticket.code).toBeTruthy();

    console.log(
      `[Lifecycle E2E] Ticket minted: id=${ticket.id}, code=${ticket.code}`,
    );

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 9 — Scan Ticket (organizer scans buyer's ticket via tRPC)
    // ═════════════════════════════════════════════════════════════════════
    //
    // The organizer is an OWNER of the org, which is in ORG_SCAN_ROLES.
    // We call tickets.scanTicket with the organizer's auth token.

    const organizerTrpc = createE2eTrpcClient(request, API_BASE_URL, {
      bearerToken: organizerToken,
    });

    const scanResult = await organizerTrpc.tickets.scanTicket.mutate({
      eventId: seed.eventId,
      ticketCode: ticket.code,
    });

    expect(scanResult.outcome).toBe("ACCEPTED");

    if (scanResult.outcome === "ACCEPTED") {
      expect(scanResult.ticketId).toBe(ticket.id);
      expect(scanResult.eventId).toBe(seed.eventId);
      expect(scanResult.scannedAt).toBeTruthy();

      console.log(
        `[Lifecycle E2E] Ticket scanned: outcome=ACCEPTED, scannedAt=${scanResult.scannedAt}`,
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 10 — Verify Replay (scanning same ticket again = REPLAY)
    // ═════════════════════════════════════════════════════════════════════

    const replayResult = await organizerTrpc.tickets.scanTicket.mutate({
      eventId: seed.eventId,
      ticketCode: ticket.code,
    });

    expect(replayResult.outcome).toBe("REPLAY");

    if (replayResult.outcome === "REPLAY") {
      expect(replayResult.ticketId).toBe(ticket.id);
      expect(replayResult.previousScannedAt).toBeTruthy();

      console.log(
        `[Lifecycle E2E] Re-scan: outcome=REPLAY, previousScannedAt=${replayResult.previousScannedAt}`,
      );
    }

    // ═════════════════════════════════════════════════════════════════════
    // PHASE 11 — Verify Ticket Email (contains code + QR URL)
    // ═════════════════════════════════════════════════════════════════════

    const ticketEmail = await mailpit.waitForEmailTo(buyerEmail, {
      timeoutMs: 20_000,
    });
    expect(ticketEmail.Subject ?? "").toContain("Your tickets are ready");

    const ticketEmailBody = `${ticketEmail.HTML ?? ""}\n${ticketEmail.Text ?? ""}`;
    const publicAppUrl = (
      process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000"
    ).replace(/\/+$/, "");

    for (const t of ticketsResponse.tickets) {
      const qrUrl = `${publicAppUrl}/tickets/qr/${t.code}`;
      expect(ticketEmailBody).toContain(t.code);
      expect(ticketEmailBody).toContain(qrUrl);
    }

    console.log("[Lifecycle E2E] Journey complete.");
  });
});
