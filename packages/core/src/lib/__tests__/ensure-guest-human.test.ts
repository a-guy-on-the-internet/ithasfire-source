import { describe, expect, it, vi } from "vitest";

import { ensureGuestHumanKeepingName } from "../ensure-guest-human";

function makeHumans(created: boolean) {
  return {
    ensureGuestHuman: vi.fn(async () => ({ humanId: "h-1", created })),
    update: vi.fn(async (id: string, u: Record<string, unknown>) => ({
      id,
      ...u,
    })),
  };
}

describe("ensureGuestHumanKeepingName", () => {
  it("never passes a name to the repo (the adapter would rename an existing account)", async () => {
    const humans = makeHumans(false);
    await ensureGuestHumanKeepingName(humans as never, {
      email: "real@example.com",
      name: "Someone Else",
    });
    expect(humans.ensureGuestHuman).toHaveBeenCalledWith({
      email: "real@example.com",
    });
  });

  it("leaves an EXISTING account's name alone", async () => {
    const humans = makeHumans(false);
    const result = await ensureGuestHumanKeepingName(humans as never, {
      email: "real@example.com",
      name: "Someone Else",
    });
    expect(result).toEqual({ humanId: "h-1", created: false });
    expect(humans.update).not.toHaveBeenCalled();
  });

  it("names a Human this call minted", async () => {
    const humans = makeHumans(true);
    await ensureGuestHumanKeepingName(humans as never, {
      email: "new@example.com",
      name: "  New Guest  ",
    });
    expect(humans.update).toHaveBeenCalledWith("h-1", { name: "New Guest" });
  });

  it("writes nothing for a minted Human when no name was given", async () => {
    const humans = makeHumans(true);
    await ensureGuestHumanKeepingName(humans as never, {
      email: "new@example.com",
      name: null,
    });
    expect(humans.update).not.toHaveBeenCalled();
  });
});
