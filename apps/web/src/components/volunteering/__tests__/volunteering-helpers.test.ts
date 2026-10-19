import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  CONFLICT_REASON_KEY,
  REWARD_STATUS_LABEL_KEY,
  REWARD_TRIGGER_LABEL_KEY,
  composeVolunteerFeedUrls,
  effectiveRewardStatus,
  getVolunteerConflictReason,
  parseAskFormQuestions,
  rewardStatusBySignup,
  volunteerConflictMessageKey,
} from "../volunteering-helpers";

describe("composeVolunteerFeedUrls", () => {
  it("composes the http + webcal feed URLs from the api base", () => {
    const { httpUrl, webcalUrl } = composeVolunteerFeedUrls(
      "https://api.ithasfire.com",
      "tok_abc123",
    );
    expect(httpUrl).toBe(
      "https://api.ithasfire.com/api/volunteering/tok_abc123/calendar.ics",
    );
    expect(webcalUrl).toBe(
      "webcal://api.ithasfire.com/api/volunteering/tok_abc123/calendar.ics",
    );
  });

  it("falls back to window.location.origin when no api base is set", () => {
    const { httpUrl } = composeVolunteerFeedUrls(null, "tok");
    expect(httpUrl).toBe(
      `${window.location.origin}/api/volunteering/tok/calendar.ics`,
    );
  });
});

describe("volunteerConflictMessageKey", () => {
  it("maps known meta.reason conflicts to i18n keys", () => {
    expect(
      volunteerConflictMessageKey({
        data: { meta: { reason: "ask_archived" } },
      }),
    ).toBe("volunteering.errAskArchived");
    expect(
      volunteerConflictMessageKey({
        data: { meta: { reason: "duplicate_group_name" } },
      }),
    ).toBe("volunteering.errDuplicateGroupName");
    expect(
      volunteerConflictMessageKey({
        data: { meta: { reason: "group_full" } },
      }),
    ).toBe("volunteering.errGroupFull");
  });

  it("falls back to appCode when meta.reason is absent", () => {
    expect(
      getVolunteerConflictReason({ data: { appCode: "ASK_NOT_OPEN" } }),
    ).toBe("ask_not_open");
    expect(
      volunteerConflictMessageKey({ data: { appCode: "ASK_NOT_OPEN" } }),
    ).toBe("volunteering.errAskNotOpen");
  });

  it("returns null for unknown or malformed errors", () => {
    expect(volunteerConflictMessageKey(null)).toBeNull();
    expect(volunteerConflictMessageKey(new Error("boom"))).toBeNull();
    expect(
      volunteerConflictMessageKey({ data: { meta: { reason: "who_knows" } } }),
    ).toBeNull();
  });
});

describe("volunteering i18n key existence", () => {
  // Every key the UI can hand to t() must resolve in BOTH catalogs — a
  // missing entry renders the raw key to end users.
  const resolve = (catalog: unknown, key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined,
        catalog,
      );

  const keysUnderTest = [
    ...Object.values(CONFLICT_REASON_KEY),
    ...Object.values(REWARD_STATUS_LABEL_KEY),
    ...Object.values(REWARD_TRIGGER_LABEL_KEY),
    "volunteering.capacityInvalid",
    "volunteering.defaultHoursInvalid",
    // Comp-reward surfaces (volunteer-comp-tickets spec)
    "volunteering.rewardConfigTitle",
    "volunteering.rewardTicketTypeRequired",
    "volunteering.rewardMaxGrantsInvalid",
    "volunteering.rewardSaved",
    "volunteering.rewardSaveFailed",
    "volunteering.rewardLedgerTitle",
    "volunteering.rewardLedgerFaceValue",
    "volunteering.rewardLedgerEmpty",
    "volunteering.rewardFinanceRequiredTitle",
    "volunteering.rewardFinanceRequiredBody",
    "volunteering.rewardNoAsk",
    "admin.volunteerEventTabRewards",
    "admin.volunteerSignupsRewardColumn",
  ];

  it.each(keysUnderTest)("%s resolves in en and es", (key) => {
    const en = resolve(enMessages, key);
    const es = resolve(esMessages, key);
    expect(typeof en, `en missing ${key}`).toBe("string");
    expect(typeof es, `es missing ${key}`).toBe("string");
    expect((en as string).length).toBeGreaterThan(0);
    expect((es as string).length).toBeGreaterThan(0);
  });
});

describe("effectiveRewardStatus", () => {
  it("prefers REVOKED, then REDEEMED, then GRANTED", () => {
    expect(
      effectiveRewardStatus({ status: "REVOKED", redeemed: false }),
    ).toBe("REVOKED");
    // A scanned comp on a REVOKED grant is still voided.
    expect(
      effectiveRewardStatus({ status: "REVOKED", redeemed: true }),
    ).toBe("REVOKED");
    expect(
      effectiveRewardStatus({ status: "GRANTED", redeemed: true }),
    ).toBe("REDEEMED");
    expect(
      effectiveRewardStatus({ status: "GRANTED", redeemed: false }),
    ).toBe("GRANTED");
  });
});

describe("rewardStatusBySignup", () => {
  it("folds grants into a signupId → effective status map", () => {
    const map = rewardStatusBySignup([
      { signupId: "s1", status: "GRANTED", redeemed: false },
      { signupId: "s2", status: "GRANTED", redeemed: true },
      { signupId: "s3", status: "REVOKED", redeemed: false },
    ]);
    expect(map.get("s1")).toBe("GRANTED");
    expect(map.get("s2")).toBe("REDEEMED");
    expect(map.get("s3")).toBe("REVOKED");
    expect(map.has("nope")).toBe(false);
  });

  it("keeps the live comp when a signup has both a revoked and an active grant", () => {
    // REDEEMED (2) > GRANTED (1) > REVOKED (0): an old voided slot never
    // hides a live comp on the same signup.
    const map = rewardStatusBySignup([
      { signupId: "s1", status: "REVOKED", redeemed: false },
      { signupId: "s1", status: "GRANTED", redeemed: true },
    ]);
    expect(map.get("s1")).toBe("REDEEMED");
  });
});

describe("parseAskFormQuestions", () => {
  it("parses the minimal questions shape", () => {
    const parsed = parseAskFormQuestions({
      questions: [
        { id: "exp", label: "Experience?", required: true },
        { id: "notes", label: "Anything else?", multiline: true },
      ],
    });
    expect(parsed).toEqual([
      { id: "exp", label: "Experience?", required: true, multiline: false },
      {
        id: "notes",
        label: "Anything else?",
        required: false,
        multiline: true,
      },
    ]);
  });

  it("ignores unknown shapes and malformed entries", () => {
    expect(parseAskFormQuestions(null)).toEqual([]);
    expect(parseAskFormQuestions("nope")).toEqual([]);
    expect(parseAskFormQuestions({ fields: [] })).toEqual([]);
    expect(
      parseAskFormQuestions({
        questions: [{ id: "", label: "x" }, { label: "no id" }, 42],
      }),
    ).toEqual([]);
  });
});
