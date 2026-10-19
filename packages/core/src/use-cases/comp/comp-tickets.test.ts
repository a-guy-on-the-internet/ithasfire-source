import { describe, expect, it, vi } from "vitest";

import { issueCompTickets } from "./issue-comp-tickets";
import type { IssueCompTicketsDeps } from "./issue-comp-tickets";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { EventRecord } from "@th/ports/repos/events";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000004";
const RECIPIENT_HUMAN_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-06-01T12:00:00.000Z");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-07-01T18:00:00Z"),
  endsAt: new Date("2026-07-01T23:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  locality: null,
  region: null,
  countryCode: null,
  postalCode: null,
  shortId: null,
  slug: null,
  currency: "usd",
  heroImageUrl: null,
  content: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  refundCutoffAt: null,
  admissionTaxRateBps: null,
  taxRateSource: null,
  agreementPrimaryId: null,
  agreementResaleId: null,
  placeLayoutId: null,
  createdAt: NOW,
  updatedAt: NOW,
} as EventRecord;

const baseTicketType = {
  id: TICKET_TYPE_ID,
  name: "General Admission",
  priceCents: 5000,
  capacity: 100,
  status: "ACTIVE" as const,
  seatSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
};

// ── Shared mock builder ──────────────────────────────────────────────────────

