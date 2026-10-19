import { describe, expect, it } from "vitest";

import {
  getSafeExternalHref,
  getSafeMailtoHref,
  getSafeTelHref,
} from "../safe-block-url";

describe("safe block URLs", () => {
  it("allows only http and https external hrefs", () => {
    expect(getSafeExternalHref("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(getSafeExternalHref(" http://example.com ")).toBe(
      "http://example.com",
    );
    expect(getSafeExternalHref("javascript:alert(1)")).toBeUndefined();
    expect(
      getSafeExternalHref("data:text/html,<script>alert(1)</script>"),
    ).toBeUndefined();
    expect(getSafeExternalHref("/relative/path")).toBeUndefined();
    expect(getSafeExternalHref(123)).toBeUndefined();
  });

  it("allows basic emails and rejects mailto query injection", () => {
    expect(getSafeMailtoHref("artist@example.com")).toBe(
      "mailto:artist@example.com",
    );
    expect(
      getSafeMailtoHref("artist@example.com?cc=bad@example.com"),
    ).toBeUndefined();
    expect(
      getSafeMailtoHref("artist@example.com%0AReply-To:bad@example.com"),
    ).toBeUndefined();
    expect(getSafeMailtoHref("not-an-email")).toBeUndefined();
  });

  it("allows conservative telephone hrefs", () => {
    expect(getSafeTelHref("+1 (555) 123-4567")).toBe("tel:+15551234567");
    expect(getSafeTelHref("555.123.4567")).toBe("tel:5551234567");
    expect(getSafeTelHref("tel:5551234567")).toBeUndefined();
    expect(getSafeTelHref("555<script>")).toBeUndefined();
  });
});
