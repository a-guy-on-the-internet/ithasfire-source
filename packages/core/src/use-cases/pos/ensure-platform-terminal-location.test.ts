import { describe, expect, it, vi } from "vitest";

import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { ensurePlatformTerminalLocation } from "./ensure-platform-terminal-location";

const STORED_LOCATION_ID = "tml_already_provisioned";
const NEW_LOCATION_ID = "tml_brand_new";

function makeDeps(opts: {
  storedValue?: string | null;
  /** Value returned by the SECOND `.get` call (race-detection re-read). */
  racedStoredValue?: string | null;
  createError?: unknown;
}) {
  const getMock = vi
    .fn(async (_key: string): Promise<{ value: string } | null> => null)
    .mockResolvedValueOnce(
      opts.storedValue == null ? null : { value: opts.storedValue },
    )
    .mockResolvedValueOnce(
      opts.racedStoredValue == null ? null : { value: opts.racedStoredValue },
    );

  const upsertMock = vi.fn(async (_key: string, _value: string) => undefined);

  const repos = {
    platformSettings: { get: getMock, upsert: upsertMock },
  } as unknown as Repos;

  const createTerminalLocation = vi.fn(async () => {
    if (opts.createError) throw opts.createError;
    return { locationId: NEW_LOCATION_ID };
  });

  const payments = {
    createTerminalLocation,
  } as unknown as PaymentProcessorPort;

  return { repos, payments, getMock, upsertMock, createTerminalLocation };
}

describe("ensurePlatformTerminalLocation", () => {
  it("returns the cached locationId without calling Stripe", async () => {
    const { repos, payments, createTerminalLocation, upsertMock } = makeDeps({
      storedValue: STORED_LOCATION_ID,
    });

    const result = await ensurePlatformTerminalLocation({ repos, payments });

    expect(result).toEqual({ locationId: STORED_LOCATION_ID, created: false });
    expect(createTerminalLocation).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("creates a new Location on Stripe and persists when none cached", async () => {
    const { repos, payments, createTerminalLocation, upsertMock } = makeDeps({
      storedValue: null,
    });

    const result = await ensurePlatformTerminalLocation({ repos, payments });

    expect(result).toEqual({ locationId: NEW_LOCATION_ID, created: true });
    expect(createTerminalLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: expect.any(String),
        address: expect.objectContaining({ country: "US" }),
      }),
    );
    expect(upsertMock).toHaveBeenCalledWith(
      "pos:terminalLocationId",
      NEW_LOCATION_ID,
    );
  });

  it("respects the displayName + address override from config", async () => {
    const { repos, payments, createTerminalLocation } = makeDeps({
      storedValue: null,
    });

    await ensurePlatformTerminalLocation({
      repos,
      payments,
      config: {
        displayName: "Ithas Fire Prod",
        address: {
          line1: "1 Main St",
          city: "Boulder",
          state: "CO",
          postalCode: "80302",
          country: "US",
        },
      },
    });

    expect(createTerminalLocation).toHaveBeenCalledWith({
      displayName: "Ithas Fire Prod",
      address: {
        line1: "1 Main St",
        city: "Boulder",
        state: "CO",
        postalCode: "80302",
        country: "US",
      },
    });
  });

  it("keeps the raced winner and logs the orphan when a sibling write lands between read and create", async () => {
    const racedWinner = "tml_raced_winner";
    const { repos, payments, upsertMock } = makeDeps({
      storedValue: null,
      racedStoredValue: racedWinner,
    });
    const warn = vi.fn();
    const logger = {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      log: vi.fn(),
      child: vi.fn(() => logger),
      withTime: vi.fn(() => logger),
    } as any;

    const result = await ensurePlatformTerminalLocation({
      repos,
      payments,
      logger,
    });

    expect(result).toEqual({ locationId: racedWinner, created: false });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "pos.platform_terminal_location.race_orphaned",
      expect.objectContaining({
        keptLocationId: racedWinner,
        orphanedLocationId: NEW_LOCATION_ID,
      }),
    );
  });
});
