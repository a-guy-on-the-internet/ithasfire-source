import { describe, expect, it } from "vitest";

import {
  findBookingInboxRowElement,
  resolveBookingInboxDeepLink,
} from "../booking-inbox-deep-link";

const rows = [
  { id: "r-open", status: "PENDING", agreementStatus: null, eventId: null },
  {
    id: "r-agr",
    status: "ACCEPTED",
    agreementStatus: "PROPOSED",
    eventId: null,
  },
  {
    id: "r-evt",
    status: "ACCEPTED",
    agreementStatus: "ACCEPTED",
    eventId: "evt-1",
  },
  { id: "r-closed", status: "DECLINED", agreementStatus: null, eventId: null },
] as const;

describe("resolveBookingInboxDeepLink", () => {
  it("lands on the tab the row is filed under — the same classifier the tabs read", () => {
    expect(resolveBookingInboxDeepLink(rows, "r-open")).toEqual({
      id: "r-open",
      tab: "open",
    });
    expect(resolveBookingInboxDeepLink(rows, "r-agr")).toEqual({
      id: "r-agr",
      tab: "agreement",
    });
    expect(resolveBookingInboxDeepLink(rows, "r-evt")).toEqual({
      id: "r-evt",
      tab: "event",
    });
    expect(resolveBookingInboxDeepLink(rows, "r-closed")).toEqual({
      id: "r-closed",
      tab: "closed",
    });
  });

  it("is null — do nothing, no error — for a missing, empty or unknown id", () => {
    expect(resolveBookingInboxDeepLink(rows, null)).toBeNull();
    expect(resolveBookingInboxDeepLink(rows, undefined)).toBeNull();
    expect(resolveBookingInboxDeepLink(rows, "")).toBeNull();
    expect(resolveBookingInboxDeepLink(rows, "r-deleted")).toBeNull();
    expect(resolveBookingInboxDeepLink([], "r-open")).toBeNull();
  });
});

describe("findBookingInboxRowElement", () => {
  it("finds the table row by data-row-key, or the card by test id, or nothing", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <table><tbody><tr data-row-key="a b"></tr></tbody></table>
      <div data-testid="inbox-row-c"></div>`;
    expect(findBookingInboxRowElement(root, "inbox", "a b")?.tagName).toBe("TR");
    expect(findBookingInboxRowElement(root, "inbox", "c")?.tagName).toBe("DIV");
    expect(findBookingInboxRowElement(root, "inbox", "zzz")).toBeNull();
  });
});
