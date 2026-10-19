import { describe, expect, it, vi } from "vitest";

import {
  EVENT_PASSWORD_CHALLENGE_CODE,
  MAX_REPORTED_KEYS,
  MAX_REPORTED_KEY_LENGTH,
  PASSWORD_COPY,
  VALIDATE_PASSWORD_MUTATION_OPTIONS,
  buildChallengeUrl,
  isPasswordChallengeError,
  noticeForOutcome,
  readChallengeRedirect,
  submitEventPassword,
  type SubmitEventPasswordDeps,
} from "../event-password-challenge";

const RETURN_URL = "ithasfire://challenge";
const WEB = "https://ithasfire.com";
const INPUT = { eventId: "evt_1", password: "hunter2" };
const SECRET = "0.SECRET-token_value";

// Shaped like a TRPCClientError: the flow reads `data` structurally.
const trpcError = (data: Record<string, unknown>) =>
  Object.assign(new Error("trpc"), { data });

const challengeError = () =>
  trpcError({ code: "FORBIDDEN", appCode: EVENT_PASSWORD_CHALLENGE_CODE });

const success = (url: string) => ({ type: "success", url });

const makeDeps = (
  overrides: Partial<SubmitEventPasswordDeps> = {},
): SubmitEventPasswordDeps & {
  validate: ReturnType<typeof vi.fn>;
  openChallenge: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
} =>
  ({
    validate: vi.fn().mockResolvedValue({ unlocked: true }),
    openChallenge: vi.fn().mockResolvedValue({ type: "cancel" }),
    reportError: vi.fn(),
    webBaseUrl: WEB,
    returnUrl: RETURN_URL,
    ...overrides,
  }) as never;

/** Challenged first, then the browser returns `session`. */
const challengedDeps = (
  session: unknown,
  overrides: Partial<SubmitEventPasswordDeps> = {},
) =>
  makeDeps({
    validate: vi.fn().mockRejectedValue(challengeError()),
    openChallenge: vi.fn().mockResolvedValue(session),
    ...overrides,
  });

const serialized = (mock: ReturnType<typeof vi.fn>) =>
  JSON.stringify(mock.mock.calls, (_k, v: unknown) =>
    v instanceof Error ? { message: v.message } : v,
  );

describe("VALIDATE_PASSWORD_MUTATION_OPTIONS", () => {
  it("disables retry (the app default is retry: 1; tokens are single-use)", () => {
    expect(VALIDATE_PASSWORD_MUTATION_OPTIONS.retry).toBe(false);
  });
});

describe("buildChallengeUrl", () => {
  it("encodes the return URL into the fixed web contract", () => {
    expect(buildChallengeUrl(WEB, RETURN_URL)).toBe(
      "https://ithasfire.com/challenge/turnstile?return=ithasfire%3A%2F%2Fchallenge",
    );
  });

  it("tolerates a trailing slash on the origin and encodes dev URLs", () => {
    expect(
      buildChallengeUrl(
        "http://localhost:3000/",
        "exp://192.168.1.5:8081/--/challenge",
      ),
    ).toBe(
      "http://localhost:3000/challenge/turnstile?return=exp%3A%2F%2F192.168.1.5%3A8081%2F--%2Fchallenge",
    );
  });
});

