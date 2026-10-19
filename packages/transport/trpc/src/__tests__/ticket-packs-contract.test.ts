import { describe, expect, it } from "vitest";

import { appRouter } from "../router";

/**
 * Ticket-type packs transport contract (spec FR-012 + the second-factor
 * discipline): every staff ticket-pack procedure lives UNDER `platform.*` so
 * it inherits guard.ts's wholesale staff 2FA gate
 * (`path.startsWith("platform.")`). A top-level `ticketPacks.*` namespace —
 * the placement `volunteerPacks.admin.*` uses — would silently sit OUTSIDE
 * that gate, so this pins both the presence of the nested paths and the
 * absence of the ungated spelling.
 */
describe("ticket packs router contract", () => {
  const procedurePaths = Object.keys(appRouter._def.procedures);

  it("mounts all staff CRUD procedures under platform.ticketPacks.*", () => {
    for (const name of ["list", "get", "upsert", "setStatus", "remove"]) {
      expect(procedurePaths).toContain(`platform.ticketPacks.${name}`);
    }
  });

  it("exposes no top-level ticketPacks namespace (would bypass the 2FA gate)", () => {
    const leaked = procedurePaths.filter((path) =>
      path.startsWith("ticketPacks."),
    );
    expect(leaked).toEqual([]);
  });

  it("exposes the organizer-facing fork under ticketTypeTemplates", () => {
    expect(procedurePaths).toContain(
      "ticketTypeTemplates.forkPlatformTemplate",
    );
  });
});
