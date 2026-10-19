import { describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

import { assertEmbedOriginAllowed } from "../_shared/assert-embed-origin-allowed";

const EMBED_ID = "00000000-0000-4000-8000-0000000000e0";

const embed = (domain = "shop.example.com") => ({ id: EMBED_ID, domain });

function warnSpyLogger() {
  const warn = vi.fn();
  const logger = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTime: vi.fn(),
  } as unknown as LoggerPort;
  return { logger, warn };
}

/** Run the guard and assert it threw EMBED_ORIGIN_NOT_ALLOWED. */
function expectOriginRejected(fn: () => void) {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "expected assertEmbedOriginAllowed to throw").not.toBeNull();
  expect(thrown).toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
}

describe("assertEmbedOriginAllowed", () => {
  it("allows an exact hostname match", () => {
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed(),
        hostOrigin: "https://shop.example.com",
      }),
    ).not.toThrow();
  });

  it("matches a legacy stored domain that carries a scheme", () => {
    // Rows written before upsertEmbed normalized input may store the full
    // URL the organiser pasted — the guard coerces the stored side too.
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("https://example.com"),
        hostOrigin: "https://example.com",
      }),
    ).not.toThrow();
  });

  it("matches a legacy stored domain with a path / trailing slash", () => {
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("example.com/tickets/"),
        hostOrigin: "https://example.com",
      }),
    ).not.toThrow();
  });

  it("rejects when the stored domain cannot yield a hostname", () => {
    const { logger, warn } = warnSpyLogger();
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({
        embed: embed("not a domain at all"),
        hostOrigin: "https://example.com",
        logger,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "embed.originRejected",
      expect.objectContaining({ reason: "stored_domain_unparseable" }),
    );
  });

  it("ignores the origin's port (allowlist is hostname-only)", () => {
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("localhost"),
        hostOrigin: "http://localhost:8080",
      }),
    ).not.toThrow();
  });

  it("treats www.X and X as equivalent — www origin against bare domain", () => {
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("shop.example.com"),
        hostOrigin: "https://www.shop.example.com",
      }),
    ).not.toThrow();
  });

  it("treats www.X and X as equivalent — bare origin against www domain", () => {
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("www.shop.example.com"),
        hostOrigin: "https://shop.example.com",
      }),
    ).not.toThrow();
  });

  it("compares hostnames case-insensitively", () => {
    // URL() lowercases hostnames itself, but the stored domain may not be.
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("Shop.Example.COM"),
        hostOrigin: "https://SHOP.EXAMPLE.com",
      }),
    ).not.toThrow();
  });

  it("always allows our own web origin (admin preview / direct viewing)", () => {
    expect(() =>
      assertEmbedOriginAllowed({
        embed: embed("shop.example.com"),
        hostOrigin: "http://localhost:3000",
        publicAppUrl: "http://localhost:3000",
      }),
    ).not.toThrow();
  });

  it("does not apply the own-origin allowance when publicAppUrl is absent", () => {
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({
        embed: embed("shop.example.com"),
        hostOrigin: "http://localhost:3000",
      }),
    );
  });

  it("rejects a null hostOrigin (fail closed) and logs a structured warn", () => {
    const { logger, warn } = warnSpyLogger();
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({ embed: embed(), hostOrigin: null, logger }),
    );
    expect(warn).toHaveBeenCalledWith(
      "embed.originRejected",
      expect.objectContaining({
        embedId: EMBED_ID,
        hostOrigin: null,
        reason: "missing_host_origin",
      }),
    );
  });

  it("rejects an undefined hostOrigin (fail closed)", () => {
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({ embed: embed(), hostOrigin: undefined }),
    );
  });

  it("rejects an unparseable hostOrigin", () => {
    const { logger, warn } = warnSpyLogger();
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({
        embed: embed(),
        hostOrigin: "not a url",
        logger,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "embed.originRejected",
      expect.objectContaining({ reason: "unparseable_host_origin" }),
    );
  });

  it('rejects the literal "null" opaque origin', () => {
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({ embed: embed(), hostOrigin: "null" }),
    );
  });

  it("rejects a mismatched hostname and logs a structured warn", () => {
    const { logger, warn } = warnSpyLogger();
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({
        embed: embed("shop.example.com"),
        hostOrigin: "https://evil.example.net",
        publicAppUrl: "https://ithasfire.com",
        logger,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "embed.originRejected",
      expect.objectContaining({
        embedId: EMBED_ID,
        embedDomain: "shop.example.com",
        hostOrigin: "https://evil.example.net",
        reason: "host_origin_mismatch",
      }),
    );
  });

  it("rejects a subdomain of the allowlisted domain (exact match only)", () => {
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({
        embed: embed("example.com"),
        hostOrigin: "https://shop.example.com",
      }),
    );
  });

  it("rejects a suffix-crafted lookalike domain", () => {
    expectOriginRejected(() =>
      assertEmbedOriginAllowed({
        embed: embed("shop.example.com"),
        hostOrigin: "https://evil-shop.example.com",
      }),
    );
  });
});
