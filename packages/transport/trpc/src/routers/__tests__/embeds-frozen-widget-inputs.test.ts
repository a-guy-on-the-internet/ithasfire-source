import { describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { embedsRouter } from "../embeds";
import { createTestLogger } from "@th/test-utils";

/**
 * Frozen public-widget INPUTS (embed-unified-views FR-005, NFR-001).
 *
 * The unified-views feature adds a browse `view` concept, and the obvious wrong
 * move is to forward the widget's `?view=` URL param into the tRPC call. Both
 * public widget procedures take `.strict()` inputs, so that would 400 EVERY
 * widget on every third-party site the moment the param appears — the repo's
 * documented strict-input footgun class (see the `direction` note in
 * embed-input-contract.test.ts).
 *
 * `view` is resolved CLIENT-SIDE from the URL plus `embed.defaultView` /
 * `embed.viewToggle`, which ride the procedure OUTPUT. These tests pin that
 * split at the transport boundary: the input key sets do not change, and a
 * smuggled `view` is rejected before the use case is reached.
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000d0";
const ORG_ID = "00000000-0000-4000-8000-0000000000d1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000d2";
const ACTOR_ID = "00000000-0000-4000-8000-0000000000d3";
const PLACE_ID = "00000000-0000-4000-8000-0000000000d4";
const DOMAIN = "shop.example.com";
const ORIGIN = "https://shop.example.com";

/** The exact wire shape both public widget queries accept. Do not grow this. */
const FROZEN_WIDGET_INPUT_KEYS = ["embedId", "hostOrigin", "scope"];

const embedRow = (over: Record<string, unknown> = {}) => ({
  id: EMBED_ID,
  subjectType: "organization",
  subjectId: ORG_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const emptySearch = () =>
  ({
    autocomplete: vi.fn(async () => ({
      ok: true as const,
      value: { suggestions: [], latencyMs: 1 },
    })),
  }) as unknown as Ctx["multiSearch"];

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {
      embeds: { getById: vi.fn(async () => embedRow()) },
      organizations: {
        getById: vi.fn(async () => ({
          id: ORG_ID,
          name: "Demo Org",
          slug: "demo-org",
        })),
      },
      humans: { getById: vi.fn(async () => null) },
      places: { listOwnedBySubject: vi.fn(async () => []) },
      events: { getById: vi.fn(async () => null) },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    } as unknown as Ctx["repos"],
    multiSearch: emptySearch(),
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } as Ctx["clock"],
    logger: createTestLogger(),
    publicAppUrl: "http://localhost:3000",
    clientIp: "203.0.113.7",
    actorHumanId: null,
    auth: null,
    authToken: null,
    apiKey: null,
    ...overrides,
  }) as unknown as Ctx;

const appRouter = () => trpcRouter({ embeds: router(embedsRouter) });
const callerFor = (ctx: Ctx) => appRouter().createCaller(ctx);

/** Reads the input schema(s) actually registered on a built procedure. */
function procedureInputShapeKeys(path: string): string[] {
  const procedures = appRouter()._def.procedures as Record<string, unknown>;
  const proc = procedures[path] as
    | { _def?: { inputs?: { shape?: Record<string, unknown> }[] } }
    | undefined;
  expect(proc, `procedure ${path} is missing`).toBeTruthy();
  const inputs = proc?._def?.inputs ?? [];
  // One `.input()` call, one schema — a second would mean someone merged an
  // extra input layer in, which is exactly the change this test exists to see.
  expect(inputs).toHaveLength(1);
  return Object.keys(inputs[0]?.shape ?? {}).sort();
}

