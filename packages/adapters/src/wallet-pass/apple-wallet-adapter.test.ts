import { describe, it, expect, vi, afterEach } from "vitest";
import forge from "node-forge";
import {
  APPLE_WWDR_G4_PEM,
  fetchWalletImage,
} from "./apple-wallet-adapter.js";

/**
 * Regression guard for a bug that silently disabled Apple Wallet entirely.
 *
 * The embedded WWDR G4 blob was one base64 character short. It looked fine on
 * inspection — right header, right footer, right line count — but failed to
 * parse, so every `.pkpass` generation threw "Too few bytes to parse DER."
 *
 * Nothing caught it: the constant was never parsed in a test, and the failure
 * only reproduces once a real signing certificate is configured (without one,
 * `dep.ts` wires the stub adapter and the code path never runs).
 */
describe("APPLE_WWDR_G4_PEM", () => {
  it("parses as a valid X.509 certificate", () => {
    expect(() => forge.pki.certificateFromPem(APPLE_WWDR_G4_PEM)).not.toThrow();
  });

  it("is Apple's Worldwide Developer Relations G4 intermediate", () => {
    const cert = forge.pki.certificateFromPem(APPLE_WWDR_G4_PEM);
    const cn = cert.subject.getField("CN")?.value as string | undefined;
    const ou = cert.subject.getField("OU")?.value as string | undefined;

    expect(cn).toBe(
      "Apple Worldwide Developer Relations Certification Authority",
    );
    expect(ou).toBe("G4");
    // Issued by the original Apple Root CA — not Apple Root CA - G3.
    expect(cert.issuer.getField("CN")?.value).toBe("Apple Root CA");
  });

  it("has not expired", () => {
    const cert = forge.pki.certificateFromPem(APPLE_WWDR_G4_PEM);
    const now = new Date();

    expect(cert.validity.notBefore.getTime()).toBeLessThan(now.getTime());
    // Fails once Apple's G4 intermediate lapses (2030-12-10). When that
    // happens the fix is to re-download the replacement intermediate, not to
    // relax this assertion — passes signed against an expired chain are
    // rejected by iOS.
    expect(cert.validity.notAfter.getTime()).toBeGreaterThan(now.getTime());
  });
});

/**
 * The wallet image is the ONLY network call in pass generation, which was
 * otherwise a purely local operation. Every one of these paths must yield a
 * valid artwork-free pass rather than an error: a holder losing access to
 * their ticket because a CDN blinked is far worse than a ticket with no
 * picture on it. So the contract under test is "never throws, returns null".
 *
 * See `docs/specs/2026-09-07/wallet-pass-image.spec.yaml` (FR-005, NFR-001).
 */
describe("fetchWalletImage", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  /**
   * Node pools small Buffers, so `buf.buffer` is the whole shared pool rather
   * than these bytes — `.buffer.slice(0)` hands back megabytes of unrelated
   * (usually zeroed) memory and the fixture silently stops representing what
   * it claims to. Slice by the view's own offset instead.
   */
  const asArrayBuffer = (b: Buffer): ArrayBuffer =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the bytes for an https PNG", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => asArrayBuffer(PNG),
      }),
    );

    const out = await fetchWalletImage("https://cdn.example.com/a.png");
    expect(out).toBeInstanceOf(Buffer);
    expect(out?.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("refuses a non-https URL without making a request (SSRF guard)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const logger = makeLogger();

    const out = await fetchWalletImage("http://169.254.169.254/latest", logger);

    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "apple-wallet.thumbnail.rejected_scheme",
      expect.objectContaining({ protocol: "http:" }),
    );
  });

  it("returns null on a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    const logger = makeLogger();

    expect(await fetchWalletImage("https://cdn.example.com/a.png", logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "apple-wallet.thumbnail.fetch_failed",
      expect.objectContaining({ status: 404 }),
    );
  });

  it("rejects a payload that is not a PNG", async () => {
    const notPng = Buffer.from("<!doctype html><html>404</html>");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => asArrayBuffer(notPng),
      }),
    );
    const logger = makeLogger();

    expect(await fetchWalletImage("https://cdn.example.com/a.png", logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "apple-wallet.thumbnail.not_png",
      expect.objectContaining({ url: "https://cdn.example.com/a.png" }),
    );
  });

  it("swallows a thrown fetch (timeout / DNS) and reports at error level", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), {
          name: "TimeoutError",
        }),
      ),
    );
    const logger = makeLogger();

    expect(await fetchWalletImage("https://cdn.example.com/a.png", logger)).toBeNull();
    // error, NOT warn — warn is not captured by Sentry's pinoIntegration, so a
    // silently artwork-less pass would go unnoticed (see CLAUDE.md).
    expect(logger.error).toHaveBeenCalledWith(
      "apple-wallet.thumbnail.fetch_threw",
      expect.objectContaining({ url: "https://cdn.example.com/a.png" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never throws, even on a malformed URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchWalletImage("not-a-url")).resolves.toBeNull();
  });

  it("tolerates having no logger at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(
      fetchWalletImage("https://cdn.example.com/a.png"),
    ).resolves.toBeNull();
  });
});
