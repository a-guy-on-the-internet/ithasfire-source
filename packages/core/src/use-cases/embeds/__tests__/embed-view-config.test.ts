import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";

import {
  upsertEmbed,
  upsertEmbedBaseSchema,
  upsertEmbedInputSchema,
  upsertEmbedOutputSchema,
  EMBED_VIEWS,
} from "../upsert-embed";
import { listEmbeds, listEmbedsOutputSchema } from "../list-embeds";
import {
  getEmbedForWidget,
  getEmbedForWidgetOutputSchema,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";
import {
  getEmbedCalendarEvents,
  getEmbedCalendarEventsOutputSchema,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";

/**
 * Per-embed browse-view config — `defaultView` + `viewToggle`
 * (docs/specs/2026-08-04/embed-unified-views.spec.yaml, FR-001/FR-002/FR-005).
 *
 * The three contracts pinned here:
 *  1. FR-002 — a "place" (booking-button) subject may NOT carry view fields.
 *     Booking is a separate product, and sending one is a caller bug, so it
 *     fails validation rather than being silently dropped.
 *  2. Legacy rows — a row written before the columns existed reads
 *     defaultView "list" / viewToggle false (column defaults, zero backfill,
 *     D-003), and every read path surfaces exactly that, i.e. today's grid.
 *  3. FR-005 — the widget OUTPUT schemas carry the fields and stay `.strict()`,
 *     while the widget INPUT schemas are untouched (pinned separately in
 *     embed-input-contract.test.ts).
 */

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EMBED_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const DOMAIN = "shop.example.com";
const ORIGIN = "https://shop.example.com";
const PUBLIC_APP_URL = "http://localhost:3000";

/**
 * A row as it exists in the DB AFTER the additive migration but with the two
 * columns never explicitly written — i.e. every embed already pasted onto a
 * third-party site. The values come from the column defaults, verified against
 * the dev DB (`SELECT "defaultView","viewToggle" FROM "Embed"` ⇒ list / false).
 */
const legacyRow = (over: Partial<EmbedRecord> = {}): EmbedRecord => ({
  id: EMBED_ID,
  subjectType: "organization",
  subjectId: ORG_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: ACTOR_ID,
  createdAt: new Date("2025-01-01"),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-002 — place (booking) subjects reject view fields
// ─────────────────────────────────────────────────────────────────────────────

const basePlace = {
  id: PLACE_ID,
  name: "The Basement",
  slug: "the-basement",
  verificationStatus: "VERIFIED",
  acceptsBookingRequests: true,
  humanIdsWithAccess: [ACTOR_ID],
  orgIdsWithAccess: [],
} as unknown as PlaceRecord;

function makeUpsertDeps(opts: { subjectType?: string } = {}) {
  const store = new Map<string, EmbedRecord>();

  const upsertFn = vi.fn(
    async (input: {
      subjectType: string;
      subjectId: string;
      domain: string;
      createdBy: string;
      requireAuth?: boolean;
      linkOut?: boolean;
      defaultView?: string;
      viewToggle?: boolean;
    }): Promise<EmbedRecord> => {
      const key = `${input.subjectType}:${input.subjectId}:${input.domain}`;
      const existing = store.get(key);
      // Mirrors the prisma adapter: omitted ⇒ preserve stored (create ⇒
      // column default).
      const record: EmbedRecord = {
        id: existing?.id ?? EMBED_ID,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        domain: input.domain,
        status: "ACTIVE",
        requireAuth: input.requireAuth ?? existing?.requireAuth ?? false,
        linkOut: input.linkOut ?? existing?.linkOut ?? false,
        defaultView: input.defaultView ?? existing?.defaultView ?? "list",
        viewToggle: input.viewToggle ?? existing?.viewToggle ?? false,
        createdBy: input.createdBy,
        createdAt: existing?.createdAt ?? new Date("2025-01-01"),
      };
      store.set(key, record);
      return record;
    },
  );

  const txRepos: Partial<TxRepos> = {
    embeds: { upsert: upsertFn } as unknown as TxRepos["embeds"],
    audit: { log: vi.fn() } as unknown as TxRepos["audit"],
  };

  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: null,
        humanId: ACTOR_ID,
        status: "PUBLISHED",
      })),
    },
    places: { getById: vi.fn(async () => basePlace) },
    authz: { getOrgMemberships: vi.fn(async () => []) },
    embeds: {
      listBySubject: vi.fn(async () => [
        legacyRow({
          subjectType: opts.subjectType ?? "event",
          subjectId: EVENT_ID,
        }),
      ]),
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
  } as unknown as Repos;

  return { repos, upsertFn };
}

