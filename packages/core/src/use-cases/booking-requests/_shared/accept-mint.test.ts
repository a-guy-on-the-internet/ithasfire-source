import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ACTOR_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
  type MakeCreateEventDepsOptions,
} from "@th/test-utils";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos, TxRepos } from "@th/ports/repos";

import {
  prepareBookingAcceptMint,
  type PrepareBookingAcceptMintInput,
} from "./accept-mint";

// ─────────────────────────────────────────────────────────────────────────────
// FR-001 step 6 — the accept mint, as ONE entry point core owns rather than
// five obligations the accept procedure has to remember.
//
// Nothing in production calls this yet. These tests ARE the caller: they open
// the transaction, mint inside it, commit, and drain — and they pin the things
// the three-phase shape exists to make unskippable.
//
// The recording-Proxy technique below is lifted from
// `events/__tests__/save-event-caller-tx.test.ts`. It is deliberately NOT
// `{ tx } as unknown as Repos`: that shape leaves `deps.repos.<x>` undefined,
// the TypeError gets eaten by a catch, and the suite goes green over dead code
// (four times in one week, per the repo's own notes). Here the underlying fake
// mocks still fire, so an assertion on `mocks.events.upsertDraft` and one on
// `calls` corroborate each other.
// ─────────────────────────────────────────────────────────────────────────────

const HOLD_ID = "b0b0b0b0-0000-4000-8000-00000000000b";
const REQUEST_ID = "c0c0c0c0-0000-4000-8000-00000000000c";
const CO_OWNER_A = "aaaa1111-0000-4000-8000-00000000000a";
const CO_OWNER_B = "bbbb2222-0000-4000-8000-00000000000b";
const GRANTEE = "9999cccc-0000-4000-8000-00000000000c";
const HOLD_DATE = "2026-10-10";
/** Deliberately NOT UTC: a date-only hold anchored in the wrong zone lands on the wrong day. */
const PLACE_ZONE = "America/Los_Angeles";

type Ctx = ReturnType<typeof makeCreateEventTestContext>;

/**
 * A context whose Place is the fake's own default row with `overrides`
 * applied. Harvested from a probe context rather than written out as a
 * literal: `PlaceRecord` has ~30 fields and `packages/test-utils` is outside
 * the base tsconfig, so a hand-rolled fixture drifts silently.
 */
async function makeCtx(
  placeOverrides: Partial<PlaceRecord> = {},
  options: MakeCreateEventDepsOptions = {},
): Promise<Ctx> {
  const probe = makeCreateEventTestContext();
  const base = (await probe.deps.repos.places.getById(DEFAULT_PLACE_ID))!;
  return makeCreateEventTestContext({
    ...options,
    place: {
      ...base,
      id: DEFAULT_PLACE_ID,
      timezone: PLACE_ZONE,
      orgIdsWithAccess: [DEFAULT_ORG_ID],
      humanIdsWithAccess: [],
      ...placeOverrides,
    },
  });
}

/** Seed a calendar on the place, with `spaceCount` active spaces joined. */
async function seedCalendar(
  ctx: Ctx,
  args: {
    defaultStartTime?: string | null;
    isDefault?: boolean;
    spaceNames?: string[];
    retiredSpaceNames?: string[];
  } = {},
) {
  const calendar = ctx.mocks.calendars.seedCalendar({
    placeId: DEFAULT_PLACE_ID,
    defaultStartTime: args.defaultStartTime ?? null,
    isDefault: args.isDefault ?? false,
  });
  const spaceIds = [
    ...(args.spaceNames ?? []).map(
      (name, i) =>
        ctx.mocks.spaces.seed({ placeId: DEFAULT_PLACE_ID, name, sortOrder: i })
          .id,
    ),
    ...(args.retiredSpaceNames ?? []).map(
      (name, i) =>
        ctx.mocks.spaces.seed({
          placeId: DEFAULT_PLACE_ID,
          name,
          sortOrder: 100 + i,
          status: "RETIRED",
        }).id,
    ),
  ];
  if (spaceIds.length > 0) {
    ctx.mocks.calendars.joins.set(calendar.id, spaceIds);
  }
  return { calendar, spaceIds };
}

