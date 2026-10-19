import type { APIRequestContext } from "@playwright/test";

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

interface ResetOptions {
  /** When provided, the auth user (+ session, account, human) for this email
   *  is preserved so Playwright's storageState cookies remain valid. */
  preserveEmail?: string;
}

/**
 * Wipes E2E state via the API's `/e2e/reset` endpoint.
 *
 * ── This REFUSES to run against a live stack ────────────────────────────────
 * `/e2e/reset` runs `deleteMany({})` across payouts, settlements, orders,
 * tickets, promos, feePolicy, ticketTypes, events, places, orgs, entityPages,
 * apiKeys and authUser — a full data wipe of whatever database the API points
 * at. `E2E_USE_LIVE_STACK=1` protects the dev server PROCESS (see
 * `global-teardown.ts`) and skips Playwright's `prisma migrate reset`, but it
 * never protected the DATA: ~54 specs call this in `beforeEach`, so running any
 * of them against a live stack destroyed the seeded dev database anyway. The
 * flag read as "reuse my stack, don't touch it" and only honoured half of that.
 *
 * So this throws instead of wiping. Set `E2E_ALLOW_LIVE_RESET=1` alongside it
 * when you genuinely want a live stack reset — the point is that it has to be
 * deliberate, not a side effect of picking the "safe" flag.
 */
export async function resetE2eState(
  request: APIRequestContext,
  apiBaseUrl: string,
  options?: ResetOptions,
): Promise<void> {
  if (
    process.env.E2E_USE_LIVE_STACK === "1" &&
    process.env.E2E_ALLOW_LIVE_RESET !== "1"
  ) {
    throw new Error(
      [
        "Refusing to wipe the database of a live stack.",
        "",
        "This spec calls resetE2eState(), which POSTs /e2e/reset and deletes every",
        "order, ticket, event, place, org and auth user in the database the API is",
        "pointed at. You set E2E_USE_LIVE_STACK=1, which reuses your running dev",
        "stack — so that is your dev database, with your seeded data in it.",
        "",
        "Either:",
        "  • drop E2E_USE_LIVE_STACK and let Playwright boot its own stack, or",
        "  • set E2E_ALLOW_LIVE_RESET=1 if you really do want the live stack wiped, or",
        "  • drive the page by hand (Chrome DevTools MCP) to check a UI surface",
        "    against existing seed data without running the spec.",
      ].join("\n"),
    );
  }

  const secret = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";
  const origin = stripTrailingSlash(apiBaseUrl);

  const startedAt = Date.now();
  const timeoutMs = Number(process.env.E2E_RESET_TIMEOUT_MS ?? 20_000);
  const retryDelayMs = Number(process.env.E2E_RESET_RETRY_DELAY_MS ?? 250);

  const bodyData: Record<string, string> = {};
  if (options?.preserveEmail) {
    bodyData.preserveEmail = options.preserveEmail;
  }

  let lastError: unknown = undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await request.post(`${origin}/e2e/reset`, {
        headers: {
          "x-e2e-reset-secret": secret,
          "content-type": "application/json",
        },
        data: bodyData,
      });

      const bodyText = await res.text();
      if (res.ok()) return;

      lastError = new Error(
        `Failed to reset E2E state (${res.status()}): ${bodyText}`,
      );
    } catch (error) {
      // Most common in CI/local under load: API is booting and refuses connections.
      lastError = error;
    }

    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to reset E2E state: ${formatUnknownError(lastError)}`);
}

function formatUnknownError(value: unknown): string {
  if (value == null) return "unknown error";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  if (value instanceof Error) return value.message;
  return "unknown error";
}
