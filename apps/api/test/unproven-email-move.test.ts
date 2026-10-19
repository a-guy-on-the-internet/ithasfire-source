import { describe, expect, it, vi } from "vitest";

import {
  CHANGE_EMAIL_PATH,
  isUnprovenEmailMoveRefused,
  prismaUnprovenEmailMoveLookup,
  refuseUnprovenEmailMove,
  type UnprovenEmailMoveLookup,
} from "../src/auth/unproven-email-move";

// B2 (account squatting through guest checkout, owner ruling 2026-10-16).
// `/email-otp/change-email` writes `{ email: new, emailVerified: true }` on
// the same AuthUser without the unproven-account sweep, so a squatter could
// move the account to their own inbox and turn it verified with the victim's
// email-attached orders still on it.

function lookup(opts: {
  authUser: { emailVerified: boolean; humanId: string | null } | null;
  holds?: boolean;
}): UnprovenEmailMoveLookup & {
  loadAuthUser: ReturnType<typeof vi.fn>;
  holdsEmailAttachedRows: ReturnType<typeof vi.fn>;
} {
  return {
    loadAuthUser: vi.fn(async () => opts.authUser),
    holdsEmailAttachedRows: vi.fn(async () => opts.holds ?? false),
  };
}

const sessionCtx = (id: string | null) => ({
  path: CHANGE_EMAIL_PATH,
  context: { session: id ? { user: { id } } : null },
});

describe("isUnprovenEmailMoveRefused", () => {
  it("refuses an unverified account that holds orders or tickets (the squatter)", async () => {
    const l = lookup({
      authUser: { emailVerified: false, humanId: "h1" },
      holds: true,
    });
    await expect(isUnprovenEmailMoveRefused(l, "u1")).resolves.toBe(true);
    expect(l.holdsEmailAttachedRows).toHaveBeenCalledWith("h1");
  });

  it("lets an unverified account with nothing on it change (typo fix)", async () => {
    const l = lookup({
      authUser: { emailVerified: false, humanId: "h1" },
      holds: false,
    });
    await expect(isUnprovenEmailMoveRefused(l, "u1")).resolves.toBe(false);
  });

  it("lets a verified account change without reading its orders", async () => {
    const l = lookup({
      authUser: { emailVerified: true, humanId: "h1" },
      holds: true,
    });
    await expect(isUnprovenEmailMoveRefused(l, "u1")).resolves.toBe(false);
    expect(l.holdsEmailAttachedRows).not.toHaveBeenCalled();
  });

  it("propagates a lookup failure (fails closed, nothing swallowed)", async () => {
    const l = lookup({ authUser: { emailVerified: false, humanId: "h1" } });
    l.holdsEmailAttachedRows.mockRejectedValueOnce(new Error("db down"));
    await expect(isUnprovenEmailMoveRefused(l, "u1")).rejects.toThrow(
      "db down",
    );
  });
});

describe("refuseUnprovenEmailMove (user.update.before)", () => {
  it("refuses /email-otp/change-email for an unverified holder with 403", async () => {
    const l = lookup({
      authUser: { emailVerified: false, humanId: "h1" },
      holds: true,
    });
    await expect(
      refuseUnprovenEmailMove(l, CHANGE_EMAIL_PATH, sessionCtx("u1")),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: expect.objectContaining({ code: "VERIFY_CURRENT_EMAIL_FIRST" }),
    });
    expect(l.loadAuthUser).toHaveBeenCalledWith("u1");
  });

  it("passes a verified account on /email-otp/change-email", async () => {
    const l = lookup({
      authUser: { emailVerified: true, humanId: "h1" },
      holds: true,
    });
    await expect(
      refuseUnprovenEmailMove(l, CHANGE_EMAIL_PATH, sessionCtx("u1")),
    ).resolves.toBeUndefined();
  });

  it("refuses when the hook cannot tell whose address moves", async () => {
    const l = lookup({ authUser: { emailVerified: true, humanId: "h1" } });
    await expect(
      refuseUnprovenEmailMove(l, CHANGE_EMAIL_PATH, sessionCtx(null)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("ignores every other path (sign-in flips, admin writes)", async () => {
    const l = lookup({
      authUser: { emailVerified: false, humanId: "h1" },
      holds: true,
    });
    for (const path of ["/sign-in/email-otp", "/magic-link/verify", undefined]) {
      await expect(
        refuseUnprovenEmailMove(l, path, sessionCtx("u1")),
      ).resolves.toBeUndefined();
    }
    expect(l.loadAuthUser).not.toHaveBeenCalled();
  });
});

describe("prismaUnprovenEmailMoveLookup", () => {
  function fakeDb(found: {
    order?: boolean;
    ticket?: boolean;
    coordinator?: boolean;
    lineup?: boolean;
  }) {
    const row = (hit: boolean | undefined) =>
      vi.fn(async () => (hit ? { id: "x" } : null));
    return {
      authUser: {
        findUnique: vi.fn(async () => ({ emailVerified: false, humanId: "h1" })),
      },
      order: { findFirst: row(found.order) },
      ticket: { findFirst: row(found.ticket) },
      volunteerGroup: { findFirst: row(found.coordinator) },
      eventHuman: { findFirst: row(found.lineup) },
    };
  }

  it("asks every email-attached table about the Human", async () => {
    const db = fakeDb({ ticket: true });
    const l = prismaUnprovenEmailMoveLookup(db);

    await expect(l.loadAuthUser("u1")).resolves.toEqual({
      emailVerified: false,
      humanId: "h1",
    });
    await expect(l.holdsEmailAttachedRows("h1")).resolves.toBe(true);
    expect(db.order.findFirst).toHaveBeenCalledWith({
      where: { buyerHumanId: "h1" },
      select: { id: true },
    });
    expect(db.ticket.findFirst).toHaveBeenCalledWith({
      where: { ownerHumanId: "h1" },
      select: { id: true },
    });
    expect(db.volunteerGroup.findFirst).toHaveBeenCalledWith({
      where: { coordinatorHumanId: "h1" },
      select: { id: true },
    });
    expect(db.eventHuman.findFirst).toHaveBeenCalledWith({
      where: { humanId: "h1" },
      select: { id: true },
    });
  });

  it.each([
    ["an order", { order: true }],
    ["a ticket", { ticket: true }],
    ["only a coordinator seat", { coordinator: true }],
    ["only a lineup link", { lineup: true }],
  ])("a Human holding %s counts as holding", async (_label, found) => {
    const l = prismaUnprovenEmailMoveLookup(fakeDb(found));
    await expect(l.holdsEmailAttachedRows("h1")).resolves.toBe(true);
  });

  it("a Human holding none of them does not", async () => {
    const l = prismaUnprovenEmailMoveLookup(fakeDb({}));
    await expect(l.holdsEmailAttachedRows("h1")).resolves.toBe(false);
  });

  it("fails closed: a failing table query rejects", async () => {
    const db = fakeDb({});
    db.eventHuman.findFirst.mockRejectedValueOnce(new Error("db down"));
    const l = prismaUnprovenEmailMoveLookup(db);
    await expect(l.holdsEmailAttachedRows("h1")).rejects.toThrow("db down");
  });

  it("a coordinator-only or lineup-only unverified account is refused", async () => {
    for (const found of [{ coordinator: true }, { lineup: true }]) {
      const l = prismaUnprovenEmailMoveLookup(fakeDb(found));
      await expect(
        refuseUnprovenEmailMove(l, CHANGE_EMAIL_PATH, sessionCtx("u1")),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});
