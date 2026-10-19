import { type APIRequestContext } from "@playwright/test";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@th/trpc";

export interface E2eTrpcClientOptions {
  /** Bearer token for authenticated requests. If provided, will be sent in Authorization header. */
  bearerToken?: string | (() => Promise<string | null>);
}

export function createE2eTrpcClient(
  request: APIRequestContext,
  apiBaseUrl: string,
  options: E2eTrpcClientOptions = {},
) {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiBaseUrl.replace(/\/+$/, "")}/trpc`,
        transformer: superjson,
        fetch: async (url, fetchOptions) => {
          const method = fetchOptions?.method ?? "GET";
          const headers = fetchOptions?.headers
            ? Object.fromEntries(new Headers(fetchOptions.headers as any))
            : {};
          const body = fetchOptions?.body;

          // Add bearer token if provided
          const token =
            typeof options.bearerToken === "function"
              ? await options.bearerToken()
              : options.bearerToken;
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }

          const response = await request.fetch(url.toString(), {
            method,
            headers,
            data: body as string | Buffer | undefined,
          });

          // Adapt Playwright's APIResponse to the standard Response interface expected by tRPC
          const bodyBuffer = await response.body();
          return new Response(new Uint8Array(bodyBuffer), {
            status: response.status(),
            statusText: response.statusText(),
            headers: response.headers(),
          });
        },
      }),
    ],
  });
}

/**
 * Sign in via Better Auth API and return a JWT token for authenticated requests.
 * This bypasses the UI and directly calls the API, useful for setting up test state.
 *
 * Note: Uses Playwright's `page` context to make requests with proper cookies.
 */
export async function signInAndGetToken(
  request: APIRequestContext,
  apiBaseUrl: string,
  credentials: { email: string; password: string },
): Promise<{ token: string; sessionToken?: string }> {
  const authBaseUrl = `${apiBaseUrl.replace(/\/+$/, "")}/api/auth`;

  // Sign in via Better Auth
  const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const signInRes = await request.post(`${authBaseUrl}/sign-in/email`, {
    headers: {
      "Content-Type": "application/json",
      Origin: webBaseUrl,
      Referer: `${webBaseUrl}/sign-in`,
    },
    data: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });

  if (!signInRes.ok()) {
    const body = await signInRes.text();
    throw new Error(`Sign-in failed: ${signInRes.status()} ${body}`);
  }

  // Better Auth can return an opaque session token in the `set-auth-token`
  // header. tRPC bearer auth needs a compact JWT, so prefer /token.
  const authToken = signInRes.headers()["set-auth-token"];

  if (isCompactJwt(authToken)) {
    return { token: authToken, sessionToken: authToken };
  }

  // The sign-in sets session cookies. Try to get a JWT token from /token endpoint.
  // The cookies should be in Playwright's request context now.
  const tokenRes = await request.get(`${authBaseUrl}/token`);

  if (!tokenRes.ok()) {
    // If /token fails, it might be because the session wasn't established properly.
    // Try extracting the session token from the sign-in response body instead.
    const signInData = await signInRes.json().catch(() => null);
    if (isCompactJwt(signInData?.session?.token)) {
      return { token: signInData.session.token };
    }
    if (isCompactJwt(signInData?.token)) {
      return { token: signInData.token };
    }

    const body = await tokenRes.text();
    throw new Error(
      `Token fetch failed: ${tokenRes.status()} ${body}. Sign-in data: ${JSON.stringify(signInData)}`,
    );
  }

  const tokenData = await tokenRes.json();
  const token = tokenData?.token;

  if (!isCompactJwt(token)) {
    throw new Error(`No token in response: ${JSON.stringify(tokenData)}`);
  }

  return { token };
}

function isCompactJwt(token: unknown): token is string {
  return typeof token === "string" && token.split(".").length === 3;
}
