import { beforeEach, describe, expect, it, vi } from "vitest";

import { transferTicket } from "../transfer-ticket";
import type { TransferTicketDeps } from "../transfer-ticket";
import type { TransferTicketInput } from "../transfer-ticket";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { IdempotencyPort } from "@th/ports/idempotency";

const DEFAULT_EVENT: EventRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  humanId: null,
  title: "Sample Event",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-05-01T18:00:00Z"),
  endsAt: new Date("2024-05-01T21:00:00Z"),
  placeId: "place-123",
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Venue St",
  lat: 37.7749,
  lng: -122.4194,
  slug: "sample-event",
  shortId: "sample",
  regionCode: "US-CA",
  publishedAt: new Date("2024-04-20T12:00:00Z"),
  agreementPrimaryId: "agreement-primary",
  agreementResaleId: "agreement-resale",
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

const DEFAULT_TICKET: TicketRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  eventId: DEFAULT_EVENT.id,
  ticketTypeId: "55555555-5555-4555-8555-555555555555",
  ownerHumanId: "66666666-6666-4666-8666-666666666666",
  orderId: "77777777-7777-4777-8777-777777777777",
  orderItemId: "88888888-8888-4888-8888-888888888888",
  seatId: null,
  code: "TK123456",
  status: "VALID",
  issuedAt: new Date("2024-04-15T12:00:00Z"),
  scannedAt: null,
};

type TestContext = ReturnType<typeof makeContext>;

