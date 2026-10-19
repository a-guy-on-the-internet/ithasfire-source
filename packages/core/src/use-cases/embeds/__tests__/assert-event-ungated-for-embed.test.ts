import { describe, expect, it } from "vitest";

import {
  assertEventUngatedForEmbed,
  embedGateTypeOf,
  isEventUngatedForEmbed,
} from "../_shared/assert-event-ungated-for-embed";

describe("assertEventUngatedForEmbed", () => {
  it("passes an ungated (NONE) event", () => {
    expect(() => assertEventUngatedForEmbed({ gateType: "NONE" })).not.toThrow();
    expect(isEventUngatedForEmbed({ gateType: "NONE" })).toBe(true);
  });

  it.each(["PASSWORD", "APPLICATION"])(
    "refuses a %s event with EVENT_GATED",
    (gateType) => {
      expect(() => assertEventUngatedForEmbed({ gateType })).toThrow(
        expect.objectContaining({ code: "EVENT_GATED" }),
      );
      expect(isEventUngatedForEmbed({ gateType })).toBe(false);
    },
  );

  it.each([
    ["missing", {}],
    ["null", { gateType: null }],
    ["an unknown value", { gateType: "INVITE" }],
    ["lowercase none", { gateType: "none" }],
  ])("fails closed on a %s gate", (_label, event) => {
    expect(() => assertEventUngatedForEmbed(event)).toThrow(
      expect.objectContaining({ code: "EVENT_GATED" }),
    );
  });
});

describe("embedGateTypeOf", () => {
  it.each(["NONE", "PASSWORD", "APPLICATION"] as const)(
    "reports %s as itself",
    (gateType) => {
      expect(embedGateTypeOf({ gateType })).toBe(gateType);
    },
  );

  it("reports a missing or unknown gate as PASSWORD (gated), never NONE", () => {
    expect(embedGateTypeOf({})).toBe("PASSWORD");
    expect(embedGateTypeOf({ gateType: null })).toBe("PASSWORD");
    expect(embedGateTypeOf({ gateType: "INVITE" })).toBe("PASSWORD");
  });
});