const placeInput = {
  actorHumanId: ACTOR_ID,
  subjectType: "place" as const,
  subjectId: PLACE_ID,
  domain: DOMAIN,
};

describe("upsertEmbed — place subjects have no views (FR-002 / D-004)", () => {
  it.each([
    ["defaultView", { defaultView: "calendar" as const }],
    ["viewToggle", { viewToggle: true }],
  ])(
    "rejects a place subject carrying %s — validation error, not a silent drop",
    async (_label, viewField) => {
      const { repos, upsertFn } = makeUpsertDeps();

      await expect(
        upsertEmbed({ repos }, { ...placeInput, ...viewField }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      // Nothing was written — the rejection happens at the boundary, before
      // any RBAC lookup or transaction.
      expect(upsertFn).not.toHaveBeenCalled();
    },
  );

  it("rejects a place subject that sends defaultView 'list' — the value is irrelevant, the FIELD is", async () => {
    const { repos } = makeUpsertDeps();
    await expect(
      upsertEmbed({ repos }, { ...placeInput, defaultView: "list" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports an issue per offending field, pathed to the field", () => {
    const parsed = upsertEmbedInputSchema.safeParse({
      ...placeInput,
      defaultView: "calendar",
      viewToggle: true,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))?.sort()).toEqual([
      "defaultView",
      "viewToggle",
    ]);
  });

  it("still accepts a place subject WITHOUT view fields (booking embeds keep working, FR-012)", async () => {
    const { repos, upsertFn } = makeUpsertDeps();
    const result = await upsertEmbed({ repos }, placeInput);

    expect(result.embed.subjectType).toBe("place");
    expect(result.embed.domain).toBe(DOMAIN);
    // The booking upsert never sends view fields to the repo.
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "place" }),
    );
    const [call] = upsertFn.mock.calls;
    expect(call?.[0].defaultView).toBeUndefined();
    expect(call?.[0].viewToggle).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-001/FR-002 — event-subject write path
// ─────────────────────────────────────────────────────────────────────────────

describe("upsertEmbed — view config on non-place subjects", () => {
  const eventInput = {
    actorHumanId: ACTOR_ID,
    subjectType: "event" as const,
    subjectId: EVENT_ID,
    domain: DOMAIN,
  };

  it("exposes exactly list | calendar", () => {
    expect([...EMBED_VIEWS]).toEqual(["list", "calendar"]);
  });

  it("rejects a view outside the vocabulary", () => {
    expect(
      upsertEmbedBaseSchema.safeParse({ ...eventInput, defaultView: "map" })
        .success,
    ).toBe(false);
  });

  it("persists and returns defaultView + viewToggle", async () => {
    const { repos, upsertFn } = makeUpsertDeps();
    const result = await upsertEmbed({ repos }, {
      ...eventInput,
      defaultView: "calendar",
      viewToggle: true,
    });

    expect(result.embed.defaultView).toBe("calendar");
    expect(result.embed.viewToggle).toBe(true);
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ defaultView: "calendar", viewToggle: true }),
    );
  });

  it("defaults to today's behaviour on create when omitted (list / no switcher)", async () => {
    const { repos, upsertFn } = makeUpsertDeps();
    const result = await upsertEmbed({ repos }, eventInput);

    expect(result.embed.defaultView).toBe("list");
    expect(result.embed.viewToggle).toBe(false);
    // Omitted fields are NOT forwarded — that is what makes the repo preserve
    // the stored value instead of resetting it.
    const [call] = upsertFn.mock.calls;
    expect(call?.[0].defaultView).toBeUndefined();
    expect(call?.[0].viewToggle).toBeUndefined();
  });

  it("PRESERVES stored view config when a later upsert omits the fields (mirrors linkOut)", async () => {
    const { repos } = makeUpsertDeps();

    const created = await upsertEmbed({ repos }, {
      ...eventInput,
      defaultView: "calendar",
      viewToggle: true,
    });
    expect(created.embed.defaultView).toBe("calendar");

    // e.g. the admin page toggling linkOut only — it must not silently reset
    // a control it never rendered.
    const later = await upsertEmbed({ repos }, { ...eventInput, linkOut: true });
    expect(later.embed.id).toBe(created.embed.id);
    expect(later.embed.linkOut).toBe(true);
    expect(later.embed.defaultView).toBe("calendar");
    expect(later.embed.viewToggle).toBe(true);
  });

  it("round-trips through the .strict() output schema", async () => {
    const { repos } = makeUpsertDeps();
    const result = await upsertEmbed({ repos }, {
      ...eventInput,
      defaultView: "calendar",
    });
    expect(upsertEmbedOutputSchema.safeParse(result).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-002 — listEmbeds surfaces current state for the admin page
// ─────────────────────────────────────────────────────────────────────────────

describe("listEmbeds — view config in the admin payload", () => {
  const listInput = {
    actorHumanId: ACTOR_ID,
    subjectType: "event" as const,
    subjectId: EVENT_ID,
  };

  it("surfaces the column defaults for a legacy row and round-trips .strict()", async () => {
    const { repos } = makeUpsertDeps();
    const result = await listEmbeds({ repos }, listInput);

    expect(result.embeds[0]).toMatchObject({
      defaultView: "list",
      viewToggle: false,
    });
    expect(listEmbedsOutputSchema.safeParse(result).success).toBe(true);
  });

  it("surfaces a configured row verbatim", async () => {
    const { repos } = makeUpsertDeps();
    (
      repos.embeds.listBySubject as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([
      legacyRow({
        subjectType: "event",
        subjectId: EVENT_ID,
        defaultView: "calendar",
        viewToggle: true,
      }),
    ]);

    const result = await listEmbeds({ repos }, listInput);
    expect(result.embeds[0]).toMatchObject({
      defaultView: "calendar",
      viewToggle: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-005 — widget payloads carry the view config
// ─────────────────────────────────────────────────────────────────────────────

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const orgSuggestion = {
  type: "event" as const,
  id: `doc-${EVENT_ID}`,
  eventId: EVENT_ID,
  title: "Embedded Show",
  subtitle: null,
  helper: null,
  slug: "embedded-show",
  startsAt: future,
  endsAt: null,
  city: "Nashville",
  region: "TN",
  location: "123 Main",
  lat: null,
  lng: null,
  imageUrl: null,
  lowestPriceCents: null,
  lowestBuyerTotalCents: null,
  currency: "usd",
  paidTierCount: 0,
  hasFreeTier: false,
  confidence: 1,
};

function widgetDeps(embed: EmbedRecord) {
  const autocomplete = vi.fn(async () => ({
    ok: true as const,
    value: { suggestions: [orgSuggestion], latencyMs: 1 },
  }));
  const repos = {
    embeds: { getById: vi.fn(async () => embed) },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        name: "Demo Org",
        slug: "demo-org",
      })),
    },
    humans: { getById: vi.fn(async () => null) },
    places: { listOwnedBySubject: vi.fn(async () => []) },
    events: {
      getById: vi.fn(),
      // FR-001 timezone + FR-023 currency come from the row, not the index.
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, timezone: "America/Chicago", currency: "usd" })),
      ),
      // FR-022/FR-023: no ticket types ⇒ soldOut false, priceLabel null.
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    tickets: { countCapacityUsageForTicketTypes: vi.fn(async () => []) },
    eventDates: { listByEventIds: vi.fn(async () => []) },
    imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
  };
  return {
    grid: {
      repos: repos as unknown as GetEmbedForWidgetDeps["repos"],
      search: { autocomplete } as unknown as GetEmbedForWidgetDeps["search"],
      publicAppUrl: PUBLIC_APP_URL,
    } satisfies GetEmbedForWidgetDeps,
    calendar: {
      repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
      search:
        { autocomplete } as unknown as GetEmbedCalendarEventsDeps["search"],
        clock: { now: () => new Date() },
      publicAppUrl: PUBLIC_APP_URL,
    } satisfies GetEmbedCalendarEventsDeps,
  };
}

const widgetInput = { embedId: EMBED_ID, hostOrigin: ORIGIN };

describe("widget payloads carry defaultView + viewToggle (FR-005)", () => {
  it("getEmbedForWidget on a LEGACY row reports list / false — today's grid", async () => {
    const result = await getEmbedForWidget(
      widgetDeps(legacyRow()).grid,
      widgetInput,
    );
    expect(result.embed.defaultView).toBe("list");
    expect(result.embed.viewToggle).toBe(false);
    expect(getEmbedForWidgetOutputSchema.safeParse(result).success).toBe(true);
  });

  it("getEmbedCalendarEvents on a LEGACY row reports list / false", async () => {
    const result = await getEmbedCalendarEvents(
      widgetDeps(legacyRow()).calendar,
      widgetInput,
    );
    expect(result.embed.defaultView).toBe("list");
    expect(result.embed.viewToggle).toBe(false);
    expect(getEmbedCalendarEventsOutputSchema.safeParse(result).success).toBe(
      true,
    );
  });

  it.each([
    [
      "getEmbedForWidget",
      (embed: EmbedRecord) =>
        getEmbedForWidget(widgetDeps(embed).grid, widgetInput),
    ],
    [
      "getEmbedCalendarEvents",
      (embed: EmbedRecord) =>
        getEmbedCalendarEvents(widgetDeps(embed).calendar, widgetInput),
    ],
  ])("%s surfaces a configured row verbatim", async (_label, run) => {
    const result = await run(
      legacyRow({ defaultView: "calendar", viewToggle: true }),
    );
    expect(result.embed.defaultView).toBe("calendar");
    expect(result.embed.viewToggle).toBe(true);
  });

  it.each([
    [
      "getEmbedForWidget",
      (embed: EmbedRecord) =>
        getEmbedForWidget(widgetDeps(embed).grid, widgetInput),
    ],
    [
      "getEmbedCalendarEvents",
      (embed: EmbedRecord) =>
        getEmbedCalendarEvents(widgetDeps(embed).calendar, widgetInput),
    ],
  ])(
    "%s passes through an UNRECOGNISED stored view instead of throwing",
    async (_label, run) => {
      // `defaultView` is a bare String column, so a value written under a
      // future (or rolled-back) vocabulary must not blow up the public read
      // path — the widget degrades to "list" client-side.
      const result = await run(legacyRow({ defaultView: "week" }));
      expect(result.embed.defaultView).toBe("week");
    },
  );
});

describe("widget output schemas stay .strict() (FR-005)", () => {
  const strictEmbedBase = {
    id: EMBED_ID,
    subjectType: "organization",
    subjectId: ORG_ID,
    domain: DOMAIN,
    defaultView: "list",
    viewToggle: false,
  };

  const gridEmbed = { ...strictEmbedBase, requireAuth: false, linkOut: false };
  const calendarEmbed = { ...strictEmbedBase, linkOut: false };

  it("getEmbedForWidget rejects an unknown TOP-LEVEL key", () => {
    expect(
      getEmbedForWidgetOutputSchema.safeParse({
        embed: gridEmbed,
        view: "calendar",
      }).success,
    ).toBe(false);
  });

  it("getEmbedCalendarEvents rejects an unknown TOP-LEVEL key", () => {
    expect(
      getEmbedCalendarEventsOutputSchema.safeParse({
        embed: calendarEmbed,
        ownerName: "Demo Org",
        events: [],
        view: "calendar",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["getEmbedForWidget", getEmbedForWidgetOutputSchema, { embed: gridEmbed }],
    [
      "getEmbedCalendarEvents",
      getEmbedCalendarEventsOutputSchema,
      { embed: calendarEmbed, ownerName: "Demo Org", events: [] },
    ],
  ])(
    "%s STRIPS an unknown key nested inside embed (only the top level is .strict())",
    (_label, schema, payload) => {
      // Pinning the real behaviour, not a wish: `.strict()` is on the outer
      // object, so a stray `embed.view` is silently dropped rather than
      // rejected. That is why the view fields had to be added to the nested
      // shape explicitly (FR-005) — a passthrough would never have surfaced.
      const embed = (payload as { embed: Record<string, unknown> }).embed;
      const parsed = schema.safeParse({
        ...payload,
        embed: { ...embed, view: "calendar" },
      });
      expect(parsed.success).toBe(true);
      expect(
        (parsed.data as { embed: Record<string, unknown> } | undefined)?.embed,
      ).not.toHaveProperty("view");
    },
  );

  it.each([
    ["defaultView", "getEmbedForWidget"],
    ["viewToggle", "getEmbedForWidget"],
  ])("getEmbedForWidget requires %s", (field) => {
    const embed: Record<string, unknown> = {
      ...strictEmbedBase,
      requireAuth: false,
      linkOut: false,
    };
    delete embed[field];
    expect(getEmbedForWidgetOutputSchema.safeParse({ embed }).success).toBe(
      false,
    );
  });
});