describe("transferTicket", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeContext();
    // Both writes are compare-and-swaps; the default is "this transfer won".
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...DEFAULT_EVENT });
    // Mock identity with verified email for most tests
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: DEFAULT_TICKET.ownerHumanId,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: DEFAULT_TICKET.ownerHumanId,
        email: "owner@example.com",
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  it("transfers a ticket when the actor is the owner", async () => {
    const input = baseInput();

    const result = await transferTicket(ctx.deps, input);

    expect(result).toEqual({
      ticketId: DEFAULT_TICKET.id,
      eventId: DEFAULT_TICKET.eventId,
      fromHumanId: DEFAULT_TICKET.ownerHumanId,
      toHumanId: input.targetHumanId,
      reason: input.reason,
      orderId: input.orderId,
      transferredAt: ctx.now,
    });

    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledWith({
      ticketId: DEFAULT_TICKET.id,
      fromHumanId: DEFAULT_TICKET.ownerHumanId,
      toHumanId: input.targetHumanId,
      reason: input.reason,
      orderId: input.orderId,
      // Compare-and-swap: only a ticket STILL VALID moves, so a refund that
      // landed between the read above and this write makes the transfer lose.
      expectedStatus: "VALID",
    });

    expect(ctx.mocks.orderItemsUpdateStatus).toHaveBeenCalledWith(
      DEFAULT_TICKET.orderItemId,
      "transferred",
      ctx.now,
      undefined,
      undefined,
      { expectedStatus: "active" },
    );

    expect(ctx.mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket",
        entityId: DEFAULT_TICKET.id,
        action: "transfer.resale",
        at: ctx.now,
      }),
    );

    expect(ctx.mocks.metricsIncrement).toHaveBeenCalledWith(
      "ticket.transfer",
      expect.objectContaining({
        eventId: DEFAULT_EVENT.id,
        outcome: "success",
        reason: "resale",
      }),
    );
  });

  // ── Money audit 2026-09-08 #19 ────────────────────────────────────────────
  // `ensureTicketTransferable` reads the ticket, then the adapter writes it.
  // Under READ COMMITTED nothing holds the row in between, so a refund landing
  // in that window used to leave BOTH sides "successful" — sender refunded,
  // recipient holding a live pass. The adapter write is now a compare-and-swap
  // and a loser must refuse, not overwrite.
  it("refuses when the ticket leaves VALID between the read and the write", async () => {
    ctx.mocks.ticketsTransfer.mockResolvedValue(false);
    const input = baseInput();

    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "TICKET_NOT_TRANSFERABLE",
    });

    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("refuses when the order item leaves 'active' between the read and the write", async () => {
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(false);
    const input = baseInput();

    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "TICKET_NOT_TRANSFERABLE",
    });

    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  });

  it("passes the CAS predicates the adapter needs to refuse a losing transfer", async () => {
    const input = baseInput();

    await transferTicket(ctx.deps, input);

    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: "VALID" }),
    );
    expect(ctx.mocks.orderItemsUpdateStatus).toHaveBeenCalledWith(
      DEFAULT_TICKET.orderItemId,
      "transferred",
      ctx.now,
      undefined,
      undefined,
      { expectedStatus: "active" },
    );
  });

  it("skips orderItems.updateStatus when ticket has no orderItemId", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      orderItemId: null,
    });
    const input = baseInput();

    await transferTicket(ctx.deps, input);

    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
  });

  it("enforces order id requirement for resale", async () => {
    await expect(
      transferTicket(ctx.deps, {
        ...baseInput(),
        orderId: null,
      }),
    ).rejects.toMatchObject({ code: "ORDER_REQUIRED_FOR_RESALE" });
  });

  it("rejects when actor is not owner for owner-only reasons", async () => {
    const input = {
      ...baseInput(),
      actorHumanId: "99999999-9999-4999-8999-999999999999",
    } satisfies TransferTicketInput;

    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("allows admin transfer for org staff", async () => {
    const input = {
      ...baseInput(),
      reason: "admin" as const,
      actorHumanId: "00000000-0000-4000-8000-000000000000",
    } satisfies TransferTicketInput;

    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: input.actorHumanId,
      role: "ADMIN",
    });

    const result = await transferTicket(ctx.deps, input);

    expect(result.reason).toBe("admin");
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalled();
  });

  // Owner ruling 2026-09-28: the organizer transfer on a PERSONAL event is
  // open to the owner's edit-role delegates (FINANCE delegates are not
  // editors, so the org arm's FINANCE does not carry over).
  describe("organizer transfer on a personal event, by a delegate", () => {
    const PRINCIPAL = "abababab-abab-4bab-8bab-abababababab";
    const DELEGATE = "00000000-0000-4000-8000-000000000000";

    const setup = (role: string) => {
      ctx.mocks.eventsGetById.mockResolvedValue({
        ...DEFAULT_EVENT,
        orgId: null,
        humanId: PRINCIPAL,
      });
      // One account email per human, so "is the recipient the delegate?"
      // is only true when a test makes it so.
      ctx.mocks.humansGetByIdWithIdentity.mockImplementation(
        async (id: string) => ({
          human: { id, name: null, status: "ACTIVE", roles: [], locale: null },
          identity: {
            authUserId: id,
            email: `${id}@example.com`,
            emailVerified: true,
          },
        }),
      );
      ctx.mocks.authzGetHumanDelegation.mockResolvedValue({
        orgId: PRINCIPAL,
        humanId: DELEGATE,
        role,
      });
      return {
        ...baseInput(),
        reason: "admin" as const,
        actorHumanId: DELEGATE,
      } satisfies TransferTicketInput;
    };

    it.each(["OWNER", "ADMIN", "EDITOR"])(
      "a %s delegate transfers",
      async (role) => {
        const result = await transferTicket(ctx.deps, setup(role));
        expect(result.reason).toBe("admin");
        expect(ctx.mocks.ticketsTransfer).toHaveBeenCalled();
      },
    );

    // Owner ruling 2026-09-28: a delegate may not transfer the principal's
    // tickets to THEMSELVES — by humanId, or to another Human whose account
    // email is the delegate's. Nothing is written on a refusal.
    it("refuses a delegate transferring to themselves (humanId), with no writes", async () => {
      await expect(
        transferTicket(ctx.deps, { ...setup("OWNER"), targetHumanId: DELEGATE }),
      ).rejects.toMatchObject({ code: "DELEGATE_SELF_BENEFIT_FORBIDDEN" });
      expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
      expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
    });

    it("refuses a delegate transferring to a Human that shares their mailbox", async () => {
      const input = setup("OWNER");
      ctx.mocks.humansGetByIdWithIdentity.mockImplementation(
        async (id: string) => ({
          human: { id, name: null, status: "ACTIVE", roles: [], locale: null },
          identity: {
            authUserId: id,
            // The delegate's account vs a second Human whose address differs
            // in case, dots and +tag but is the same Gmail mailbox — so the
            // canonical compare is what refuses it.
            email:
              id === DELEGATE
                ? "delegate.person@gmail.com"
                : "DelegatePerson+tix@GoogleMail.com",
            emailVerified: true,
          },
        }),
      );

      await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
        code: "DELEGATE_SELF_BENEFIT_FORBIDDEN",
      });
      expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    });

    it("the OWNER may still transfer to themselves", async () => {
      setup("OWNER");
      const result = await transferTicket(ctx.deps, {
        ...baseInput(),
        reason: "admin",
        actorHumanId: PRINCIPAL,
        targetHumanId: PRINCIPAL,
      });
      expect(result.toHumanId).toBe(PRINCIPAL);
      expect(ctx.mocks.ticketsTransfer).toHaveBeenCalled();
    });

    it.each(["VIEWER", "FINANCE", "SCANNER"])(
      "a %s delegate is refused",
      async (role) => {
        await expect(
          transferTicket(ctx.deps, setup(role)),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
        expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
      },
    );
  });

  it("returns cached result on idempotent replay", async () => {
    const input = baseInput();

    const first = await transferTicket(ctx.deps, input);
    expect(first).toBeDefined();

    const transferCalls = ctx.mocks.ticketsTransfer.mock.calls.length;
    const auditCalls = ctx.mocks.auditLog.mock.calls.length;
    const metricsCalls = ctx.mocks.metricsIncrement.mock.calls.length;

    const replay = await transferTicket(ctx.deps, input);
    expect(replay).toEqual(first);
    expect(ctx.mocks.ticketsTransfer.mock.calls.length).toBe(transferCalls);
    expect(ctx.mocks.auditLog.mock.calls.length).toBe(auditCalls);
    expect(ctx.mocks.metricsIncrement.mock.calls.length).toBe(metricsCalls);
  });

  // ── Ticket-status guard (money audit #13) ──────────────────────────────
  // `initiateEmailTransfer` already refuses anything but VALID; a direct
  // transfer must follow the same rule or a LISTED / SCANNED / REFUNDED /
  // INVALID ticket can be gifted out from under its listing, scan or refund.
  it.each(["LISTED", "SCANNED", "REFUNDED", "INVALID"] as const)(
    "refuses to transfer a %s ticket",
    async (status) => {
      ctx.mocks.ticketsGetById.mockResolvedValue({
        ...DEFAULT_TICKET,
        status,
      });

      await expect(transferTicket(ctx.deps, baseInput())).rejects.toMatchObject({
        code: "TICKET_NOT_TRANSFERABLE",
      });
      expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
      expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
      expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
    },
  );

  it("refuses a non-VALID ticket even for an org admin transfer", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      status: "SCANNED",
    });
    const input = {
      ...baseInput(),
      reason: "admin" as const,
      actorHumanId: "00000000-0000-4000-8000-000000000000",
    } satisfies TransferTicketInput;
    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: input.actorHumanId,
      role: "ADMIN",
    });

    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "TICKET_NOT_TRANSFERABLE",
    });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("still transfers a VALID ticket", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      status: "VALID",
    });

    await expect(transferTicket(ctx.deps, baseInput())).resolves.toMatchObject({
      ticketId: DEFAULT_TICKET.id,
    });
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
  });

  it("disallows resale when the event lacks a resale agreement", async () => {
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...DEFAULT_EVENT,
      agreementResaleId: null,
    });

    await expect(transferTicket(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "RESALE_DISABLED_FOR_EVENT",
    });
  });

  it("requires verified email for non-admin transfers", async () => {
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: DEFAULT_TICKET.ownerHumanId,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: DEFAULT_TICKET.ownerHumanId,
        email: "test@example.com",
        emailVerified: false,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });

    await expect(transferTicket(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("requires verified email for admin transfers", async () => {
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: "00000000-0000-4000-8000-000000000000",
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: "00000000-0000-4000-8000-000000000000",
        email: "admin@example.com",
        emailVerified: false,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });

    const input = {
      ...baseInput(),
      reason: "admin" as const,
      actorHumanId: "00000000-0000-4000-8000-000000000000",
    } satisfies TransferTicketInput;

    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: input.actorHumanId,
      role: "ADMIN",
    });

    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "forbidden",
      message: "email_verification_required",
    });
  });
});

