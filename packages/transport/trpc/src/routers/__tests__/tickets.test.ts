import { beforeEach, describe, expect, it, vi } from "vitest";

import * as scanTicketModule from "@th/core/use-cases/tickets/scan-ticket";
import * as transferTicketModule from "@th/core/use-cases/tickets/transfer-ticket";
import * as initiateEmailTransferModule from "@th/core/use-cases/tickets/initiate-email-transfer";
import * as claimPendingTransferModule from "@th/core/use-cases/tickets/claim-pending-transfer";
import { fail } from "@th/errors";

import { ticketsRouter } from "../tickets";
import { createCaller } from "./test-helpers";

describe("ticketsRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the error reporter to scanTicket", async () => {
    // The scan's audit write is a deliberate swallow, so it reports through
    // ReporterPort. `reportError` is OPTIONAL on ScanTicketDeps, so dropping
    // this one line from the router still satisfies its `satisfies` clause and
    // still passes typecheck and every core test — the door path just goes
    // silent in Sentry. This is the only gate on that.
    const reportError = vi.fn();
    const scanSpy = vi.spyOn(scanTicketModule, "scanTicket").mockResolvedValue({
      outcome: "ACCEPTED",
      ticketId: "77777777-7777-4777-8777-777777777777",
      eventId: "33333333-3333-4333-8333-333333333333",
      ownerHumanId: "22222222-2222-4222-8222-222222222222",
      scannedAt: new Date("2024-05-01T12:00:00.000Z"),
    });

    const { caller } = createCaller(ticketsRouter, { reportError });

    await caller.scanTicket({
      eventId: "33333333-3333-4333-8333-333333333333",
      ticketCode: "ABC123",
    });

    expect(scanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reportError }),
      expect.anything(),
    );
  });

  it("forwards dependencies and actor human id to scanTicket", async () => {
    const now = new Date("2024-05-01T12:00:00.000Z");
    const scanSpy = vi.spyOn(scanTicketModule, "scanTicket").mockResolvedValue({
      outcome: "ACCEPTED",
      ticketId: "77777777-7777-4777-8777-777777777777",
      eventId: "33333333-3333-4333-8333-333333333333",
      ownerHumanId: "22222222-2222-4222-8222-222222222222",
      scannedAt: now,
    });

    const { caller, ctx } = createCaller(ticketsRouter);

    const result = await caller.scanTicket({
      eventId: "33333333-3333-4333-8333-333333333333",
      ticketCode: "ABC123",
    });

    expect(result).toEqual({
      outcome: "ACCEPTED",
      ticketId: "77777777-7777-4777-8777-777777777777",
      eventId: "33333333-3333-4333-8333-333333333333",
      ownerHumanId: "22222222-2222-4222-8222-222222222222",
      scannedAt: now,
    });
    expect(scanSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        eventId: "33333333-3333-4333-8333-333333333333",
        ticketCode: "ABC123",
      }),
    );
  });

  it("maps use case errors to TRPC errors", async () => {
    vi.spyOn(scanTicketModule, "scanTicket").mockRejectedValue({
      code: "forbidden",
      message: "nope",
    });

    const { caller } = createCaller(ticketsRouter);

    await expect(
      caller.scanTicket({
        eventId: "33333333-3333-4333-8333-333333333333",
        ticketCode: "ABC123",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "nope" });
  });

  it("rejects when actor human id is missing", async () => {
    const scanSpy = vi.spyOn(scanTicketModule, "scanTicket").mockResolvedValue({
      outcome: "ACCEPTED",
      ticketId: "77777777-7777-4777-8777-777777777777",
      eventId: "33333333-3333-4333-8333-333333333333",
      ownerHumanId: "22222222-2222-4222-8222-222222222222",
      scannedAt: new Date(),
    });

    const overrides = {
      actorHumanId: null,
      auth: null,
      authToken: null,
    } as const;
    const { caller } = createCaller(ticketsRouter, overrides);

    await expect(
      caller.scanTicket({
        eventId: "33333333-3333-4333-8333-333333333333",
        ticketCode: "ABC123",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(scanSpy).not.toHaveBeenCalled();
  });
  // Owner rule 2026-09-28: every transfer door refuses a past event with a
  // PRECONDITION_FAILED that still carries the app code for the web copy.
  describe("TICKET_TRANSFER_EVENT_PAST", () => {
    const refuse = async (): Promise<never> => fail("TICKET_TRANSFER_EVENT_PAST");

    it("maps a direct transfer refusal", async () => {
      vi.spyOn(transferTicketModule, "transferTicket").mockImplementation(refuse);
      const { caller } = createCaller(ticketsRouter);
      await expect(
        caller.transferTicket({
          ticketId: "77777777-7777-4777-8777-777777777777",
          targetHumanId: "22222222-2222-4222-8222-222222222222",
          reason: "gift",
          clientKey: "client-key-123",
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "TICKET_TRANSFER_EVENT_PAST",
      });
    });

    it("maps an email-invite refusal", async () => {
      vi.spyOn(
        initiateEmailTransferModule,
        "initiateEmailTransfer",
      ).mockImplementation(refuse);
      const { caller } = createCaller(ticketsRouter);
      await expect(
        caller.initiateEmailTransfer({
          ticketId: "77777777-7777-4777-8777-777777777777",
          recipientEmail: "friend@example.com",
          reason: "gift",
          clientKey: "client-key-123",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("maps a claim refusal", async () => {
      vi.spyOn(
        claimPendingTransferModule,
        "claimPendingTransfer",
      ).mockImplementation(refuse);
      const { caller } = createCaller(ticketsRouter);
      await expect(
        caller.claimPendingTransfer({
          token: "claim-token",
          clientKey: "client-key-123",
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });
  });
});
