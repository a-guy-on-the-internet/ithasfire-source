/**
 * The open-redirect guard for `/challenge/turnstile?return=`. Whatever this
 * accepts is navigated to with a live Turnstile token attached, so the tests
 * lean on the reject side.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_RETURN_LENGTH,
  appendReturnParam,
  parseChallengeReturn,
} from "../return-url";

const PROD = { production: true } as const;
const DEV = { production: false } as const;

describe("parseChallengeReturn — accepted", () => {
  it.each([
    "ithasfire://challenge",
    "ithasfire://challenge/turnstile",
    "ithasfire://challenge?eventId=abc",
    "ithasfire:///challenge",
    "ithasfire://events/some-slug/unlock?a=1&b=2",
    "ithasfire://challenge?next=%2Fevents%2Fx",
    // Look-alike keys are not the result params.
    "ithasfire://challenge?turnstileTokenX=1&xturnstileError=2",
    "ithasfire://challenge?TurnstileToken=1",
    // Well-formed escapes and query shapes the app's parser also reads.
    "ithasfire://challenge?city=%E2%82%AC",
    "ithasfire://challenge?a=1&&b=2",
    "ithasfire://challenge?a=b=c",
    "ithasfire://challenge?flag",
    "ithasfire://challenge?",
    "ithasfire://challenge?q=a+b%20c",
  ])("app scheme %s in production AND dev", (raw) => {
    expect(parseChallengeReturn(raw, PROD)).toBe(raw);
    expect(parseChallengeReturn(raw, DEV)).toBe(raw);
  });

  it.each([
    "exp://192.168.1.5:8081/--/challenge",
    "exp://u.expo.dev/abc/--/challenge?x=1",
    "exp+ithasfire://expo-development-client/--/challenge",
  ])("Expo dev URL %s outside production only", (raw) => {
    expect(parseChallengeReturn(raw, DEV)).toBe(raw);
    expect(parseChallengeReturn(raw, PROD)).toBeNull();
  });

  it("refuses an Expo dev URL with a malformed escape even outside production", () => {
    expect(
      parseChallengeReturn("exp://192.168.1.5:8081/--/challenge?x=%ZZ", DEV),
    ).toBeNull();
  });

  it("accepts exactly the cap", () => {
    const raw = `ithasfire://c?p=${"a".repeat(MAX_RETURN_LENGTH - "ithasfire://c?p=".length)}`;
    expect(raw).toHaveLength(MAX_RETURN_LENGTH);
    expect(parseChallengeReturn(raw, PROD)).toBe(raw);
  });

  it("defaults to the build's NODE_ENV (vitest = not production)", () => {
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(parseChallengeReturn("exp://x/--/c")).toBe("exp://x/--/c");
  });
});

describe("parseChallengeReturn — refused", () => {
  it.each<[string, unknown]>([
    ["missing", undefined],
    ["empty", ""],
    ["repeated param", ["ithasfire://a", "ithasfire://b"]],
    ["single-element array", ["ithasfire://a"]],
  ])("%s", (_label, raw) => {
    expect(
      parseChallengeReturn(raw as string | string[] | undefined, DEV),
    ).toBeNull();
  });

  it.each([
    // Web and script schemes
    "https://evil.example/collect",
    "http://evil.example",
    "HTTPS://evil.example",
    "javascript:alert(1)",
    "javascript://ithasfire://%0aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "intent://evil#Intent;scheme=https;end",
    // Protocol-relative and path-only
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/challenge",
    "challenge",
    // Look-alikes of the allowed prefixes
    "ithasfire:/challenge",
    "ithasfire:challenge",
    "ithasfire//challenge",
    "ithasfire:\\\\challenge",
    "ithasfire.evil://challenge",
    "ithasfirex://challenge",
    "xithasfire://challenge",
    "ithas-fire://challenge",
    "ITHASFIRE://challenge",
    "Ithasfire://challenge",
    "https://ithasfire://challenge",
    "https://ithasfire.com/challenge",
    "exp+evil://x",
    // The dev client's own scheme (slug `mobile`) is not in the contract;
    // dev-client builds send `ithasfire://` anyway.
    "exp+mobile://expo-development-client/--/challenge",
    "expo://x",
    // Scheme alone is not a destination
    "ithasfire://",
    // A fragment would swallow the appended token query
    "ithasfire://challenge#frag",
    "ithasfire://challenge?x=1#frag",
    // A pre-seeded result: the app would receive a token this page never
    // minted. Keys are matched DECODED, so percent-encoded spellings count.
    "ithasfire://challenge?turnstileToken=forged",
    "ithasfire://challenge?eventId=e1&turnstileToken=forged",
    "ithasfire://challenge?turnstileToken",
    "ithasfire://challenge?%74urnstileToken=forged",
    "ithasfire://challenge?turnstile%54oken=forged",
    "ithasfire://challenge?turnstileError=unavailable",
    "ithasfire://challenge?a=1&turnstileError",
    "ithasfire://challenge?%74urnstileError=unavailable",
    // A malformed percent-escape anywhere in the query: URLSearchParams keeps
    // it, but the app's parser refuses the whole link, so the minted token
    // would be wasted.
    "ithasfire://challenge?x=%ZZ",
    "ithasfire://challenge?x=%",
    "ithasfire://challenge?x=50%",
    "ithasfire://challenge?x=%2",
    "ithasfire://challenge?%ZZ=1",
    "ithasfire://challenge?%ZZ",
    "ithasfire://challenge?%",
    "ithasfire://challenge?eventId=e1&x=%ZZ",
    "ithasfire://challenge?x=%ZZ&eventId=e1",
    // Escapes that are well-formed hex but not valid UTF-8.
    "ithasfire://challenge?x=%E2%82",
    "ithasfire://challenge?x=%C0%AF",
    "ithasfire://challenge?x=%FF",
  ])("%s", (raw) => {
    expect(parseChallengeReturn(raw, DEV)).toBeNull();
    expect(parseChallengeReturn(raw, PROD)).toBeNull();
  });

  it.each([
    [" leading space", " ithasfire://challenge"],
    ["trailing space", "ithasfire://challenge "],
    ["inner space", "ithasfire://chal lenge"],
    ["leading tab", "\tithasfire://challenge"],
    ["newline in scheme (URL would strip it)", "ithas\nfire://challenge"],
    ["CR in host", "ithasfire://chal\rlenge"],
    ["tab in scheme", "java\tscript:alert(1)"],
    ["NUL", "ithasfire://challenge\u0000"],
    ["DEL", "ithasfire://challenge\u007f"],
    ["C1 control", "ithasfire://challenge\u0085"],
    ["zero-width space", "​ithasfire://challenge"],
    ["BOM", "﻿ithasfire://challenge"],
    ["right-to-left override", "ithasfire://‮challenge"],
    ["non-breaking space", " ithasfire://challenge"],
    ["fullwidth colon", "ithasfire：//challenge"],
    ["non-ASCII letter", "ithasfıre://challenge"],
    ["backslash", "ithasfire://challenge\\x"],
  ])("%s", (_label, raw) => {
    expect(parseChallengeReturn(raw, DEV)).toBeNull();
    expect(parseChallengeReturn(raw, PROD)).toBeNull();
  });

  it("refuses one past the cap, and far past it", () => {
    const over = `ithasfire://c?p=${"a".repeat(MAX_RETURN_LENGTH + 1 - "ithasfire://c?p=".length)}`;
    expect(over).toHaveLength(MAX_RETURN_LENGTH + 1);
    expect(parseChallengeReturn(over, DEV)).toBeNull();
    expect(
      parseChallengeReturn(`ithasfire://${"a".repeat(100_000)}`, DEV),
    ).toBeNull();
  });
});

describe("appendReturnParam", () => {
  it("starts a query when there is none", () => {
    expect(appendReturnParam("ithasfire://challenge", "turnstileToken", "t")).toBe(
      "ithasfire://challenge?turnstileToken=t",
    );
  });

  it("extends an existing query with &", () => {
    expect(
      appendReturnParam("ithasfire://challenge?eventId=e1", "turnstileToken", "t"),
    ).toBe("ithasfire://challenge?eventId=e1&turnstileToken=t");
  });

  it("percent-encodes the value", () => {
    expect(
      appendReturnParam("ithasfire://c", "turnstileToken", "a+b/c=d&e f"),
    ).toBe("ithasfire://c?turnstileToken=a%2Bb%2Fc%3Dd%26e%20f");
  });
});
