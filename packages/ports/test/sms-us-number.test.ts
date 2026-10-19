import { describe, expect, it } from "vitest";

import { isUsSmsNumber, redactPhoneNumbers } from "../src/comms/sms";

describe("isUsSmsNumber", () => {
  it.each([
    ["+12125550100", true, "New York"],
    ["+17875550100", true, "Puerto Rico bills as the US"],
    ["+19395550100", true, "Puerto Rico overlay"],
    ["+13405550100", true, "US Virgin Islands"],
    ["+14165550100", false, "Toronto, Canada"],
    ["+16045550100", false, "Vancouver, Canada"],
    ["+16005550100", false, "Canadian non-geographic"],
    ["+16225550100", false, "Canadian non-geographic"],
    ["+16335550100", false, "Canadian non-geographic"],
    ["+16445550100", false, "Canadian non-geographic"],
    ["+16555550100", false, "Canadian non-geographic"],
    ["+16775550100", false, "Canadian non-geographic"],
    ["+16885550100", false, "Canadian non-geographic"],
    ["+18795550100", false, "Newfoundland overlay"],
    ["+18765550100", false, "Jamaica"],
    ["+19005550100", false, "premium rate"],
    ["+16715550100", false, "Guam"],
    ["+16705550100", false, "Northern Mariana Islands"],
    ["+16845550100", false, "American Samoa"],
    ["+14115550100", false, "N11 service code"],
    ["2125550100", false, "national format, no +1"],
    ["(212) 555-0100", false, "formatted national"],
    ["+442071234567", false, "UK"],
    ["+11125550100", false, "area code starting 1"],
  ])("%s -> %s (%s)", (value, expected) => {
    expect(isUsSmsNumber(value)).toBe(expected);
  });
});

describe("redactPhoneNumbers", () => {
  it.each([
    "Invalid destination +16155550100",
    "Invalid destination 6155550100",
    "Invalid destination +1 615 555 0100",
    "Invalid destination (615) 555-0100",
    "Invalid destination 615.555.0100",
    "Invalid destination +1-615-555-0100",
  ])("removes the number from %s", (text) => {
    const out = redactPhoneNumbers(text);
    expect(out).toContain("[redacted]");
    expect(out).not.toMatch(/555/);
    expect(out.startsWith("Invalid destination ")).toBe(true);
  });

  it("leaves short numbers and ordinary text alone", () => {
    expect(redactPhoneNumbers("retry after 30 s, code 429")).toBe(
      "retry after 30 s, code 429",
    );
  });
});
