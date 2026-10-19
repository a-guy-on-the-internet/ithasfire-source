import { describe, expect, it, vi } from "vitest";

import {
  inviteLineupHumanToRegister,
  type InviteLineupHumanToRegisterDeps,
} from "../invite-lineup-human-to-register";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-09-29T12:00:00.000Z");

function makeDeps(created: boolean) {
  const humans = {
    ensureGuestHuman: vi.fn(async () => ({ humanId: HUMAN_ID, created })),
    update: vi.fn(async (id: string, u: Record<string, unknown>) => ({
      id,
      ...u,
    })),
  };
  const tx = {
    eventHumans: {
      linkHuman: vi.fn(async ({ id }: { id: string }) => ({
        id,
        role: "CREW",
      })),
    },
    events: { getById: vi.fn(async () => null) },
  };
  const deps = {
    repos: {
      eventHumans: {
        getById: vi.fn(async () => ({
          id: EVENT_HUMAN_ID,
          eventId: EVENT_ID,
          humanId: null,
          externalName: "Stage Name",
        })),
      },
      humans,
      audit: { log: vi.fn(async () => undefined) },
      tx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    authz: { canEditEvent: vi.fn(async () => ({ allowed: true })) },
    clock: { now: () => NOW },
  } as unknown as InviteLineupHumanToRegisterDeps;
  return { deps, humans };
}

describe("inviteLineupHumanToRegister — never renames an existing account", () => {
  it("leaves an EXISTING account's name alone when the organizer types its email", async () => {
    const { deps, humans } = makeDeps(false);

    const result = await inviteLineupHumanToRegister(deps, {
      actorHumanId: ACTOR_ID,
      eventHumanId: EVENT_HUMAN_ID,
      email: "real.person@example.com",
      displayName: "Organizer Typed Name",
    });

    // Only the row id: no account-existence signal for the editor.
    expect(result).toEqual({ eventHumanId: EVENT_HUMAN_ID });
    expect(humans.ensureGuestHuman).toHaveBeenCalledWith({
      email: "real.person@example.com",
    });
    expect(humans.update).not.toHaveBeenCalled();
  });

  it("names a Human it just minted (display name, else the row's stage name)", async () => {
    const { deps, humans } = makeDeps(true);

    await inviteLineupHumanToRegister(deps, {
      actorHumanId: ACTOR_ID,
      eventHumanId: EVENT_HUMAN_ID,
      email: "new.person@example.com",
    });

    expect(humans.update).toHaveBeenCalledWith(HUMAN_ID, {
      name: "Stage Name",
    });
  });
});
