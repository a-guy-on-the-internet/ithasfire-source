import type { APIRequestContext } from "@playwright/test";

/**
 * Adds test funds to the Stripe platform account balance.
 *
 * This is necessary for Connect transfers to succeed in test mode.
 * The endpoint creates a charge using Stripe's `tok_bypassPending` token.
 *
 * @param request - Playwright's APIRequestContext
 * @param apiBaseUrl - Base URL of the API (e.g., "http://localhost:3001")
 * @param options - Configuration options
 * @returns The new available balance in cents
 */
export async function addStripeTestFunds(
  request: APIRequestContext,
  apiBaseUrl: string,
  options: {
    amountCents?: number;
    currency?: string;
    e2eResetSecret?: string;
  } = {},
): Promise<{ ok: boolean; availableBalance: number; chargeId?: string }> {
  const {
    amountCents = 100_000, // Default $1000
    currency = "usd",
    e2eResetSecret = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
  } = options;

  const res = await request.post(`${apiBaseUrl}/e2e/stripe/add-test-funds`, {
    headers: {
      "x-e2e-reset-secret": e2eResetSecret,
      "content-type": "application/json",
    },
    data: { amountCents, currency },
  });

  if (!res.ok()) {
    const text = await res.text();
    console.error(`Failed to add Stripe test funds: ${res.status()} ${text}`);
    return { ok: false, availableBalance: 0 };
  }

  const json = await res.json();
  return {
    ok: true,
    availableBalance: json.availableBalance ?? 0,
    chargeId: json.chargeId,
  };
}

/**
 * Gets the current Stripe test account balance.
 *
 * @param request - Playwright's APIRequestContext
 * @param apiBaseUrl - Base URL of the API
 * @returns The balance information
 */
export async function getStripeTestBalance(
  request: APIRequestContext,
  apiBaseUrl: string,
  options: {
    e2eResetSecret?: string;
  } = {},
): Promise<{
  ok: boolean;
  available: Array<{ amount: number; currency: string }>;
  pending: Array<{ amount: number; currency: string }>;
}> {
  const {
    e2eResetSecret = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret",
  } = options;

  const res = await request.get(`${apiBaseUrl}/e2e/stripe/balance`, {
    headers: { "x-e2e-reset-secret": e2eResetSecret },
  });

  if (!res.ok()) {
    return { ok: false, available: [], pending: [] };
  }

  const json = await res.json();
  return {
    ok: true,
    available: json.available ?? [],
    pending: json.pending ?? [],
  };
}

/**
 * Ensures the Stripe test account has at least the specified amount available.
 *
 * Will add funds if the current balance is insufficient.
 *
 * @param request - Playwright's APIRequestContext
 * @param apiBaseUrl - Base URL of the API
 * @param requiredAmountCents - Minimum amount required in cents
 * @param currency - Currency to check (default: "usd")
 * @returns Whether the required balance is available
 */
export async function ensureStripeTestFunds(
  request: APIRequestContext,
  apiBaseUrl: string,
  requiredAmountCents: number,
  currency = "usd",
): Promise<boolean> {
  // First check current balance
  const balance = await getStripeTestBalance(request, apiBaseUrl);
  if (!balance.ok) {
    console.error("Failed to get Stripe balance");
    return false;
  }

  const currentAvailable =
    balance.available.find((b) => b.currency === currency)?.amount ?? 0;
  console.log(
    `Current Stripe ${currency} available balance: ${currentAvailable} cents`,
  );

  if (currentAvailable >= requiredAmountCents) {
    console.log(
      `✓ Sufficient funds available (need ${requiredAmountCents}, have ${currentAvailable})`,
    );
    return true;
  }

  // Need to add funds - add extra buffer
  const deficit = requiredAmountCents - currentAvailable;
  const amountToAdd = Math.max(deficit + 10_000, 50_000); // Add at least $500 or deficit + $100

  console.log(`Adding ${amountToAdd} cents to Stripe test balance...`);
  const result = await addStripeTestFunds(request, apiBaseUrl, {
    amountCents: amountToAdd,
    currency,
  });

  if (!result.ok) {
    console.error("Failed to add Stripe test funds");
    return false;
  }

  console.log(
    `✓ Added funds. New available balance: ${result.availableBalance} cents`,
  );
  return result.availableBalance >= requiredAmountCents;
}