function makeTxRepos(
  overrides: Record<string, unknown> = {},
): Partial<TxRepos> {
  return {
    events: {
      getById: vi.fn(async () => baseEvent),
      listTicketTypes: vi.fn(async () => [baseTicketType]),
    },
    authz: {
      getHumanDelegation: vi.fn(async () => null),
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    humans: {
      ensureGuestHuman: vi.fn(async () => ({
        humanId: RECIPIENT_HUMAN_ID,
        created: true,
      })),
      update: vi.fn(async (id: string, updates: any) => ({ id, ...updates })),
      // The delegate self-benefit check (owner ruling 2026-09-28) reads the
      // actor's account email and resolves the recipient email. Neither is
      // the actor unless a test says so.
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: ACTOR_ID },
        identity: { email: "actor@example.com" },
      })),
      getByEmail: vi.fn(async () => null),
    },
    tickets: {
      countIssuedForTicketType: vi.fn(async () => 10),
      countCapacityConsumingForTicketType: vi.fn(async () => 10),
      countForOrderTicketType: vi.fn(async () => 0),
      getByOrderItemId: vi.fn(async () => null),
      create: vi.fn(async (input: any) => ({
        id: crypto.randomUUID(),
        ...input,
      })),
    },
    orders: {
      createPending: vi.fn(async (input: any) => ({
        id: input.id,
        amountGrossCents: 0,
        feesPlatformCents: 0,
        currency: "usd",
      })),
      markSucceeded: vi.fn(async () => undefined),
      getById: vi.fn(async (id: string) => ({
        id,
        eventId: EVENT_ID,
        buyerHumanId: RECIPIENT_HUMAN_ID,
        amountGrossCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        currency: "usd",
        feePolicySnapshot: {},
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        source: "COMP",
        occurredAt: NOW,
        paidOutAt: null,
        parentOrderId: null,
        paymentMethodType: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        stripeTaxCalculationId: null,
        items: [
          {
            id: crypto.randomUUID(),
            orderId: id,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 0,
            amountCents: 0,
            meta: {},
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
          {
            id: crypto.randomUUID(),
            orderId: id,
            kind: "ticket",
            ticketTypeId: TICKET_TYPE_ID,
            qty: 1,
            unitPriceCents: 0,
            amountCents: 0,
            meta: {},
            paidOutAt: null,
            refundedAt: null,
            transferredAt: null,
            status: "active",
          },
        ],
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    seats: { updateStatuses: vi.fn(async () => undefined) },
    ...overrides,
  } as any;
}

function makeDeps(
  txOverrides: Record<string, unknown> = {},
): IssueCompTicketsDeps {
  const txRepos = makeTxRepos(txOverrides);
  return {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
    clock: { now: () => NOW },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// issueCompTickets
// ══════════════════════════════════════════════════════════════════════════════

describe("issueCompTickets", () => {
  const validInput = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    ticketTypeId: TICKET_TYPE_ID,
    quantity: 2,
    recipientEmail: "guest@example.com",
    recipientName: "Guest User",
    reason: "VIP guest",
  };

  it("creates a $0 COMP order and returns orderId", async () => {
    const deps = makeDeps();
    const result = await issueCompTickets(deps, validInput);

    expect(result.orderId).toBeDefined();
    expect(result.recipientHumanId).toBe(RECIPIENT_HUMAN_ID);
  });

  // Refunds restock (spec 2026-10-09, FR-003): the capacity warning and the
  // mint backstop count places still held. All 100 rows exist, but 90 were
  // refunded, so a comp of two fits: no warning, and it mints.
  it("counts only places still held, so refunded tickets free room for a comp", async () => {
    const warn = vi.fn();
    const scopedLogger = {
      ...createTestLogger(),
      warn,
      withTime: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    };
    const logger = {
      ...createTestLogger(),
      child: vi.fn(() => scopedLogger),
    } as unknown as LoggerPort;
    const base = makeTxRepos().tickets as Record<string, unknown>;
    const deps = {
      ...makeDeps({
        tickets: {
          ...base,
          countIssuedForTicketType: vi.fn(async () => 100),
          countCapacityConsumingForTicketType: vi.fn(async () => 10),
        },
      }),
      logger,
    };

    const result = await issueCompTickets(deps, validInput);

    expect(result.orderId).toBeDefined();
    expect(warn).not.toHaveBeenCalledWith(
      "issueCompTickets.capacity_warning",
      expect.anything(),
    );
  });

  it("creates order with COMP source and zero amounts", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await issueCompTickets(deps, validInput);

    expect((txRepos.orders as any).createPending).toHaveBeenCalledWith(
      expect.objectContaining({ source: "COMP", amountGrossCents: 0 }),
    );
    expect((txRepos.orders as any).markSucceeded).toHaveBeenCalled();
  });

  // Provenance lives on the order so the comps ledger can be a plain Order
  // read instead of a query against the audit log.
  it("stamps the reason and issuer onto the order", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await issueCompTickets(deps, validInput);

    expect((txRepos.orders as any).createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        compReason: "VIP guest",
        compIssuedByHumanId: ACTOR_ID,
      }),
    );
  });

  // Reason is optional on the form; absent must persist as null rather than
  // undefined so the column is written explicitly.
  it("stamps a null reason when none was given", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    const { reason: _omitted, ...withoutReason } = validInput;
    await issueCompTickets(deps, withoutReason);

    expect((txRepos.orders as any).createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        compReason: null,
        compIssuedByHumanId: ACTOR_ID,
      }),
    );
  });

  // The audit log is the tamper-evident record; the columns are only a
  // queryable projection of it. Promoting the fields must not have replaced it.
  it("still writes the comp_issued audit entry", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await issueCompTickets(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "comp_issued",
        data: expect.objectContaining({
          reason: "VIP guest",
          issuedByHumanId: ACTOR_ID,
        }),
      }),
    );
  });

  it("resolves recipient via ensureGuestHuman", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await issueCompTickets(deps, validInput);

    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "guest@example.com",
    });
    expect((txRepos.humans as any).update).toHaveBeenCalledWith(
      RECIPIENT_HUMAN_ID,
      { name: "Guest User" },
    );
  });

  it("leaves a NEW recipient unnamed when no recipientName is given (never named after the email)", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };
    const { recipientName: _omit, ...noName } = validInput;

    await issueCompTickets(deps, noName);

    expect((txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("never renames an EXISTING account the organizer comps by email", async () => {
    const txRepos = makeTxRepos();
    (txRepos.humans as any).ensureGuestHuman.mockResolvedValueOnce({
      humanId: RECIPIENT_HUMAN_ID,
      created: false,
    });
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await issueCompTickets(deps, validInput);

    expect((txRepos.humans as any).ensureGuestHuman).toHaveBeenCalledWith({
      email: "guest@example.com",
    });
    expect((txRepos.humans as any).update).not.toHaveBeenCalled();
  });

  it("rejects when event is not found", async () => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => null),
        listTicketTypes: vi.fn(async () => []),
      },
    });

    await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });

  it("rejects when event is cancelled", async () => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => ({ ...baseEvent, status: "CANCELLED" })),
        listTicketTypes: vi.fn(async () => [baseTicketType]),
      },
    });

    await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
      code: "EVENT_CANCELLED",
    });
  });

  describe("a COMMUNITY listing (owner ruling 2026-10-07: no comps)", () => {
    it("is refused with EVENT_NOT_TICKETED, and nothing is written", async () => {
      const txRepos = makeTxRepos({
        events: {
          // Ownerless by DB constraint: orgId AND humanId null.
          getById: vi.fn(async () => ({
            ...baseEvent,
            orgId: null,
            humanId: null,
            stewardship: "COMMUNITY",
          })),
          listTicketTypes: vi.fn(async () => [baseTicketType]),
        },
      });
      const deps: IssueCompTicketsDeps = {
        repos: {
          tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
            fn(txRepos as TxRepos),
          ),
        } as unknown as Repos,
        clock: { now: () => NOW },
      };

      await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
        code: "EVENT_NOT_TICKETED",
      });
      expect(txRepos.orders!.createPending).not.toHaveBeenCalled();
      expect(txRepos.humans!.ensureGuestHuman).not.toHaveBeenCalled();
      expect(txRepos.audit!.log).not.toHaveBeenCalled();
    });

    it("is refused by stewardship BEFORE the role check, even for an org ADMIN the role check admits", async () => {
      // Not a shape the DB allows (COMMUNITY rows carry no orgId); it pins
      // that the refusal is the stewardship guard, not the owner arms
      // refusing an ownerless row by accident. The default fake grants ADMIN.
      const txRepos = makeTxRepos({
        events: {
          getById: vi.fn(async () => ({
            ...baseEvent,
            stewardship: "COMMUNITY",
          })),
          listTicketTypes: vi.fn(async () => [baseTicketType]),
        },
      });
      const deps: IssueCompTicketsDeps = {
        repos: {
          tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
            fn(txRepos as TxRepos),
          ),
        } as unknown as Repos,
        clock: { now: () => NOW },
      };

      await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
        code: "EVENT_NOT_TICKETED",
      });
      expect(txRepos.authz!.getOrgMembership).not.toHaveBeenCalled();
      expect(txRepos.orders!.createPending).not.toHaveBeenCalled();
    });
  });

  it("rejects when actor lacks ADMIN role", async () => {
    const deps = makeDeps({
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })),
      },
    });

    await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("rejects when ticket type does not exist", async () => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => baseEvent),
        listTicketTypes: vi.fn(async () => []),
      },
    });

    await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_FOUND",
    });
  });

  it("rejects invalid input (bad email)", async () => {
    const deps = makeDeps();
    await expect(
      issueCompTickets(deps, { ...validInput, recipientEmail: "not-an-email" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects invalid input (quantity 0)", async () => {
    const deps = makeDeps();
    await expect(
      issueCompTickets(deps, { ...validInput, quantity: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("allows personal event owner (no org) to issue", async () => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          orgId: null,
          humanId: ACTOR_ID,
        })),
        listTicketTypes: vi.fn(async () => [baseTicketType]),
      },
    });

    const result = await issueCompTickets(deps, validInput);
    expect(result.orderId).toBeDefined();
  });

  it("rejects when personal event owner mismatch", async () => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          orgId: null,
          humanId: "someone-else",
        })),
        listTicketTypes: vi.fn(async () => [baseTicketType]),
      },
    });

    await expect(issueCompTickets(deps, validInput)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  // Owner ruling 2026-09-28: comps are not payout routing — an OWNER/ADMIN
  // delegate of the personal event's owner issues them (the org arm's
  // ORG_ADMIN_ROLES); an EDITOR delegate, like an org EDITOR, may not.
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["EDITOR", false],
    ["VIEWER", false],
  ] as const)("a %s delegate of the personal event's owner → allowed=%s", async (role, allowed) => {
    const deps = makeDeps({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          orgId: null,
          humanId: "principal-human",
        })),
        listTicketTypes: vi.fn(async () => [baseTicketType]),
      },
      authz: {
        getHumanDelegation: vi.fn(async () => ({
          orgId: "principal-human",
          humanId: validInput.actorHumanId,
          role,
        })),
        getOrgMembership: vi.fn(async () => null),
      },
    });

    const run = issueCompTickets(deps, validInput);
    if (allowed) {
      await expect(run).resolves.toBeDefined();
    } else {
      await expect(run).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }
  });

  // Owner ruling 2026-09-28: a DELEGATE may not comp themselves on the
  // principal's event — matched on the actor's account email, and on any
  // recipient email that resolves to the actor's Human. Checked before the
  // recipient is resolved, so a refusal writes nothing (no shadow Human, no
  // order). The owner, and a delegate comping someone else, are unaffected.
  describe("delegate self-benefit", () => {
    const personalEvent = {
      ...baseEvent,
      orgId: null,
      humanId: "principal-human",
    };
    const delegateDeps = (humans: Record<string, unknown> = {}) => {
      const txRepos = makeTxRepos({
        events: {
          getById: vi.fn(async () => personalEvent),
          listTicketTypes: vi.fn(async () => [baseTicketType]),
        },
        authz: {
          getHumanDelegation: vi.fn(async () => ({
            orgId: "principal-human",
            humanId: ACTOR_ID,
            role: "OWNER",
          })),
          getOrgMembership: vi.fn(async () => null),
        },
      }) as Record<string, any>;
      Object.assign(txRepos.humans, humans);
      const deps: IssueCompTicketsDeps = {
        repos: {
          tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
            fn(txRepos as TxRepos),
          ),
        } as unknown as Repos,
        clock: { now: () => NOW },
      };
      return { deps, txRepos };
    };

    // Compared in canonical form: case, `+tag` (any domain), and for Gmail
    // the dots and googlemail.com. The input schema already refuses
    // surrounding whitespace, so that form cannot reach the check.
    const withActorEmail = (email: string) =>
      delegateDeps({
        getByIdWithIdentity: vi.fn(async () => ({
          human: { id: ACTOR_ID },
          identity: { email },
        })),
      });

    it.each([
      ["actor@example.com", "ACTOR@Example.com"],
      ["dele@example.com", "dele+tag@example.com"],
      ["dele@gmail.com", "dele+x@gmail.com"],
      ["dele@gmail.com", "d.e.l.e@gmail.com"],
      ["dele@gmail.com", "DELE@googlemail.com"],
      ["D.Ele+a@GoogleMail.com", "dele@gmail.com"],
    ])(
      "refuses a delegate (account %s) comping %s, with no writes",
      async (actorEmail, recipientEmail) => {
        const { deps, txRepos } = withActorEmail(actorEmail);

        await expect(
          issueCompTickets(deps, { ...validInput, recipientEmail }),
        ).rejects.toMatchObject({ code: "DELEGATE_SELF_BENEFIT_FORBIDDEN" });
        expect(txRepos.humans.ensureGuestHuman).not.toHaveBeenCalled();
        expect(txRepos.orders.createPending).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["dele@gmail.com", "dele2@gmail.com"],
      // Dots only fold for Gmail: elsewhere they are a different mailbox.
      ["d.ele@example.com", "dele@example.com"],
    ])(
      "lets a delegate (account %s) comp a genuinely different address %s",
      async (actorEmail, recipientEmail) => {
        const { deps, txRepos } = withActorEmail(actorEmail);

        await expect(
          issueCompTickets(deps, { ...validInput, recipientEmail }),
        ).resolves.toBeDefined();
        expect(txRepos.orders.createPending).toHaveBeenCalled();
      },
    );

    it("refuses a recipient email that resolves to the delegate's Human", async () => {
      const { deps, txRepos } = delegateDeps({
        getByEmail: vi.fn(async () => ({
          human: { id: ACTOR_ID },
          identity: { email: "alias@example.com" },
        })),
      });

      await expect(
        issueCompTickets(deps, {
          ...validInput,
          recipientEmail: "alias@example.com",
        }),
      ).rejects.toMatchObject({ code: "DELEGATE_SELF_BENEFIT_FORBIDDEN" });
      expect(txRepos.humans.ensureGuestHuman).not.toHaveBeenCalled();
      expect(txRepos.orders.createPending).not.toHaveBeenCalled();
    });

    it("lets a delegate comp someone else", async () => {
      const { deps, txRepos } = delegateDeps();

      await expect(
        issueCompTickets(deps, validInput),
      ).resolves.toMatchObject({ recipientHumanId: RECIPIENT_HUMAN_ID });
      expect(txRepos.orders.createPending).toHaveBeenCalled();
    });

    it("lets the OWNER comp themselves, with no self-benefit lookup", async () => {
      const { deps, txRepos } = delegateDeps();
      (txRepos.events.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...personalEvent,
        humanId: ACTOR_ID,
      });

      await expect(
        issueCompTickets(deps, {
          ...validInput,
          recipientEmail: "actor@example.com",
        }),
      ).resolves.toBeDefined();
      expect(txRepos.humans.getByIdWithIdentity).not.toHaveBeenCalled();
    });
  });

  it("logs audit entry", async () => {
    const txRepos = makeTxRepos();
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };

    await issueCompTickets(deps, validInput);

    expect((txRepos.audit as any).log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        action: "comp_issued",
      }),
    );
  });
});