describe("readChallengeRedirect", () => {
  it("reads a token off a custom-scheme URL", () => {
    expect(
      readChallengeRedirect(
        success("ithasfire://challenge?turnstileToken=0.abc%2Bdef_-"),
      ),
    ).toEqual({ kind: "token", token: "0.abc+def_-" });
  });

  it("reads a token off an Expo Go URL and ignores a fragment", () => {
    expect(
      readChallengeRedirect(
        success("exp://192.168.1.5:8081/--/challenge?turnstileToken=tok#x"),
      ),
    ).toEqual({ kind: "token", token: "tok" });
  });

  it("keeps a raw `=` inside the value (RN's URLSearchParams would cut it)", () => {
    expect(
      readChallengeRedirect(success("ithasfire://challenge?turnstileToken=ab==")),
    ).toEqual({ kind: "token", token: "ab==" });
  });

  it("decodes a raw `+` to a space", () => {
    expect(
      readChallengeRedirect(success("ithasfire://challenge?turnstileToken=a+b")),
    ).toEqual({ kind: "token", token: "a b" });
  });

  it("finds the token after a key with no `=`", () => {
    expect(
      readChallengeRedirect(
        success("ithasfire://challenge?flag&turnstileToken=t"),
      ),
    ).toEqual({ kind: "token", token: "t" });
  });

  it("takes the first of a repeated turnstileToken", () => {
    expect(
      readChallengeRedirect(
        success(
          "ithasfire://challenge?turnstileToken=first&turnstileToken=second",
        ),
      ),
    ).toEqual({ kind: "token", token: "first" });
  });

  it("decodes a double-encoded token exactly once", () => {
    // `+` encoded twice: %2B → %252B. One decode leaves `%2B`, which goes to
    // the server as-is and is rejected there (→ challenge-failed).
    expect(
      readChallengeRedirect(
        success("ithasfire://challenge?turnstileToken=abc%252Bdef"),
      ),
    ).toEqual({ kind: "token", token: "abc%2Bdef" });
  });

  describe("two `?` characters: only the first starts the query", () => {
    it("is malformed when the second `?` hides the token key", () => {
      expect(
        readChallengeRedirect(
          success("ithasfire://challenge?from=web?turnstileToken=tok"),
        ),
      ).toEqual({
        kind: "malformed",
        shape: { scheme: "ithasfire", queryKeys: ["from"] },
      });
    });

    it("keeps the rest in the value when the `?` follows the token", () => {
      // Not a real Turnstile token; the server rejects it.
      expect(
        readChallengeRedirect(
          success("ithasfire://challenge?turnstileToken=tok?x=1"),
        ),
      ).toEqual({ kind: "token", token: "tok?x=1" });
    });
  });

  it("is malformed, with raw key names, on a bad percent escape", () => {
    expect(
      readChallengeRedirect(
        success("ithasfire://challenge?turnstileToken=%E0%A4%A&x=1"),
      ),
    ).toEqual({
      kind: "malformed",
      shape: { scheme: "ithasfire", queryKeys: ["turnstileToken", "x"] },
    });
  });

  describe("reported key names", () => {
    // Turnstile tokens are hundreds of chars; a valueless `?<token>` pair
    // makes the token a key name.
    const LONG_TOKEN = `0.${"x".repeat(300)}`;

    it("replaces an over-long key with its length (no prefix leaks)", () => {
      const result = readChallengeRedirect(
        success(`ithasfire://challenge?${LONG_TOKEN}`),
      );
      expect(result).toEqual({
        kind: "malformed",
        shape: { scheme: "ithasfire", queryKeys: ["<302 chars>"] },
      });
      expect(JSON.stringify(result)).not.toContain("0.xxxx");
    });

    it("keeps a key of exactly the limit", () => {
      const key = "k".repeat(MAX_REPORTED_KEY_LENGTH);
      expect(
        readChallengeRedirect(success(`ithasfire://challenge?${key}=1`)),
      ).toEqual({
        kind: "malformed",
        shape: { scheme: "ithasfire", queryKeys: [key] },
      });
    });

    it("caps the list at 10 keys, on the decoded and the raw path", () => {
      const pairs = Array.from({ length: 15 }, (_, i) => `k${i}=1`).join("&");
      const decoded = readChallengeRedirect(
        success(`ithasfire://challenge?${pairs}`),
      );
      const raw = readChallengeRedirect(
        success(`ithasfire://challenge?${pairs}&bad=%E0%A4%A`),
      );
      for (const result of [decoded, raw]) {
        expect(result.kind).toBe("malformed");
        if (result.kind !== "malformed") continue;
        expect(result.shape.queryKeys).toHaveLength(MAX_REPORTED_KEYS);
        expect(result.shape.queryKeys[0]).toBe("k0");
      }
    });

    it("a token-as-key never reaches the reporter", async () => {
      const deps = challengedDeps(
        success(`ithasfire://challenge?${LONG_TOKEN}`),
      );
      await submitEventPassword(INPUT, deps);
      expect(deps.reportError).toHaveBeenCalledTimes(1);
      expect(serialized(deps.reportError)).not.toContain("0.xxxx");
    });
  });

  it("prefers turnstileError=unavailable", () => {
    expect(
      readChallengeRedirect(
        success("ithasfire://challenge?turnstileError=unavailable"),
      ),
    ).toEqual({
      kind: "unavailable",
      shape: { scheme: "ithasfire", queryKeys: ["turnstileError"] },
    });
  });

  it.each(["cancel", "dismiss", "locked", "opened"])(
    "treats %s as cancelled",
    (type) => {
      expect(readChallengeRedirect({ type })).toEqual({ kind: "cancelled" });
    },
  );

  it("treats a success without a token as malformed", () => {
    expect(readChallengeRedirect(success("ithasfire://challenge"))).toEqual({
      kind: "malformed",
      shape: { scheme: "ithasfire", queryKeys: [] },
    });
    expect(
      readChallengeRedirect(success("ithasfire://challenge?turnstileToken=")),
    ).toEqual({
      kind: "malformed",
      shape: { scheme: "ithasfire", queryKeys: ["turnstileToken"] },
    });
  });
});

