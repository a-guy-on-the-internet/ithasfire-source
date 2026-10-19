import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

import * as placesUseCases from "@th/core/use-cases/places";

import { createCaller } from "./test-helpers";
import { placesRouter } from "../places";

describe("placesRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("listHumanPlaces", () => {
    it("injects actor human id and forwards dependencies", async () => {
      const listSpy = vi
        .spyOn(placesUseCases, "listHumanPlaces")
        .mockResolvedValue({
          places: [
            {
              placeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              name: "Nomad Warehouse",
              formattedAddress: "123 Main",
              addressLine1: "123 Main",
              addressLine2: null,
              city: "Los Angeles",
              region: "CA",
              postalCode: "90001",
              countryCode: "US",
              capacity: 1200,
              lat: 34.04,
              lng: -118.25,
              timezone: "America/Los_Angeles",
              eventsCount: 3,
              status: "ACTIVE",
              verificationStatus: "VERIFIED",
              activeVerificationRequestStatus: null,
              listedInDirectory: true,
              // Address privacy (place-address-withholding). Required on the
              // output schema, not optional: a row that cannot say whether its
              // address is withheld has no business being rendered.
              locationIsExact: true,
              locationHidden: false,
              areaLabel: "Los Angeles, CA",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              access: {
                orgIds: [],
                humanIds: [],
              },
            },
          ],
          pageInfo: {
            total: 1,
            count: 1,
            limit: 5,
            offset: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        });

      const { caller, ctx } = createCaller(placesRouter);

      const result = await caller.listHumanPlaces({ limit: 5, query: "Nomad" });

      expect(result.places).toHaveLength(1);
      expect(listSpy).toHaveBeenCalledTimes(1);
      const call = listSpy.mock.calls[0];
      expect(call).toBeDefined();
      const [depsArg, inputArg] = call!;
      expect(depsArg.repos).toBe(ctx.repos);
      expect(depsArg.logger).toBeDefined();
      expect(depsArg.logger?.info).toBeTypeOf("function");
      expect(inputArg).toMatchObject({
        actorHumanId: ctx.actorHumanId,
        query: "Nomad",
        limit: 5,
        verifiedOnly: true,
      });
      // The new eventsCount aggregate must survive the output schema.
      expect(result.places[0]?.eventsCount).toBe(3);
    });

    it("forwards sort and status filter params", async () => {
      const listSpy = vi
        .spyOn(placesUseCases, "listHumanPlaces")
        .mockResolvedValue({
          places: [],
          pageInfo: {
            total: 0,
            count: 0,
            limit: 20,
            offset: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        });

      const { caller } = createCaller(placesRouter);

      await caller.listHumanPlaces({
        sort: { field: "created", direction: "desc" },
        status: "archived",
      });

      expect(listSpy).toHaveBeenCalledTimes(1);
      const [, inputArg] = listSpy.mock.calls[0]!;
      expect(inputArg).toMatchObject({
        sort: { field: "created", direction: "desc" },
        status: "archived",
      });
    });

    it("rejects an invalid sort field at the transport boundary", async () => {
      const listSpy = vi
        .spyOn(placesUseCases, "listHumanPlaces")
        .mockResolvedValue({
          places: [],
          pageInfo: {
            total: 0,
            count: 0,
            limit: 20,
            offset: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        });

      const { caller } = createCaller(placesRouter);

      await expect(
        caller.listHumanPlaces({
          // @ts-expect-error — invalid sort field must be rejected by zod
          sort: { field: "verification", direction: "asc" },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("rejects when actor human id is missing", async () => {
      const listSpy = vi
        .spyOn(placesUseCases, "listHumanPlaces")
        .mockResolvedValue({
          places: [],
          pageInfo: {
            total: 0,
            count: 0,
            limit: 1,
            offset: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        });

      const { caller } = createCaller(placesRouter, {
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(caller.listHumanPlaces({ limit: 1 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("maps use case errors", async () => {
      vi.spyOn(placesUseCases, "listHumanPlaces").mockRejectedValue({
        code: "invalid_input",
        message: "query_too_short",
      });

      const { caller } = createCaller(placesRouter);

      await expect(
        caller.listHumanPlaces({ query: "a" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  it("injects actor human id and forwards dependencies to upsertPlace", async () => {
    const upsertSpy = vi
      .spyOn(placesUseCases, "upsertPlace")
      .mockResolvedValue({
        placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        access: { orgIds: [], humanIds: [] },
      });

    const { caller, ctx } = createCaller(placesRouter);

    const input = {
      owner: { kind: "human" as const, humanId: ctx.actorHumanId! },
      name: "My Living Room",
      address: {
        formatted: "123 Main St, City, ST",
        line1: "123 Main St",
        countryCode: "us",
      },
      capacity: 12,
      clientKey: "abcdefgh",
    } satisfies Parameters<typeof caller.upsertPlace>[0];

    const result = await caller.upsertPlace(input);

    expect(result).toEqual({
      placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
      access: { orgIds: [], humanIds: [] },
    });

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        owner: { kind: "human", humanId: ctx.actorHumanId },
        name: "My Living Room",
        address: expect.objectContaining({
          formatted: "123 Main St, City, ST",
          line1: "123 Main St",
          countryCode: "US",
        }),
        capacity: 12,
        clientKey: "abcdefgh",
      }),
    );
  });

  it("rejects when actor human id is missing", async () => {
    const upsertSpy = vi
      .spyOn(placesUseCases, "upsertPlace")
      .mockResolvedValue({
        placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "ACTIVE",
        verificationStatus: "UNVERIFIED",
        access: { orgIds: [], humanIds: [] },
      });

    const { caller } = createCaller(placesRouter, {
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(
      caller.upsertPlace({
        owner: {
          kind: "human",
          humanId: "00000000-0000-4000-8000-000000000000",
        },
        name: "Unauthorized Place",
        address: {
          formatted: "456 Main",
          line1: "456 Main",
          countryCode: "us",
        },
        clientKey: "abcdefgh",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("maps use case errors to TRPC errors", async () => {
    vi.spyOn(placesUseCases, "upsertPlace").mockRejectedValue({
      code: "forbidden",
      message: "not_allowed",
    });

    const { caller } = createCaller(placesRouter);

    await expect(
      caller.upsertPlace({
        owner: {
          kind: "human",
          humanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
        name: "Another Place",
        address: {
          formatted: "789 Main",
          line1: "789 Main",
          countryCode: "us",
        },
        clientKey: "abcdefgh",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "not_allowed" });
  });

  it("injects actor human id and forwards dependencies to updatePlaceStatus", async () => {
    const updateSpy = vi
      .spyOn(placesUseCases, "updatePlaceStatus")
      .mockResolvedValue({
        placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "ARCHIVED",
      });

    const { caller, ctx } = createCaller(placesRouter);

    const result = await caller.updatePlaceStatus({
      placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "ARCHIVED",
      clientKey: "abcdefgh",
    });

    expect(result).toEqual({
      placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "ARCHIVED",
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "ARCHIVED",
        clientKey: "abcdefgh",
      }),
    );
  });

  it("rejects updatePlaceStatus when actor human id is missing", async () => {
    const updateSpy = vi
      .spyOn(placesUseCases, "updatePlaceStatus")
      .mockResolvedValue({
        placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "ARCHIVED",
      });

    const { caller } = createCaller(placesRouter, {
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(
      caller.updatePlaceStatus({
        placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "ARCHIVED",
        clientKey: "abcdefgh",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("maps updatePlaceStatus use case errors to TRPC errors", async () => {
    vi.spyOn(placesUseCases, "updatePlaceStatus").mockRejectedValue({
      code: "forbidden",
      message: "not_allowed",
    });

    const { caller } = createCaller(placesRouter);

    await expect(
      caller.updatePlaceStatus({
        placeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "ARCHIVED",
        clientKey: "abcdefgh",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "not_allowed" });
  });

  // `places.updatePlaceVerificationStatus` used to be pinned here (forwarding,
  // actor injection, error mapping). It was DELETED as a
  // privilege-escalation hole — an org admin could POST
  // `{ verificationStatus: "VERIFIED" }` and mint their own verified badge.
  // Its replacement coverage lives in `platform-place-verification.test.ts`
  // (removal is pinned structurally) and
  // `@th/core`'s `update-place-verification-status.test.ts` (the server-side
  // staff-only guarantee for terminal decisions).
  describe("resolveTimezone", () => {
    // The read-only lat/lng -> IANA lookup the event editor calls when an
    // organiser picks a FREEFORM address, so the zone field stops defaulting to
    // the organiser's browser zone (venue-hierarchy FR-004).
    it("passes the coordinates through to the port and returns its answer", async () => {
      const timezoneLookup = vi.fn(() => "America/New_York");
      const { caller } = createCaller(placesRouter, { timezoneLookup });

      await expect(
        caller.resolveTimezone({ lat: 40.7182, lng: -73.9884 }),
      ).resolves.toEqual({ timezone: "America/New_York" });
      expect(timezoneLookup).toHaveBeenCalledWith(40.7182, -73.9884);
    });

    it("answers null when no port is wired, rather than failing the request", async () => {
      const { caller } = createCaller(placesRouter);

      await expect(
        caller.resolveTimezone({ lat: 40.7182, lng: -73.9884 }),
      ).resolves.toEqual({ timezone: null });
    });

    it("maps invalid coordinates to BAD_REQUEST", async () => {
      const { caller } = createCaller(placesRouter, {
        timezoneLookup: () => "America/New_York",
      });

      await expect(
        caller.resolveTimezone({ lat: 991, lng: -73.9884 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("requires auth", async () => {
      const { caller } = createCaller(placesRouter, {
        auth: null,
        authToken: null,
        actorHumanId: null,
        timezoneLookup: () => "America/New_York",
      });

      await expect(
        caller.resolveTimezone({ lat: 40.7182, lng: -73.9884 }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  /**
   * The gate for this read lives in core (`canManagePlace`), but the router is
   * the only thing that hands core the port to call it with. Forget
   * `authz: ctx.authz` here and the use case throws on `undefined` instead of
   * refusing — which is a 500, not a 403 — so the wiring gets its own pin.
   */
  describe("getPlaceForEdit", () => {
    it("forwards ctx.authz so the canManagePlace gate can run", async () => {
      const spy = vi
        .spyOn(placesUseCases, "getPlaceForEdit")
        .mockResolvedValue({
          place: {},
        } as unknown as Awaited<
          ReturnType<typeof placesUseCases.getPlaceForEdit>
        >);

      const { caller, ctx } = createCaller(placesRouter);
      await caller
        .getPlaceForEdit({ placeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
        // The output schema rejects the stub payload; the deps assertion below
        // is what this test is about, and it is recorded before that happens.
        .catch(() => undefined);

      expect(spy).toHaveBeenCalledTimes(1);
      const [depsArg, inputArg] = spy.mock.calls[0]!;
      expect(depsArg.authz).toBe(ctx.authz);
      expect(depsArg.repos).toBe(ctx.repos);
      expect(inputArg).toMatchObject({ actorHumanId: ctx.actorHumanId });
    });

    it("maps the gate's refusal to FORBIDDEN, not a 500", async () => {
      vi.spyOn(placesUseCases, "getPlaceForEdit").mockRejectedValue(
        new AppError("NOT_RESOURCE_OWNER", { meta: { entity: "place" } }),
      );

      const { caller } = createCaller(placesRouter);

      await expect(
        caller.getPlaceForEdit({
          placeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("exposes no org-side verification-status write", () => {
    expect(placesRouter).not.toHaveProperty("updatePlaceVerificationStatus");
    // The use case itself is untouched — the platform route still uses it.
    expect(placesUseCases.updatePlaceVerificationStatus).toBeTypeOf("function");
  });
});
