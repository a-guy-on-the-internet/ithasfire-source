import { describe, expect, it } from "vitest";

import {
  BOOKING_BILL_ACT_NAME_MAX_LENGTH,
  BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH,
  BOOKING_BILL_MAX_ROWS as CORE_MAX_ROWS,
  bookingBillSchema,
} from "@th/core/use-cases/booking-requests/_shared/bill-schema";
import { bookingRequestActRoleSchema } from "@th/core/use-cases/booking-requests/_shared/bill-items";

import {
  BOOKING_BILL_ACT_NAME_MAX,
  BOOKING_BILL_MAX_ROWS,
  BOOKING_BILL_ROLE_LABEL_MAX,
  BOOKING_BILL_ROLES,
  billAddRefusal,
  billIndexLabel,
  billRowNames,
  buildBookingBillPayload,
  moveBillAct,
  type BookingBillActDraft,
} from "../booking-bill.helpers";
import {
  buildBookingRequestPayloadWithBill,
  mapCreateBookingRequestError,
} from "../request-to-play-form.helpers";

/**
 * The bill on the place-page pitch (lineup-booking-requests v3, board F1).
 * The client cannot import core's bill schema (zod + sanitize-html in the
 * client bundle), so its constants are pinned here and every payload the
 * builder emits is parsed by core's REAL schema.
 */

const HUMAN_A = "6a1f0f8e-1c55-4a4e-9a4c-3b0d3a1f0a01";
const HUMAN_B = "6a1f0f8e-1c55-4a4e-9a4c-3b0d3a1f0a02";
const ORG_A = "7b2e1f9d-2d66-4b5f-8b5d-4c1e4b2f1b01";
const SENDER = { ownerType: "human" as const, ownerId: HUMAN_A };

let seq = 0;
const tagged = (
  ownerType: "human" | "org",
  ownerId: string,
  extra: Partial<Pick<BookingBillActDraft, "role" | "customRoleLabel" | "name">> = {},
): BookingBillActDraft => ({
  key: `k${++seq}`,
  kind: "tagged",
  ownerType,
  ownerId,
  name: extra.name ?? "Paper Moth",
  role: extra.role ?? "PERFORMER",
  customRoleLabel: extra.customRoleLabel ?? "",
});
const external = (
  name: string,
  extra: Partial<{ url: string; role: BookingBillActDraft["role"]; customRoleLabel: string }> = {},
): BookingBillActDraft => ({
  key: `k${++seq}`,
  kind: "external",
  name,
  url: extra.url ?? "",
  role: extra.role ?? "PERFORMER",
  customRoleLabel: extra.customRoleLabel ?? "",
});

/** Every emitted bill must be one core accepts. */
function expectCoreAccepts(bill: unknown) {
  expect(bookingBillSchema.safeParse(bill).success).toBe(true);
}

describe("bill constants are core's", () => {
  it("pins the row cap, name and role-label bounds and the role vocabulary", () => {
    expect(BOOKING_BILL_MAX_ROWS).toBe(CORE_MAX_ROWS);
    expect(BOOKING_BILL_ACT_NAME_MAX).toBe(BOOKING_BILL_ACT_NAME_MAX_LENGTH);
    expect(BOOKING_BILL_ROLE_LABEL_MAX).toBe(
      BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH,
    );
    expect([...BOOKING_BILL_ROLES]).toEqual(bookingRequestActRoleSchema.options);
  });
});

