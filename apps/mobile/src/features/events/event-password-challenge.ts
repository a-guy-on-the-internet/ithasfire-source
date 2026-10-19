/**
 * Event-password submit flow, including the Turnstile challenge step.
 *
 * `events.validatePassword` asks for a Cloudflare Turnstile token after
 * repeated wrong passwords (per IP, or per event). It signals that with a
 * FORBIDDEN whose `data.appCode` is `EVENT_PASSWORD_CHALLENGE_REQUIRED`. The
 * app has no WebView, so the challenge runs on the web app's
 * `/challenge/turnstile` page in the system browser, which redirects back to
 * `returnUrl` carrying `turnstileToken=<token>` (or
 * `turnstileError=unavailable`).
 *
 * Pure on purpose: no react-native / expo imports, so it runs under vitest.
 * The hook (`use-event-password-submit.ts`) injects the browser + transport.
 */

export const EVENT_PASSWORD_CHALLENGE_CODE = "EVENT_PASSWORD_CHALLENGE_REQUIRED";

/**
 * Options for `events.validatePassword.useMutation`. `retry: false` is
 * load-bearing: the app's mutation default is `retry: 1`
 * (`src/lib/trpc.ts`), and a retry would burn the per-event rate-limit
 * budget on a wrong password and resend a single-use Turnstile token.
 */
export const VALIDATE_PASSWORD_MUTATION_OPTIONS = { retry: false } as const;

export type ValidatePasswordInput = {
  eventId: string;
  password: string;
  turnstileToken?: string;
};

/** The slice of `WebBrowserAuthSessionResult` the flow reads. */
export type ChallengeSessionResult = { type: string; url?: string };

export type SubmitEventPasswordDeps = {
  validate: (input: ValidatePasswordInput) => Promise<{ unlocked: boolean }>;
  /** `WebBrowser.openAuthSessionAsync(challengeUrl, returnUrl)`. */
  openChallenge: (
    challengeUrl: string,
    returnUrl: string,
  ) => Promise<ChallengeSessionResult>;
  /** Public web origin, no trailing slash. */
  webBaseUrl: string;
  /** Deep link the challenge page redirects to (`Linking.createURL`). */
  returnUrl: string;
  /**
   * Called on every degraded branch that isn't the user's own doing: the
   * browser threw, the page reported Turnstile unavailable, or the redirect
   * broke the URL contract. Never receives the token. Not called on cancel.
   */
  reportError?: (err: unknown, context: ChallengeReportContext) => void;
};

export type ChallengeReportContext = {
  tags: { feature: "event-password-challenge"; reason: ChallengeReportReason };
  extra?: { scheme: string | null; queryKeys: string[] };
};

export type ChallengeReportReason =
  | "browser_threw"
  | "unavailable"
  | "malformed_redirect";

export type SubmitEventPasswordOutcome =
  | { kind: "unlocked" }
  | { kind: "wrong-password" }
  /** The user closed the browser before finishing the check. */
  | { kind: "challenge-cancelled" }
  /** The challenge page couldn't load Turnstile, or the browser threw. */
  | { kind: "challenge-unavailable" }
  /** The server rejected the token, or the redirect carried no token. */
  | { kind: "challenge-failed" }
  | { kind: "error"; error: unknown };

export const isPasswordChallengeError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  return (
    (data as { appCode?: unknown }).appCode === EVENT_PASSWORD_CHALLENGE_CODE
  );
};

export const buildChallengeUrl = (
  webBaseUrl: string,
  returnUrl: string,
): string =>
  `${webBaseUrl.replace(/\/+$/, "")}/challenge/turnstile?return=${encodeURIComponent(returnUrl)}`;

/** Safe to report: the scheme and the query KEY names, never a value. */
export type RedirectShape = { scheme: string | null; queryKeys: string[] };

export type ChallengeRedirect =
  | { kind: "token"; token: string }
  | { kind: "unavailable"; shape: RedirectShape }
  | { kind: "cancelled" }
  | { kind: "malformed"; shape: RedirectShape };

