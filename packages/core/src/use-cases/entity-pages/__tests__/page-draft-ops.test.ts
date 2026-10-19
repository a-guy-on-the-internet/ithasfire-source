import { randomUUID } from "node:crypto";

import sanitizeHtml from "sanitize-html";
import { describe, expect, it, vi } from "vitest";

import {
  PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
  type PageBlockRecord,
  type PageDraftRecord,
  type PageOwnerType,
} from "@th/types/repos/entity-pages";

import {
  PAGE_BIO_MAX_LENGTH,
  PAGE_DRAFT_MAX_DATA_JSON_LENGTH,
  PAGE_DRAFT_MAX_EDITOR_ENTRIES,
  PAGE_DRAFT_MAX_LEAVES,
  applyOverlay,
  blockHasContent,
  changeCount,
  changedSince,
  draftValuesEqual,
  isBatchApplied,
  isEmptyDraft,
  mergeOps,
  parseOps,
  placeDraftFactsFromRecord,
  resolveMainOrder,
  type PageDraftOpsContext,
  type ParsedPageDraftOp,
  type PlaceDraftFacts,
} from "../page-draft-ops";
import { canPlace, resolvePageZoneLayout } from "../page-zones";
import { PAGE_RICH_TEXT_MAX_INPUT_LENGTH } from "../../../lib/page-rich-text";

// sanitize-html, passed through but counted: the rich-text budget test
// proves an over-budget op is refused BEFORE it is parsed.
vi.mock("sanitize-html", async (importOriginal) => {
  // sanitize-html is `export =`: at runtime the function is `default`.
  const actual = await importOriginal<{
    default: typeof import("sanitize-html");
  }>();
  return {
    ...actual,
    default: Object.assign(vi.fn(actual.default), actual.default),
  };
});

const layout = resolvePageZoneLayout("PLACE", "standard")!;
const PAGE_ID = "page-1";
const HUMAN_A = "human-a";
const HUMAN_B = "human-b";
const NOW = new Date("2026-10-08T15:00:00.000Z");
const LATER = new Date("2026-10-08T15:05:00.000Z");
const IMAGE_PREFIX = "https://cdn.example/pages/page-1/";

function block(
  id: string,
  kind: string,
  orderIndex: number,
  extra: Partial<PageBlockRecord> = {},
): PageBlockRecord {
  return {
    id,
    pageId: PAGE_ID,
    kind,
    orderIndex,
    data: {},
    visible: true,
    section: "main",
    ...extra,
  };
}

// Stored order is deliberately NOT zone order: the public layout sorts at
// render time, so the draft must too.
const LIVE_BLOCKS: PageBlockRecord[] = [
  block("blk-booking", "booking_info", 0),
  block("blk-amenities", "amenities", 1, { data: { amenities: ["Bar"] } }),
  block("blk-about", "about", 2, {
    data: { heading: "About", content: "We host shows.\n\nAll ages." },
  }),
  block("blk-photos", "photos", 3),
  block("blk-track", "track_record", 4),
  block("blk-tech", "tech_specs", 5),
  block("blk-links", "links", 6),
  block("blk-member", "about", 0, { section: "memberships" }),
];