describe("buildBookingBillPayload", () => {
  it("omits the bill when it is the sender alone — the server's own default", () => {
    expect(buildBookingBillPayload({})).toEqual({ ok: true, bill: undefined });
    expect(buildBookingBillPayload({ includeSelf: true, acts: [] })).toEqual({
      ok: true,
      bill: undefined,
    });
  });

  it("sends includeSelf:false even with no acts, so a promoter is not put on the bill", () => {
    const result = buildBookingBillPayload({ includeSelf: false, acts: [] });
    expect(result).toEqual({ ok: true, bill: { includeSelf: false, acts: [] } });
    if (result.ok) expectCoreAccepts(result.bill);
  });

  it("includes self with a tagged person, a tagged group and a by-name act with a link, in order", () => {
    const result = buildBookingBillPayload({
      includeSelf: true,
      sender: SENDER,
      acts: [
        tagged("human", HUMAN_B),
        tagged("org", ORG_A, { name: "The Sallows" }),
        external("  Junebug Radio ", {
          url: " https://junebug.example/ ",
          role: "DJ",
        }),
      ],
    });
    expect(result).toEqual({
      ok: true,
      bill: {
        includeSelf: true,
        acts: [
          { kind: "tagged", humanId: HUMAN_B, role: "PERFORMER" },
          { kind: "tagged", orgId: ORG_A, role: "PERFORMER" },
          {
            kind: "external",
            name: "Junebug Radio",
            url: "https://junebug.example/",
            role: "DJ",
          },
        ],
      },
    });
    if (result.ok) expectCoreAccepts(result.bill);
  });

  it("omits an empty link on a by-name act", () => {
    const result = buildBookingBillPayload({
      includeSelf: false,
      acts: [external("Junebug Radio")],
    });
    expect(result.ok && result.bill?.acts[0]).toEqual({
      kind: "external",
      name: "Junebug Radio",
      role: "PERFORMER",
    });
  });

  it("keeps the role name beside OTHER, trimmed", () => {
    const result = buildBookingBillPayload({
      acts: [tagged("human", HUMAN_B, { role: "OTHER", customRoleLabel: "  Stage manager " })],
    });
    expect(result.ok && result.bill?.acts[0]).toEqual({
      kind: "tagged",
      humanId: HUMAN_B,
      role: "OTHER",
      customRoleLabel: "Stage manager",
    });
    if (result.ok) expectCoreAccepts(result.bill);
  });

  it("drops the role name for any role other than OTHER, and a blank one beside OTHER", () => {
    const result = buildBookingBillPayload({
      acts: [
        external("Junebug Radio", { role: "DJ", customRoleLabel: "Selector" }),
        external("Ines Farrow", { role: "OTHER", customRoleLabel: "   " }),
      ],
    });
    expect(result.ok && result.bill?.acts).toEqual([
      { kind: "external", name: "Junebug Radio", role: "DJ" },
      { kind: "external", name: "Ines Farrow", role: "OTHER" },
    ]);
  });

  it("caps the bill at 12 rows, the sender's own included", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => external(`Act ${i + 1}`));
    const twelveWithSelf = buildBookingBillPayload({ includeSelf: true, acts: eleven });
    expect(twelveWithSelf.ok).toBe(true);
    if (twelveWithSelf.ok) expectCoreAccepts(twelveWithSelf.bill);

    const twelveActs = [...eleven, external("Act 12")];
    expect(buildBookingBillPayload({ includeSelf: false, acts: twelveActs }).ok).toBe(true);
    expect(buildBookingBillPayload({ includeSelf: true, acts: twelveActs })).toEqual({
      ok: false,
      errorKey: "admin.bkErrBillTooLong",
    });
    // …which is exactly where core draws the line too.
    expect(
      bookingBillSchema.safeParse({
        includeSelf: true,
        acts: twelveActs.map((a) => ({ kind: "external", name: a.name })),
      }).success,
    ).toBe(false);
  });

  it("refuses a tag of the sender and a tag twice, before the server does", () => {
    expect(
      buildBookingBillPayload({ sender: SENDER, acts: [tagged("human", HUMAN_A)] }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrBillSelfTag" });
    expect(
      buildBookingBillPayload({
        sender: SENDER,
        acts: [tagged("org", ORG_A), tagged("org", ORG_A)],
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrBillDuplicate" });
    // A person and a group may share an id space without colliding.
    expect(
      buildBookingBillPayload({
        sender: { ownerType: "org", ownerId: HUMAN_A },
        acts: [tagged("human", HUMAN_A)],
      }).ok,
    ).toBe(true);
  });

  it("refuses a by-name act whose link is not http(s)", () => {
    expect(
      buildBookingBillPayload({
        acts: [external("Junebug Radio", { url: "javascript:alert(1)" })],
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrBillActInvalid" });
  });
});

describe("buildBookingRequestPayloadWithBill", () => {
  const pitch = {
    message: "We are a four-piece surf-rock band from town.",
    preferredDates: ["2027-08-01"],
    expectedDraw: "",
    genre: "",
  };

  it("is the shared pitch, byte for byte, when the bill was never touched", () => {
    expect(
      buildBookingRequestPayloadWithBill({ ...pitch, senderOwnerType: "human", senderOwnerId: HUMAN_A }),
    ).toEqual({
      ok: true,
      payload: { message: pitch.message, preferredDates: pitch.preferredDates },
    });
  });

  it("adds the bill beside the pitch fields", () => {
    const result = buildBookingRequestPayloadWithBill({
      ...pitch,
      senderOwnerType: "human",
      senderOwnerId: HUMAN_A,
      billIncludeSelf: false,
      billActs: [tagged("org", ORG_A)],
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        message: pitch.message,
        preferredDates: pitch.preferredDates,
        bill: {
          includeSelf: false,
          acts: [{ kind: "tagged", orgId: ORG_A, role: "PERFORMER" }],
        },
      },
    });
  });

  it("reports the pitch's own first error before the bill's", () => {
    expect(
      buildBookingRequestPayloadWithBill({
        ...pitch,
        message: "short",
        senderOwnerType: "human",
        senderOwnerId: HUMAN_A,
        billActs: [tagged("human", HUMAN_A)],
      }),
    ).toEqual({ ok: false, errorKey: "admin.bkErrMessageTooShort" });
  });
});

describe("ledger helpers", () => {
  it("moves an act one place and ignores a move off either end", () => {
    expect(moveBillAct(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveBillAct(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveBillAct(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveBillAct(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("numbers rows 01, 02 … 12", () => {
    expect(billIndexLabel(1)).toBe("01");
    expect(billIndexLabel(12)).toBe("12");
  });

  it("names row controls by act, adding the position only when two acts share a name", () => {
    expect(
      billRowNames([{ name: "Paper Moth" }, { name: "The Sallows" }, { name: "paper moth" }], 2),
    ).toEqual(["Paper Moth (02)", "The Sallows", "paper moth (04)"]);
  });

  it("refuses a full bill, the sender, and a duplicate by identity or by name", () => {
    const acts = [tagged("human", HUMAN_B), external("Junebug Radio")];
    const base = { acts, sender: SENDER, rowCount: 3 };
    expect(
      billAddRefusal({ ...base, candidate: { kind: "external", name: "Ines" }, rowCount: 12 }),
    ).toBe("full");
    expect(
      billAddRefusal({ ...base, candidate: { kind: "tagged", ownerType: "human", ownerId: HUMAN_A } }),
    ).toBe("self");
    expect(
      billAddRefusal({ ...base, candidate: { kind: "tagged", ownerType: "human", ownerId: HUMAN_B } }),
    ).toBe("duplicate");
    expect(
      billAddRefusal({ ...base, candidate: { kind: "external", name: " junebug radio " } }),
    ).toBe("duplicate");
    expect(
      billAddRefusal({ ...base, candidate: { kind: "tagged", ownerType: "org", ownerId: ORG_A } }),
    ).toBeNull();
  });
});

describe("mapCreateBookingRequestError — the bill's refusals", () => {
  const err = (appCode: string, extra: { message?: string; meta?: Record<string, unknown> } = {}) => ({
    message: extra.message ?? appCode,
    data: { appCode, ...(extra.meta ? { meta: extra.meta } : {}) },
  });

  it("maps ACT_NOT_TAGGABLE by its reason", () => {
    expect(mapCreateBookingRequestError(err("ACT_NOT_TAGGABLE", { meta: { reason: "duplicate" } }))).toBe(
      "admin.bkErrBillDuplicate",
    );
    expect(mapCreateBookingRequestError(err("ACT_NOT_TAGGABLE", { meta: { reason: "self" } }))).toBe(
      "admin.bkErrBillSelfTag",
    );
    expect(
      mapCreateBookingRequestError(err("ACT_NOT_TAGGABLE", { meta: { reason: "not_taggable", humanId: HUMAN_B } })),
    ).toBe("admin.bkErrBillNotTaggable");
    expect(mapCreateBookingRequestError(err("ACT_NOT_TAGGABLE"))).toBe("admin.bkErrBillNotTaggable");
  });

  it("maps BILL_NOT_ALLOWED and PERFORMER_MODE_REQUIRED (the SELF row's gate)", () => {
    expect(mapCreateBookingRequestError(err("BILL_NOT_ALLOWED"))).toBe("admin.bkErrBillNotAllowed");
    expect(mapCreateBookingRequestError(err("PERFORMER_MODE_REQUIRED"))).toBe(
      "admin.bkErrBillPerformerMode",
    );
  });

  it("maps the daily tag budget, and leaves any other rate limit generic", () => {
    expect(
      mapCreateBookingRequestError(
        err("RATE_LIMITED", {
          message: "lineup_tag_budget",
          meta: { scope: "lineup_tag_budget", retryAfterSeconds: 60 },
        }),
      ),
    ).toBe("admin.bkErrBillTagBudget");
    expect(mapCreateBookingRequestError(err("RATE_LIMITED"))).toBe("admin.bkErrGeneric");
  });
});
