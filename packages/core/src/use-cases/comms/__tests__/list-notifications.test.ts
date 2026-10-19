import { describe, expect, it, vi } from "vitest";

import { createFakeNotificationsRepo } from "@th/test-utils/fakes/notifications-repo";

import { listNotifications } from "../list-notifications";

const HUMAN_ID = "8d96bcf3-75bb-4e6b-9bea-9891e093cf3e";

const RSVP_PAYLOAD = {
  eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  eventTitle: "Open Mic Night",
  startsAtIso: "2026-11-14T01:30:00.000Z",
  timezone: "America/Chicago",
  addressText: "123 Secret Lane",
  eventUrl: "https://ithas.fire/e/open-mic-night",
};

async function seeded() {
  const repo = createFakeNotificationsRepo();
  await repo.create({
    humanId: HUMAN_ID,
    title: "You're going to Open Mic Night",
    body: "Your RSVP for Open Mic Night is confirmed.",
    kind: "SUCCESS",
    metadata: { variant: "rsvp.confirmed" },
    action: { label: "View event", route: "/e/open-mic-night" },
    template: { key: "rsvp.confirmed", version: "1", variables: RSVP_PAYLOAD },
  });
  return repo;
}

const ITEM_KEYS = [
  "action",
  "body",
  "createdAt",
  "expiresAt",
  "humanId",
  "id",
  "kind",
  "metadata",
  "readAt",
  "tags",
  "title",
  "updatedAt",
];

describe("listNotifications", () => {
  it("returns the reader's rows in their language with exactly the DTO fields", async () => {
    const repo = await seeded();

    const out = await listNotifications(
      { repos: { notifications: repo } },
      { humanId: HUMAN_ID, locale: "es" },
    );

    expect(out.nextCursor).toBeNull();
    expect(out.items).toHaveLength(1);
    expect(Object.keys(out.items[0]!).sort()).toEqual(ITEM_KEYS);
    expect(out.items[0]!.title).toBe("Vas a ir a Open Mic Night");
    expect(JSON.stringify(out)).not.toContain("123 Secret Lane");
  });

  it("strips the template in English too, and leaves the stored text alone", async () => {
    const repo = await seeded();

    const out = await listNotifications(
      { repos: { notifications: repo } },
      { humanId: HUMAN_ID },
    );

    expect(Object.keys(out.items[0]!).sort()).toEqual(ITEM_KEYS);
    expect(out.items[0]!.title).toBe("You're going to Open Mic Night");
  });

  it("does not pass a column the DTO does not list", async () => {
    const repo = await seeded();
    const [record] = [...repo.__records.values()];
    (record as unknown as Record<string, unknown>).internalNote = "secret";

    const out = await listNotifications(
      { repos: { notifications: repo } },
      { humanId: HUMAN_ID },
    );
    expect(out.items[0]).not.toHaveProperty("internalNote");
  });

  it("passes the reporter through to the re-render", async () => {
    const repo = createFakeNotificationsRepo();
    await repo.create({
      humanId: HUMAN_ID,
      body: "Your RSVP for X is confirmed.",
      kind: "SUCCESS",
      metadata: { variant: "rsvp.confirmed" },
      template: { key: "rsvp.confirmed", version: "1", variables: { nope: 1 } },
    });
    const reportError = vi.fn();

    const out = await listNotifications(
      { repos: { notifications: repo }, reportError },
      { humanId: HUMAN_ID, locale: "es" },
    );

    expect(out.items[0]!.body).toBe("Your RSVP for X is confirmed.");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("returns an empty page when no notifications repo is bound", async () => {
    await expect(
      listNotifications({ repos: {} }, { humanId: HUMAN_ID }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("rejects unknown input keys and an oversized locale", async () => {
    const repo = createFakeNotificationsRepo();
    await expect(
      listNotifications(
        { repos: { notifications: repo } },
        { humanId: HUMAN_ID, extra: 1 },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listNotifications(
        { repos: { notifications: repo } },
        { humanId: HUMAN_ID, locale: "x".repeat(36) },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
