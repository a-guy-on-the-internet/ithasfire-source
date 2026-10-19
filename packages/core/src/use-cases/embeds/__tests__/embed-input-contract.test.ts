import { describe, expect, it } from "vitest";

import { getEmbedCalendarEventsInputSchema } from "../get-embed-calendar-events";
import { getEmbedForWidgetInputSchema } from "../get-embed-for-widget";
import {
  upsertEmbedBaseSchema,
  upsertEmbedInputSchema,
  ALLOWED_SUBJECT_TYPES,
} from "../upsert-embed";
import { listEmbedsInputSchema } from "../list-embeds";
import { EMBED_SCOPES } from "../_shared/embed-scope";

/**
 * The INPUT CONTRACT the admin UI + widget pages code against. These schemas
 * are the tRPC procedure inputs, so a change here is an API change — pin the
 * shape deliberately.
 */

const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const EMBED_ID = "00000000-0000-4000-8000-000000000002";

describe("subject types", () => {
  it("accepts exactly event | organization | place | human | memberships | calendar", () => {
    expect([...ALLOWED_SUBJECT_TYPES].sort()).toEqual([
      // Named-calendar widget (venue-hierarchy FR-010, Step 6).
      "calendar",
      "event",
      "human",
      "memberships",
      "organization",
      "place",
    ]);
  });

  it("upsert accepts a human subject whose subjectId is a HUMAN id", () => {
    const parsed = upsertEmbedInputSchema.parse({
      actorHumanId: HUMAN_ID,
      subjectType: "human",
      subjectId: HUMAN_ID,
      domain: "Example.COM",
    });
    expect(parsed.subjectType).toBe("human");
    // Domain is lowercased at the boundary (hostname coercion happens in the
    // use case).
    expect(parsed.domain).toBe("example.com");
  });

  it("list accepts a human subject", () => {
    expect(
      listEmbedsInputSchema.safeParse({
        actorHumanId: HUMAN_ID,
        subjectType: "human",
        subjectId: HUMAN_ID,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown subject type", () => {
    expect(
      upsertEmbedInputSchema.safeParse({
        actorHumanId: HUMAN_ID,
        subjectType: "venue",
        subjectId: HUMAN_ID,
        domain: "example.com",
      }).success,
    ).toBe(false);
  });

  it("requires subjectId to be a uuid", () => {
    expect(
      upsertEmbedInputSchema.safeParse({
        actorHumanId: HUMAN_ID,
        subjectType: "human",
        subjectId: "not-a-uuid",
        domain: "example.com",
      }).success,
    ).toBe(false);
  });
});

describe("scope param", () => {
  const base = { embedId: EMBED_ID, hostOrigin: "https://venue.example.com" };

  it("exposes exactly own | venues | all", () => {
    expect([...EMBED_SCOPES]).toEqual(["own", "venues", "all"]);
  });

  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s defaults scope to 'own' when omitted", (_label, schema) => {
    expect(schema.parse(base).scope).toBe("own");
  });

  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s accepts every declared scope", (_label, schema) => {
    for (const scope of EMBED_SCOPES) {
      expect(schema.parse({ ...base, scope }).scope).toBe(scope);
    }
  });

  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s rejects an unknown scope", (_label, schema) => {
    expect(schema.safeParse({ ...base, scope: "everything" }).success).toBe(
      false,
    );
  });

  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s stays .strict() — unknown keys are rejected", (_label, schema) => {
    // Guards the repo's useInfiniteQuery `direction` footgun: these are plain
    // .useQuery calls, so `direction` must never appear. If a future caller
    // switches to useInfiniteQuery, this failing is the intended signal.
    expect(schema.safeParse({ ...base, direction: "forward" }).success).toBe(
      false,
    );
  });

  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s still fails closed on a null hostOrigin at the schema level", (
    _label,
    schema,
  ) => {
    // null is ACCEPTED by the schema (the origin guard rejects it at runtime,
    // with a structured log) — pin that split so nobody "fixes" it here.
    expect(schema.safeParse({ ...base, hostOrigin: null }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Browse view (embed-unified-views FR-005): an OUTPUT-only concept
// ─────────────────────────────────────────────────────────────────────────────

describe("view is never a widget INPUT (FR-005)", () => {
  const base = { embedId: EMBED_ID, hostOrigin: "https://venue.example.com" };

  /**
   * `?view=calendar` is a URL param on the IFRAME, resolved client-side against
   * `embed.defaultView` from the widget PAYLOAD. Both procedure inputs are
   * `.strict()`, so a client that forwarded the param into the tRPC call would
   * 400 the entire widget — the documented footgun class in this repo. These
   * pin the exact input key sets so the "just pass it through" reflex fails
   * here, loudly, instead of in production.
   */
  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s input keys are frozen to embedId | hostOrigin | scope", (
    _label,
    schema,
  ) => {
    expect(Object.keys(schema.shape).sort()).toEqual([
      "embedId",
      "hostOrigin",
      "scope",
    ]);
  });

  it.each([
    ["getCalendarEvents", getEmbedCalendarEventsInputSchema],
    ["getForWidget", getEmbedForWidgetInputSchema],
  ])("%s rejects a smuggled view param", (_label, schema) => {
    for (const view of ["calendar", "list", "map"]) {
      expect(schema.safeParse({ ...base, view }).success).toBe(false);
    }
  });
});

describe("upsert accepts the view config (FR-002)", () => {
  const eventSubject = {
    actorHumanId: HUMAN_ID,
    subjectType: "event" as const,
    subjectId: EMBED_ID,
    domain: "example.com",
  };

  it("accepts defaultView + viewToggle on a non-place subject", () => {
    const parsed = upsertEmbedInputSchema.parse({
      ...eventSubject,
      defaultView: "calendar",
      viewToggle: true,
    });
    expect(parsed.defaultView).toBe("calendar");
    expect(parsed.viewToggle).toBe(true);
  });

  it("leaves both undefined when omitted (⇒ repo preserves stored values)", () => {
    const parsed = upsertEmbedInputSchema.parse(eventSubject);
    expect(parsed.defaultView).toBeUndefined();
    expect(parsed.viewToggle).toBeUndefined();
  });

  it("stays .strict() on the base object transport omits from", () => {
    expect(
      upsertEmbedBaseSchema.safeParse({ ...eventSubject, view: "calendar" })
        .success,
    ).toBe(false);
  });
});
