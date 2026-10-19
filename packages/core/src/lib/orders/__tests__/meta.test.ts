import { describe, it, expect } from "vitest";

import { getMetaString } from "../meta";

describe("getMetaString", () => {
  it("returns the string value for an existing key", () => {
    const meta = { ticketTypeName: "GA", seatId: "A12" };
    expect(getMetaString(meta, "ticketTypeName")).toBe("GA");
    expect(getMetaString(meta, "seatId")).toBe("A12");
  });

  it("returns undefined when the key does not exist", () => {
    const meta = { ticketTypeName: "GA" };
    expect(getMetaString(meta, "missing")).toBeUndefined();
  });

  it("returns undefined when the value is not a string", () => {
    const meta = { count: 42, flag: true, nested: { a: 1 } };
    expect(getMetaString(meta, "count")).toBeUndefined();
    expect(getMetaString(meta, "flag")).toBeUndefined();
    expect(getMetaString(meta, "nested")).toBeUndefined();
  });

  it("returns undefined when meta is null", () => {
    expect(getMetaString(null, "anything")).toBeUndefined();
  });

  it("returns undefined when meta is undefined", () => {
    expect(getMetaString(undefined, "anything")).toBeUndefined();
  });

  it("returns undefined when meta is a primitive", () => {
    expect(getMetaString("hello" as unknown, "anything")).toBeUndefined();
    expect(getMetaString(42 as unknown, "anything")).toBeUndefined();
  });
});