const decodeComponent = (raw: string): string =>
  decodeURIComponent(raw.replace(/\+/g, " "));

/**
 * Splits a query string into key → FIRST value. Hand-rolled on purpose, not
 * `URLSearchParams`: RN 0.81's polyfill (Libraries/Blob/URLSearchParams.js)
 * cuts a value at its second `=` and throws on a bad `%` escape, while Node's
 * doesn't, so vitest would pass on code that breaks on Hermes. This parser runs
 * the same on both. Returns `null` when a component can't be decoded.
 */
const parseQuery = (query: string): Map<string, string> | null => {
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = decodeComponent(eq === -1 ? pair : pair.slice(0, eq));
      value = eq === -1 ? "" : decodeComponent(pair.slice(eq + 1));
    } catch {
      return null;
    }
    if (!params.has(key)) params.set(key, value);
  }
  return params;
};

export const MAX_REPORTED_KEYS = 10;
export const MAX_REPORTED_KEY_LENGTH = 32;

/**
 * Key names made safe to report. A valueless pair (`?<token>`) turns the
 * token into a KEY, so an over-long key is replaced by its length rather than
 * truncated: a 32-char prefix would still be part of the token. Real key
 * names are short; Turnstile tokens are not. Deduped, at most 10.
 */
const reportableKeys = (keys: Iterable<string>): string[] =>
  Array.from(new Set(keys))
    .slice(0, MAX_REPORTED_KEYS)
    .map((key) =>
      key.length > MAX_REPORTED_KEY_LENGTH ? `<${key.length} chars>` : key,
    );

/** Key names only, undecoded; for reports when decoding failed. */
const rawQueryKeys = (query: string): string[] =>
  reportableKeys(
    query
      .split("&")
      .filter(Boolean)
      .map((pair) => pair.split("=", 1)[0]),
  );

/**
 * Reads the auth-session result.
 *
 * Edge cases, pinned by tests: only the first `?` starts the query, so a
 * second `?` lands inside a value; a repeated `turnstileToken` takes the
 * first; values are decoded exactly once (a double-encoded token reaches the
 * server still encoded once, and the server rejects it); a raw `=` inside a
 * value is kept.
 */
export const readChallengeRedirect = (
  result: ChallengeSessionResult,
): ChallengeRedirect => {
  if (result.type !== "success") return { kind: "cancelled" };
  const url = result.url ?? "";
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return { kind: "malformed", shape: { scheme, queryKeys: [] } };
  }
  const hashStart = url.indexOf("#", queryStart);
  const query = url.slice(
    queryStart + 1,
    hashStart === -1 ? undefined : hashStart,
  );
  const params = parseQuery(query);
  if (!params) {
    return {
      kind: "malformed",
      shape: { scheme, queryKeys: rawQueryKeys(query) },
    };
  }
  const shape: RedirectShape = {
    scheme,
    queryKeys: reportableKeys(params.keys()),
  };
  if (params.get("turnstileError") === "unavailable") {
    return { kind: "unavailable", shape };
  }
  const token = params.get("turnstileToken");
  return token ? { kind: "token", token } : { kind: "malformed", shape };
};

/** A throwing reporter must never change the outcome. */
const report = (
  deps: SubmitEventPasswordDeps,
  err: unknown,
  reason: ChallengeReportReason,
  shape?: RedirectShape,
): void => {
  try {
    deps.reportError?.(err, {
      tags: { feature: "event-password-challenge", reason },
      ...(shape ? { extra: shape } : {}),
    });
  } catch {
    // Swallowed on purpose; see above.
  }
};

const settle = async (
  deps: SubmitEventPasswordDeps,
  input: ValidatePasswordInput,
): Promise<{ unlocked: boolean } | { error: unknown }> => {
  try {
    return await deps.validate(input);
  } catch (error) {
    return { error };
  }
};

