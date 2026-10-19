import { describe, expect, it, vi } from "vitest";

import type { AcceptanceRecordRow } from "@th/ports/repos/acceptances";
import type { TxRepos } from "@th/ports/repos";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "../../payments/chargeback-terms";
import {
  DOCUMENT_REGISTRY,
  getDocumentSpec,
  hasCurrentAcceptance,
  recordAcceptance,
} from "../acceptance";

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

function makeRepos(existing: AcceptanceRecordRow | null = null) {
  const acceptances = {
    findCurrent: vi.fn(async () => existing),
    create: vi.fn(async (input) => ({
      id: "acc-1",
      humanId: input.humanId,
      documentType: input.documentType,
      documentVersion: input.documentVersion,
      documentTextSnapshot: input.documentTextSnapshot,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      acceptedAt: input.acceptedAt ?? new Date("2026-05-17T00:00:00.000Z"),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ?? null,
    })),
  };
  return { acceptances } as unknown as Pick<TxRepos, "acceptances"> & {
    acceptances: typeof acceptances;
  };
}

describe("getDocumentSpec", () => {
  it("returns the registered chargeback terms spec", () => {
    const spec = getDocumentSpec("CHARGEBACK_TERMS_ORGANIZER");
    expect(spec.currentVersion).toBe(CURRENT_CHARGEBACK_TERMS_VERSION);
    expect(spec.scopeType).toBe("ORGANIZATION");
    expect(spec.currentText.length).toBeGreaterThan(0);
  });

  it("throws invalid_input for an unregistered document", () => {
    expect(() => getDocumentSpec("PRIVACY_POLICY")).toThrow();
    try {
      getDocumentSpec("PRIVACY_POLICY");
    } catch (err) {
      expect(err).toMatchObject({ code: "invalid_input" });
    }
  });
});

describe("hasCurrentAcceptance", () => {
  it("is false when no current acceptance exists", async () => {
    const repos = makeRepos(null);
    const result = await hasCurrentAcceptance({
      repos,
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
    });
    expect(result).toBe(false);
    expect(repos.acceptances.findCurrent).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      documentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
    });
  });

  it("defaults the scope to the registry scope when omitted", async () => {
    const repos = makeRepos(null);
    await hasCurrentAcceptance({
      repos,
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
    });
    expect(repos.acceptances.findCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: "ORGANIZATION", scopeId: null }),
    );
  });

  it("is true when a current acceptance exists", async () => {
    const existing: AcceptanceRecordRow = {
      id: "acc-1",
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      documentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      documentTextSnapshot: "x",
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
      acceptedAt: new Date(),
      ipAddress: null,
      userAgent: null,
      metadata: null,
    };
    const repos = makeRepos(existing);
    const result = await hasCurrentAcceptance({
      repos,
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
    });
    expect(result).toBe(true);
  });
});

describe("recordAcceptance", () => {
  it("creates a new record snapshotting the current version + text", async () => {
    const repos = makeRepos(null);
    const spec = DOCUMENT_REGISTRY.CHARGEBACK_TERMS_ORGANIZER!;
    const acceptedAt = new Date("2026-05-17T00:00:00.000Z");

    const row = await recordAcceptance({
      repos,
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
      acceptedAt,
    });

    expect(repos.acceptances.create).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      documentVersion: spec.currentVersion,
      documentTextSnapshot: spec.currentText,
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
      acceptedAt,
      ipAddress: null,
      userAgent: null,
      metadata: null,
    });
    expect(row.documentVersion).toBe(spec.currentVersion);
  });

  it("is idempotent — returns the existing record without creating", async () => {
    const existing: AcceptanceRecordRow = {
      id: "acc-existing",
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      documentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      documentTextSnapshot: "x",
      scopeType: "GLOBAL",
      scopeId: null,
      acceptedAt: new Date(),
      ipAddress: null,
      userAgent: null,
      metadata: null,
    };
    const repos = makeRepos(existing);

    const row = await recordAcceptance({
      repos,
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      scopeType: "GLOBAL",
      scopeId: null,
    });

    expect(row).toBe(existing);
    expect(repos.acceptances.create).not.toHaveBeenCalled();
  });
});

/**
 * A version bump (2026-05-17 → 2026-09-03) is APPEND-ONLY in the ledger. The
 * `AcceptanceRepo` port has no update/upsert at all, so an existing row keeps
 * its original `documentVersion` + `documentTextSnapshot` forever — the copy
 * a human actually agreed to is what stays on file.
 */
describe("acceptance ledger across a version bump", () => {
  const STALE_VERSION = "2026-05-17";

  function makeVersionFilteringRepos(rows: AcceptanceRecordRow[]) {
    const acceptances = {
      findCurrent: vi.fn(
        async (input: { documentVersion: string }) =>
          rows.find((r) => r.documentVersion === input.documentVersion) ?? null,
      ),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const created = {
          id: `acc-${rows.length + 1}`,
          scopeId: null,
          ipAddress: null,
          userAgent: null,
          metadata: null,
          acceptedAt: new Date("2026-09-03T00:00:00.000Z"),
          ...input,
        } as unknown as AcceptanceRecordRow;
        rows.push(created);
        return created;
      }),
    };
    return {
      repos: { acceptances } as unknown as Pick<TxRepos, "acceptances"> & {
        acceptances: typeof acceptances;
      },
      rows,
    };
  }

  function staleRow(): AcceptanceRecordRow {
    return {
      id: "acc-stale",
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      documentVersion: STALE_VERSION,
      documentTextSnapshot: "the 2026-05-17 copy",
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
      acceptedAt: new Date("2026-06-01T00:00:00.000Z"),
      ipAddress: null,
      userAgent: null,
      metadata: null,
    };
  }

  it("is not a current acceptance once the version moves on", async () => {
    const { repos } = makeVersionFilteringRepos([staleRow()]);

    await expect(
      hasCurrentAcceptance({
        repos,
        humanId: HUMAN_ID,
        documentType: "CHARGEBACK_TERMS_ORGANIZER",
        scopeType: "ORGANIZATION",
        scopeId: ORG_ID,
      }),
    ).resolves.toBe(false);
    expect(CURRENT_CHARGEBACK_TERMS_VERSION).not.toBe(STALE_VERSION);
  });

  it("appends a new row and leaves the old snapshot untouched", async () => {
    const stale = staleRow();
    const { repos, rows } = makeVersionFilteringRepos([stale]);
    const spec = DOCUMENT_REGISTRY.CHARGEBACK_TERMS_ORGANIZER!;

    const created = await recordAcceptance({
      repos,
      humanId: HUMAN_ID,
      documentType: "CHARGEBACK_TERMS_ORGANIZER",
      scopeType: "ORGANIZATION",
      scopeId: ORG_ID,
    });

    expect(created.documentVersion).toBe(spec.currentVersion);
    expect(created.documentTextSnapshot).toBe(spec.currentText);
    expect(rows).toHaveLength(2);
    // The row the human actually accepted is byte-for-byte what it was.
    expect(stale).toMatchObject({
      documentVersion: STALE_VERSION,
      documentTextSnapshot: "the 2026-05-17 copy",
      acceptedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
  });
});
