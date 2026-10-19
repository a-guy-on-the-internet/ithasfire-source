import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  unsubscribeFromAudience,
  generateUnsubscribeToken,
  generateWaitlistUnsubscribeToken,
  generateOrgUnsubscribeToken,
  verifyOrgUnsubscribeToken,
  type UnsubscribeFromAudienceDeps,
} from "./unsubscribe-from-audience";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = "test-unsubscribe-secret-that-is-long-enough";
const LIST_ID = randomUUID();
const EVENT_ID = randomUUID();
const EMAIL = "jane@example.com";
const ENTRY_ID = randomUUID();
const WAITLIST_ENTRY_ID = randomUUID();
const NOW = new Date("2025-01-15T12:00:00Z");

function makeEntry(overrides?: { unsubscribedAt?: Date | null }) {
  return {
    id: ENTRY_ID,
    inviteListId: LIST_ID,
    humanId: null,
    contactEmail: EMAIL,
    contactPhone: null,
    displayName: "Jane Doe",
    notes: null,
    tags: [],
    lastInvitedAt: null,
    metadata: {},
    importId: null,
    consentSource: null,
    consentRecordedAt: null,
    unsubscribedAt: overrides?.unsubscribedAt ?? null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
  };
}

function makeWaitlistEntry(overrides?: { status?: string }) {
  return {
    id: WAITLIST_ENTRY_ID,
    eventId: EVENT_ID,
    humanId: null,
    contactEmail: EMAIL,
    contactPhone: null,
    status: overrides?.status ?? "PENDING",
    notes: null,
    metadata: {},
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
  };
}

function makeDeps(overrides?: {
  entry?: ReturnType<typeof makeEntry> | null;
  waitlistEntry?: ReturnType<typeof makeWaitlistEntry> | null;
  secret?: string;
}): UnsubscribeFromAudienceDeps {
  const entry = overrides?.entry !== undefined ? overrides.entry : makeEntry();
  const waitlistEntry =
    overrides?.waitlistEntry !== undefined
      ? overrides.waitlistEntry
      : makeWaitlistEntry();

  return {
    repos: {
      inviteLists: {
        getEntryByListAndEmail: vi.fn(async () => entry),
        unsubscribeEntry: vi.fn(async () => entry),
      },
      eventWaitlists: {
        findEntry: vi.fn(async () => waitlistEntry),
        updateEntry: vi.fn(async () => waitlistEntry),
      },
    } as any,
    clock: { now: () => NOW } satisfies ClockPort,
    logger: createTestLogger(),
    unsubscribeSecret: overrides?.secret ?? SECRET,
  };
}

function validInput() {
  const token = generateUnsubscribeToken(SECRET, LIST_ID, EMAIL);
  return { listId: LIST_ID, email: EMAIL, token };
}