// ── organiser-resale-share FR-003: a comp records the clause at $0 ──────────

describe("issueCompTickets — FR-003 resale clause record", () => {
  const RESALE_TERMS_ID = "resale-terms-comp";
  const input = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    ticketTypeId: TICKET_TYPE_ID,
    quantity: 2,
    recipientEmail: "guest@example.com",
    recipientName: "Guest User",
    reason: "VIP guest",
  };

  const run = async (resaleTerms: Record<string, unknown> | null) => {
    const getTerms = vi.fn(async () =>
      resaleTerms ? { id: RESALE_TERMS_ID, kind: "RESALE", ...resaleTerms } : null,
    );
    const txRepos = makeTxRepos({
      events: {
        getById: vi.fn(async () => ({
          ...baseEvent,
          resalePayoutTermsId: resaleTerms ? RESALE_TERMS_ID : null,
        })),
        listTicketTypes: vi.fn(async () => [baseTicketType]),
      },
      payoutTerms: { getById: getTerms },
    });
    const deps: IssueCompTicketsDeps = {
      repos: {
        tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
          fn(txRepos as TxRepos),
        ),
      } as unknown as Repos,
      clock: { now: () => NOW },
    };
    await issueCompTickets(deps, input);
    const call = (txRepos.orders as any).createPending.mock.calls[0][0];
    return { items: call.items as Array<Record<string, unknown>>, getTerms };
  };

  it("stamps each comp ticket with the event's clause and an original price of 0", async () => {
    const { items, getTerms } = await run({
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 300,
      resaleSharePayer: "BUYER",
      version: 5,
    });

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({
        unitPriceCents: 0,
        resaleClauseType: "FLAT",
        resaleClauseBps: null,
        resaleClauseCents: 300,
        resaleClausePayer: "BUYER",
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 5,
        originalUnitPriceCents: 0,
      });
    }
    expect(getTerms).toHaveBeenCalledTimes(1);
  });

  it("an event with no resale terms records no clause, and an original price of 0", async () => {
    const { items, getTerms } = await run(null);
    for (const item of items) {
      expect(item).toMatchObject({
        resaleClauseType: null,
        resaleClauseTermsId: null,
        resaleClauseTermsVersion: null,
        originalUnitPriceCents: 0,
      });
    }
    expect(getTerms).not.toHaveBeenCalled();
  });
});
