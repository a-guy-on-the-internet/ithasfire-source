import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import { SCANNER_TERMS_VERSION } from "@th/types";

import {
  acknowledgeScannerTerms,
  type AcknowledgeScannerTermsDeps,
} from "../acknowledge-scanner-terms";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function makeContext() {
  const now = new Date("2026-05-15T12:00:00.000Z");

  const humans = {
    acknowledgeScannerTerms: vi.fn(async (input) => ({
      id: input.humanId,
      scannerTermsAckAt: input.acknowledgedAt,
      scannerTermsAckVersion: input.version,
      scannerTermsAckIp: input.ipAddress,
      scannerTermsAckUserAgent: input.userAgent,
    })),
  };

  const audit = {
    log: vi.fn(async () => undefined),
  };

  const txRepos = {
    humans,
    audit,
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos)),
  } as unknown as Repos;

  const deps: AcknowledgeScannerTermsDeps = {
    repos,
    clock: { now: () => now },
  };

  return { deps, repos, humans, audit, now };
}

describe("acknowledgeScannerTerms", () => {
  it("writes the ack columns and audit log inside one transaction", async () => {
    const ctx = makeContext();

    await acknowledgeScannerTerms(ctx.deps, {
      humanId: HUMAN_ID,
      version: SCANNER_TERMS_VERSION,
      ipAddress: "203.0.113.7",
      userAgent: "ScannerApp/1.0",
    });

    expect(ctx.humans.acknowledgeScannerTerms).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      version: SCANNER_TERMS_VERSION,
      acknowledgedAt: ctx.now,
      ipAddress: "203.0.113.7",
      userAgent: "ScannerApp/1.0",
    });
    expect(ctx.audit.log).toHaveBeenCalledWith({
      entity: "human",
      entityId: HUMAN_ID,
      action: "human.scanner_terms_acknowledged",
      data: { version: SCANNER_TERMS_VERSION },
      at: ctx.now,
    });
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
  });

  it("rejects on version mismatch before touching the repo", async () => {
    const ctx = makeContext();

    await expect(
      acknowledgeScannerTerms(ctx.deps, {
        humanId: HUMAN_ID,
        version: "999",
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: "SCANNER_TERMS_VERSION_MISMATCH" });

    expect(ctx.humans.acknowledgeScannerTerms).not.toHaveBeenCalled();
    expect(ctx.audit.log).not.toHaveBeenCalled();
    expect(ctx.repos.tx).not.toHaveBeenCalled();
  });
});