/**
 * Submit → (challenge → resubmit once). Never loops: a challenge on the
 * resubmit means the token was rejected, and the user has to tap again.
 */
export const submitEventPassword = async (
  input: { eventId: string; password: string },
  deps: SubmitEventPasswordDeps,
): Promise<SubmitEventPasswordOutcome> => {
  const first = await settle(deps, input);
  if ("unlocked" in first) {
    return first.unlocked ? { kind: "unlocked" } : { kind: "wrong-password" };
  }
  if (!isPasswordChallengeError(first.error)) {
    return { kind: "error", error: first.error };
  }

  let session: ChallengeSessionResult;
  try {
    session = await deps.openChallenge(
      buildChallengeUrl(deps.webBaseUrl, deps.returnUrl),
      deps.returnUrl,
    );
  } catch (err) {
    report(deps, err, "browser_threw");
    return { kind: "challenge-unavailable" };
  }

  const redirect = readChallengeRedirect(session);
  if (redirect.kind === "cancelled") return { kind: "challenge-cancelled" };
  if (redirect.kind === "unavailable") {
    report(
      deps,
      new Error("event_password_challenge_unavailable"),
      "unavailable",
      redirect.shape,
    );
    return { kind: "challenge-unavailable" };
  }
  if (redirect.kind === "malformed") {
    // The web page and the app disagree on the redirect contract. Without
    // this report every challenged mobile guest is stuck and nobody knows.
    report(
      deps,
      new Error("event_password_challenge_malformed_redirect"),
      "malformed_redirect",
      redirect.shape,
    );
    return { kind: "challenge-failed" };
  }

  const second = await settle(deps, { ...input, turnstileToken: redirect.token });
  if ("unlocked" in second) {
    return second.unlocked ? { kind: "unlocked" } : { kind: "wrong-password" };
  }
  if (isPasswordChallengeError(second.error)) {
    return { kind: "challenge-failed" };
  }
  return { kind: "error", error: second.error };
};

/** The sheet's CTA. The cancel copy names it, so both read from here. */
const UNLOCK_CTA = "Unlock event";

export const PASSWORD_COPY = {
  unlockCta: UNLOCK_CTA,
  wrongPassword: "That password didn't work. Check it and try again.",
  tooManyAttempts: "Too many attempts. Wait a minute and try again.",
  generic: "Couldn't verify the password. Try again.",
  challengeNeeded: `Tap "${UNLOCK_CTA}" to open a quick security check.`,
  challengeFailed: "The security check didn't go through. Try again.",
  challengeUnavailable:
    "We can't run the security check right now. Try again later.",
} as const;

/** Maps a non-challenge error to the sheet's existing copy (unchanged). */
export const getPasswordErrorMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null) {
    const code = (err as { data?: { code?: unknown } | null }).data?.code;
    if (code === "TOO_MANY_REQUESTS") return PASSWORD_COPY.tooManyAttempts;
    if (code === "BAD_REQUEST") return PASSWORD_COPY.wrongPassword;
  }
  return PASSWORD_COPY.generic;
};

export type PasswordNotice = { tone: "danger" | "info"; text: string };

/** `null` for `unlocked`: the sheet closes, nothing to show. */
export const noticeForOutcome = (
  outcome: SubmitEventPasswordOutcome,
): PasswordNotice | null => {
  switch (outcome.kind) {
    case "unlocked":
      return null;
    case "wrong-password":
      return { tone: "danger", text: PASSWORD_COPY.wrongPassword };
    case "challenge-cancelled":
      return { tone: "info", text: PASSWORD_COPY.challengeNeeded };
    case "challenge-unavailable":
      return { tone: "danger", text: PASSWORD_COPY.challengeUnavailable };
    case "challenge-failed":
      return { tone: "danger", text: PASSWORD_COPY.challengeFailed };
    case "error":
      return { tone: "danger", text: getPasswordErrorMessage(outcome.error) };
  }
};
