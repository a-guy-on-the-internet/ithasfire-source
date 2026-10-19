import { describe, expect, it } from "vitest";

import {
  applicantHumansHref,
  applicantLabel,
} from "../applications-queue.helpers";

const ID = "22222222-2222-4222-8222-222222222222";

describe("applicantHumansHref", () => {
  it("links a named applicant to the platform humans list, filtered by name", () => {
    expect(
      applicantHumansHref({ applicantHumanId: ID, applicantName: "Rosa Diaz" }),
    ).toBe("/platform/humans?q=Rosa%20Diaz");
  });

  it("encodes characters that would break the query string", () => {
    expect(
      applicantHumansHref({ applicantHumanId: ID, applicantName: "A&B ?x" }),
    ).toBe("/platform/humans?q=A%26B%20%3Fx");
  });

  it("has no link without a name", () => {
    expect(
      applicantHumansHref({ applicantHumanId: ID, applicantName: null }),
    ).toBeNull();
    expect(
      applicantHumansHref({ applicantHumanId: ID, applicantName: "  " }),
    ).toBeNull();
  });
});

describe("applicantLabel", () => {
  it("shows the applicant's name", () => {
    expect(
      applicantLabel(
        { applicantHumanId: ID, applicantName: "Rosa Diaz" },
        false,
        "Deleted user",
      ),
    ).toBe("Rosa Diaz");
  });

  it("falls back to the short id for an applicant with no name set", () => {
    expect(
      applicantLabel(
        { applicantHumanId: ID, applicantName: null },
        false,
        "Deleted user",
      ),
    ).toBe("22222222");
  });

  it("reads as deleted for a dangling applicant, even with a stale name", () => {
    expect(
      applicantLabel(
        { applicantHumanId: ID, applicantName: "Rosa Diaz" },
        true,
        "Deleted user",
      ),
    ).toBe("Deleted user");
  });
});
