import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { updateEventAccessControls } from "../update-event-access-controls";

// ─────────────────────────────────────────────────────────────────────────────
// A gate makes an event's public location label only
// (`projectPublicEventLocation` rule 5). The search document of a published
// event still carries its pin until something rewrites it, so adding a gate
// deletes that document inside the transaction and fails the update if the
// delete fails (`search/privacy-scrub.ts`).
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-25T12:00:00.000Z");

function exactPublished(): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    stewardship: "OWNED",
    gateType: "NONE",
    visibility: "PUBLIC",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    placeId: null,
    addressText: "1604 8th Ave S, Nashville, TN 37203",
    lat: 36.1395,
    lng: -86.7825,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37203",
    passwordHash: null,
  } as Partial<EventRecord>);
}

function setup(opts: { scrub?: "ok" | "err" | "throw"; search?: boolean } = {}) {
  let row = exactPublished();
  const order: string[] = [];
  const tx = {
    events: {
      getById: vi.fn(async () => row),
      updateGateType: vi.fn(
        async (i: { gateType: EventRecord["gateType"] }) => {
          row = { ...row, gateType: i.gateType };
          return row;
        },
      ),
      updateWaitlistSettings: vi.fn(async () => row),
      updateVisibility: vi.fn(
        async (i: { visibility: EventRecord["visibility"] }) => {
          row = { ...row, visibility: i.visibility };
          return row;
        },
      ),
    },
    places: { getById: vi.fn(async () => null) },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER",
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
  } as unknown as TxRepos;
  const repos = {
    tx: vi.fn(async (fn: (t: TxRepos) => Promise<unknown>) => {
      const out = await fn(tx);
      order.push("commit");
      return out;
    }),
  } as unknown as Repos;
  const deleteDocuments = vi.fn(async (req: { ids?: string[] }) => {
    order.push("search.delete");
    if (opts.scrub === "throw") throw new Error("search db unreachable");
    if (opts.scrub === "err") {
      return { ok: false as const, error: new Error("delete failed") };
    }
    return { ok: true as const, value: { deleted: req.ids?.length ?? 0 } };
  });
  const deps = {
    repos,
    clock: { now: () => NOW },
    search:
      opts.search === false
        ? undefined
        : ({ deleteDocuments } as unknown as MultiSearchPort),
    reportError: vi.fn(),
  };
  return { deps, deleteDocuments, order };
}

describe("updateEventAccessControls scrubs the search document when a gate is added", () => {
  it("NONE → APPLICATION: deletes event_<id> before commit", async () => {
    const h = setup();

    await updateEventAccessControls(h.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      gateType: "APPLICATION",
    });

    expect(h.deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${EVENT_ID}`],
    });
    expect(h.order).toEqual(["search.delete", "commit"]);
  });

  it.each(["err", "throw"] as const)(
    "a failed delete (%s) FAILS the update: nothing commits, reported, retryable",
    async (mode) => {
      const h = setup({ scrub: mode });

      await expect(
        updateEventAccessControls(h.deps, {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          gateType: "APPLICATION",
        }),
      ).rejects.toMatchObject({ code: "SEARCH_UPDATE_RETRY" });
      expect(h.order).not.toContain("commit");
      // The 503 is not captured by the 500-only Sentry hook, so the scrub
      // reports it itself.
      expect(h.deps.reportError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: {
            useCase: "updateEventAccessControls",
            op: "searchPrivacyScrub",
          },
        }),
      );
    },
  );

  it("PUBLIC → PRIVATE scrubs too: a link-only event must leave public search", async () => {
    const h = setup();

    await updateEventAccessControls(h.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      visibility: "PRIVATE",
    });

    expect(h.deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${EVENT_ID}`],
    });
    expect(h.order).toEqual(["search.delete", "commit"]);
  });

  it("PUBLIC → PRIVATE with a failed delete FAILS the update", async () => {
    const h = setup({ scrub: "err" });

    await expect(
      updateEventAccessControls(h.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        visibility: "PRIVATE",
      }),
    ).rejects.toMatchObject({ code: "SEARCH_UPDATE_RETRY" });
    expect(h.order).not.toContain("commit");
  });

  it("a waitlist-only change does not scrub", async () => {
    const h = setup();

    await updateEventAccessControls(h.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      waitlist: { status: "DISABLED" },
    });

    expect(h.deleteDocuments).not.toHaveBeenCalled();
  });

  it("no search port: the gate still commits", async () => {
    const h = setup({ search: false });

    await updateEventAccessControls(h.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      gateType: "APPLICATION",
    });

    expect(h.order).toEqual(["commit"]);
  });
});