describe("public widget procedure inputs are frozen (FR-005)", () => {
  it.each([["embeds.getForWidget"], ["embeds.getCalendarEvents"]])(
    "%s registers exactly embedId | hostOrigin | scope",
    (path) => {
      expect(procedureInputShapeKeys(path)).toEqual([
        ...FROZEN_WIDGET_INPUT_KEYS,
      ]);
    },
  );

  it.each([
    ["getForWidget", (c: ReturnType<typeof callerFor>) => c.embeds.getForWidget],
    [
      "getCalendarEvents",
      (c: ReturnType<typeof callerFor>) => c.embeds.getCalendarEvents,
    ],
  ])(
    "%s BAD_REQUESTs a smuggled ?view= and never reaches the use case",
    async (_label, pick) => {
      const ctx = buildCtx();
      const getById = (
        ctx.repos as unknown as { embeds: { getById: ReturnType<typeof vi.fn> } }
      ).embeds.getById;

      await expect(
        pick(callerFor(ctx))({
          embedId: EMBED_ID,
          hostOrigin: ORIGIN,
          view: "calendar",
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // The whole widget would have gone down here in production — pin that
      // the rejection is at the boundary, not a swallowed no-op.
      expect(getById).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["getForWidget", (c: ReturnType<typeof callerFor>) => c.embeds.getForWidget],
    [
      "getCalendarEvents",
      (c: ReturnType<typeof callerFor>) => c.embeds.getCalendarEvents,
    ],
  ])(
    "%s positive control: the same call WITHOUT view succeeds and carries the view config on the OUTPUT",
    async (_label, pick) => {
      const result = (await pick(callerFor(buildCtx()))({
        embedId: EMBED_ID,
        hostOrigin: ORIGIN,
      })) as { embed: { defaultView: string; viewToggle: boolean } };

      expect(result.embed.defaultView).toBe("list");
      expect(result.embed.viewToggle).toBe(false);
    },
  );

  it("a non-allowlisted host origin is still rejected on both view queries (NFR-003)", async () => {
    const caller = callerFor(buildCtx());
    for (const call of [
      caller.embeds.getForWidget,
      caller.embeds.getCalendarEvents,
    ]) {
      await expect(
        call({ embedId: EMBED_ID, hostOrigin: "https://evil.example.net" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upsert / list threading (FR-002)
// ─────────────────────────────────────────────────────────────────────────────

function adminCtx(embedOverrides: Record<string, unknown> = {}) {
  const upsert = vi.fn(async (input: Record<string, unknown>) =>
    embedRow({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      domain: input.domain,
      defaultView: input.defaultView ?? "list",
      viewToggle: input.viewToggle ?? false,
    }),
  );
  const mocks = {
    embeds: {
      upsert,
      listBySubject: vi.fn(async () => [embedRow(embedOverrides)]),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: null,
        humanId: ACTOR_ID,
        status: "PUBLISHED",
      })),
    },
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        name: "The Basement",
        humanIdsWithAccess: [ACTOR_ID],
        orgIdsWithAccess: [],
      })),
    },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    audit: { log: vi.fn(async () => {}) },
  };
  const repos = {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
  } as unknown as Ctx["repos"];

  return {
    mocks,
    ctx: buildCtx({
      repos,
      actorHumanId: ACTOR_ID,
      auth: {
        userId: ACTOR_ID,
        sessionId: null,
        token: "t",
      } as Ctx["auth"],
      authToken: "t",
    }),
  };
}

describe("embeds.upsert / embeds.list thread the view config", () => {
  const eventSubject = {
    subjectType: "event" as const,
    subjectId: EVENT_ID,
    domain: DOMAIN,
  };

  it("accepts defaultView + viewToggle and returns them in the DTO", async () => {
    const { ctx, mocks } = adminCtx();
    const result = await callerFor(ctx).embeds.upsert({
      ...eventSubject,
      defaultView: "calendar",
      viewToggle: true,
    });

    expect(result.embed.defaultView).toBe("calendar");
    expect(result.embed.viewToggle).toBe(true);
    expect(mocks.embeds.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ defaultView: "calendar", viewToggle: true }),
    );
  });

  it("rejects a view outside list | calendar at the transport boundary", async () => {
    const { ctx, mocks } = adminCtx();
    await expect(
      callerFor(ctx).embeds.upsert({
        ...eventSubject,
        defaultView: "map" as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.embeds.upsert).not.toHaveBeenCalled();
  });

  it("rejects view fields on a PLACE subject — the use case re-validates the cross-field rule transport's .omit() drops (FR-002/FR-012)", async () => {
    const { ctx, mocks } = adminCtx();
    await expect(
      callerFor(ctx).embeds.upsert({
        subjectType: "place",
        subjectId: PLACE_ID,
        domain: DOMAIN,
        defaultView: "calendar",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.embeds.upsert).not.toHaveBeenCalled();
  });

  it("still upserts a PLACE subject with no view fields (booking untouched)", async () => {
    const { ctx, mocks } = adminCtx();
    const result = await callerFor(ctx).embeds.upsert({
      subjectType: "place",
      subjectId: PLACE_ID,
      domain: DOMAIN,
    });
    expect(result.embed.subjectType).toBe("place");
    expect(mocks.embeds.upsert).toHaveBeenCalledTimes(1);
  });

  it("list surfaces the stored view config for the admin page", async () => {
    const { ctx } = adminCtx({ defaultView: "calendar", viewToggle: true });
    const result = await callerFor(ctx).embeds.list({
      subjectType: "event",
      subjectId: EVENT_ID,
    });
    expect(result.embeds[0]).toMatchObject({
      defaultView: "calendar",
      viewToggle: true,
    });
  });

  it("list surfaces the column defaults for a legacy row (NFR-001)", async () => {
    const { ctx } = adminCtx();
    const result = await callerFor(ctx).embeds.list({
      subjectType: "event",
      subjectId: EVENT_ID,
    });
    expect(result.embeds[0]).toMatchObject({
      defaultView: "list",
      viewToggle: false,
    });
  });
});
