import { describe, expect, it } from "vitest";

import { redactDeep } from "../utils";

const redact = (text: string) => text.replace(/\d{7}/g, "[redacted]");

describe("redactDeep", () => {
  it("leaves null and other primitives unchanged", () => {
    expect(redactDeep({ a: null, b: 5, c: true }, redact)).toEqual({
      a: null,
      b: 5,
      c: true,
    });
  });

  it("redacts nested objects, arrays and Errors", () => {
    const out = redactDeep(
      {
        deep: { text: "call 5550100" },
        list: ["5550100", { x: "5550100" }],
        err: new Error("boom 5550100"),
      },
      redact,
    );
    expect(JSON.stringify(out)).not.toContain("5550100");
    expect(out).toMatchObject({
      deep: { text: "call [redacted]" },
      err: { name: "Error", message: "boom [redacted]" },
    });
  });

  it("keeps requestId and name as they are", () => {
    expect(
      redactDeep(
        { requestId: "a5550100b", name: "5550100", m: "5550100" },
        redact,
      ),
    ).toEqual({ requestId: "a5550100b", name: "5550100", m: "[redacted]" });
  });

  it("turns a Date into its ISO string and other objects into [object]", () => {
    const out = redactDeep(
      {
        at: new Date("2026-10-17T00:00:00.000Z"),
        buf: Buffer.from("5550100"),
        set: new Set(["5550100"]),
        map: new Map([["k", "5550100"]]),
      },
      redact,
    );
    expect(out).toEqual({
      at: "2026-10-17T00:00:00.000Z",
      buf: "[object]",
      set: "[object]",
      map: "[object]",
    });
  });

  it("ends a cycle in [truncated]", () => {
    const loop: Record<string, unknown> = { text: "5550100" };
    loop.self = loop;
    const out = JSON.stringify(redactDeep(loop, redact));
    expect(out).toContain("[truncated]");
    expect(out).not.toContain("5550100");
  });

  it("does not mutate its input", () => {
    const input = { a: { b: "5550100" }, list: ["5550100"] };
    redactDeep(input, redact);
    expect(input).toEqual({ a: { b: "5550100" }, list: ["5550100"] });
  });
});