function emptyDraft(overrides: Partial<PageDraftRecord> = {}): PageDraftRecord {
  return {
    id: "draft-1",
    pageId: PAGE_ID,
    data: {},
    placePatch: {},
    placeBase: {},
    fieldEditors: {},
    appliedBatchIds: [],
    revision: 0,
    lastPublishedRevision: null,
    updatedByHumanId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function ctxFor(
  draft: PageDraftRecord | null,
  ownerType: PageOwnerType = "PLACE",
): PageDraftOpsContext {
  return {
    ownerType,
    layout,
    liveBlocks: LIVE_BLOCKS,
    draft,
    isAllowedImageUrl: (url) => url.startsWith(IMAGE_PREFIX),
    isAllowedBlockImageUrl: (url) => url.startsWith(IMAGE_PREFIX),
  };
}

const PLACE_LIVE: PlaceDraftFacts = {
  name: "The Room",
  capacity: 200,
  phone: null,
  website: null,
  address: { formatted: "1 Main St, Minneapolis, MN", countryCode: "US" },
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
};

function parseOk(
  rawOps: unknown,
  draft: PageDraftRecord | null = null,
): ParsedPageDraftOp[] {
  const result = parseOps(rawOps, ctxFor(draft));
  if (!result.ok)
    throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.ops;
}

function codes(
  rawOps: unknown,
  draft: PageDraftRecord | null = null,
  ownerType?: PageOwnerType,
) {
  const result = parseOps(rawOps, ctxFor(draft, ownerType));
  return result.ok ? [] : result.errors.map((error) => error.code);
}

/** Parse + merge one batch, returning the next stored row (as the adapter would). */
function save(
  locked: PageDraftRecord,
  rawOps: unknown,
  actorHumanId = HUMAN_A,
  now = NOW,
  placeLive: PlaceDraftFacts | null = PLACE_LIVE,
): PageDraftRecord {
  const ops = parseOk(rawOps, locked);
  const result = mergeOps(locked, ops, {
    batchId: randomUUID(),
    actorHumanId,
    now,
    placeLive,
  });
  if (result.deduped) throw new Error("unexpected dedupe");
  return { ...locked, ...result.next };
}

// ── Path grammar ───────────────────────────────────────────────────────────

describe("path grammar", () => {
  it("refuses non-leaf paths (a path that is a prefix of leaves)", () => {
    expect(codes([{ path: "theme", value: {} }])).toEqual(["path_not_leaf"]);
    expect(codes([{ path: "page", value: {} }])).toEqual(["path_not_leaf"]);
    expect(codes([{ path: "order", value: [] }])).toEqual(["path_not_leaf"]);
    expect(codes([{ path: "blocks.blk-about", value: {} }])).toEqual([
      "path_not_leaf",
    ]);
    expect(codes([{ path: "blocks.blk-about.data", value: {} }])).toEqual([
      "path_not_leaf",
    ]);
  });

  it("refuses a path that collides with a stored path by prefix", () => {
    // Planted by hand: the grammar never writes a key under a leaf, but the
    // generic rule must hold whatever the grammar becomes (R19).
    const draft = emptyDraft({ data: { "page.bio.extra": "x" } });
    const result = parseOps([{ path: "page.bio", value: "hi" }], ctxFor(draft));
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          index: 0,
          path: "page.bio",
          code: "path_prefix_conflict",
          meta: { conflictsWith: "page.bio.extra" },
        },
      ],
    });
  });

  it("refuses paths below a leaf and unknown fields", () => {
    expect(codes([{ path: "theme.colorBg.x", value: "#fff" }])).toEqual([
      "path_unknown",
    ]);
    expect(codes([{ path: "page.displayName", value: "x" }])).toEqual([
      "path_unknown",
    ]);
    expect(codes([{ path: "theme.layoutKey", value: "grid" }])).toEqual([
      "path_unknown",
    ]);
    expect(codes([{ path: "blocks.blk-about.orderIndex", value: 3 }])).toEqual([
      "path_unknown",
    ]);
    expect(codes([{ path: "page..bio", value: "x" }])).toEqual([
      "path_unknown",
    ]);
  });

  it("reserves v and v.* (the format version)", () => {
    expect(codes([{ path: "v", value: 2 }])).toEqual(["path_reserved"]);
    expect(codes([{ path: "v.anything", value: 2 }])).toEqual([
      "path_reserved",
    ]);
    expect(codes([{ path: "v", revert: true }])).toEqual(["path_reserved"]);
  });

  it("refuses a new block id that is not new:<uuid>", () => {
    expect(codes([{ path: "blocks.new:abc.kind", value: "faq" }])).toEqual([
      "block_id_invalid",
    ]);
  });

  it("refuses malformed ops and batches", () => {
    expect(codes("nope")).toEqual(["ops_not_array"]);
    expect(codes([])).toEqual(["ops_empty"]);
    expect(
      codes(
        Array.from({ length: 201 }, () => ({ path: "page.bio", value: "x" })),
      ),
    ).toEqual(["ops_too_many"]);
    expect(codes([{ path: "page.bio" }])).toEqual(["op_malformed"]);
    expect(codes([{ path: "page.bio", value: "x", revert: true }])).toEqual([
      "op_malformed",
    ]);
    expect(codes([{ path: "page.bio", revert: false }])).toEqual([
      "op_malformed",
    ]);
    expect(codes([{ path: "page.bio", value: "x", extra: 1 }])).toEqual([
      "op_malformed",
    ]);
  });

  it("refuses place paths on pages without a Place", () => {
    expect(
      codes([{ path: "place.name", value: "X" }], null, "ORGANIZATION"),
    ).toEqual(["path_not_for_owner"]);
  });

  it("refuses a draft written in a format version this code does not know", () => {
    expect(
      codes([{ path: "page.bio", value: "x" }], emptyDraft({ data: { v: 2 } })),
    ).toEqual(["draft_version_unsupported"]);
  });

  it("reports every refused op with its index, and refuses the whole batch", () => {
    const result = parseOps(
      [
        { path: "page.bio", value: "ok" },
        { path: "v", value: 1 },
        { path: "theme", value: {} },
      ],
      ctxFor(null),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => [error.index, error.code])).toEqual([
        [1, "path_reserved"],
        [2, "path_not_leaf"],
      ]);
    }
  });
});

// ── Values ─────────────────────────────────────────────────────────────────

