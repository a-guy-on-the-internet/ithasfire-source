import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  unsubscribeFromOrgAnnouncements,
  type UnsubscribeFromOrgAnnouncementsDeps,
} from "./unsubscribe-from-org-announcements";
import { generateOrgUnsubscribeToken } from "./unsubscribe-from-audience";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = "test-unsubscribe-secret-that-is-long-enough";
const ORG_ID = randomUUID();
const HUMAN_ID = randomUUID();
const EMAIL = "jane@example.com";

function makeHuman() {
  return {
    human: {
      id: HUMAN_ID,
      displayName: "Jane Doe",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    identity: {
      email: EMAIL,
    },
  };
}

function makeDeps(overrides?: {
  human?: ReturnType<typeof makeHuman> | null;
  secret?: string;
}): {
  deps: UnsubscribeFromOrgAnnouncementsDeps;
  upsert: ReturnType<typeof vi.fn>;
  insertAnonymousSuppression: ReturnType<typeof vi.fn>;
  getByEmail: ReturnType<typeof vi.fn>;
} {
  const human = overrides?.human !== undefined ? overrides.human : makeHuman();

  const upsert = vi.fn(async () => {});
  const insertAnonymousSuppression = vi.fn(async () => {});
  const getByEmail = vi.fn(async () => human);

  const deps: UnsubscribeFromOrgAnnouncementsDeps = {
    repos: {
      humans: { getByEmail },
      notificationPrefs: { upsert },
      announcements: { insertAnonymousSuppression },
    } as any,
    logger: createTestLogger(),
    unsubscribeSecret: overrides?.secret ?? SECRET,
  };

  return { deps, upsert, insertAnonymousSuppression, getByEmail };
}

function validInput(email = EMAIL) {
  return {
    orgId: ORG_ID,
    email,
    token: generateOrgUnsubscribeToken(SECRET, ORG_ID, email),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("unsubscribeFromOrgAnnouncements", () => {
  it("rejects an invalid HMAC token before touching repos", async () => {
    const { deps, getByEmail, upsert, insertAnonymousSuppression } = makeDeps();

    await expect(
      unsubscribeFromOrgAnnouncements(deps, {
        ...validInput(),
        token: "forged-token",
      }),
    ).rejects.toMatchObject({ code: "INVALID_UNSUBSCRIBE_TOKEN" });

    expect(getByEmail).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(insertAnonymousSuppression).not.toHaveBeenCalled();
  });

  it("found-human path upserts an ORG-scope pref disabling email announcements", async () => {
    const { deps, upsert, insertAnonymousSuppression } = makeDeps();

    const result = await unsubscribeFromOrgAnnouncements(deps, validInput());

    expect(result).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      humanId: HUMAN_ID,
      scope: { kind: "ORG", orgId: ORG_ID },
      delta: { channels: { email: { announcements: false } } },
    });
    expect(insertAnonymousSuppression).not.toHaveBeenCalled();
  });

  it("only flips announcements/email — the delta does not clobber other categories", async () => {
    const { deps, upsert } = makeDeps();

    await unsubscribeFromOrgAnnouncements(deps, validInput());

    const delta = upsert.mock.calls[0][0].delta;
    // Delta is sparse: it carries only the announcements override. The adapter's
    // upsert deep-merges this into any existing row, so other prefs are kept.
    expect(delta).toEqual({
      channels: { email: { announcements: false } },
    });
    expect(delta.categories).toBeUndefined();
    expect(delta.channels.email.marketing).toBeUndefined();
    expect(delta.channels.email.transactional).toBeUndefined();
  });

  it("no-human path inserts an anonymous suppression row (lowercased)", async () => {
    const { deps, upsert, insertAnonymousSuppression } = makeDeps({
      human: null,
    });

    const result = await unsubscribeFromOrgAnnouncements(
      deps,
      validInput("Jane@Example.COM"),
    );

    expect(result).toEqual({ ok: true });
    expect(insertAnonymousSuppression).toHaveBeenCalledWith({
      email: "jane@example.com",
      orgId: ORG_ID,
      reason: "unsubscribe",
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent: repeat calls produce the same effect", async () => {
    const { deps, upsert } = makeDeps();

    await unsubscribeFromOrgAnnouncements(deps, validInput());
    await unsubscribeFromOrgAnnouncements(deps, validInput());

    // Same upsert payload each time; the adapter upsert is itself idempotent.
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0]).toEqual(upsert.mock.calls[1][0]);
  });

  it("rejects malformed email input", async () => {
    const { deps } = makeDeps();
    await expect(
      unsubscribeFromOrgAnnouncements(deps, {
        orgId: ORG_ID,
        email: "not-an-email",
        token: "abc",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
