import { ZodError } from "zod";

import {
  type AppErrorCode,
  NETWORK_ERROR_MESSAGE,
  fromLegacyCode,
  toKey,
} from "./codes";
import { isAppError } from "./app-error";

export type NormalizedError = {
  fieldErrors: Record<string, string>;
  formError: string | null;
  code: AppErrorCode | null;
};

const EMPTY: NormalizedError = { fieldErrors: {}, formError: null, code: null };

const GENERIC_FALLBACK = "Something went wrong. Please try again.";

const NETWORK_MESSAGE_PATTERN =
  /load failed|failed to fetch|network\s?error|network request failed|fetch failed|networkerror when/i;

const EMAIL_NOT_VERIFIED_PATTERN =
  /verify your email|not verified|unverified|email.*verification/i;
const USER_EXISTS_PATTERN = /already (exists|in use|registered)/i;
const INVALID_CREDENTIALS_MESSAGE =
  "Invalid email or password. Please try again.";
const EMAIL_NOT_VERIFIED_MESSAGE =
  "Please verify your email address before signing in.";

// ── Shape readers ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a `code` field from any of the shapes Better Auth / fetch errors nest
 * it in: top-level `.code` or nested `.body.code`.
 */
function readAuthCode(e: Record<string, unknown>): string | null {
  if (typeof e.code === "string") return e.code;
  const body = asRecord(e.body);
  if (body && typeof body.code === "string") return body.code;
  return null;
}

/**
 * Read an HTTP-ish status from `.status` or `.statusCode`.
 */
function readStatus(e: Record<string, unknown>): number | null {
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return null;
}

/**
 * Collect every plausible message string off an error shape:
 * top-level `.message`, `.error.message`, `.body.message`, or a plain string.
 */
function collectMessages(error: unknown): string[] {
  if (typeof error === "string") return [error];
  const e = asRecord(error);
  if (!e) return [];
  const out: string[] = [];
  if (typeof e.message === "string") out.push(e.message);
  const nestedError = asRecord(e.error);
  if (nestedError && typeof nestedError.message === "string")
    out.push(nestedError.message);
  const body = asRecord(e.body);
  if (body && typeof body.message === "string") out.push(body.message);
  return out;
}

// ── Detectors ──────────────────────────────────────────────────────────

/**
 * Detect a network/fetch failure across the shapes Better Auth nests errors in
 * (top-level `.message`, `.error.message`, `.body.message`, or a plain string),
 * plus the `status === 0` signal of a fetch with no HTTP response.
 */
function isNetworkError(error: unknown): boolean {
  if (typeof error === "string") return NETWORK_MESSAGE_PATTERN.test(error);
  const e = asRecord(error);
  if (!e) return false;
  if (e.status === 0) return true;
  return collectMessages(error).some((msg) =>
    NETWORK_MESSAGE_PATTERN.test(msg),
  );
}

/**
 * Map a Better Auth error shape to an {@link AppErrorCode}. Consolidates the
 * bespoke detectors that previously lived in LoginCard
 * (`routeUnverifiedEmailToCard`) and SignUpCard (`isAccountAlreadyExistsError`).
 * Returns `null` when the shape isn't a recognised auth error.
 */
function detectAuthCode(error: unknown): AppErrorCode | null {
  const e = asRecord(error);
  if (!e) return null;

  const code = readAuthCode(e);
  const status = readStatus(e);
  const messages = collectMessages(error);

  // Only an explicit auth/verify signal maps to EMAIL_NOT_VERIFIED. A bare
  // `status === 403` does NOT — this resolver is shared across web/scanner/
  // mobile, where a 403 almost always means FORBIDDEN / insufficient role, not
  // an unverified email. (That bare-403 branch was a LoginCard-only heuristic.)
  if (
    code === "EMAIL_NOT_VERIFIED" ||
    messages.some((m) => EMAIL_NOT_VERIFIED_PATTERN.test(m))
  ) {
    return "EMAIL_NOT_VERIFIED";
  }

  // Prefix-match the whole USER_ALREADY_EXISTS* family: Better Auth's sign-up
  // path emits the variant `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`. Matching on
  // the stable code prefix (not just the English message) keeps account-exists
  // routing robust if that copy ever changes or is localized.
  if (
    (code && code.startsWith("USER_ALREADY_EXISTS")) ||
    messages.some((m) => USER_EXISTS_PATTERN.test(m))
  ) {
    return "USER_ALREADY_EXISTS";
  }

  // A 403 without any auth/verify signal is an authorization failure.
  if (code === "FORBIDDEN" || status === 403) {
    return "FORBIDDEN";
  }

  return null;
}

