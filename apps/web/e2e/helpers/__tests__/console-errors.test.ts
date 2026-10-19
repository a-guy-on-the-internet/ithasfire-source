import { describe, expect, it } from "vitest";

import { isHandledRefusalResource } from "../console-errors";

const line = (status: number, reason: string) =>
  `Failed to load resource: the server responded with a status of ${status} (${reason})`;
const API = "http://localhost:3001/trpc";
const deal = `${API}/deals.getTermsDeal?batch=1&input=%7B%7D`;

describe("isHandledRefusalResource", () => {
  it("exempts Chrome's line for a deal read with no deal to show", () => {
    expect(isHandledRefusalResource(line(409, "Conflict"), deal)).toBe(true);
    expect(isHandledRefusalResource(line(404, "Not Found"), deal)).toBe(true);
    expect(isHandledRefusalResource(line(403, "Forbidden"), deal)).toBe(true);
    // Two deal reads batched together fail together.
    expect(
      isHandledRefusalResource(
        line(409, "Conflict"),
        `${API}/deals.getTermsDeal,deals.getTermsDeal?batch=1`,
      ),
    ).toBe(true);
  });

  it("never exempts another procedure, or a batch that carries one", () => {
    expect(
      isHandledRefusalResource(
        line(409, "Conflict"),
        `${API}/orders.confirmPayment?batch=1`,
      ),
    ).toBe(false);
    expect(
      isHandledRefusalResource(
        line(409, "Conflict"),
        `${API}/deals.getTermsDeal,orders.list?batch=1`,
      ),
    ).toBe(false);
    expect(
      isHandledRefusalResource(
        line(409, "Conflict"),
        `${API}/deals.setTermsDeal?batch=1`,
      ),
    ).toBe(false);
  });

  it("never exempts a fault status, another message, or a missing source", () => {
    expect(
      isHandledRefusalResource(line(500, "Internal Server Error"), deal),
    ).toBe(false);
    expect(isHandledRefusalResource(line(401, "Unauthorized"), deal)).toBe(
      false,
    );
    expect(
      isHandledRefusalResource(
        "Hydration failed because the server rendered HTML didn't match the client",
        deal,
      ),
    ).toBe(false);
    expect(isHandledRefusalResource(line(409, "Conflict"), undefined)).toBe(
      false,
    );
    expect(isHandledRefusalResource(line(409, "Conflict"), "not a url")).toBe(
      false,
    );
  });
});