// ── Owner rule 2026-09-28: no transfers once the event is over ─────────────
// `ctx.now` is the injected clock (2024-05-01T18:00Z). Each case moves the
// event's times around that instant rather than the clock.
describe("transferTicket — past events", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeContext();
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: DEFAULT_TICKET.ownerHumanId,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: DEFAULT_TICKET.ownerHumanId,
        email: "owner@example.com",
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  function eventEnding(endsAt: Date | null, startsAt?: Date) {
    ctx.mocks.eventsGetById.mockResolvedValue({
      ...DEFAULT_EVENT,
      startsAt: startsAt ?? new Date(ctx.now.getTime() - 3 * 60 * 60 * 1000),
      endsAt,
    });
  }

  async function expectRefused(input: TransferTicketInput = baseInput()) {
    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "TICKET_TRANSFER_EVENT_PAST",
    });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
  }

  it("refuses once the event has ended", async () => {
    eventEnding(new Date(ctx.now.getTime() - 60_000));
    await expectRefused();
  });

  it("refuses at the exact end instant", async () => {
    eventEnding(new Date(ctx.now.getTime()));
    await expectRefused();
  });

  it("still transfers one millisecond before the end", async () => {
    eventEnding(new Date(ctx.now.getTime() + 1));
    const result = await transferTicket(ctx.deps, baseInput());
    expect(result.transferredAt).toBe(ctx.now);
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalled();
  });

  it("uses the start when the event has no end", async () => {
    eventEnding(null, new Date(ctx.now.getTime()));
    await expectRefused();
  });

  it("allows a future event with no end", async () => {
    eventEnding(null, new Date(ctx.now.getTime() + 60_000));
    await expect(transferTicket(ctx.deps, baseInput())).resolves.toMatchObject(
      { ticketId: DEFAULT_TICKET.id },
    );
  });

  it("refuses an organizer admin transfer too", async () => {
    eventEnding(new Date(ctx.now.getTime() - 60_000));
    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: "00000000-0000-4000-8000-000000000000",
      role: "ADMIN",
    });
    await expectRefused({
      ...baseInput(),
      reason: "admin",
      actorHumanId: "00000000-0000-4000-8000-000000000000",
    });
  });

  it("reads the injected clock, not the wall clock", async () => {
    // The event ended in 2024; a wall-clock read would call it past. Pin the
    // clock before the end and the transfer goes through.
    eventEnding(new Date("2024-05-01T21:00:00Z"));
    vi.mocked(ctx.deps.clock.now).mockReturnValue(
      new Date("2024-05-01T20:59:59Z"),
    );
    await expect(transferTicket(ctx.deps, baseInput())).resolves.toBeDefined();
  });

  it("tells a non-owner they are not the owner, not that the event is over", async () => {
    eventEnding(new Date(ctx.now.getTime() - 60_000));
    await expect(
      transferTicket(ctx.deps, {
        ...baseInput(),
        reason: "gift",
        actorHumanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

// ── Owner ruling 2026-10-04: "transfers should be frozen" ─────────────────
// A buyer with an unresolved resale claim on the ticket's order item cannot
// move it — otherwise a later full_refund approval takes back a ticket
// someone else now holds. Every reason refuses, organizer `admin` included.
describe("transferTicket — frozen while a resale claim is unresolved", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeContext();
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...DEFAULT_EVENT });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: {
        id: DEFAULT_TICKET.ownerHumanId,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
      },
      identity: {
        authUserId: DEFAULT_TICKET.ownerHumanId,
        email: "owner@example.com",
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        username: null,
        displayUsername: null,
        image: null,
      },
    });
  });

  function claimWithStatus(status: string) {
    ctx.mocks.claimsGetByOrderItemId.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      orderItemId: DEFAULT_TICKET.orderItemId,
      orderId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      status,
    });
  }

  const OWNER_REASONS = ["primary", "resale", "gift"] as const;

  for (const status of ["open", "under_review"]) {
    for (const reason of OWNER_REASONS) {
      it(`refuses a ${reason} transfer while the claim is ${status}`, async () => {
        claimWithStatus(status);

        await expect(
          transferTicket(ctx.deps, { ...baseInput(), reason }),
        ).rejects.toMatchObject({ code: "TICKET_UNDER_CLAIM" });

        expect(ctx.mocks.claimsLockOrderItem).toHaveBeenCalledWith(
          DEFAULT_TICKET.orderItemId,
        );
        expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
        expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
        expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
        // The refusal frees the key: a retry once the claim closes is not
        // locked out.
        expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
          `ticket:transfer:${DEFAULT_TICKET.id}:${baseInput().clientKey}`,
          expect.any(String),
        );
      });
    }

    it(`refuses an organizer admin transfer while the claim is ${status}`, async () => {
      claimWithStatus(status);
      const input = {
        ...baseInput(),
        reason: "admin" as const,
        actorHumanId: "00000000-0000-4000-8000-000000000000",
      } satisfies TransferTicketInput;
      ctx.mocks.authzGetOrgMembership.mockResolvedValue({
        orgId: DEFAULT_EVENT.orgId!,
        humanId: input.actorHumanId,
        role: "ADMIN",
      });

      await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
        code: "TICKET_UNDER_CLAIM",
      });
      expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
      expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
        `ticket:transfer:${DEFAULT_TICKET.id}:${input.clientKey}`,
        expect.any(String),
      );
    });
  }

  for (const status of ["denied", "expired"]) {
    it(`transfers once the claim is ${status}`, async () => {
      claimWithStatus(status);

      const result = await transferTicket(ctx.deps, baseInput());

      expect(result.toHumanId).toBe(baseInput().targetHumanId);
      expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
    });
  }

  // Owner ruling 2026-10-05: approval commits before its refund lands, and a
  // pending refund or a retry still unwinds the ticket, so an approved claim
  // keeps the freeze until the resale order is REFUNDED.
  it("refuses while the claim is approved and its refund has not landed", async () => {
    claimWithStatus("approved");
    ctx.mocks.ordersGetById.mockResolvedValue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "SUCCEEDED" });

    await expect(
      transferTicket(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_UNDER_CLAIM" });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.ordersGetById).toHaveBeenCalledWith("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  it("frees the ticket once the approved claim's order is REFUNDED", async () => {
    claimWithStatus("approved");
    ctx.mocks.ordersGetById.mockResolvedValue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "REFUNDED" });

    const result = await transferTicket(ctx.deps, baseInput());
    expect(result.toHumanId).toBe(baseInput().targetHumanId);
  });

  it("takes the claim lock before reading the claim and before any write", async () => {
    await transferTicket(ctx.deps, baseInput());

    expect(ctx.mocks.claimsLockOrderItem).toHaveBeenCalledWith(
      DEFAULT_TICKET.orderItemId,
    );
    const lockAt = ctx.mocks.claimsLockOrderItem.mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(
      ctx.mocks.claimsGetByOrderItemId.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.ticketsTransfer.mock.invocationCallOrder[0]!,
    );
    expect(lockAt).toBeLessThan(
      ctx.mocks.orderItemsUpdateStatus.mock.invocationCallOrder[0]!,
    );
  });

  it("skips the claim check (and the lock) for a ticket with no order item", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      orderItemId: null,
    });

    await transferTicket(ctx.deps, baseInput());

    expect(ctx.mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    expect(ctx.mocks.claimsGetByOrderItemId).not.toHaveBeenCalled();
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
  });
});