/**
 * True when a WebAuthn/passkey ceremony was dismissed by the user (or timed
 * out) rather than failing for a real reason. Browsers throw a `DOMException`
 * with `name === "NotAllowedError"` — and crucially its `.message` text ("The
 * operation either timed out or was not allowed…") contains neither "cancel"
 * nor "NotAllowedError", so message-substring matching alone misses it. Check
 * `.name` first, then fall back to substring matching for engines that surface
 * a custom message.
 *
 * The `typeof DOMException` guard keeps this safe on React Native / Hermes,
 * where `DOMException` is not a global.
 */
export function isWebAuthnCancel(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return (
    message.toLowerCase().includes("cancel") ||
    message.includes("NotAllowedError")
  );
}

// ── Copy helpers ───────────────────────────────────────────────────────

/**
 * Convert a snake_case code into a readable sentence.
 * e.g. "event_not_found" → "Event not found"
 */
function humanize(code: string): string {
  const spaced = code.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Pattern-match auth error messages into user-friendly text.
 * Better Auth returns generic strings like "Unauthorized" or messages
 * containing "verify" — rewrite them to something actionable.
 */
function rewriteAuthMessage(raw: string): string | null {
  const lower = raw.toLowerCase();
  // Only match auth-specific patterns — "invalid" alone is too broad
  // (would catch "Invalid date format", "Invalid event ID", etc.)
  if (
    lower === "unauthorized" ||
    lower.includes("invalid credentials") ||
    lower.includes("invalid password") ||
    lower.includes("invalid email or password") ||
    lower.includes("user not found")
  ) {
    return INVALID_CREDENTIALS_MESSAGE;
  }
  if (
    lower.includes("verify your email") ||
    lower.includes("email not verified")
  ) {
    return EMAIL_NOT_VERIFIED_MESSAGE;
  }
  return null;
}

/**
 * Resolve a structured {@link AppErrorCode} to user copy: prefer the injected
 * `t("errors.<key>")` translation, else a humanized fallback. Never leaks raw
 * internal detail.
 */
function resolveCode(code: AppErrorCode, t?: (key: string) => string): string {
  if (t) {
    const key = `errors.${toKey(code)}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return `${humanize(code.toLowerCase())}. Please try again or contact support.`;
}

/**
 * Attempt to resolve a raw error code/message string to a human-readable
 * string.
 *
 * 1. Check for auth error patterns (unauthorized, verify).
 * 2. If the string is a known legacy/canonical code, resolve via the catalog.
 * 3. If the string already looks human-readable (uppercase + space), return it.
 * 4. If a `t` function is provided, try `errors.<camelCaseCode>`.
 * 5. Fall back to humanising the snake_case code.
 */
function resolveMessage(raw: string, t?: (key: string) => string): string {
  const authRewrite = rewriteAuthMessage(raw);
  if (authRewrite) return authRewrite;

  // A known code (snake_case message-as-code) resolves through the catalog.
  const known = fromLegacyCode(raw);
  if (known) return resolveCode(known, t);

  // Already a sentence (starts uppercase + contains a space).
  if (/^[A-Z].*\s/.test(raw)) return raw;

  if (t) {
    const key = `errors.${raw.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }

  return `${humanize(raw)}. Please try again or contact support.`;
}

function isTRPCError(err: unknown): boolean {
  const e = asRecord(err);
  return !!e && "data" in e && typeof e.data === "object" && e.data !== null;
}

function isErrorLike(err: unknown): boolean {
  const e = asRecord(err);
  return !!e && typeof e.message === "string";
}

/**
 * Read a structured `AppErrorCode` off an error if present: an `AppError`
 * instance, a tRPC `data.appCode`, or a top-level `appCode`.
 */
function readStructuredCode(error: unknown): AppErrorCode | null {
  if (isAppError(error)) return error.code;
  const e = asRecord(error);
  if (!e) return null;
  const data = asRecord(e.data);
  const raw =
    (data && typeof data.appCode === "string" ? data.appCode : null) ??
    (typeof e.appCode === "string" ? e.appCode : null);
  return raw ? fromLegacyCode(raw) : null;
}

/**
 * Normalise any error shape into a consistent {@link NormalizedError}.
 *
 * Resolution order (highest priority first):
 *   1. Structured `AppErrorCode` (`AppError`, tRPC `data.appCode`, `appCode`).
 *   2. tRPC `data.zodError` field-level errors.
 *   3. Better Auth shape mapping (EMAIL_NOT_VERIFIED / USER_ALREADY_EXISTS).
 *   4. Network / fetch failure detection.
 *   5. Auth-message rewrites + i18n key resolution + humanized fallback.
 *
 * Never throws. Never leaks raw provider/host/internal strings to copy.
 */
export function normalizeError(
  error: unknown,
  t?: (key: string) => string,
): NormalizedError {
  if (error == null) return EMPTY;

  // ── 1. Structured AppErrorCode (preferred) ─────────────────────────
  const structured = readStructuredCode(error);
  if (structured) {
    return {
      fieldErrors: {},
      formError: resolveCode(structured, t),
      code: structured,
    };
  }

  // ── 2. ZodError (client-side validation) ───────────────────────────
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".");
      if (key && !(key in fieldErrors)) {
        fieldErrors[key] = issue.message;
      }
    }
    return { fieldErrors, formError: null, code: null };
  }

  // ── 2b. tRPC error with `.data.zodError` (field-level) ─────────────
  if (isTRPCError(error)) {
    const data = asRecord((error as Record<string, unknown>).data);
    const zodError = asRecord(data?.zodError);
    if (zodError) {
      const fieldErrors: Record<string, string> = {};
      const fe = asRecord(zodError.fieldErrors);
      if (fe) {
        for (const [field, messages] of Object.entries(fe)) {
          if (Array.isArray(messages) && messages.length > 0) {
            fieldErrors[field] = String(messages[0]);
          }
        }
      }
      const formErrors = zodError.formErrors;
      const formError =
        Array.isArray(formErrors) && formErrors.length > 0
          ? String(formErrors[0])
          : null;
      return {
        fieldErrors,
        formError,
        code:
          (data && typeof data.code === "string"
            ? fromLegacyCode(data.code)
            : null) ?? null,
      };
    }
  }

  // ── 3. Better Auth shape mapping ───────────────────────────────────
  const authCode = detectAuthCode(error);
  if (authCode) {
    return {
      fieldErrors: {},
      formError: resolveCode(authCode, t),
      code: authCode,
    };
  }

  // ── 4. Network / fetch failure ─────────────────────────────────────
  // Raw browser strings ("Load failed", "Failed to fetch") are useless to
  // users; rewrite them to a friendly, actionable message.
  if (isNetworkError(error)) {
    return {
      fieldErrors: {},
      formError: NETWORK_ERROR_MESSAGE,
      code: "NETWORK",
    };
  }

  // ── 5. tRPC error without zodError → message as form error ─────────
  if (isTRPCError(error)) {
    const e = error as Record<string, unknown>;
    const data = asRecord(e.data);
    const msg = e.message;
    if (typeof msg === "string" && msg) {
      return {
        fieldErrors: {},
        formError: resolveMessage(msg, t),
        code:
          (data && typeof data.code === "string"
            ? fromLegacyCode(data.code)
            : null) ?? null,
      };
    }
  }

  // ── 5b. Object with `.message` ─────────────────────────────────────
  if (isErrorLike(error)) {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string" && msg) {
      return {
        fieldErrors: {},
        formError: resolveMessage(msg, t),
        code: fromLegacyCode(msg),
      };
    }
  }

  // ── 5c. Plain string ───────────────────────────────────────────────
  if (typeof error === "string" && error) {
    return {
      fieldErrors: {},
      formError: resolveMessage(error, t),
      code: fromLegacyCode(error),
    };
  }

  // ── Fallback ───────────────────────────────────────────────────────
  return { fieldErrors: {}, formError: GENERIC_FALLBACK, code: null };
}

/**
 * Single source of truth for turning ANY error shape into a user-facing string
 * for toasts. Delegates to {@link normalizeError}; falls back to a generic
 * default when no form-level message is produced.
 */
export function formatAuthErrorMessage(
  error: unknown,
  t?: (key: string) => string,
): string {
  return (
    normalizeError(error, t).formError ??
    "We couldn't complete that action. Double-check your details and try again."
  );
}
