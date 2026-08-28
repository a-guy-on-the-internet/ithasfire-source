import { describe, expect, it } from "vitest";

import { isUuid, parseTicketQrPayload, parseVolunteerQrPayload } from "./qr";

describe("qr helpers", () => {
  it("parses structured ticket QR payloads", () => {
    expect(
      parseTicketQrPayload(
        "hf://11111111-1111-4111-8111-111111111111/DOORABC123",
      ),
    ).toEqual({
      embeddedEventId: "11111111-1111-4111-8111-111111111111",
      ticketCode: "DOORABC123",
    });
  });

  it("parses structured ticket QR payloads with hyphens in the code", () => {
    // Seed/dev fixtures and any code with hyphens (e.g. TKT-E2E-CONCERT-001)
    // must round-trip the structured form, not fall through to bare.
    expect(
      parseTicketQrPayload(
        "hf://11111111-1111-4111-8111-111111111111/TKT-E2E-CONCERT-001",
      ),
    ).toEqual({
      embeddedEventId: "11111111-1111-4111-8111-111111111111",
      ticketCode: "TKT-E2E-CONCERT-001",
    });
  });

  it("parses structured codes with underscores", () => {
    expect(
      parseTicketQrPayload(
        "hf://11111111-1111-4111-8111-111111111111/tk_abcdef0123456789",
      ),
    ).toEqual({
      embeddedEventId: "11111111-1111-4111-8111-111111111111",
      ticketCode: "TK_ABCDEF0123456789",
    });
  });

  it("parses raw ticket codes", () => {
    expect(parseTicketQrPayload("  abc123  ")).toEqual({
      ticketCode: "ABC123",
    });
  });

  it("rejects short ticket payloads", () => {
    expect(parseTicketQrPayload("abc")).toBeNull();
  });

  it("parses volunteer QR payloads as opaque tokens", () => {
    expect(parseVolunteerQrPayload("  volunteer-token  ")).toBe(
      "volunteer-token",
    );
  });

  it("validates UUID strings", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});
