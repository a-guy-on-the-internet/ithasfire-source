import { describe, expect, it, vi } from "vitest";

import { makeOrganizationsRepo } from "../organizations";
import { makePlacesRepo } from "../places";

/**
 * Event COUNTS shown outside the owner's own tenant count PUBLIC events only.
 * A PRIVATE event is link-only; counting it in a number strangers see says
 * that it exists.
 *
 *   · `organizations.listActive().eventCount` → the public organization
 *     search document ("N events" on the result card).
 *   · `places.listAccessibleByHuman().eventsCount` → the places table, which
 *     lists globally-VERIFIED venues to any signed-in user.
 */

describe("public event counts — PUBLISHED + PUBLIC only", () => {
  it("organizations.listActive counts PUBLISHED + PUBLIC events", async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    await makeOrganizationsRepo({
      organization: { findMany, count },
    } as never).listActive({ limit: 10, offset: 0 });
    const args = (findMany.mock.calls[0] as unknown as [
      { select: { _count: { select: { events: unknown } } } },
    ])[0];
    expect(args.select._count.select.events).toEqual({
      where: { status: "PUBLISHED", visibility: "PUBLIC" },
    });
  });

  it("places.listAccessibleByHuman counts PUBLISHED + PUBLIC events", async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    await makePlacesRepo({ place: { findMany, count } } as never).listAccessibleByHuman({
      humanId: "00000000-0000-4000-8000-0000000000c1",
      limit: 10,
      offset: 0,
    } as never);
    const args = (findMany.mock.calls[0] as unknown as [
      { select: { _count: { select: { events: unknown } } } },
    ])[0];
    expect(args.select._count.select.events).toEqual({
      where: { status: "PUBLISHED", visibility: "PUBLIC" },
    });
  });
});