describe("op values", () => {
  it("caps the bio at 280 characters (R11)", () => {
    expect(
      codes([{ path: "page.bio", value: "x".repeat(PAGE_BIO_MAX_LENGTH) }]),
    ).toEqual([]);
    expect(
      codes([{ path: "page.bio", value: "x".repeat(PAGE_BIO_MAX_LENGTH + 1) }]),
    ).toEqual(["value_invalid"]);
  });

  it("sanitises plain-text page fields before storing", () => {
    const [op] = parseOk([{ path: "page.bio", value: "<b>Loud</b> ‮room" }]);
    expect(op).toMatchObject({ op: "set", value: "Loud room" });
  });

  it("validates theme, visibility and slug with the live schemas", () => {
    expect(codes([{ path: "theme.colorBg", value: "#101010" }])).toEqual([]);
    expect(codes([{ path: "theme.fontKey", value: " SERIF " }])).toEqual([]);
    expect(codes([{ path: "theme.fontKey", value: "comic-sans" }])).toEqual([
      "value_invalid",
    ]);
    expect(codes([{ path: "page.visibility", value: "SECRET" }])).toEqual([
      "value_invalid",
    ]);
    expect(codes([{ path: "page.slug", value: "the-room-a1b2c3d4" }])).toEqual(
      [],
    );
    expect(codes([{ path: "page.slug", value: "The Room/x" }])).toEqual([
      "value_invalid",
    ]);
    expect(codes([{ path: "page.slug", value: null }])).toEqual([
      "value_invalid",
    ]);
  });

  it("validates Place facts with upsertPlace's schemas", () => {
    expect(codes([{ path: "place.name", value: "The Room" }])).toEqual([]);
    expect(codes([{ path: "place.name", value: "X" }])).toEqual([
      "value_invalid",
    ]);
    expect(codes([{ path: "place.capacity", value: -5 }])).toEqual([
      "value_invalid",
    ]);
    expect(codes([{ path: "place.phone", value: "555-1234" }])).toEqual([
      "value_invalid",
    ]);
    expect(codes([{ path: "place.phone", value: "+16125551234" }])).toEqual([]);
    expect(
      codes([{ path: "place.website", value: "javascript:alert(1)" }]),
    ).toEqual(["value_invalid"]);
    expect(
      codes([
        {
          path: "place.address",
          value: { formatted: "1 Main", countryCode: "us", lat: 44.9 },
        },
      ]),
    ).toEqual(["value_invalid"]); // lat without lng
  });

  it("only stores avatar / banner URLs the page owns", () => {
    expect(
      codes([{ path: "page.avatarUrl", value: `${IMAGE_PREFIX}a.webp` }]),
    ).toEqual([]);
    expect(codes([{ path: "page.avatarUrl", value: null }])).toEqual([]);
    expect(
      codes([
        { path: "page.bannerUrl", value: "https://elsewhere.example/b.webp" },
      ]),
    ).toEqual(["image_url_not_allowed"]);
    expect(
      codes([{ path: "page.bannerUrl", value: "javascript:alert(1)" }]),
    ).toEqual(["value_invalid"]);
  });

  it("sanitises rich-text block fields at op validation, so the draft never holds unsafe HTML", () => {
    const [op] = parseOk([
      {
        path: "blocks.blk-about.data.content",
        value:
          '<p><b>Hi</b><img src=x onerror=alert(1)><a href="javascript:x">y</a></p>',
      },
    ]);
    expect(op).toMatchObject({ value: "<p><strong>Hi</strong>y</p>" });
  });

  it("validates other block fields with block-config's schemas", () => {
    expect(
      codes([
        {
          path: "blocks.blk-amenities.data.amenities",
          value: ["Bar", "Patio"],
        },
      ]),
    ).toEqual([]);
    expect(
      codes([{ path: "blocks.blk-amenities.data.amenities", value: "Bar" }]),
    ).toEqual(["value_invalid"]);
    // Read-only and unknown fields, and track_record's server-built content.
    expect(
      codes([{ path: "blocks.blk-track.data.source", value: "x" }]),
    ).toEqual(["block_field_unknown"]);
    expect(
      codes([{ path: "blocks.blk-track.data.showsHosted", value: 999 }]),
    ).toEqual(["block_field_unknown"]);
    expect(
      codes([{ path: "blocks.blk-track.data.heading", value: "Our history" }]),
    ).toEqual([]);
  });

  it("refuses edits to blocks that do not exist or are not in the main section", () => {
    expect(codes([{ path: "blocks.nope.data.heading", value: "x" }])).toEqual([
      "block_not_found",
    ]);
    expect(
      codes([{ path: "blocks.blk-member.data.heading", value: "x" }]),
    ).toEqual(["block_not_found"]);
  });

  it("refuses a theme colour that is not a colour (updatePageTheme's schema, so no CSS injection)", () => {
    for (const value of [
      "red;}body{background:url(https://evil.example)}",
      "#fff; --x: url(x)",
      "expression(alert(1))",
    ]) {
      expect(codes([{ path: "theme.colorBg", value }])).toEqual([
        "value_invalid",
      ]);
    }
    expect(codes([{ path: "theme.colorBg", value: "#6366f1" }])).toEqual([]);
  });

  it("sanitises and bounds booking_info.contactPhone like other plain text", () => {
    const path = "blocks.blk-booking.data.contactPhone";
    const [op] = parseOk([{ path, value: "  612\u0000-555‮-0100  " }]);
    expect(op).toMatchObject({ op: "set", value: "612-555-0100" });
    expect(codes([{ path, value: "5".repeat(81) }])).toEqual(["value_invalid"]);
  });
});

// ── Structure: adds, removes, hides, order ─────────────────────────────────