// Owner ruling 2026-10-05: "when the refund is in process nothing can happen
// to the ticket". The move holds the refund paths' own per-order mutex.
describe("transferTicket — locked out while a refund is in flight", () => {
  let ctx: TestContext;
  const REFUND_KEY = `refund-op:${DEFAULT_TICKET.orderId}`;
  const SITE_KEY = `ticket:transfer:${DEFAULT_TICKET.id}:${baseInput().clientKey}`;

  beforeEach(() => {
    ctx = makeContext();
    ctx.mocks.ticketsTransfer.mockResolvedValue(true);
    ctx.mocks.orderItemsUpdateStatus.mockResolvedValue(true);
    ctx.mocks.ticketsGetById.mockResolvedValue({ ...DEFAULT_TICKET });
    ctx.mocks.eventsGetById.mockResolvedValue({ ...DEFAULT_EVENT });
    ctx.mocks.humansGetByIdWithIdentity.mockResolvedValue({
      human: { id: DEFAULT_TICKET.ownerHumanId },
      identity: { email: "owner@example.com", emailVerified: true },
    });
  });

  function refundBegins() {
    return ctx.mocks.idempotencyBegin.mock.calls.filter(([key]) =>
      String(key).startsWith("refund-op:"),
    );
  }

  it("holds refund-op:<the ticket's order> after the site claim and frees it after the tx commits", async () => {
    await transferTicket(ctx.deps, baseInput());

    expect(ctx.mocks.orderItemsGetById).toHaveBeenCalledWith(
      DEFAULT_TICKET.orderItemId,
    );
    expect(ctx.mocks.idempotencyBegin).toHaveBeenCalledWith(
      REFUND_KEY,
      60,
      expect.any(String),
    );
    const calls = ctx.mocks.idempotencyBegin.mock.calls;
    const order = ctx.mocks.idempotencyBegin.mock.invocationCallOrder;
    const siteAt = order[calls.findIndex(([k]) => k === SITE_KEY)]!;
    const refundAt = order[calls.findIndex(([k]) => k === REFUND_KEY)]!;
    expect(siteAt).toBeLessThan(refundAt);

    const token = calls.find(([k]) => k === REFUND_KEY)![2];
    expect(ctx.mocks.idempotencyRelease).toHaveBeenCalledWith(REFUND_KEY, token);
    // Released only after the tx's last write.
    expect(
      ctx.mocks.idempotencyRelease.mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(ctx.mocks.auditLog.mock.invocationCallOrder[0]!);
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(false);
  });

  it("refuses with TICKET_REFUND_IN_PROGRESS while a refund holds the order, writes nothing, leaves the refund's lock alone", async () => {
    ctx.mocks.idempotencyLocks.add(REFUND_KEY);

    await expect(
      transferTicket(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_REFUND_IN_PROGRESS" });

    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.orderItemsUpdateStatus).not.toHaveBeenCalled();
    expect(ctx.mocks.auditLog).not.toHaveBeenCalled();
    // Refused before the claim lock: no row locks for a doomed move.
    expect(ctx.mocks.claimsLockOrderItem).not.toHaveBeenCalled();
    // Same site-key handling as TICKET_UNDER_CLAIM.
    expect(ctx.mocks.idempotencyFail).toHaveBeenCalledWith(
      SITE_KEY,
      expect.any(String),
    );
    expect(ctx.mocks.idempotencyRelease).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(true);
  });

  it("refuses an organizer admin move too", async () => {
    ctx.mocks.idempotencyLocks.add(REFUND_KEY);
    const input = {
      ...baseInput(),
      reason: "admin" as const,
      actorHumanId: "00000000-0000-4000-8000-000000000000",
    } satisfies TransferTicketInput;
    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: input.actorHumanId,
      role: "ADMIN",
    });

    await expect(transferTicket(ctx.deps, input)).rejects.toMatchObject({
      code: "TICKET_REFUND_IN_PROGRESS",
    });
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
  });

  it("tells a caller who does not own the ticket NOT_RESOURCE_OWNER, not that a refund is running", async () => {
    ctx.mocks.idempotencyLocks.add(REFUND_KEY);

    await expect(
      transferTicket(ctx.deps, {
        ...baseInput(),
        reason: "gift",
        actorHumanId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    // Review round 1: a stranger never holds (or even tries) the seller's
    // order mutex, so spamming public ticket ids cannot stall refunds.
    expect(refundBegins()).toHaveLength(0);
  });

  it("an organizer without an edit/finance role never touches the mutex and still gets INSUFFICIENT_ROLE", async () => {
    ctx.mocks.authzGetOrgMembership.mockResolvedValue(null);

    await expect(
      transferTicket(ctx.deps, {
        ...baseInput(),
        reason: "admin",
        actorHumanId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(refundBegins()).toHaveLength(0);
  });

  it("an authorized organizer admin move does take the ticket's refund lock", async () => {
    const input = {
      ...baseInput(),
      reason: "admin" as const,
      actorHumanId: "00000000-0000-4000-8000-000000000000",
    } satisfies TransferTicketInput;
    ctx.mocks.authzGetOrgMembership.mockResolvedValue({
      orgId: DEFAULT_EVENT.orgId!,
      humanId: input.actorHumanId,
      role: "ADMIN",
    });

    await transferTicket(ctx.deps, input);

    expect(refundBegins().map((c) => c[0])).toEqual([REFUND_KEY]);
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
  });

  it("frees the lock when the move fails", async () => {
    ctx.mocks.ticketsTransfer.mockResolvedValue(false);

    await expect(
      transferTicket(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_NOT_TRANSFERABLE" });

    expect(ctx.mocks.idempotencyRelease).toHaveBeenCalledWith(
      REFUND_KEY,
      expect.any(String),
    );
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(false);
  });

  it("refuses when the ticket moved to another order item after the lock was picked", async () => {
    const OTHER_ITEM = "99999999-9999-4999-8999-999999999999";
    // Pre-tx read (picks the lock) sees the old item; the tx sees the new one.
    ctx.mocks.ticketsGetById.mockResolvedValueOnce({
      ...DEFAULT_TICKET,
      orderItemId: OTHER_ITEM,
    });

    await expect(
      transferTicket(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_REFUND_IN_PROGRESS" });

    expect(ctx.mocks.orderItemsGetById).toHaveBeenCalledWith(OTHER_ITEM);
    expect(ctx.mocks.ticketsTransfer).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotencyLocks.has(REFUND_KEY)).toBe(false);
  });

  it("takes no refund lock for a ticket with no order item", async () => {
    ctx.mocks.ticketsGetById.mockResolvedValue({
      ...DEFAULT_TICKET,
      orderItemId: null,
    });

    await transferTicket(ctx.deps, baseInput());

    expect(refundBegins()).toHaveLength(0);
    expect(ctx.mocks.ticketsTransfer).toHaveBeenCalledTimes(1);
  });
});

function baseInput(): TransferTicketInput {
  return {
    actorHumanId: DEFAULT_TICKET.ownerHumanId,
    ticketId: DEFAULT_TICKET.id,
    targetHumanId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    reason: "resale",
    orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    clientKey: "transfer-key-123456",
  };
}

function makeContext() {
  const ticketsGetById = vi.fn();
  const ticketsTransfer = vi.fn();
  const eventsGetById = vi.fn();
  const humansGetById = vi.fn();
  const humansGetByIdWithIdentity = vi.fn();
  const authzGetOrgMembership = vi.fn();
  const authzGetHumanDelegation = vi.fn(async (): Promise<unknown> => null);
  const orderItemsUpdateStatus = vi.fn();
  const auditLog = vi.fn();
  const metricsIncrement = vi.fn();
  const claimsLockOrderItem = vi.fn(async (): Promise<void> => undefined);
  const claimsGetByOrderItemId = vi.fn(async (): Promise<unknown> => null);
  // The resale order behind an approved claim: the freeze holds until it
  // is REFUNDED (owner ruling 2026-10-05).
  const ordersGetById = vi.fn(async (): Promise<unknown> => null);
  // Pre-tx lookup that picks the ticket's order refund mutex (owner ruling
  // 2026-10-05).
  const orderItemsGetById = vi.fn(async (id: string): Promise<unknown> => ({
    id,
    orderId: DEFAULT_TICKET.orderId,
  }));

  const idempotencyStore = new Map<string, unknown>();
  const idempotencyLocks = new Set<string>();

  const idempotencyTokens = new Map<string, string | undefined>();
  const begin = vi.fn(
    async (key: string, _ttlSec?: number, ownerToken?: string) => {
      if (idempotencyLocks.has(key)) return false;
      idempotencyLocks.add(key);
      idempotencyTokens.set(key, ownerToken);
      return true;
    },
  );
  // Owner-checked, like both real adapters.
  const release = vi.fn(async (key: string, ownerToken: string) => {
    if (!idempotencyLocks.has(key) || idempotencyTokens.get(key) !== ownerToken)
      return false;
    idempotencyLocks.delete(key);
    return true;
  });

  async function commit<T>(key: string, value: T): Promise<void> {
    idempotencyStore.set(key, value);
    idempotencyLocks.delete(key);
  }

  const fail = vi.fn(async (key: string, _error?: string): Promise<void> => {
    idempotencyLocks.delete(key);
  });

  async function get<T>(key: string): Promise<T | null> {
    if (!idempotencyStore.has(key)) {
      return null;
    }
    return idempotencyStore.get(key) as T;
  }

  async function run<T>(
    key: string,
    ttlSec: number,
    fn: () => Promise<T>,
  ): Promise<{ fresh: boolean; result: T }> {
    if (!(await begin(key, ttlSec))) {
      const cached = await get<T>(key);
      if (cached !== null) {
        return { fresh: false, result: cached };
      }
    }
    const result = await fn();
    await commit(key, result);
    return { fresh: true, result };
  }

  const idempotency: IdempotencyPort = {
    begin,
    commit,
    fail,
    get,
    run,
    release,
    purgeExpired: async () => 0,
  };

  const now = new Date("2024-05-01T18:00:00Z");

  const tx = {
    tickets: {
      getById: ticketsGetById,
      transfer: ticketsTransfer,
      findBySeatIds: vi.fn(),
      markScanned: vi.fn(),
      getByCode: vi.fn(),
      setStatus: vi.fn(),
      recordScan: vi.fn(),
      create: vi.fn(),
      countForOrderTicketType: vi.fn(),
      countIssuedForTicketType: vi.fn(),
      countIssuedForEvent: vi.fn(),
      createTicketType: vi.fn(),
      findTicketTypeByName: vi.fn(),
    },
    events: {
      getById: eventsGetById,
      listTicketTypes: vi.fn(),
    },
    humans: {
      getById: humansGetById,
      getByIdWithIdentity: humansGetByIdWithIdentity,
      getByEmail: vi.fn(),
      getByPhone: vi.fn(),
      getHumanIdForAuthUserId: vi.fn(),
      linkAuthUserToHuman: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      ensureByProvider: vi.fn(),
    },
    authz: {
      getOrgMembership: authzGetOrgMembership,
      getHumanDelegation: authzGetHumanDelegation,
    },
    orderItems: {
      updateStatus: orderItemsUpdateStatus,
    },
    claims: {
      lockOrderItem: claimsLockOrderItem,
      getByOrderItemId: claimsGetByOrderItemId,
    },
    orders: {
      getById: ordersGetById,
    },
    audit: {
      log: auditLog,
    },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    tickets: { getById: ticketsGetById },
    orderItems: { getById: orderItemsGetById },
    // Reads the `mayLock` pre-filter makes for an organizer `admin` move.
    events: { getById: eventsGetById },
    authz: {
      getOrgMembership: authzGetOrgMembership,
      getHumanDelegation: authzGetHumanDelegation,
    },
    humans: {
      getById: humansGetById,
      getByIdWithIdentity: humansGetByIdWithIdentity,
    },
  } as unknown as Repos;

  const deps: TransferTicketDeps = {
    repos,
    idempotency,
    clock: {
      now: vi.fn(() => now),
    },
    metrics: {
      increment: metricsIncrement,
      record: vi.fn(),
    },
    logger: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        withTime: vi.fn(async (_name, runner) => runner()),
      })) as any,
      withTime: vi.fn(async (_name, runner) => runner()),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
    } as any,
  };

  return {
    deps,
    mocks: {
      authzGetHumanDelegation,
      ticketsGetById,
      ticketsTransfer,
      eventsGetById,
      humansGetById,
      humansGetByIdWithIdentity,
      authzGetOrgMembership,
      orderItemsUpdateStatus,
      auditLog,
      metricsIncrement,
      claimsLockOrderItem,
      claimsGetByOrderItemId,
      ordersGetById,
      idempotencyFail: fail,
      idempotencyBegin: begin,
      idempotencyRelease: release,
      idempotencyLocks,
      orderItemsGetById,
    },
    now,
  };
}