describe("isPasswordChallengeError", () => {
  it("matches only the challenge appCode", () => {
    expect(isPasswordChallengeError(challengeError())).toBe(true);
    expect(isPasswordChallengeError(trpcError({ code: "FORBIDDEN" }))).toBe(
      false,
    );
    expect(isPasswordChallengeError(new Error("x"))).toBe(false);
    expect(isPasswordChallengeError(null)).toBe(false);
  });
});

describe("submitEventPassword", () => {
  it("unlocks without opening the browser when no challenge is asked", async () => {
    const deps = makeDeps();
    await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
      kind: "unlocked",
    });
    expect(deps.validate).toHaveBeenCalledTimes(1);
    expect(deps.validate).toHaveBeenCalledWith(INPUT);
    expect(deps.openChallenge).not.toHaveBeenCalled();
  });

  it("opens the browser at the challenge URL when the server asks", async () => {
    const deps = challengedDeps({ type: "cancel" });
    await submitEventPassword(INPUT, deps);
    expect(deps.openChallenge).toHaveBeenCalledTimes(1);
    expect(deps.openChallenge).toHaveBeenCalledWith(
      "https://ithasfire.com/challenge/turnstile?return=ithasfire%3A%2F%2Fchallenge",
      RETURN_URL,
    );
  });

  it("resubmits the same password with the token and unlocks, reporting nothing", async () => {
    const validate = vi
      .fn()
      .mockRejectedValueOnce(challengeError())
      .mockResolvedValueOnce({ unlocked: true });
    const deps = challengedDeps(
      success(`ithasfire://challenge?turnstileToken=${SECRET}`),
      { validate },
    );
    await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
      kind: "unlocked",
    });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenNthCalledWith(2, {
      ...INPUT,
      turnstileToken: SECRET,
    });
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("reports a wrong password after a passed check", async () => {
    const deps = challengedDeps(
      success("ithasfire://challenge?turnstileToken=tok-1"),
      {
        validate: vi
          .fn()
          .mockRejectedValueOnce(challengeError())
          .mockResolvedValueOnce({ unlocked: false }),
      },
    );
    await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
      kind: "wrong-password",
    });
  });

  it.each(["cancel", "dismiss"])(
    "on %s, tells the user how to continue, does not resubmit or report",
    async (type) => {
      const deps = challengedDeps({ type });
      const outcome = await submitEventPassword(INPUT, deps);
      expect(outcome).toEqual({ kind: "challenge-cancelled" });
      expect(deps.validate).toHaveBeenCalledTimes(1);
      expect(deps.reportError).not.toHaveBeenCalled();
      expect(noticeForOutcome(outcome)).toEqual({
        tone: "info",
        text: 'Tap "Unlock event" to open a quick security check.',
      });
    },
  );

  it("the cancel copy names the sheet's CTA exactly", () => {
    expect(PASSWORD_COPY.challengeNeeded).toContain(
      `Tap "${PASSWORD_COPY.unlockCta}" `,
    );
    expect(PASSWORD_COPY.unlockCta).toBe("Unlock event");
  });

  describe("turnstileError=unavailable", () => {
    const url = `ithasfire://challenge?turnstileError=unavailable&turnstileToken=${SECRET}`;

    it("shows the unavailable copy and does not resubmit", async () => {
      const deps = challengedDeps(success(url));
      const outcome = await submitEventPassword(INPUT, deps);
      expect(outcome).toEqual({ kind: "challenge-unavailable" });
      expect(deps.validate).toHaveBeenCalledTimes(1);
      expect(noticeForOutcome(outcome)).toEqual({
        tone: "danger",
        text: PASSWORD_COPY.challengeUnavailable,
      });
    });

    it("reports with reason `unavailable` and never the token", async () => {
      const deps = challengedDeps(success(url));
      await submitEventPassword(INPUT, deps);
      expect(deps.reportError).toHaveBeenCalledTimes(1);
      expect(deps.reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "event_password_challenge_unavailable",
        }),
        {
          tags: { feature: "event-password-challenge", reason: "unavailable" },
          extra: {
            scheme: "ithasfire",
            queryKeys: ["turnstileError", "turnstileToken"],
          },
        },
      );
      expect(serialized(deps.reportError)).not.toContain(SECRET);
    });

    it("a throwing reporter doesn't change the outcome", async () => {
      const deps = challengedDeps(success(url), {
        reportError: vi.fn(() => {
          throw new Error("reporter down");
        }),
      });
      await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
        kind: "challenge-unavailable",
      });
    });
  });

  describe("malformed redirect (web/app URL contract drift)", () => {
    // A renamed key: the token is present but the app can't find it.
    const url = `ithasfire://challenge?turnstile_token=${SECRET}`;

    it("fails without resubmitting", async () => {
      const deps = challengedDeps(success(url));
      const outcome = await submitEventPassword(INPUT, deps);
      expect(outcome).toEqual({ kind: "challenge-failed" });
      expect(deps.validate).toHaveBeenCalledTimes(1);
      expect(noticeForOutcome(outcome)?.text).toBe(
        PASSWORD_COPY.challengeFailed,
      );
    });

    it("reports with reason `malformed_redirect`, key names only", async () => {
      const deps = challengedDeps(success(url));
      await submitEventPassword(INPUT, deps);
      expect(deps.reportError).toHaveBeenCalledTimes(1);
      expect(deps.reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "event_password_challenge_malformed_redirect",
        }),
        {
          tags: {
            feature: "event-password-challenge",
            reason: "malformed_redirect",
          },
          extra: { scheme: "ithasfire", queryKeys: ["turnstile_token"] },
        },
      );
      expect(serialized(deps.reportError)).not.toContain(SECRET);
    });

    it("reports a redirect with no query at all", async () => {
      const deps = challengedDeps(success(RETURN_URL));
      await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
        kind: "challenge-failed",
      });
      expect(deps.reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: {
          feature: "event-password-challenge",
          reason: "malformed_redirect",
        },
        extra: { scheme: "ithasfire", queryKeys: [] },
      });
    });

    it("a throwing reporter doesn't change the outcome", async () => {
      const deps = challengedDeps(success(url), {
        reportError: vi.fn(() => {
          throw new Error("reporter down");
        }),
      });
      await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
        kind: "challenge-failed",
      });
    });
  });

  it("treats a browser that throws as unavailable and reports it", async () => {
    const boom = new Error("WebBrowser is already open");
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    const deps = makeDeps({
      validate: vi.fn().mockRejectedValue(challengeError()),
      openChallenge: vi.fn().mockRejectedValue(boom),
      reportError,
    });
    await expect(submitEventPassword(INPUT, deps)).resolves.toEqual({
      kind: "challenge-unavailable",
    });
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { feature: "event-password-challenge", reason: "browser_threw" },
    });
  });

  it("does not reopen the browser when the token is rejected", async () => {
    const deps = challengedDeps(
      success("ithasfire://challenge?turnstileToken=stale"),
    );
    const outcome = await submitEventPassword(INPUT, deps);
    expect(outcome).toEqual({ kind: "challenge-failed" });
    expect(deps.openChallenge).toHaveBeenCalledTimes(1);
    expect(deps.validate).toHaveBeenCalledTimes(2);
    expect(noticeForOutcome(outcome)).toEqual({
      tone: "danger",
      text: PASSWORD_COPY.challengeFailed,
    });
  });

  it("surfaces a non-challenge error from the resubmit as an error", async () => {
    const limited = trpcError({ code: "TOO_MANY_REQUESTS" });
    const validate = vi
      .fn()
      .mockRejectedValueOnce(challengeError())
      .mockRejectedValueOnce(limited);
    const deps = challengedDeps(
      success("ithasfire://challenge?turnstileToken=tok"),
      { validate },
    );
    const outcome = await submitEventPassword(INPUT, deps);
    expect(outcome).toEqual({ kind: "error", error: limited });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(noticeForOutcome(outcome)?.text).toBe(PASSWORD_COPY.tooManyAttempts);
  });

  describe("other errors are unchanged", () => {
    it.each([
      [{ code: "TOO_MANY_REQUESTS" }, PASSWORD_COPY.tooManyAttempts],
      [{ code: "BAD_REQUEST" }, PASSWORD_COPY.wrongPassword],
      [{ code: "FORBIDDEN" }, PASSWORD_COPY.generic],
      [{ code: "INTERNAL_SERVER_ERROR" }, PASSWORD_COPY.generic],
    ])("%o → %s, no browser", async (data, text) => {
      const err = trpcError(data);
      const deps = makeDeps({ validate: vi.fn().mockRejectedValue(err) });
      const outcome = await submitEventPassword(INPUT, deps);
      expect(outcome).toEqual({ kind: "error", error: err });
      expect(deps.openChallenge).not.toHaveBeenCalled();
      expect(noticeForOutcome(outcome)).toEqual({ tone: "danger", text });
    });

    it("unlocked: false → wrong-password copy", async () => {
      const deps = makeDeps({
        validate: vi.fn().mockResolvedValue({ unlocked: false }),
      });
      const outcome = await submitEventPassword(INPUT, deps);
      expect(noticeForOutcome(outcome)).toEqual({
        tone: "danger",
        text: PASSWORD_COPY.wrongPassword,
      });
    });

    it("a network error with no data → generic copy", async () => {
      const deps = makeDeps({
        validate: vi
          .fn()
          .mockRejectedValue(new TypeError("Network request failed")),
      });
      const outcome = await submitEventPassword(INPUT, deps);
      expect(noticeForOutcome(outcome)?.text).toBe(PASSWORD_COPY.generic);
    });
  });
});