describe("structure ops keep zone and pinned rules", () => {
  it("refuses an order.main that breaks a zone", () => {
    const result = parseOps(
      [
        {
          path: "order.main",
          value: [
            "blk-photos",
            "blk-about",
            "blk-amenities",
            "blk-tech",
            "blk-track",
            "blk-booking",
          ],
        },
      ],
      ctxFor(null),
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          index: 0,
          path: "order.main",
          code: "zone_order",
          meta: { kind: "about", after: "photos", lock: "fixed_first" },
        },
      ],
    });
    expect(
      codes([
        {
          path: "order.main",
          value: ["blk-about", "blk-photos", "blk-booking", "blk-amenities"],
        },
      ]),
    ).toEqual(["zone_order"]);
  });

  it("accepts a reorder inside the free zone, and refuses unknown or duplicate ids", () => {
    expect(
      codes([
        {
          path: "order.main",
          value: [
            "blk-about",
            "blk-photos",
            "blk-track",
            "blk-tech",
            "blk-amenities",
            "blk-booking",
            "blk-links",
          ],
        },
      ]),
    ).toEqual([]);
    expect(
      codes([{ path: "order.main", value: ["blk-about", "ghost"] }]),
    ).toEqual(["block_not_found"]);
    expect(
      codes([{ path: "order.main", value: ["blk-about", "blk-about"] }]),
    ).toEqual(["order_invalid"]);
  });

  it("refuses removing or hiding a pinned block (BLOCK_PINNED vocabulary)", () => {
    const result = parseOps(
      [
        { path: "blocks.blk-track.removed", value: true },
        { path: "blocks.blk-track.visible", value: false },
      ],
      ctxFor(null),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.map((error) => [error.code, error.meta?.attempted]),
      ).toEqual([
        ["block_pinned", "delete"],
        ["block_pinned", "hide"],
      ]);
    }
  });

  it("refuses a second pinned block, a kind outside the palette, and a kind for another owner type", () => {
    const id = `new:${randomUUID()}`;
    const result = parseOps(
      [{ path: `blocks.${id}.kind`, value: "track_record" }],
      ctxFor(null),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatchObject({
        code: "block_pinned",
        meta: { attempted: "add_duplicate" },
      });
    expect(
      codes([
        { path: `blocks.new:${randomUUID()}.kind`, value: "resident_artists" },
      ]),
    ).toEqual(["block_kind_not_addable"]);
    expect(
      codes([{ path: `blocks.new:${randomUUID()}.kind`, value: "team" }]),
    ).toEqual(["block_kind_invalid"]);
    expect(codes([{ path: "blocks.blk-about.kind", value: "faq" }])).toEqual([
      "block_kind_immutable",
    ]);
  });

  it("allows the pinned recovery add when the page has none, and refuses hiding it", () => {
    const draft = emptyDraft({ data: { "blocks.blk-track.removed": true } }); // planted
    const id = `new:${randomUUID()}`;
    expect(
      codes([{ path: `blocks.${id}.kind`, value: "track_record" }], draft),
    ).toEqual([]);
    expect(
      codes(
        [
          { path: `blocks.${id}.kind`, value: "track_record" },
          { path: `blocks.${id}.visible`, value: false },
        ],
        draft,
      ),
    ).toEqual(["block_pinned"]);
  });

  it("adds a block, edits it and places it in one batch; the order is checked against the add", () => {
    const id = `new:${randomUUID()}`;
    const ops = parseOk([
      { path: `blocks.${id}.kind`, value: "faq" },
      {
        path: `blocks.${id}.data.items`,
        value: [{ question: "Parking?", answer: "Street." }],
      },
      {
        path: "order.main",
        value: [
          "blk-about",
          "blk-photos",
          "blk-amenities",
          id,
          "blk-tech",
          "blk-track",
          "blk-booking",
        ],
      },
    ]);
    expect(ops).toHaveLength(3);
    expect(
      codes([
        { path: `blocks.${id}.kind`, value: "faq" },
        { path: "order.main", value: [id, "blk-about", "blk-photos"] },
      ]),
    ).toEqual(["zone_order"]);
  });

  it("removing a new block drops all of its leaves", () => {
    const id = `new:${randomUUID()}`;
    let draft = save(emptyDraft(), [
      { path: `blocks.${id}.kind`, value: "faq" },
      { path: `blocks.${id}.data.heading`, value: "FAQ" },
    ]);
    expect(changeCount(draft)).toBe(2);
    draft = save(
      draft,
      [{ path: `blocks.${id}.removed`, value: true }],
      HUMAN_B,
      LATER,
    );
    expect(draft.data).toEqual({});
    expect(isEmptyDraft(draft)).toBe(true);
    // Its paths are still reported as changed, so other editors drop them.
    expect(
      changedSince(draft, 1)
        .changes.map((change) => change.path)
        .sort(),
    ).toEqual(
      [
        `blocks.${id}.data.heading`,
        `blocks.${id}.kind`,
        `blocks.${id}.removed`,
      ].sort(),
    );
    // Editing it afterwards is refused: it no longer exists.
    expect(
      codes([{ path: `blocks.${id}.data.heading`, value: "x" }], draft),
    ).toEqual(["block_not_found"]);
  });

  it("refuses reverting a new block's kind (remove it instead)", () => {
    expect(
      codes([{ path: `blocks.new:${randomUUID()}.kind`, revert: true }]),
    ).toEqual(["revert_not_allowed"]);
  });

  it("refuses reverting a new block's removal (its leaves are gone; re-add it)", () => {
    const id = `new:${randomUUID()}`;
    const draft = save(emptyDraft(), [
      { path: `blocks.${id}.kind`, value: "faq" },
    ]);
    const removed = save(draft, [
      { path: `blocks.${id}.removed`, value: true },
    ]);
    expect(
      codes([{ path: `blocks.${id}.removed`, revert: true }], removed),
    ).toEqual(["revert_not_allowed"]);
    // A LIVE block's removal still reverts.
    const liveRemoved = save(emptyDraft(), [
      { path: "blocks.blk-tech.removed", value: true },
    ]);
    expect(
      codes([{ path: "blocks.blk-tech.removed", revert: true }], liveRemoved),
    ).toEqual([]);
  });

  it("drops a new: id the draft no longer has from order.main, and still refuses an unknown live id", () => {
    const gone = `new:${randomUUID()}`;
    const order = [
      "blk-about",
      "blk-photos",
      gone,
      "blk-amenities",
      "blk-tech",
      "blk-track",
      "blk-booking",
    ];
    const ops = parseOk([{ path: "order.main", value: order }]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "set",
      value: order.filter((id) => id !== gone),
    });
    expect(codes([{ path: "order.main", value: [...order, "ghost"] }])).toEqual(
      ["block_not_found"],
    );
  });
});

// ── Merge ──────────────────────────────────────────────────────────────────

