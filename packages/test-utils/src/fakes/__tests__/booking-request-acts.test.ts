import { describe, expect, it } from "vitest";

import { createFakeBookingRequestActs } from "../booking-request-acts";

// Pins the fake to the adapter's contract (the adapter's own behaviour is
// pinned against real Postgres in
// packages/adapters/src/db/prisma/__tests__/booking-request-acts.integration.test.ts).
describe("createFakeBookingRequestActs", () => {
  const H1 = "11111111-1111-4111-8111-111111111111";
  const H2 = "22222222-2222-4222-8222-222222222222";
  const KEY = { bookingRequestId: "req-a", actOwnerType: "human", actOwnerId: H1 } as const;

  const withSender = () =>
    createFakeBookingRequestActs({
      senderOf: (id) =>
        id === "req-a"
          ? { ownerType: "organization", ownerId: "org-1" }
          : id === "req-anon"
            ? null
            : undefined,
    });

  it("stamps confirmation by source, keeps input order, and takes SELF's owner off the request", async () => {
    const fake = withSender();
    const rows = await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
      { source: "SELF", sortOrder: 1 },
      { source: "EXTERNAL", externalName: "Free", sortOrder: 2 },
    ]);
    expect(rows.map((r) => [r.source, r.confirmation])).toEqual([
      ["TAGGED", "PENDING"],
      ["SELF", "CONFIRMED"],
      ["EXTERNAL", "CONFIRMED"],
    ]);
    expect(rows[1]).toMatchObject({ actOwnerType: "organization", actOwnerId: "org-1" });
  });

  it("SELF on a missing request / a sender-less inquiry throws like the adapter", async () => {
    const fake = withSender();
    await expect(fake.addActs("req-missing", [{ source: "SELF", sortOrder: 0 }])).rejects.toMatchObject({
      code: "not_found",
      message: "booking_request_not_found",
    });
    await expect(fake.addActs("req-anon", [{ source: "SELF", sortOrder: 0 }])).rejects.toMatchObject({
      code: "invalid_input",
      message: "booking_request_self_act_without_sender",
    });
    // No senderOf at all → treated as a missing request.
    await expect(
      createFakeBookingRequestActs().addActs("req-a", [{ source: "SELF", sortOrder: 0 }]),
    ).rejects.toMatchObject({ message: "booking_request_not_found" });
  });

  it("rejects a duplicate platform act (declined rows still hold the key)", async () => {
    const fake = createFakeBookingRequestActs();
    await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
    ]);
    await fake.setActConfirmation({
      ...KEY,
      expectedFrom: "PENDING",
      to: "DECLINED",
      respondedAt: new Date(),
    });
    await expect(
      fake.addActs("req-a", [
        { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
      ]),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_duplicate" });
    // Free-text acts never collide.
    await expect(
      fake.addActs("req-a", [
        { source: "EXTERNAL", externalName: "X", sortOrder: 1 },
        { source: "EXTERNAL", externalName: "X", sortOrder: 2 },
      ]),
    ).resolves.toHaveLength(2);
  });

  it("lists scoped and ordered by request, then sortOrder", async () => {
    const fake = createFakeBookingRequestActs();
    await fake.addActs("req-b", [{ source: "EXTERNAL", externalName: "b0", sortOrder: 0 }]);
    await fake.addActs("req-a", [
      { source: "EXTERNAL", externalName: "a1", sortOrder: 1 },
      { source: "EXTERNAL", externalName: "a0", sortOrder: 0 },
    ]);
    await fake.addActs("req-z", [{ source: "EXTERNAL", externalName: "z", sortOrder: 0 }]);
    const rows = await fake.listActsForRequests(["req-b", "req-a"]);
    expect(rows.map((r) => r.externalName)).toEqual(["a0", "a1", "b0"]);
  });

  it("addresses an act only by its owner key: another human's id reads nothing and cannot answer", async () => {
    const fake = createFakeBookingRequestActs();
    await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
    ]);
    await expect(fake.getActForOwner({ ...KEY, actOwnerId: H2 })).resolves.toBeNull();
    await expect(fake.getActForOwner({ ...KEY, bookingRequestId: "req-b" })).resolves.toBeNull();
    await expect(
      fake.setActConfirmation({
        ...KEY,
        actOwnerId: H2,
        expectedFrom: "PENDING",
        to: "CONFIRMED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_state_changed" });
    await expect(fake.getActForOwner(KEY)).resolves.toMatchObject({ confirmation: "PENDING" });
  });

  it("CAS: the second answer conflicts and changes nothing", async () => {
    const fake = createFakeBookingRequestActs();
    await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
    ]);
    await fake.setActConfirmation({
      ...KEY,
      expectedFrom: "PENDING",
      to: "CONFIRMED",
      respondedAt: new Date(),
      declineReason: "ignored",
    });
    await expect(
      fake.setActConfirmation({
        ...KEY,
        expectedFrom: "PENDING",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    await expect(fake.getActForOwner(KEY)).resolves.toMatchObject({
      confirmation: "CONFIRMED",
      declineReason: null,
    });
  });

  it("hands out copies, never the stored rows", async () => {
    const fake = createFakeBookingRequestActs();
    const [inserted] = await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
    ]);
    inserted!.confirmation = "CONFIRMED";
    const [listed] = await fake.listActsForRequests(["req-a"]);
    listed!.confirmation = "DECLINED";
    const read = await fake.getActForOwner(KEY);
    expect(read!.confirmation).toBe("PENDING");
    read!.confirmation = "CONFIRMED";
    expect([...fake.rows.values()][0]!.confirmation).toBe("PENDING");
  });
  it("a CONFIRMED act can be CAS'd to DECLINED (consent withdrawn), only from CONFIRMED", async () => {
    const fake = createFakeBookingRequestActs();
    await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
    ]);
    // Not yet confirmed: expectedFrom CONFIRMED misses.
    await expect(
      fake.setActConfirmation({
        ...KEY,
        expectedFrom: "CONFIRMED",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    await fake.setActConfirmation({
      ...KEY,
      expectedFrom: "PENDING",
      to: "CONFIRMED",
      respondedAt: new Date(),
    });
    await expect(
      fake.setActConfirmation({
        ...KEY,
        expectedFrom: "CONFIRMED",
        to: "DECLINED",
        respondedAt: new Date(),
        declineReason: "changed plans",
      }),
    ).resolves.toMatchObject({ confirmation: "DECLINED", declineReason: "changed plans" });
  });

  it("a SELF row can never be CAS'd (consent is TAGGED-only)", async () => {
    // A HUMAN sender: their SELF row has exactly a tagged answer's key shape.
    const fake = createFakeBookingRequestActs({
      senderOf: () => ({ ownerType: "human", ownerId: H2 }),
    });
    await fake.addActs("req-h", [{ source: "SELF", sortOrder: 0 }]);
    await expect(
      fake.setActConfirmation({
        bookingRequestId: "req-h",
        actOwnerType: "human",
        actOwnerId: H2,
        expectedFrom: "CONFIRMED",
        to: "DECLINED",
        respondedAt: new Date(),
      }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    await expect(
      fake.getActForOwner({ bookingRequestId: "req-h", actOwnerType: "human", actOwnerId: H2 }),
    ).resolves.toMatchObject({ source: "SELF", confirmation: "CONFIRMED" });
  });

  it("lockBill is a callable no-op", async () => {
    await expect(createFakeBookingRequestActs().lockBill("req-a")).resolves.toBeUndefined();
  });

  it("promoteActToSelf rewrites ONE EXTERNAL row into the sender's SELF row", async () => {
    const fake = withSender();
    const [own, other] = await fake.addActs("req-a", [
      { source: "EXTERNAL", externalName: "Own Act", externalUrl: "https://own.example", sortOrder: 0 },
      { source: "EXTERNAL", externalName: "Other", sortOrder: 1 },
    ]);

    const promoted = await fake.promoteActToSelf({ bookingRequestId: "req-a", actId: own!.id });

    expect(promoted).toMatchObject({
      id: own!.id,
      source: "SELF",
      actOwnerType: "organization",
      actOwnerId: "org-1",
      externalName: null,
      externalUrl: null,
      confirmation: "CONFIRMED",
      sortOrder: 0,
    });
    await expect(fake.listActsForRequests(["req-a"])).resolves.toEqual([
      expect.objectContaining({ source: "SELF" }),
      expect.objectContaining({ id: other!.id, source: "EXTERNAL", externalName: "Other" }),
    ]);
  });

  it("promoteActToSelf refuses a non-EXTERNAL row, a foreign request, a sender-less request, and a duplicate", async () => {
    const fake = withSender();
    const [tagged, external] = await fake.addActs("req-a", [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
      { source: "EXTERNAL", externalName: "Free", sortOrder: 1 },
    ]);
    await expect(
      fake.promoteActToSelf({ bookingRequestId: "req-a", actId: tagged!.id }),
    ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    await expect(
      fake.promoteActToSelf({ bookingRequestId: "req-missing", actId: external!.id }),
    ).rejects.toMatchObject({ message: "booking_request_not_found" });
    await expect(
      fake.promoteActToSelf({ bookingRequestId: "req-anon", actId: external!.id }),
    ).rejects.toMatchObject({ message: "booking_request_self_act_without_sender" });

    // The sender already holds a SELF row → the unique key would collide.
    await fake.addActs("req-a", [{ source: "SELF", sortOrder: 2 }]);
    await expect(
      fake.promoteActToSelf({ bookingRequestId: "req-a", actId: external!.id }),
    ).rejects.toMatchObject({ message: "booking_request_act_duplicate" });
  });

  // ── lineup v3 (FR-001, FR-009, L13, L17) — the same cases the adapter's
  // integration suite pins against real Postgres. ──────────────────────────

  describe("v3", () => {
    const seed = async () => {
      const fake = withSender();
      const rows = await fake.addActs("req-a", [
        { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 0 },
        { source: "SELF", sortOrder: 1 },
        { source: "EXTERNAL", externalName: "Junco", sortOrder: 2 },
      ]);
      return { fake, tagged: rows[0]!, self: rows[1]!, external: rows[2]! };
    };

    it("tags a group like a human, and carries the role label", async () => {
      const fake = createFakeBookingRequestActs();
      const [group] = await fake.addActs("req-b", [
        {
          source: "TAGGED",
          actOwnerType: "organization",
          actOwnerId: "org-9",
          sortOrder: 0,
          role: "OTHER",
          customRoleLabel: "Backing band",
        },
      ]);
      expect(group).toMatchObject({
        actOwnerType: "organization",
        confirmation: "PENDING",
        customRoleLabel: "Backing band",
        removedAt: null,
      });
      await expect(
        fake.setActConfirmation({
          bookingRequestId: "req-b",
          actOwnerType: "organization",
          actOwnerId: "org-9",
          expectedFrom: "PENDING",
          to: "CONFIRMED",
          respondedAt: new Date(),
        }),
      ).resolves.toMatchObject({ confirmation: "CONFIRMED" });
    });

    it("addActs mirrors the role-label CHECK (a label only beside OTHER)", async () => {
      const fake = createFakeBookingRequestActs();
      await expect(
        fake.addActs("req-b", [
          {
            source: "EXTERNAL",
            externalName: "Named",
            sortOrder: 0,
            role: "PERFORMER",
            customRoleLabel: "Hype man",
          },
        ]),
      ).rejects.toThrow(/BookingRequestAct_custom_role_label_check/);
      await expect(fake.listActsForRequests(["req-b"])).resolves.toEqual([]);
    });

    it("removed rows are off every default read, back with includeRemoved", async () => {
      const { fake, tagged, self, external } = await seed();
      const at = new Date("2026-10-01T09:00:00.000Z");
      await expect(
        fake.softRemoveAct({ bookingRequestId: "req-a", actId: tagged.id, at }),
      ).resolves.toMatchObject({ removedAt: at });

      await expect(
        fake.listActsForRequests(["req-a"]).then((r) => r.map((a) => a.id)),
      ).resolves.toEqual([self.id, external.id]);
      await expect(fake.getActForOwner(KEY)).resolves.toBeNull();
      await expect(
        fake
          .listActsForRequests(["req-a"], { includeRemoved: true })
          .then((r) => r.map((a) => a.id)),
      ).resolves.toEqual([tagged.id, self.id, external.id]);
      await expect(
        fake.getActForOwner(KEY, { includeRemoved: true }),
      ).resolves.toMatchObject({ id: tagged.id, removedAt: at });
    });

    it("a removed row still holds its key, cannot answer, cannot be removed twice", async () => {
      const { fake, tagged } = await seed();
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: tagged.id, at: new Date() });
      await expect(
        fake.addActs("req-a", [
          { source: "TAGGED", actOwnerType: "human", actOwnerId: H1, sortOrder: 3 },
        ]),
      ).rejects.toMatchObject({ message: "booking_request_act_duplicate" });
      await expect(
        fake.setActConfirmation({
          ...KEY,
          expectedFrom: "PENDING",
          to: "CONFIRMED",
          respondedAt: new Date(),
        }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
      for (const input of [
        { bookingRequestId: "req-a", actId: tagged.id }, // already removed
        { bookingRequestId: "req-b", actId: tagged.id }, // foreign request
        { bookingRequestId: "req-a", actId: "nope" }, // unknown
      ]) {
        await expect(
          fake.softRemoveAct({ ...input, at: new Date() }),
        ).rejects.toMatchObject({ code: "conflict", message: "booking_request_act_state_changed" });
      }
    });

    it("a removed EXTERNAL row cannot be promoted", async () => {
      const { fake, external } = await seed();
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: external.id, at: new Date() });
      await expect(
        fake.promoteActToSelf({ bookingRequestId: "req-a", actId: external.id }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });

    it("restoreAct: SELF stays CONFIRMED; TAGGED is asked again; a pass never returns", async () => {
      const { fake, tagged, self } = await seed();
      await fake.setActConfirmation({
        ...KEY,
        expectedFrom: "PENDING",
        to: "CONFIRMED",
        respondedAt: new Date(),
      });
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: self.id, at: new Date() });
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: tagged.id, at: new Date() });

      await expect(
        fake.restoreAct({ bookingRequestId: "req-a", actId: self.id, sortOrder: 0 }),
      ).resolves.toMatchObject({ removedAt: null, sortOrder: 0, confirmation: "CONFIRMED" });
      const invitedAt = new Date("2026-10-02T12:00:00.000Z");
      await expect(
        fake.restoreAct({ bookingRequestId: "req-a", actId: tagged.id, sortOrder: 5, invitedAt }),
      ).resolves.toMatchObject({
        removedAt: null,
        sortOrder: 5,
        confirmation: "PENDING",
        respondedAt: null,
        invitedAt,
      });
      // Live row → refused.
      await expect(
        fake.restoreAct({ bookingRequestId: "req-a", actId: self.id, sortOrder: 0 }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });

      // DECLINED then removed → never restorable.
      await fake.setActConfirmation({
        ...KEY,
        expectedFrom: "PENDING",
        to: "DECLINED",
        respondedAt: new Date(),
      });
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: tagged.id, at: new Date() });
      await expect(
        fake.restoreAct({ bookingRequestId: "req-a", actId: tagged.id, sortOrder: 0 }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });

    it("setActSortOrders rewrites the live order and refuses a stale plan", async () => {
      const { fake, tagged, self, external } = await seed();
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: self.id, at: new Date() });
      for (const orderedActIds of [
        [external.id],
        [external.id, tagged.id, self.id],
        [external.id, external.id],
      ]) {
        await expect(
          fake.setActSortOrders({ bookingRequestId: "req-a", orderedActIds }),
        ).rejects.toMatchObject({ code: "conflict", message: "booking_request_bill_changed" });
      }
      const reordered = await fake.setActSortOrders({
        bookingRequestId: "req-a",
        orderedActIds: [external.id, tagged.id],
      });
      expect(reordered.map((r) => [r.id, r.sortOrder])).toEqual([
        [external.id, 0],
        [tagged.id, 1],
      ]);
    });

    it("setActRole changes a live act's role and mirrors the label CHECK", async () => {
      const { fake, tagged, external } = await seed();
      await expect(
        fake.setActRole({
          bookingRequestId: "req-a",
          actId: external.id,
          role: "OTHER",
          customRoleLabel: "MC",
        }),
      ).resolves.toMatchObject({ role: "OTHER", customRoleLabel: "MC" });
      await expect(
        fake.setActRole({
          bookingRequestId: "req-a",
          actId: external.id,
          role: "DJ",
          customRoleLabel: "MC",
        }),
      ).rejects.toThrow(/BookingRequestAct_custom_role_label_check/);
      await fake.softRemoveAct({ bookingRequestId: "req-a", actId: tagged.id, at: new Date() });
      await expect(
        fake.setActRole({
          bookingRequestId: "req-a",
          actId: tagged.id,
          role: "DJ",
          customRoleLabel: null,
        }),
      ).rejects.toMatchObject({ message: "booking_request_act_state_changed" });
    });
  });
});