function validWaitlistInput() {
  const token = generateWaitlistUnsubscribeToken(SECRET, EVENT_ID, EMAIL);
  return { kind: "waitlist" as const, eventId: EVENT_ID, email: EMAIL, token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("unsubscribeFromAudience", () => {
  it("marks entry as unsubscribed when token is valid", async () => {
    const deps = makeDeps();
    const result = await unsubscribeFromAudience(deps, validInput());

    expect(result).toEqual({ ok: true });
    expect(deps.repos.inviteLists.getEntryByListAndEmail).toHaveBeenCalledWith(
      LIST_ID,
      EMAIL,
    );
    expect(deps.repos.inviteLists.unsubscribeEntry).toHaveBeenCalledWith(
      ENTRY_ID,
      NOW,
    );
  });

  it("rejects an invalid HMAC token", async () => {
    const deps = makeDeps();
    const input = { ...validInput(), token: "invalid-token-value" };

    await expect(unsubscribeFromAudience(deps, input)).rejects.toMatchObject({ code: "INVALID_UNSUBSCRIBE_TOKEN" });
    expect(
      deps.repos.inviteLists.getEntryByListAndEmail,
    ).not.toHaveBeenCalled();
  });

  it("returns ok when entry does not exist (idempotent)", async () => {
    const deps = makeDeps({ entry: null });
    const result = await unsubscribeFromAudience(deps, validInput());

    expect(result).toEqual({ ok: true });
    expect(deps.repos.inviteLists.unsubscribeEntry).not.toHaveBeenCalled();
  });

  it("returns ok when already unsubscribed (idempotent)", async () => {
    const deps = makeDeps({
      entry: makeEntry({ unsubscribedAt: new Date("2025-01-10T00:00:00Z") }),
    });
    const result = await unsubscribeFromAudience(deps, validInput());

    expect(result).toEqual({ ok: true });
    expect(deps.repos.inviteLists.unsubscribeEntry).not.toHaveBeenCalled();
  });

  it("token is case-insensitive on email", async () => {
    const token = generateUnsubscribeToken(SECRET, LIST_ID, "Jane@Example.COM");
    const deps = makeDeps();
    const result = await unsubscribeFromAudience(deps, {
      listId: LIST_ID,
      email: "jane@example.com",
      token,
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects with invalid_input for missing listId", async () => {
    const deps = makeDeps();
    await expect(
      unsubscribeFromAudience(deps, { email: EMAIL, token: "abc" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects with invalid_input for malformed email", async () => {
    const deps = makeDeps();
    await expect(
      unsubscribeFromAudience(deps, {
        listId: LIST_ID,
        email: "not-an-email",
        token: "abc",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("generateUnsubscribeToken", () => {
  it("is deterministic for the same inputs", () => {
    const a = generateUnsubscribeToken(SECRET, LIST_ID, EMAIL);
    const b = generateUnsubscribeToken(SECRET, LIST_ID, EMAIL);
    expect(a).toBe(b);
  });

  it("normalizes email to lowercase", () => {
    const a = generateUnsubscribeToken(SECRET, LIST_ID, "Jane@Example.COM");
    const b = generateUnsubscribeToken(SECRET, LIST_ID, "jane@example.com");
    expect(a).toBe(b);
  });

  it("differs for different secrets", () => {
    const a = generateUnsubscribeToken("secret-a", LIST_ID, EMAIL);
    const b = generateUnsubscribeToken("secret-b", LIST_ID, EMAIL);
    expect(a).not.toBe(b);
  });

  it("differs for different list IDs", () => {
    const a = generateUnsubscribeToken(SECRET, randomUUID(), EMAIL);
    const b = generateUnsubscribeToken(SECRET, randomUUID(), EMAIL);
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Waitlist unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

describe("unsubscribeFromAudience – waitlist kind", () => {
  it("drops waitlist entry when token is valid", async () => {
    const deps = makeDeps();
    const result = await unsubscribeFromAudience(deps, validWaitlistInput());

    expect(result).toEqual({ ok: true });
    expect(deps.repos.eventWaitlists.findEntry).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      contactEmail: EMAIL,
    });
    expect(deps.repos.eventWaitlists.updateEntry).toHaveBeenCalledWith({
      entryId: WAITLIST_ENTRY_ID,
      status: "DROPPED",
      updatedAt: NOW,
    });
  });

  it("rejects an invalid waitlist HMAC token", async () => {
    const deps = makeDeps();
    const input = { ...validWaitlistInput(), token: "forged-token" };

    await expect(unsubscribeFromAudience(deps, input)).rejects.toMatchObject({ code: "INVALID_UNSUBSCRIBE_TOKEN" });
    expect(deps.repos.eventWaitlists.findEntry).not.toHaveBeenCalled();
  });

  it("returns ok when waitlist entry does not exist (idempotent)", async () => {
    const deps = makeDeps({ waitlistEntry: null });
    const result = await unsubscribeFromAudience(deps, validWaitlistInput());

    expect(result).toEqual({ ok: true });
    expect(deps.repos.eventWaitlists.updateEntry).not.toHaveBeenCalled();
  });

  it("returns ok when waitlist entry is already DROPPED (idempotent)", async () => {
    const deps = makeDeps({
      waitlistEntry: makeWaitlistEntry({ status: "DROPPED" }),
    });
    const result = await unsubscribeFromAudience(deps, validWaitlistInput());

    expect(result).toEqual({ ok: true });
    expect(deps.repos.eventWaitlists.updateEntry).not.toHaveBeenCalled();
  });

  it("waitlist token is case-insensitive on email", async () => {
    const token = generateWaitlistUnsubscribeToken(
      SECRET,
      EVENT_ID,
      "Jane@Example.COM",
    );
    const deps = makeDeps();
    const result = await unsubscribeFromAudience(deps, {
      kind: "waitlist",
      eventId: EVENT_ID,
      email: "jane@example.com",
      token,
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects with invalid_input for waitlist without eventId", async () => {
    const deps = makeDeps();
    await expect(
      unsubscribeFromAudience(deps, {
        kind: "waitlist",
        email: EMAIL,
        token: "abc",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("generateWaitlistUnsubscribeToken", () => {
  it("is deterministic for the same inputs", () => {
    const a = generateWaitlistUnsubscribeToken(SECRET, EVENT_ID, EMAIL);
    const b = generateWaitlistUnsubscribeToken(SECRET, EVENT_ID, EMAIL);
    expect(a).toBe(b);
  });

  it("normalizes email to lowercase", () => {
    const a = generateWaitlistUnsubscribeToken(
      SECRET,
      EVENT_ID,
      "Jane@Example.COM",
    );
    const b = generateWaitlistUnsubscribeToken(
      SECRET,
      EVENT_ID,
      "jane@example.com",
    );
    expect(a).toBe(b);
  });

  it("differs from contact list token for the same ID + email", () => {
    const wl = generateWaitlistUnsubscribeToken(SECRET, EVENT_ID, EMAIL);
    const cl = generateUnsubscribeToken(SECRET, EVENT_ID, EMAIL);
    expect(wl).not.toBe(cl);
  });

  it("differs for different event IDs", () => {
    const a = generateWaitlistUnsubscribeToken(SECRET, randomUUID(), EMAIL);
    const b = generateWaitlistUnsubscribeToken(SECRET, randomUUID(), EMAIL);
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Org-level unsubscribe token
// ─────────────────────────────────────────────────────────────────────────────

describe("generateOrgUnsubscribeToken / verifyOrgUnsubscribeToken", () => {
  const ORG_ID = randomUUID();

  it("round-trips: a generated token verifies", () => {
    const token = generateOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    expect(verifyOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL, token)).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const a = generateOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    const b = generateOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    expect(a).toBe(b);
  });

  it("normalizes email to lowercase", () => {
    const a = generateOrgUnsubscribeToken(SECRET, ORG_ID, "Jane@Example.COM");
    const b = generateOrgUnsubscribeToken(SECRET, ORG_ID, "jane@example.com");
    expect(a).toBe(b);
    expect(
      verifyOrgUnsubscribeToken(SECRET, ORG_ID, "JANE@example.com", a),
    ).toBe(true);
  });

  it("rejects a tampered token", () => {
    const token = generateOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL, tampered)).toBe(
      false,
    );
  });

  it("rejects a token for a different org", () => {
    const token = generateOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    expect(
      verifyOrgUnsubscribeToken(SECRET, randomUUID(), EMAIL, token),
    ).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = generateOrgUnsubscribeToken("other-secret", ORG_ID, EMAIL);
    expect(verifyOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL, token)).toBe(false);
  });

  it("differs from contact-list and waitlist tokens for the same ID + email", () => {
    const org = generateOrgUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    const cl = generateUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    const wl = generateWaitlistUnsubscribeToken(SECRET, ORG_ID, EMAIL);
    expect(org).not.toBe(cl);
    expect(org).not.toBe(wl);
  });
});