describe("mergeOps", () => {
  it("last write wins per path across two editors, and keeps other paths", () => {
    const first = save(emptyDraft(), [
      { path: "page.bio", value: "From A" },
      { path: "theme.colorBg", value: "#000000" },
    ]);
    const second = save(
      first,
      [{ path: "page.bio", value: "From B" }],
      HUMAN_B,
      LATER,
    );
    expect(second.data).toEqual({
      "page.bio": "From B",
      "theme.colorBg": "#000000",
    });
    expect(second.fieldEditors["page.bio"]).toEqual({
      humanId: HUMAN_B,
      at: LATER.toISOString(),
      rev: 2,
    });
    expect(second.fieldEditors["theme.colorBg"]).toEqual({
      humanId: HUMAN_A,
      at: NOW.toISOString(),
      rev: 1,
    });
    expect(second.updatedByHumanId).toBe(HUMAN_B);
  });

  it("records placeBase on a field's first set only", () => {
    const first = save(emptyDraft(), [{ path: "place.capacity", value: 300 }]);
    expect(first.placePatch).toEqual({ capacity: 300 });
    expect(first.placeBase).toEqual({ capacity: 200 });
    const second = save(
      first,
      [{ path: "place.capacity", value: 400 }],
      HUMAN_B,
      LATER,
      { ...PLACE_LIVE, capacity: 250 },
    );
    expect(second.placePatch).toEqual({ capacity: 400 });
    expect(second.placeBase).toEqual({ capacity: 200 });
    // A revert drops the patch AND the base: the field no longer differs
    // from live, so a stale base would only mislead the publish check.
    const third = save(second, [{ path: "place.capacity", revert: true }]);
    expect(third.placePatch).toEqual({});
    expect(third.placeBase).toEqual({});
    // The next set takes its base from the live value at that moment.
    const fourth = save(
      third,
      [{ path: "place.capacity", value: 500 }],
      HUMAN_A,
      LATER,
      { ...PLACE_LIVE, capacity: 250 },
    );
    expect(fourth.placePatch).toEqual({ capacity: 500 });
    expect(fourth.placeBase).toEqual({ capacity: 250 });
  });

  it("refuses (INTERNAL) a place op without the live value to base it on", () => {
    const ops = parseOk([{ path: "place.name", value: "New Name" }]);
    expect(() =>
      mergeOps(emptyDraft(), ops, {
        batchId: randomUUID(),
        actorHumanId: HUMAN_A,
        now: NOW,
        placeLive: null,
      }),
    ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("dedupes a batch id already applied, changing nothing", () => {
    const batchId = randomUUID();
    const locked = emptyDraft({ revision: 7, appliedBatchIds: [batchId] });
    const snapshot = structuredClone(locked);
    const ops = parseOk([{ path: "page.bio", value: "again" }], locked);
    expect(
      mergeOps(locked, ops, {
        batchId,
        actorHumanId: HUMAN_A,
        now: NOW,
        placeLive: null,
      }),
    ).toEqual({ deduped: true });
    expect(locked).toEqual(snapshot);
  });

  it("isBatchApplied answers a retry of an applied remove-new-block batch before parseOps would refuse it", () => {
    const id = `new:${randomUUID()}`;
    const added = save(emptyDraft(), [
      { path: `blocks.${id}.kind`, value: "faq" },
    ]);
    const removeBatch = [{ path: `blocks.${id}.removed`, value: true }];
    const batchId = randomUUID();
    const first = mergeOps(added, parseOk(removeBatch, added), {
      batchId,
      actorHumanId: HUMAN_A,
      now: NOW,
      placeLive: null,
    });
    if (first.deduped) throw new Error("unexpected dedupe");
    const afterRemove: PageDraftRecord = { ...added, ...first.next };
    // The retry: validating it again would fail (the block is gone)...
    expect(codes(removeBatch, afterRemove)).toEqual(["block_not_found"]);
    // ...so savePageDraft asks isBatchApplied first, and it says yes.
    expect(isBatchApplied(afterRemove, batchId)).toBe(true);
    expect(isBatchApplied(afterRemove, randomUUID())).toBe(false);
  });

  it("isBatchApplied recognises a retry after a Publish / Discard clear", () => {
    const batchId = randomUUID();
    const applied = mergeOps(
      emptyDraft(),
      parseOk([{ path: "page.bio", value: "x" }]),
      { batchId, actorHumanId: HUMAN_A, now: NOW, placeLive: null },
    );
    if (applied.deduped) throw new Error("unexpected dedupe");
    const saved: PageDraftRecord = { ...emptyDraft(), ...applied.next };
    // What clearDraft writes: overlays reset, revision + 1, batch ids KEPT.
    const cleared: PageDraftRecord = {
      ...saved,
      data: {},
      placePatch: {},
      placeBase: {},
      fieldEditors: {},
      revision: saved.revision + 1,
    };
    expect(isBatchApplied(cleared, batchId)).toBe(true);
    // mergeOps' backstop agrees.
    expect(
      mergeOps(cleared, parseOk([{ path: "page.bio", value: "x" }], cleared), {
        batchId,
        actorHumanId: HUMAN_A,
        now: LATER,
        placeLive: null,
      }),
    ).toEqual({ deduped: true });
  });

  it("isBatchApplied answers false with no row, and throws invalid_input for a non-UUID id", () => {
    expect(isBatchApplied(null, randomUUID())).toBe(false);
    expect(() => isBatchApplied(emptyDraft(), "not-a-uuid")).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("appends the batch id and trims to the newest 100", () => {
    const old = Array.from({ length: PAGE_DRAFT_APPLIED_BATCH_IDS_MAX }, () =>
      randomUUID(),
    );
    const locked = emptyDraft({ appliedBatchIds: old, revision: 120 });
    const batchId = randomUUID();
    const result = mergeOps(
      locked,
      parseOk([{ path: "page.bio", value: "x" }], locked),
      {
        batchId,
        actorHumanId: HUMAN_A,
        now: NOW,
        placeLive: null,
      },
    );
    if (result.deduped) throw new Error("unexpected dedupe");
    expect(result.next.appliedBatchIds).toHaveLength(
      PAGE_DRAFT_APPLIED_BATCH_IDS_MAX,
    );
    expect(result.next.appliedBatchIds[0]).toBe(old[1]);
    expect(result.next.appliedBatchIds.at(-1)).toBe(batchId);
  });

  it("sets revision to the locked revision + 1", () => {
    const locked = emptyDraft({ revision: 41 });
    const result = mergeOps(
      locked,
      parseOk([{ path: "page.bio", value: "x" }], locked),
      {
        batchId: randomUUID(),
        actorHumanId: HUMAN_A,
        now: NOW,
        placeLive: null,
      },
    );
    expect(result).toMatchObject({ deduped: false, next: { revision: 42 } });
  });

  it("refuses a batch id that is not a UUID", () => {
    const ops = parseOk([{ path: "page.bio", value: "x" }]);
    expect(() =>
      mergeOps(emptyDraft(), ops, {
        batchId: "batch-1",
        actorHumanId: HUMAN_A,
        now: NOW,
        placeLive: null,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("never writes or drops data.v", () => {
    const draft = save(emptyDraft({ data: { v: 1 } }), [
      { path: "page.bio", value: "x" },
    ]);
    expect(draft.data.v).toBe(1);
  });
});

// ── Reading ────────────────────────────────────────────────────────────────

describe("changeCount / isEmptyDraft", () => {
  it("counts leaf paths across the overlays, ignoring v", () => {
    expect(
      changeCount({
        data: { v: 1, "page.bio": "x", "theme.colorBg": "#fff" },
        placePatch: { name: "N" },
      }),
    ).toBe(3);
  });

  it("treats null, a bare revision-0 row and a cleared row alike", () => {
    expect(isEmptyDraft(null)).toBe(true);
    expect(isEmptyDraft(emptyDraft())).toBe(true);
    expect(isEmptyDraft(emptyDraft({ data: { v: 1 } }))).toBe(true);
    expect(
      isEmptyDraft(
        emptyDraft({
          revision: 12,
          lastPublishedRevision: 12,
          appliedBatchIds: [randomUUID()],
        }),
      ),
    ).toBe(true);
    expect(changeCount(null)).toBe(changeCount(emptyDraft()));
    expect(isEmptyDraft(emptyDraft({ placePatch: { name: "N" } }))).toBe(false);
  });
});

describe("changedSince", () => {
  it("reports paths written after the client's revision, with their editor", () => {
    const r1 = save(emptyDraft(), [{ path: "page.bio", value: "a" }]);
    const r2 = save(
      r1,
      [{ path: "theme.colorBg", value: "#fff" }],
      HUMAN_B,
      LATER,
    );
    expect(changedSince(r2, 1)).toEqual({
      revision: 2,
      cleared: false,
      resync: false,
      changes: [
        {
          path: "theme.colorBg",
          humanId: HUMAN_B,
          at: LATER.toISOString(),
          rev: 2,
        },
      ],
    });
    expect(changedSince(r2, 2).changes).toEqual([]);
  });

  it("says cleared when Publish or Discard cleared the draft after the client's revision", () => {
    const r1 = save(emptyDraft(), [{ path: "page.bio", value: "a" }]);
    // Discard: overlays reset, revision + 1 (what clearDraft writes).
    const cleared: PageDraftRecord = {
      ...r1,
      data: {},
      placePatch: {},
      placeBase: {},
      fieldEditors: {},
      revision: 2,
    };
    expect(changedSince(cleared, 1)).toEqual({
      revision: 2,
      cleared: true,
      resync: true,
      changes: [],
    });
    expect(changedSince(cleared, 2).cleared).toBe(false);
    // New edits after the clear: a client from before it is still told
    // "cleared", a client that saw the clear gets the new path only.
    const r3 = save(
      cleared,
      [{ path: "theme.colorText", value: "#111" }],
      HUMAN_B,
      LATER,
    );
    expect(changedSince(r3, 1).cleared).toBe(true);
    expect(changedSince(r3, 2)).toMatchObject({
      cleared: false,
      changes: [{ path: "theme.colorText", rev: 3 }],
    });
  });

  it("answers the same for no row and an empty revision-0 row", () => {
    expect(changedSince(null, 0)).toEqual(changedSince(emptyDraft(), 0));
  });
});

describe("size bounds", () => {
  it("refuses a batch that would take data past the leaf cap", () => {
    const data: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < PAGE_DRAFT_MAX_LEAVES; i++) {
      data[`blocks.new:${randomUUID()}.kind`] = "faq";
    }
    const draft = emptyDraft({ data });
    expect(codes([{ path: "page.bio", value: "one more" }], draft)).toEqual([
      "draft_too_large",
    ]);
    // A batch that does not add a leaf still goes through.
    const withBio = emptyDraft({ data: { ...data, "page.bio": "x" } });
    delete withBio.data[Object.keys(data)[1]!];
    expect(codes([{ path: "page.bio", value: "edit" }], withBio)).toEqual([]);
  });

  it("accepts batches that do not grow a draft already over the caps", () => {
    // Over the leaf cap (e.g. the cap was lowered after these were written).
    const data: Record<string, unknown> = { v: 1, "page.bio": "old" };
    for (let i = 0; i < PAGE_DRAFT_MAX_LEAVES + 5; i++) {
      data[`blocks.new:${randomUUID()}.kind`] = "faq";
    }
    const overLeaves = emptyDraft({ data });
    // Editing a leaf it already has: same count, accepted.
    expect(codes([{ path: "page.bio", value: "edit" }], overLeaves)).toEqual(
      [],
    );
    // Reverting a leaf: shrinks, accepted.
    expect(codes([{ path: "page.bio", revert: true }], overLeaves)).toEqual([]);
    // Adding one: grows past the cap, refused.
    expect(
      codes([{ path: "theme.colorBg", value: "#fff" }], overLeaves),
    ).toEqual(["draft_too_large"]);

    // Over the JSON-size cap: shrinking the big value is accepted.
    const overJson = emptyDraft({
      data: { "page.bio": "x".repeat(PAGE_DRAFT_MAX_DATA_JSON_LENGTH + 10) },
    });
    expect(codes([{ path: "page.bio", value: "short" }], overJson)).toEqual([]);
  });

  it("gives a batch ONE rich-text budget, not one per op", () => {
    // Big input, small output (the comment is dropped), so only the INPUT
    // budget can refuse it, not the stored-HTML cap.
    const big = (fill: string) =>
      `<p>hi</p><!--${fill.repeat(Math.floor(PAGE_RICH_TEXT_MAX_INPUT_LENGTH / 2))}-->`;
    const path = "blocks.blk-about.data.content";
    // Each op alone is under the per-value input cap...
    expect(parseOk([{ path, value: big("a") }])[0]).toMatchObject({
      value: "<p>hi</p>",
    });
    const sanitizeCalls = vi.mocked(sanitizeHtml);
    sanitizeCalls.mockClear();
    parseOps([{ path, value: big("a") }], ctxFor(null));
    const callsForOneOp = sanitizeCalls.mock.calls.length;
    expect(callsForOneOp).toBeGreaterThan(0);
    // ...but two in one batch are over the batch's budget.
    sanitizeCalls.mockClear();
    const result = parseOps(
      [
        { path, value: big("a") },
        { path, value: big("b") },
      ],
      ctxFor(null),
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          index: 1,
          path,
          code: "rich_text_too_long",
          meta: { max: PAGE_RICH_TEXT_MAX_INPUT_LENGTH },
        },
      ],
    });
    // The second op was refused on its length, never parsed.
    expect(sanitizeCalls.mock.calls.length).toBe(callsForOneOp);
  });

  it("refuses a batch that would take data past the size cap", () => {
    const draft = emptyDraft({
      data: { "page.bio": "x".repeat(PAGE_DRAFT_MAX_DATA_JSON_LENGTH) },
    });
    expect(codes([{ path: "theme.colorBg", value: "#fff" }], draft)).toEqual([
      "draft_too_large",
    ]);
  });

  it("prunes the oldest editor entries of paths no longer in the overlay, and tells older clients to resync", () => {
    const fieldEditors: Record<string, unknown> = { $base: { rev: 0 } };
    for (let i = 1; i <= PAGE_DRAFT_MAX_EDITOR_ENTRIES; i++) {
      // Reverted paths: in fieldEditors, not in data.
      fieldEditors[`blocks.new:${randomUUID()}.kind`] = {
        humanId: HUMAN_A,
        at: NOW.toISOString(),
        rev: i,
      };
    }
    const locked = emptyDraft({
      fieldEditors,
      revision: PAGE_DRAFT_MAX_EDITOR_ENTRIES,
    });
    const next = save(locked, [{ path: "page.bio", value: "kept" }]);
    const entries = Object.keys(next.fieldEditors).filter(
      (path) => !path.startsWith("$"),
    );
    expect(entries).toHaveLength(PAGE_DRAFT_MAX_EDITOR_ENTRIES);
    expect(next.fieldEditors["page.bio"]).toMatchObject({ rev: 1_001 });
    expect(next.fieldEditors.$pruned).toEqual({ rev: 1 });
    expect(next.fieldEditors.$base).toEqual({ rev: 0 });
    // A client at revision 0 missed the pruned entry: resync, not cleared.
    expect(changedSince(next, 0)).toMatchObject({
      cleared: false,
      resync: true,
    });
    expect(changedSince(next, 1)).toMatchObject({
      cleared: false,
      resync: false,
    });
  });
});

// ── Overlay ────────────────────────────────────────────────────────────────

describe("applyOverlay / resolveMainOrder", () => {
  const livePage = {
    id: PAGE_ID,
    slug: "the-room",
    bio: "Live bio",
    displayName: null,
  };
  const live = {
    page: livePage,
    theme: { colorBg: "#ffffff", colorText: null as string | null },
    blocks: LIVE_BLOCKS,
    place: PLACE_LIVE,
  };

  it("without a draft, shows the live page in zone order with rich text as HTML (FR-022)", () => {
    const view = applyOverlay(live, null, layout);
    expect(view.page).toEqual(livePage);
    expect(view.blocks.map((b) => b.id)).toEqual([
      "blk-about",
      "blk-photos",
      "blk-amenities",
      "blk-track",
      "blk-tech",
      "blk-booking",
      "blk-links",
      "blk-member",
    ]);
    expect(view.blocks[0]!.data).toMatchObject({
      content: "<p>We host shows.</p><p>All ages.</p>",
    });
    expect(
      canPlace(
        view.blocks.slice(0, 7).map((b) => b.kind),
        layout,
      ).ok,
    ).toBe(true);
  });

  it("applies page, theme, place, block and structure leaves", () => {
    const added = `new:${randomUUID()}`;
    let draft = save(emptyDraft(), [
      { path: "page.bio", value: "Draft bio" },
      { path: "theme.colorBg", value: "#000000" },
      { path: "place.name", value: "The New Room" },
      { path: "blocks.blk-amenities.data.amenities", value: ["Patio"] },
      { path: "blocks.blk-tech.removed", value: true },
      { path: "blocks.blk-amenities.visible", value: false },
      { path: `blocks.${added}.kind`, value: "faq" },
    ]);
    let view = applyOverlay(live, draft, layout);
    expect(view.page.bio).toBe("Draft bio");
    expect(view.theme).toEqual({ colorBg: "#000000", colorText: null });
    expect(view.place).toMatchObject({ name: "The New Room", capacity: 200 });
    expect(view.removedBlockIds).toEqual(["blk-tech"]);
    const amenities = view.blocks.find((b) => b.id === "blk-amenities")!;
    expect(amenities).toMatchObject({
      data: { amenities: ["Patio"] },
      visible: false,
    });
    // The new FAQ lands at the end of the free zone, above Booking info,
    // and is empty until it has content (FR-011).
    expect(view.blocks.slice(0, 6).map((b) => b.id)).toEqual([
      "blk-about",
      "blk-photos",
      "blk-amenities",
      "blk-track",
      added,
      "blk-booking",
    ]);
    expect(view.blocks[4]).toMatchObject({
      isNew: true,
      emptyNewBlock: true,
      kind: "faq",
    });

    draft = save(draft, [
      {
        path: `blocks.${added}.data.items`,
        value: [{ question: "Parking?", answer: "Street." }],
      },
    ]);
    view = applyOverlay(live, draft, layout);
    expect(view.blocks.find((b) => b.id === added)).toMatchObject({
      emptyNewBlock: false,
    });
  });

  it("follows order.main, then places blocks it does not list in their zone", () => {
    let draft = save(emptyDraft(), [
      {
        path: "order.main",
        value: [
          "blk-about",
          "blk-photos",
          "blk-tech",
          "blk-track",
          "blk-amenities",
          "blk-booking",
        ],
      },
    ]);
    const added = `new:${randomUUID()}`;
    draft = save(draft, [
      { path: `blocks.${added}.kind`, value: "house_rules" },
    ]);
    expect(resolveMainOrder(LIVE_BLOCKS, draft, layout)).toEqual([
      "blk-about",
      "blk-photos",
      "blk-tech",
      "blk-track",
      "blk-amenities",
      added,
      "blk-booking",
      "blk-links",
    ]);
  });

  it("refuses to read a draft in an unknown format version", () => {
    expect(() =>
      applyOverlay(
        live,
        { data: { v: 9 }, placePatch: {}, fieldEditors: {} },
        layout,
      ),
    ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });
});

describe("blockHasContent (FR-011)", () => {
  const rows: Array<[string, Record<string, unknown>, boolean]> = [
    ["about", { content: "<p></p>" }, false],
    ["about", { heading: "About", content: "" }, false],
    ["about", { content: "<p>Hi</p>" }, true],
    ["faq", { items: [] }, false],
    ["faq", { items: [{ question: " ", answer: "" }] }, false],
    ["faq", { items: [{ question: "Parking?" }] }, true],
    ["booking_info", { heading: "Book us" }, false],
    ["booking_info", { contactEmail: "a@b.example" }, true],
    // Automatic sections: only the heading is editable.
    ["track_record", {}, true],
    ["audience_stats", {}, true],
    // Calls to action: the button is the content.
    ["rate_venue", {}, true],
    ["request_to_play", {}, true],
    ["upcoming_events", {}, true],
  ];
  it.each(rows)("%s %j → %s", (kind, data, expected) => {
    expect(blockHasContent(kind, data)).toBe(expected);
  });
});

describe("place facts helpers", () => {
  it("builds the draft shape from a Place row, leaving out null address parts", () => {
    expect(
      placeDraftFactsFromRecord({
        name: "The Room",
        capacity: null,
        phone: "+16125551234",
        website: null,
        formattedAddress: "1 Main St",
        addressLine1: "1 Main St",
        addressLine2: null,
        city: "Minneapolis",
        region: "MN",
        postalCode: null,
        countryCode: "US",
        lat: 44.97,
        lng: -93.26,
        locationMode: "OBSCURED",
        locationRadiusMeters: 500,
        locationLabel: "Northeast",
      }),
    ).toEqual({
      name: "The Room",
      capacity: null,
      phone: "+16125551234",
      website: null,
      address: {
        formatted: "1 Main St",
        line1: "1 Main St",
        city: "Minneapolis",
        region: "MN",
        countryCode: "US",
        lat: 44.97,
        lng: -93.26,
      },
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      locationLabel: "Northeast",
    });
  });

  it("compares draft values regardless of key order (jsonb reorders keys)", () => {
    expect(
      draftValuesEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }),
    ).toBe(true);
    expect(draftValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(draftValuesEqual(null, undefined)).toBe(true);
    expect(draftValuesEqual([1, 2], [2, 1])).toBe(false);
  });
});
