/**
 * Native passkey adapter for the scanner.
 *
 * Better Auth ships an `@better-auth/passkey/client` plugin for the browser
 * but not for Expo/React Native. We talk to the same REST endpoints
 * directly using `react-native-passkey` to drive the native WebAuthn ceremony.
 *
 * Endpoints (mounted by `passkey()` on the API):
 *   GET  /api/auth/passkey/generate-register-options       (query: name, etc.)
 *   POST /api/auth/passkey/verify-registration             (body: { response, name })
 *   GET  /api/auth/passkey/generate-authenticate-options
 *   POST /api/auth/passkey/verify-authentication           (body: { response })
 *   GET  /api/auth/passkey/list-user-passkeys
 *   POST /api/auth/passkey/delete-passkey                  (body: { id })
 *
 * RN session glue:
 *   - WebAuthn challenge survives via a signed cookie set by the options
 *     endpoint and read by the verify endpoint. RN's fetch hides Set-Cookie,
 *     so we capture the response cookies via `getResponseCookies()` and
 *     resend them as a `Cookie` header on the verify call.
 *   - The session token after a successful verify-authentication comes via
 *     the bearer plugin's `set-auth-token` response header (the body only
 *     contains `{ session, user }`).
 */

import {
  Passkey,
  type PasskeyCreateResult,
  type PasskeyGetResult,
} from "react-native-passkey";

import { getApiBaseUrl, getAuthOrigin } from "../../config/api";
import { getSessionTokenSync, setSessionToken } from "./auth-token-store";

export interface PasskeyError {
  message: string;
  code?: string;
}

export interface PasskeyResult<T> {
  data: T | null;
  error: PasskeyError | null;
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(extra ?? {}),
  };
  const origin = getAuthOrigin();
  if (origin) headers.origin = origin;
  const token = getSessionTokenSync();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function buildUrl(
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const base = `${getApiBaseUrl().replace(/\/+$/, "")}/api/auth/passkey${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === "string" && v.length > 0) params.append(k, v);
  }
  const qs = params.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

interface RawCall<TResp> {
  data: TResp | null;
  error: PasskeyError | null;
  rawCookies: string[];
  authToken: string | null;
}

/**
 * Read response cookies in a way that survives RN's case-insensitive header
 * map oddities. `getSetCookie()` is the spec method; falls back to `get()`.
 */
function readSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=[^;]+=)/) : [];
}

async function call<TResp>(
  path: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string | undefined>;
    cookies?: string[];
  },
): Promise<RawCall<TResp>> {
  const headers = buildHeaders(
    init.body !== undefined
      ? { "content-type": "application/json" }
      : undefined,
  );
  if (init.cookies && init.cookies.length > 0) {
    // Strip attributes (Path, HttpOnly, etc.) and just send `name=value`.
    headers.cookie = init.cookies
      .map((c) => c.split(";")[0]?.trim())
      .filter((c): c is string => Boolean(c))
      .join("; ");
  }
  try {
    const res = await fetch(buildUrl(path, init.query), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json().catch(() => null)) as
      | TResp
      | { message?: unknown }
      | null;
    const rawCookies = readSetCookies(res.headers);
    const authToken = res.headers.get("set-auth-token");
    if (!res.ok) {
      const message =
        (json && typeof json === "object" && "message" in json
          ? String((json as { message?: unknown }).message)
          : null) ?? `passkey_${path.replace(/^\//, "")}_failed`;
      return { data: null, error: { message }, rawCookies, authToken };
    }
    return { data: json as TResp, error: null, rawCookies, authToken };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "passkey_request_failed";
    return { data: null, error: { message }, rawCookies: [], authToken: null };
  }
}

export interface ScannerPasskey {
  id: string;
  name: string | null;
  deviceType: string | null;
  createdAt: string | null;
}

export function isPasskeySupported(): boolean {
  try {
    return Passkey.isSupported();
  } catch {
    return false;
  }
}

/**
 * Enroll a new passkey on the current device.
 * Caller must already be signed in.
 */
export async function addPasskey(
  name?: string,
): Promise<PasskeyResult<unknown>> {
  const optionsResult = await call<Record<string, unknown>>(
    "/generate-register-options",
    {
      method: "GET",
      query: { name },
    },
  );
  if (optionsResult.error || !optionsResult.data) {
    return { data: null, error: optionsResult.error };
  }

  let credential: PasskeyCreateResult;
  try {
    credential = await Passkey.create(optionsResult.data as never);
  } catch (err) {
    // Keep logs minimal to avoid printing potentially sensitive
    // native stack traces or platform-specific fields.
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        "[passkey] Passkey.create threw (dev-only)",
        err instanceof Error ? err.message : err,
      );
    }
    const messageRaw = err instanceof Error ? err.message : String(err);
    const message =
      messageRaw && messageRaw.length > 0
        ? messageRaw
        : "passkey_create_failed";
    const isCancel = /\bcancel|user[_ ]?cancel|notallowed|aborted/i.test(
      message,
    );
    return {
      data: null,
      error: {
        message,
        code: isCancel ? "user_cancelled" : "passkey_create_failed",
      },
    };
  }

  const verify = await call<unknown>("/verify-registration", {
    method: "POST",
    body: { response: credential, name },
    cookies: optionsResult.rawCookies,
  });
  return { data: verify.data, error: verify.error };
}

/**
 * Sign in with a passkey via discoverable (resident) credentials.
 * On success, persists the new bearer token captured from `set-auth-token`.
 */
export async function signInWithPasskey(): Promise<
  PasskeyResult<{ session?: unknown; user?: unknown }>
> {
  const optionsResult = await call<Record<string, unknown>>(
    "/generate-authenticate-options",
    {
      method: "GET",
    },
  );
  if (optionsResult.error || !optionsResult.data) {
    return { data: null, error: optionsResult.error };
  }

  let assertion: PasskeyGetResult;
  try {
    assertion = await Passkey.get(optionsResult.data as never);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "passkey_assertion_failed";
    const isCancel = /\bcancel|user[_ ]?cancel|notallowed|aborted/i.test(
      message,
    );
    return {
      data: null,
      error: {
        message,
        code: isCancel ? "user_cancelled" : "passkey_assertion_failed",
      },
    };
  }

  const verify = await call<{ session?: unknown; user?: unknown }>(
    "/verify-authentication",
    {
      method: "POST",
      body: { response: assertion },
      cookies: optionsResult.rawCookies,
    },
  );

  if (verify.error) return { data: null, error: verify.error };

  if (!verify.authToken) {
    return {
      data: null,
      error: {
        message:
          "Sign-in succeeded but the device couldn't capture a session token. Make sure the API has the bearer() plugin enabled.",
        code: "missing_session_token",
      },
    };
  }

  await setSessionToken(verify.authToken);
  return { data: verify.data, error: null };
}

export async function listUserPasskeys(): Promise<
  PasskeyResult<ScannerPasskey[]>
> {
  const result = await call<ScannerPasskey[]>("/list-user-passkeys", {
    method: "GET",
  });
  return { data: result.data, error: result.error };
}

export async function deletePasskey(
  id: string,
): Promise<PasskeyResult<{ success?: boolean }>> {
  const result = await call<{ success?: boolean }>("/delete-passkey", {
    method: "POST",
    body: { id },
  });
  return { data: result.data, error: result.error };
}

export const scannerPasskey = {
  isSupported: isPasskeySupported,
  addPasskey,
  signInWithPasskey,
  listUserPasskeys,
  deletePasskey,
};
