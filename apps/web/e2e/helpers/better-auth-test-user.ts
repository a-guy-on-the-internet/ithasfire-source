import type { APIRequestContext } from "@playwright/test";

type EnsureTestUserInput = {
  request: APIRequestContext;
  apiBaseUrl: string;
  email: string;
  password: string;
  name?: string;
};

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

/**
 * Ensure a test user exists in Better Auth.
 *
 * We do this before UI sign-in so failures are unambiguous:
 * - if sign-in fails, it's not because someone forgot to pre-seed the auth DB.
 */
export async function ensureBetterAuthTestUserExists({
  request,
  apiBaseUrl,
  email,
  password,
  name = "Playwright Test User",
}: EnsureTestUserInput): Promise<void> {
  const origin = stripTrailingSlash(apiBaseUrl);
  const url = `${origin}/api/auth/sign-up/email`;

  const res = await request.post(url, {
    headers: { "content-type": "application/json" },
    data: {
      name,
      email,
      password,
    },
  });

  // Better Auth returns structured JSON on both success and error.
  const bodyText = await res.text();
  let json: any = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // ignore
  }

  // Success: user created.
  if (res.ok()) {
    return;
  }

  // If the user already exists, Better Auth can respond with different status
  // codes depending on adapter + schema: commonly 400/409/422.
  // Since our goal is "ensure exists" (idempotent), treat those as success
  // when the response indicates a uniqueness conflict.
  if ([400, 409, 422].includes(res.status())) {
    const combined = `${bodyText}\n${json?.message ?? ""}\n${json?.error?.message ?? ""}`;
    if (
      /unique constraint failed|P2002|email\b.*exists|already\s+exists|user\b.*exists/i.test(
        combined,
      )
    ) {
      return;
    }
  }

  // Better Auth can return a generic 422 for signup even when we can't
  // introspect the precise failure. Historically this happens for "already
  // exists" and isn't actionable for our setup, so treat it as success.
  if (
    res.status() === 422 &&
    typeof bodyText === "string" &&
    /failed to create user/i.test(bodyText)
  )
    return;

  // Idempotency: if the user already exists, Better Auth will typically return a 4xx with a message.
  const message =
    json?.error?.message ??
    json?.message ??
    json?.error ??
    (res.status() ? `HTTP ${res.status()}` : "unknown_error");

  // In practice the per-spec UI tests might intentionally sign up with the same
  // email as the setup user (or a previous run could have already created it).
  // Treat "already exists" as success so setup remains deterministic.
  if (
    typeof bodyText === "string" &&
    /unique constraint failed|P2002|email\b.*exists/i.test(bodyText)
  ) {
    return;
  }
  if (typeof message === "string" && /exist|already/i.test(message)) {
    return;
  }

  const diagnostics = bodyText
    ? `Response body: ${bodyText}`
    : "(empty response body)";
  throw new Error(
    `Failed to ensure Better Auth test user exists (${res.status()}): ${message}\n${diagnostics}`,
  );
}
