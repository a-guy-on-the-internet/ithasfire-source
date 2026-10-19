import { describe, expect, it } from "vitest";

import {
  EMBED_AUTH_MESSAGE_TYPE,
  isEmbedAuthTokenMessage,
} from "../embed-auth-handoff";

describe("isEmbedAuthTokenMessage", () => {
  it("accepts a valid payload", () => {
    expect(
      isEmbedAuthTokenMessage({ type: EMBED_AUTH_MESSAGE_TYPE, token: "abc.def.ghi" }),
    ).toBe(true);
  });

  it("accepts a valid payload with extra fields (extras are ignored, not trusted)", () => {
    expect(
      isEmbedAuthTokenMessage({
        type: EMBED_AUTH_MESSAGE_TYPE,
        token: "abc",
        extra: "field",
      }),
    ).toBe(true);
  });

  it("rejects a wrong type", () => {
    expect(
      isEmbedAuthTokenMessage({ type: "hf:something-else", token: "abc" }),
    ).toBe(false);
    expect(isEmbedAuthTokenMessage({ type: 42, token: "abc" })).toBe(false);
    expect(isEmbedAuthTokenMessage({ token: "abc" })).toBe(false);
  });

  it("rejects a non-string token", () => {
    expect(
      isEmbedAuthTokenMessage({ type: EMBED_AUTH_MESSAGE_TYPE, token: 123 }),
    ).toBe(false);
    expect(
      isEmbedAuthTokenMessage({ type: EMBED_AUTH_MESSAGE_TYPE, token: null }),
    ).toBe(false);
    expect(
      isEmbedAuthTokenMessage({
        type: EMBED_AUTH_MESSAGE_TYPE,
        token: { nested: true },
      }),
    ).toBe(false);
    expect(isEmbedAuthTokenMessage({ type: EMBED_AUTH_MESSAGE_TYPE })).toBe(
      false,
    );
  });

  it("rejects an empty token", () => {
    expect(
      isEmbedAuthTokenMessage({ type: EMBED_AUTH_MESSAGE_TYPE, token: "" }),
    ).toBe(false);
  });

  it("rejects an oversized token (> 8192 chars)", () => {
    expect(
      isEmbedAuthTokenMessage({
        type: EMBED_AUTH_MESSAGE_TYPE,
        token: "a".repeat(8193),
      }),
    ).toBe(false);
    // Boundary: exactly 8192 is still accepted.
    expect(
      isEmbedAuthTokenMessage({
        type: EMBED_AUTH_MESSAGE_TYPE,
        token: "a".repeat(8192),
      }),
    ).toBe(true);
  });

  it("rejects null, primitives, and arrays", () => {
    expect(isEmbedAuthTokenMessage(null)).toBe(false);
    expect(isEmbedAuthTokenMessage(undefined)).toBe(false);
    expect(isEmbedAuthTokenMessage("hf:auth-token")).toBe(false);
    expect(isEmbedAuthTokenMessage(42)).toBe(false);
    expect(isEmbedAuthTokenMessage(true)).toBe(false);
    expect(
      isEmbedAuthTokenMessage([EMBED_AUTH_MESSAGE_TYPE, "token"]),
    ).toBe(false);
  });
});