function baseInput(
  overrides: Partial<PrepareBookingAcceptMintInput> & {
    place: PlaceRecord;
    hold: PrepareBookingAcceptMintInput["hold"];
  },
): PrepareBookingAcceptMintInput {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    bookingRequestId: REQUEST_ID,
    ownership: { via: "org", orgId: DEFAULT_ORG_ID },
    title: "Grieves at The Blue Room",
    ...overrides,
  };
}

/** The caller's transaction handle, recording every `<repo>.<method>` through it. */
async function makeCallerTx(
  repos: Repos,
): Promise<{ tx: TxRepos; calls: string[] }> {
  const base = await repos.tx(async (tx) => tx);
  const calls: string[] = [];
  const handle = new Proxy(base as unknown as Record<string, unknown>, {
    get(target, repoName) {
      const repo = Reflect.get(target, repoName);
      if (typeof repoName !== "string") return repo;
      if (repo === null || typeof repo !== "object") return repo;
      return new Proxy(repo as Record<string, unknown>, {
        get(inner, method) {
          const value = Reflect.get(inner, method);
          if (typeof value !== "function" || typeof method !== "string") {
            return value;
          }
          return (...args: unknown[]) => {
            calls.push(`${repoName}.${method}`);
            return (value as (...a: unknown[]) => unknown).apply(inner, args);
          };
        },
      });
    },
  }) as unknown as TxRepos;
  return { tx: handle, calls };
}

/**
 * Replace `deps.repos` with a recorder over the real bag. `touches` is the
 * load-bearing one: while the caller's transaction is open, the mint must not
 * reach for a single property off the root bag. `armed` is dropped before the
 * post-commit drain, which is SUPPOSED to use it — that is why it is deferred.
 */
