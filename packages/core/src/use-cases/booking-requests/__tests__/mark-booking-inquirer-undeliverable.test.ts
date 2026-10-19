import { describe, expect, it, vi } from "vitest";

import {
  markBookingInquirerUndeliverable,
  type MarkBookingInquirerUndeliverableDeps,
} from "../mark-booking-inquirer-undeliverable";

const OCCURRED_AT = new Date("2026-09-05T10:00:00.000Z");

function buildDeps(
  markImpl?: (input: unknown) => Promise<number>,
): {
  deps: MarkBookingInquirerUndeliverableDeps;
  mark: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  logger: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
} {
  const mark = vi.fn(markImpl ?? (async () => 1));
  const reportError = vi.fn();
  const logger = {
    child: vi.fn((): unknown => logger),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    deps: {
      repos: {
        bookingRequests: { markInquirerEmailUndeliverable: mark },
      } as unknown as MarkBookingInquirerUndeliverableDeps["repos"],
      logger: logger as never,
      reportError,
    },
    mark,
    reportError,
    logger,
  };
}

describe("markBookingInquirerUndeliverable", () => {
  it("lowercases the address and passes the provider timestamp through", async () => {
    const h = buildDeps();

    const result = await markBookingInquirerUndeliverable(h.deps, {
      email: "JO@Example.COM",
      status: "BOUNCED",
      occurredAt: OCCURRED_AT,
    });

    expect(h.mark).toHaveBeenCalledWith({
      // contactEmail is lowercased at rest — plain equality has to match.
      contactEmail: "jo@example.com",
      status: "BOUNCED",
      at: OCCURRED_AT,
    });
    expect(result).toEqual({ stamped: 1 });
  });

  it("treats zero matches as the normal case, not an error", async () => {
    const h = buildDeps(async () => 0);

    const result = await markBookingInquirerUndeliverable(h.deps, {
      email: "nobody@example.com",
      status: "COMPLAINED",
      occurredAt: OCCURRED_AT,
    });

    expect(result).toEqual({ stamped: 0 });
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("never throws — a repo failure must not 500 the provider webhook", async () => {
    const h = buildDeps(async () => {
      throw new Error("db down");
    });

    const result = await markBookingInquirerUndeliverable(h.deps, {
      email: "jo@example.com",
      status: "BOUNCED",
      occurredAt: OCCURRED_AT,
    });

    expect(result).toEqual({ stamped: 0 });
    expect(h.logger.error).toHaveBeenCalledWith(
      "booking_requests.inquirer_undeliverable_failed",
      expect.objectContaining({ status: "BOUNCED" }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "markBookingInquirerUndeliverable" },
      }),
    );
  });

  it("keeps the recipient address out of the Sentry report", async () => {
    const h = buildDeps(async () => {
      throw new Error("db down");
    });

    await markBookingInquirerUndeliverable(h.deps, {
      email: "jo@example.com",
      status: "BOUNCED",
      occurredAt: OCCURRED_AT,
    });

    const [, context] = h.reportError.mock.calls[0]!;
    expect(JSON.stringify(context)).not.toContain("jo@example.com");
  });

  it("survives a throwing reporter", async () => {
    const h = buildDeps(async () => {
      throw new Error("db down");
    });
    h.deps.reportError = () => {
      throw new Error("sentry down");
    };

    await expect(
      markBookingInquirerUndeliverable(h.deps, {
        email: "jo@example.com",
        status: "BOUNCED",
        occurredAt: OCCURRED_AT,
      }),
    ).resolves.toEqual({ stamped: 0 });
  });

  it("rejects an unknown status at the boundary", async () => {
    const h = buildDeps();
    await expect(
      markBookingInquirerUndeliverable(h.deps, {
        email: "jo@example.com",
        status: "DELIVERABLE",
        occurredAt: OCCURRED_AT,
      }),
    ).rejects.toThrow();
    expect(h.mark).not.toHaveBeenCalled();
  });
});
