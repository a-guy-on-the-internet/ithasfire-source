import { describe, expect, it } from "vitest";
import { AppError } from "@th/errors";

import { resolveWebhookAppCode } from "../src/lib/webhook-app-code";

describe("resolveWebhookAppCode", () => {
  it("returns the code of an AppError directly", () => {
    expect(resolveWebhookAppCode(new AppError("ORDER_NOT_FOUND"))).toBe(
      "ORDER_NOT_FOUND",
    );
  });

  it("maps a use-case object's legacy snake_case `code`", () => {
    expect(resolveWebhookAppCode({ code: "event_not_found" })).toBe(
      "EVENT_NOT_FOUND",
    );
  });

  it("falls back to the snake_case domain code on `message` when `code` does not map", () => {
    expect(
      resolveWebhookAppCode({ code: "TRANSIENT_DB", message: "order_not_found" }),
    ).toBe("ORDER_NOT_FOUND");
  });

  it("prefers a mapping `code` over `message`", () => {
    expect(
      resolveWebhookAppCode({ code: "conflict", message: "order_not_found" }),
    ).toBe("CONFLICT");
  });

  it("returns null for opaque errors (plain Error, unknown tokens)", () => {
    expect(resolveWebhookAppCode(new Error("connect ECONNREFUSED"))).toBeNull();
    expect(resolveWebhookAppCode({ code: "totally_made_up" })).toBeNull();
    expect(resolveWebhookAppCode("boom")).toBeNull();
    expect(resolveWebhookAppCode(undefined)).toBeNull();
  });
});