function guardRootRepos(deps: Ctx["deps"]) {
  const real = deps.repos;
  const txSpy = vi.fn(real.tx.bind(real)) as unknown as Repos["tx"];
  real.tx = txSpy;
  const touches: string[] = [];
  let armed = false;
  deps.repos = new Proxy(real, {
    get(target, prop) {
      if (armed && typeof prop === "string") touches.push(prop);
      return Reflect.get(target, prop);
    },
  }) as Repos;
  return {
    touches,
    txSpy: txSpy as unknown as ReturnType<typeof vi.fn>,
    /** Arm AFTER phase 1 — preparing is supposed to read the root bag. */
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — the owner rule (FR-006) and the attach gate
// ─────────────────────────────────────────────────────────────────────────────

describe("prepareBookingAcceptMint — who the booking is minted under", () => {
  it("an org member's accept mints under the ORG", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place: (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );

    expect(plan.venueParty).toEqual({
      type: "organization",
      id: DEFAULT_ORG_ID,
    });
    expect(plan.owner).toEqual({ kind: "org", orgId: DEFAULT_ORG_ID });
  });

  it("on a CO-OWNED human place, co-owner B's accept mints under B — never under A", async () => {
    // The whole point of FR-006 rule 2. The claim path's smallest-id pick
    // would mint under A here and then fail B's own edit with
    // NOT_RESOURCE_OWNER.
    const ctx = await makeCtx({
      orgIdsWithAccess: [],
      humanIdsWithAccess: [CO_OWNER_A, CO_OWNER_B],
    });
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        actorHumanId: CO_OWNER_B,
        ownership: { via: "human", orgId: null },
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );

    expect(plan.venueParty).toEqual({ type: "human", id: CO_OWNER_B });
    expect(plan.owner).toEqual({ kind: "human", humanId: CO_OWNER_B });

    // ...and the event really is written under B.
    const { tx } = await makeCallerTx(ctx.deps.repos);
    await plan.mintInTx(tx);
    expect(ctx.mocks.events.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: CO_OWNER_B, orgId: null }),
    );
  });

  // (holds-without-a-request FR-002 retired "a GRANTEE at a human-owned
  // place mints under the PLACE's owner": the staff gate has no grant arm, so
  // no `via: "grant"` ownership reaches the accept mint.)

  it("refuses NOT_RESOURCE_OWNER when no venue party can be derived — before reading anything", async () => {
    const ctx = await makeCtx({ orgIdsWithAccess: [], humanIdsWithAccess: [] });
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;
    const listSpy = vi.spyOn(ctx.deps.repos.calendars, "listByPlace");

    await expect(
      prepareBookingAcceptMint(
        ctx.deps,
        baseInput({
          place,
          actorHumanId: GRANTEE,
          // An actor on neither list (the staff gate never yields this; the
          // derivation refuses it anyway).
          ownership: { via: "human", orgId: null },
          hold: {
            id: HOLD_ID,
            calendarId: calendar.id,
            spaceId: null,
            date: HOLD_DATE,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(listSpy).not.toHaveBeenCalled();
    expect(ctx.mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("the attach gate refuses a place the owner cannot attach to — and does so before the tax provider", async () => {
    // A suspended / retired venue takes no new events, whoever owns it. The
    // refusal lands before any competitor hold has been released.
    const ctx = await makeCtx({ status: "SUSPENDED" });
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;
    const listSpy = vi.spyOn(ctx.deps.repos.calendars, "listByPlace");

    await expect(
      prepareBookingAcceptMint(
        ctx.deps,
        baseInput({
          place,
          hold: {
            id: HOLD_ID,
            calendarId: calendar.id,
            spaceId: null,
            date: HOLD_DATE,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });

    expect(listSpy).not.toHaveBeenCalled();
    expect(ctx.mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.mocks.events.upsertDraft).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — the free text
// ─────────────────────────────────────────────────────────────────────────────

describe("prepareBookingAcceptMint — the title is sanitized here, not by the caller", () => {
  /** The path that makes this reachable: an anonymous embed inquiry's `actName`
   * is bounded `min(1).max(120)` with no `plainText*`, and FR-001 composes the
   * accept's title out of it. On the wrapper path `baseSaveEventInputSchema`
   * would have cleaned it; `FinalizeParams.title` is a bare `string`. */
  const HOSTILE_TITLE =
    '<img src=x onerror=alert(1)>&lt;script&gt;alert(2)&lt;/script&gt; \u202eeviL\u200b at The Blue Room';

  it("stores a tag-bearing title stripped, not verbatim", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        title: HOSTILE_TITLE,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );
    const { tx } = await makeCallerTx(ctx.deps.repos);
    await plan.mintInTx(tx);

    const stored = vi.mocked(ctx.mocks.events.upsertDraft).mock.calls[0]![0]
      .title;
    // Tags gone to a FIXPOINT: the entity-encoded payload does not get decoded
    // back into live markup in the stored value.
    expect(stored).not.toContain("<");
    expect(stored).not.toContain(">");
    expect(stored).not.toContain("onerror");
    // Bidi override and zero-width joiner gone.
    expect(stored).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/);
    expect(stored).toContain("at The Blue Room");
  });

  it("refuses a title that collapses to empty once sanitized — invalid_input, before any write", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    await expect(
      prepareBookingAcceptMint(
        ctx.deps,
        baseInput({
          place,
          // All markup and invisible characters: `plainTextRequired`
          // sanitizes BEFORE it measures, so this is `""` and fails min(1)
          // rather than being stored as a blank-looking title.
          title: "<b></b><script>x</script>\u200b\u202e",
          hold: {
            id: HOLD_ID,
            calendarId: calendar.id,
            spaceId: null,
            date: HOLD_DATE,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(ctx.mocks.events.upsertDraft).not.toHaveBeenCalled();
    expect(ctx.mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("refuses a title over the 140-character bound the wrapper path enforces", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    await expect(
      prepareBookingAcceptMint(
        ctx.deps,
        baseInput({
          place,
          title: "x".repeat(141),
          hold: {
            id: HOLD_ID,
            calendarId: calendar.id,
            spaceId: null,
            date: HOLD_DATE,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — when the show is
// ─────────────────────────────────────────────────────────────────────────────

describe("prepareBookingAcceptMint — the night the venue held", () => {
  it("falls back to 19:00 in the PLACE's zone when the calendar names no default", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, {
      defaultStartTime: null,
      spaceNames: ["Main"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );

    // 19:00 PDT on the held night = 02:00 UTC the NEXT day. Anchoring in UTC
    // would have produced 19:00Z — the right clock on the wrong evening.
    expect(plan.startsAt.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(plan.timezone).toBe(PLACE_ZONE);
    // Nothing measured the set length, so the platform fallback show length.
    expect(plan.endsAt.toISOString()).toBe("2026-10-11T05:00:00.000Z");
  });

  it("uses the HOLD calendar's defaultStartTime when it has one", async () => {
    const ctx = await makeCtx();
    // A default calendar with a DIFFERENT default time, to prove the hold's
    // calendar is the one consulted.
    await seedCalendar(ctx, {
      defaultStartTime: "12:00",
      isDefault: true,
      spaceNames: ["Lobby"],
    });
    const { calendar } = await seedCalendar(ctx, {
      defaultStartTime: "21:30",
      spaceNames: ["Main"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
        setLengthMinutes: 45,
      }),
    );

    expect(plan.startsAt.toISOString()).toBe("2026-10-11T04:30:00.000Z");
    // The span the agreement header is seeded with, computed the same way.
    expect(plan.endsAt.toISOString()).toBe("2026-10-11T05:15:00.000Z");
  });

  it("a slot the act NAMED on the held night outranks the calendar default", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, {
      defaultStartTime: "21:30",
      spaceNames: ["Main"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
        // A date-only entry on another night names nothing; the timed entry on
        // the HELD night is the slot the act picked out of the availability.
        preferredDates: ["2026-10-09", `${HOLD_DATE}T20:00`],
      }),
    );

    expect(plan.startsAt.toISOString()).toBe("2026-10-11T03:00:00.000Z");
  });

  it("refuses an unanchorable hold date before anything is written", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, { spaceNames: ["Main"] });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    await expect(
      prepareBookingAcceptMint(
        ctx.deps,
        baseInput({
          place,
          hold: {
            id: HOLD_ID,
            calendarId: calendar.id,
            spaceId: null,
            date: "2026-02-31",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(ctx.mocks.events.upsertDraft).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — where in the venue
// ─────────────────────────────────────────────────────────────────────────────

describe("prepareBookingAcceptMint — placement", () => {
  it("takes the space from the input when the accept dialog asked for one", async () => {
    const ctx = await makeCtx();
    const { calendar, spaceIds } = await seedCalendar(ctx, {
      spaceNames: ["Main", "Patio"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
        spaceId: spaceIds[1],
      }),
    );

    expect(plan.calendarId).toBe(calendar.id);
    expect(plan.spaceId).toBe(spaceIds[1]);

    const { tx } = await makeCallerTx(ctx.deps.repos);
    await plan.mintInTx(tx);
    expect(ctx.mocks.events.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: calendar.id, spaceId: spaceIds[1] }),
    );
  });

  it("otherwise the hold's own space, then the hold calendar's first ACTIVE space", async () => {
    const ctx = await makeCtx();
    const { calendar, spaceIds } = await seedCalendar(ctx, {
      spaceNames: ["Main", "Patio"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const held = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: spaceIds[1]!,
          date: HOLD_DATE,
        },
      }),
    );
    expect(held.spaceId).toBe(spaceIds[1]);

    const unheld = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );
    expect(unheld.spaceId).toBe(spaceIds[0]);
  });

  it("falls back to the place's DEFAULT calendar's space — and never moves the booking off the hold's calendar", async () => {
    const ctx = await makeCtx();
    const { spaceIds: defaultSpaces } = await seedCalendar(ctx, {
      isDefault: true,
      spaceNames: ["Main"],
    });
    // The hold's calendar has a space, but it is RETIRED — a retired space takes
    // no new events, and `listByPlace` hydrates retired joins too, so the
    // status check is what does the work here.
    const { calendar } = await seedCalendar(ctx, {
      retiredSpaceNames: ["Old Stage"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );

    expect(plan.spaceId).toBe(defaultSpaces[0]);
    expect(plan.calendarId).toBe(calendar.id);

    // Asserted on the PERSISTED value, not just the plan's field: the fallback
    // is about the SPACE, and a version of this that borrowed the default
    // calendar's id for the stamp would still report the hold's on the plan.
    const { tx } = await makeCallerTx(ctx.deps.repos);
    await plan.mintInTx(tx);
    expect(ctx.mocks.events.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: calendar.id,
        spaceId: defaultSpaces[0],
      }),
    );
  });

  it("mints SPACELESS — reported, never refused — when the venue has no active space anywhere", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, {});
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );

    expect(plan.spaceId).toBeNull();
    expect(plan.calendarId).toBe(calendar.id);
    // An event outside the space system is invisible to conflict detection —
    // an operator-visible fault, so it reaches Sentry, not just the log.
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "booking_accept_spaceless_mint" }),
      expect.objectContaining({
        tags: { useCase: "prepareBookingAcceptMint" },
      }),
    );
  });

  it("a broken calendars read degrades to 19:00 and spaceless — reported, never a bogus CALENDAR_NOT_FOUND", async () => {
    const ctx = await makeCtx();
    const { calendar } = await seedCalendar(ctx, {
      defaultStartTime: "21:30",
      spaceNames: ["Main"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;
    const boom = new Error("calendars repo is down");
    vi.spyOn(ctx.deps.repos.calendars, "listByPlace").mockRejectedValue(boom);

    const plan = await prepareBookingAcceptMint(
      ctx.deps,
      baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    );

    // The booking still happens. The repo being down must not read as "that
    // calendar does not exist".
    expect(plan.calendarId).toBe(calendar.id);
    expect(plan.spaceId).toBeNull();
    // ...but the show SILENTLY MOVED off the calendar's 21:30 to 19:00, which
    // nothing surfaces to the venue — so the report is the only signal.
    expect(plan.startsAt.toISOString()).toBe("2026-10-11T02:00:00.000Z");

    // The swallow is REPORTED, not just logged (`logger.warn` is not captured
    // by the Sentry pino integration — the exact shape of the Jun 2026 silent
    // search outage). A demotion to warn must fail here.
    expect(ctx.mocks.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "prepareBookingAcceptMint" },
        extra: expect.objectContaining({ calendarId: calendar.id }),
      }),
    );
    expect(ctx.mocks.logger.error).toHaveBeenCalledWith(
      "booking_requests.accept_mint.calendar_routing_failed",
      expect.objectContaining({ err: boom }),
    );

    // And the mint goes through, spaceless.
    const { tx } = await makeCallerTx(ctx.deps.repos);
    const minted = await plan.mintInTx(tx);
    expect(minted.eventId).toBeTruthy();
  });

  it("refuses a hold whose calendar is not at this place, rather than discovering it mid-transaction", async () => {
    const ctx = await makeCtx();
    await seedCalendar(ctx, { isDefault: true, spaceNames: ["Main"] });
    const foreign = ctx.mocks.calendars.seedCalendar({
      placeId: "dddddddd-0000-4000-8000-00000000000d",
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;

    await expect(
      prepareBookingAcceptMint(
        ctx.deps,
        baseInput({
          place,
          hold: {
            id: HOLD_ID,
            calendarId: foreign.id,
            spaceId: null,
            date: HOLD_DATE,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    expect(ctx.mocks.events.upsertDraft).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three-phase handoff itself
// ─────────────────────────────────────────────────────────────────────────────

describe("prepareBookingAcceptMint — the phase handoff", () => {
  async function arrange() {
    const ctx = await makeCtx();
    const { calendar, spaceIds } = await seedCalendar(ctx, {
      spaceNames: ["Main"],
    });
    const place = (await ctx.deps.repos.places.getById(DEFAULT_PLACE_ID))!;
    return {
      ctx,
      calendar,
      spaceIds,
      input: baseInput({
        place,
        hold: {
          id: HOLD_ID,
          calendarId: calendar.id,
          spaceId: null,
          date: HOLD_DATE,
        },
      }),
    };
  }

  it("resolves the tax rate BEFORE the transaction, and never calls the provider inside it", async () => {
    const { ctx, input } = await arrange();
    const sequence: string[] = [];
    ctx.mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      sequence.push("provider");
      return { rateBps: 875, source: "fake" };
    });

    const plan = await prepareBookingAcceptMint(ctx.deps, input);

    // P-1: the round trip happened while no transaction was open.
    expect(sequence).toEqual(["provider"]);
    const providerCallsBeforeTx =
      ctx.mocks.taxRateLookup.lookupByPostalCode.mock.calls.length;

    const { tx, calls } = await makeCallerTx(ctx.deps.repos);
    await plan.mintInTx(tx);

    expect(ctx.mocks.taxRateLookup.lookupByPostalCode.mock.calls.length).toBe(
      providerCallsBeforeTx,
    );
    // ...and the rate the caller prepared was stamped, in the caller's tx.
    expect(calls).toContain("events.updateTaxRate");
    expect(ctx.mocks.events.updateTaxRate).toHaveBeenCalledWith(
      expect.objectContaining({ admissionTaxRateBps: 875 }),
    );
  });

  it("runs every write through the supplied handle and never touches deps.repos", async () => {
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const { tx, calls } = await makeCallerTx(ctx.deps.repos);
    const root = guardRootRepos(ctx.deps);
    root.arm();

    const minted = await plan.mintInTx(tx);

    expect(minted.eventId).toBeTruthy();
    // Stated two ways: no transaction of its own was opened, and the root bag
    // was never even reached for.
    expect(root.txSpy).not.toHaveBeenCalled();
    expect(root.touches).toEqual([]);
    expect(calls).toContain("events.upsertDraft");
    expect(calls).toContain("audit.log");
    expect(ctx.mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("hands the eventId back inside the transaction, but the save's output only after the drain", async () => {
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const { tx } = await makeCallerTx(ctx.deps.repos);
    const root = guardRootRepos(ctx.deps);

    // The marker that flips when the CALLER'S transaction commits. Ordering is
    // asserted against it rather than call counts: "the slug ran" and "the slug
    // ran after the commit" are different claims and only the second is the
    // requirement.
    let txCommitted = false;
    const sequence: string[] = [];
    vi.mocked(ctx.mocks.events.assignSlug).mockImplementation(async () => {
      sequence.push(txCommitted ? "slug-after-commit" : "slug-before-commit");
      return {} as never;
    });

    root.arm();
    const minted = await plan.mintInTx(tx);
    root.disarm();

    // The ledger entry FR-001 step 7 writes needs this, in-tx.
    expect(minted.eventId).toBeTruthy();
    expect(ctx.mocks.events.assignSlug).not.toHaveBeenCalled();
    expect(sequence).toEqual([]);

    txCommitted = true;
    const result = await minted.runAfterCommit();

    expect(sequence).toEqual(["slug-after-commit"]);
    expect(result.eventId).toBe(minted.eventId);
    // The slug step takes its OWN transaction off the root bag — which is
    // exactly why it could not run while the caller's was still open.
    expect(root.txSpy).toHaveBeenCalledTimes(1);
  });

  it("draining twice does not log a second slug-assigned audit row", async () => {
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const { tx } = await makeCallerTx(ctx.deps.repos);
    const minted = await plan.mintInTx(tx);

    const first = await minted.runAfterCommit();
    const second = await minted.runAfterCommit();

    expect(second).toBe(first);
    expect(ctx.mocks.events.assignSlug).toHaveBeenCalledTimes(1);
  });

  it("draining inside the caller's transaction is NOT refused — it opens a second transaction, which is the hazard", async () => {
    // The one ordering rule in the handoff that nothing enforces, pinned as it
    // actually behaves rather than as we wish it behaved. Against the real
    // adapter this second transaction blocks on the hold-line advisory locks
    // the caller still holds and dies on Prisma's `maxWait`, rolling back an
    // accept that had otherwise succeeded. The fakes do not block, so what is
    // observable here is the second transaction being opened AT ALL while the
    // caller's is open — which is the whole failure.
    //
    // If a future change makes this detectable (see the note on
    // `runAfterCommit`), this test flips to asserting a refusal.
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const root = guardRootRepos(ctx.deps);

    let txStillOpen = false;
    const opened: string[] = [];
    vi.mocked(ctx.mocks.events.assignSlug).mockImplementation(async () => {
      opened.push(txStillOpen ? "slug-tx-inside-caller-tx" : "slug-tx-after-commit");
      return {} as never;
    });

    await ctx.deps.repos.tx(async (tx) => {
      txStillOpen = true;
      const minted = await plan.mintInTx(tx);
      // The mistake: drained here, not after the commit.
      await minted.runAfterCommit();
      txStillOpen = false;
    });

    expect(opened).toEqual(["slug-tx-inside-caller-tx"]);
    // Two transactions were opened where one should have been: the caller's,
    // and the slug step's nested inside it.
    expect(root.txSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses the ROOT repo bag, which TypeScript cannot", async () => {
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);

    await expect(
      plan.mintInTx(ctx.deps.repos as unknown as TxRepos),
    ).rejects.toThrow(/ROOT `Repos`/);
    expect(ctx.mocks.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("refuses a second mint off one plan", async () => {
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const { tx } = await makeCallerTx(ctx.deps.repos);

    await plan.mintInTx(tx);
    await expect(plan.mintInTx(tx)).rejects.toThrow(/called twice/);
    expect(ctx.mocks.events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("opens NO idempotency envelope of its own — the caller owns the only one (FR-005)", async () => {
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const { tx } = await makeCallerTx(ctx.deps.repos);

    const minted = await plan.mintInTx(tx);
    await minted.runAfterCommit();

    expect(ctx.mocks.idempotency.__mocks.get).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.__mocks.begin).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.__mocks.fail).not.toHaveBeenCalled();
  });

  it("mints a VENUE-OWNED event: no booking request is created inside the caller's transaction", async () => {
    // The latent hazard on the caller-tx path (lock-order note 4): a
    // third-party mint runs `createBookingRequestFromEvent` in-tx, taking a
    // BookingRequest lock the accept already holds on a row set it thought it
    // had bounded. The owner rule makes that arm unreachable.
    const { ctx, input } = await arrange();
    const plan = await prepareBookingAcceptMint(ctx.deps, input);
    const { tx, calls } = await makeCallerTx(ctx.deps.repos);

    const minted = await plan.mintInTx(tx);
    const result = await minted.runAfterCommit();

    expect(calls).not.toContain("bookingRequests.create");
    expect(result.bookingRequest).toBeNull();
  });
});
