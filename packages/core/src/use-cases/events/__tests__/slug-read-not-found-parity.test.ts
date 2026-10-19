import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord, EventSlugResolution } from "@th/ports/repos/events";

import { ensureEventReadableBySlug } from "../_shared/event-public-readability";
import { getEventGateState } from "../get-event-gate-state";
import { getEventGatedPreview } from "../get-event-gated-preview";
import { getEventSeo } from "../get-event-seo";
import { getPublicEventApplicationForm } from "../get-public-event-application-form";
import { getPublicEventBody } from "../get-public-event-body";
import { resolveEventBySlug } from "../resolve-event-by-slug";
import { validateEventPassword } from "../validate-event-password";

// ─────────────────────────────────────────────────────────────────────────────
// N3 parity: every slug-keyed read answers a HIDDEN event (a DRAFT, or an
// event cancelled / archived without ever going live) exactly like a slug
// that never existed — whether it was reached by its CURRENT slug or an OLD
// one, and whatever the read. The transport forwards `code`, `category` and
// `meta` to the client, so any difference in those is an oracle for "this
// slug is a real event". An editor of the event still gets through.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const STRANGER_ID = "33333333-3333-4333-8333-333333333333";
const CURRENT_SLUG = "event/us/austin/after-2026-10-09--abc";
const OLD_SLUG = "event/us/austin/before-2026-10-09--abc";
const UNKNOWN_SLUG = "event/us/austin/never-existed--zzz";
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

const HIDDEN: Array<[string, Partial<EventRecord>]> = [
  ["DRAFT", { status: "DRAFT", publishedAt: null }],
  ["never-live CANCELLED", { status: "CANCELLED", publishedAt: null }],
  ["never-live ARCHIVED", { status: "ARCHIVED", publishedAt: null }],
  // Ban that sticks (2026-09-29): a PUBLISHED event whose owner is withheld
  // because of a ban (derived by the events adapter) hides exactly like a
  // draft.
  ["PUBLISHED with a banned owner", { status: "PUBLISHED", ownerBanned: true }],
];

/**
 * `orgRole` is the role EVERY asker holds in the event's org (none by
 * default); `staffRoles` likewise for platform staff roles; `delegateRole`
 * the role EVERY asker holds as a `HumanDelegate` of the event's human owner.
 */
function makeRepos(
  eventOverrides: Partial<EventRecord>,
  access: { orgRole?: string; staffRoles?: string[]; delegateRole?: string } = {},
) {
  const event = {
    id: EVENT_ID,
    slug: CURRENT_SLUG,
    status: "PUBLISHED",
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    orgId: null,
    humanId: OWNER_ID,
    stewardship: "OWNED",
    gateType: "NONE",
    visibility: "PUBLIC",
    passwordHash: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    ...eventOverrides,
  } as unknown as EventRecord;

  const resolveBySlug = vi.fn(
    async (slug: string): Promise<EventSlugResolution | null> => {
      if (slug === CURRENT_SLUG) {
        return { eventId: EVENT_ID, currentSlug: CURRENT_SLUG, redirect: false };
      }
      if (slug === OLD_SLUG) {
        return { eventId: EVENT_ID, currentSlug: CURRENT_SLUG, redirect: true };
      }
      return null;
    },
  );

  return {
    events: {
      resolveBySlug,
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      getContent: vi.fn(async () => null),
    },
    images: { resolveByIds: vi.fn(async () => []) },
    authz: {
      getOrgMembership: vi.fn(async () =>
        access.orgRole ? { role: access.orgRole } : null,
      ),
      getStaffRolesForHumanId: vi.fn(async () => access.staffRoles ?? []),
      getHumanDelegation: vi.fn(async () =>
        access.delegateRole ? { role: access.delegateRole } : null,
      ),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => false) },
    eventApplications: {},
  } as unknown as Repos;
}

/** Everything about an error a client can observe, plus its class. */
function observable(err: unknown) {
  const e = err as {
    constructor: unknown;
    name: unknown;
    message: unknown;
    code: unknown;
    category: unknown;
    meta: unknown;
  };
  return {
    ctor: e.constructor,
    name: e.name,
    message: e.message,
    code: e.code,
    category: e.category,
    meta: e.meta,
  };
}

/**
 * The authz PORT's staff probe for a community moderator, as the adapter
 * answers it: `enrolled: false` is a role holder with no second factor.
 */
type StaffProbe = {
  hasStaffRole: () => Promise<{
    allowed: boolean;
    secondFactorRequired?: true;
  }>;
};
const moderatorProbe = (enrolled: boolean): StaffProbe => ({
  hasStaffRole: async () =>
    enrolled
      ? { allowed: true }
      : { allowed: false, secondFactorRequired: true as const },
});
/** A viewer who holds no staff role. */
const noStaffRole: StaffProbe = {
  hasStaffRole: async () => ({ allowed: false }),
};

const READS: Array<{
  name: string;
  run: (
    repos: Repos,
    slug: string,
    viewerHumanId: string | null,
    authz?: StaffProbe,
  ) => Promise<unknown>;
}> = [
  {
    name: "resolveEventBySlug",
    run: (repos, slug, viewerHumanId, authz = noStaffRole) =>
      resolveEventBySlug({ repos, authz }, { slug, viewerHumanId }),
  },
  {
    name: "getEventSeo",
    run: (repos, slug, viewerHumanId, authz = noStaffRole) =>
      getEventSeo(
        {
          repos,
          clock: { now: () => new Date() } as never,
          authz,
        },
        { slug, ...(viewerHumanId ? { viewerHumanId } : {}) },
      ),
  },
  {
    name: "getPublicEventBody",
    run: (repos, slug, viewerHumanId, authz = noStaffRole) =>
      getPublicEventBody({ repos, authz }, { slug, viewerHumanId }),
  },
];

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the read to throw");
}

describe.each(READS)("$name — hidden events answer like unknown slugs", (read) => {
  describe.each(HIDDEN)("%s", (_label, hidden) => {
    it.each([
      ["anonymous", null],
      ["a signed-in stranger", STRANGER_ID],
    ] as const)(
      "unknown, hidden-OLD and hidden-CURRENT slugs throw the identical error for %s",
      async (_who, viewer) => {
        const repos = makeRepos(hidden);

        const unknown = observable(
          await caught(read.run(repos, UNKNOWN_SLUG, viewer)),
        );
        const hiddenOld = observable(
          await caught(read.run(repos, OLD_SLUG, viewer)),
        );
        const hiddenCurrent = observable(
          await caught(read.run(repos, CURRENT_SLUG, viewer)),
        );

        expect(unknown).toMatchObject({
          code: "EVENT_NOT_FOUND",
          meta: { via: "slug" },
        });
        expect(hiddenOld).toEqual(unknown);
        expect(hiddenCurrent).toEqual(unknown);
      },
    );

    it("an org VIEWER (not an edit role) of an org event gets the unknown-slug error too", async () => {
      const repos = makeRepos(
        { ...hidden, orgId: ORG_ID, humanId: null } as Partial<EventRecord>,
        { orgRole: "VIEWER" },
      );

      const unknown = observable(
        await caught(read.run(repos, UNKNOWN_SLUG, STRANGER_ID)),
      );
      expect(
        observable(await caught(read.run(repos, OLD_SLUG, STRANGER_ID))),
      ).toEqual(unknown);
      expect(
        observable(await caught(read.run(repos, CURRENT_SLUG, STRANGER_ID))),
      ).toEqual(unknown);
    });

    it("an ownerless COMMUNITY listing: hidden from a stranger, readable by a community moderator", async () => {
      const community = {
        ...hidden,
        humanId: null,
        stewardship: "COMMUNITY",
      } as Partial<EventRecord>;
      const plain = makeRepos(community);
      const unknown = observable(
        await caught(read.run(plain, UNKNOWN_SLUG, STRANGER_ID)),
      );
      expect(
        observable(await caught(read.run(plain, OLD_SLUG, STRANGER_ID))),
      ).toEqual(unknown);

      const settled = await read
        .run(plain, OLD_SLUG, STRANGER_ID, moderatorProbe(true))
        .then((value) => ({ value }), (err: unknown) => ({ err }));
      if ("err" in settled) {
        expect(settled.err).toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
      } else {
        expect(settled.value).toMatchObject({ redirect: true });
      }
    });

    // The moderator read is a staff grant. A moderator with no second factor
    // enrolled is a stranger here, down to the error they get.
    it("an ownerless COMMUNITY listing: a moderator with no second factor gets the unknown-slug error", async () => {
      const community = {
        ...hidden,
        humanId: null,
        stewardship: "COMMUNITY",
      } as Partial<EventRecord>;
      const repos = makeRepos(community, {
        staffRoles: ["COMMUNITY_MODERATOR"],
      });
      const unknown = observable(
        await caught(read.run(repos, UNKNOWN_SLUG, STRANGER_ID)),
      );

      expect(
        observable(
          await caught(
            read.run(repos, OLD_SLUG, STRANGER_ID, moderatorProbe(false)),
          ),
        ),
      ).toEqual(unknown);
    });

    // Ownership is not a staff grant: an org editor who also holds a staff
    // role with no second factor still reads their own hidden event.
    it("an org EDITOR who is also un-enrolled staff still gets past the gate", async () => {
      const repos = makeRepos(
        { ...hidden, orgId: ORG_ID, humanId: null } as Partial<EventRecord>,
        { orgRole: "EDITOR", staffRoles: ["ADMIN"] },
      );
      const settled = await read
        .run(repos, OLD_SLUG, STRANGER_ID, moderatorProbe(false))
        .then((value) => ({ value }), (err: unknown) => ({ err }));
      if ("err" in settled) {
        expect(settled.err).toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
      } else {
        expect(settled.value).toMatchObject({ redirect: true });
      }
    });

    // The editor bar is `authz.canEditEvent`'s (`actorHoldsEventEditRole`):
    // an edit-role delegate of the human owner may read the hidden event;
    // a delegate in any other role is a stranger.
    it.each(["OWNER", "ADMIN", "EDITOR"])(
      "a %s delegate of the human owner gets past the gate on the OLD slug",
      async (delegateRole) => {
        const repos = makeRepos(hidden, { delegateRole });
        const settled = await read
          .run(repos, OLD_SLUG, STRANGER_ID)
          .then((value) => ({ value }), (err: unknown) => ({ err }));
        if ("err" in settled) {
          expect(settled.err).toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
        } else {
          expect(settled.value).toMatchObject({ redirect: true });
        }
        // The delegation looked up is the EVENT OWNER's, for THIS viewer —
        // not a blanket "is a delegate of anyone".
        expect(repos.authz.getHumanDelegation).toHaveBeenCalledWith({
          principalId: OWNER_ID,
          delegateId: STRANGER_ID,
        });
      },
    );

    it.each(["VIEWER", "FINANCE", "SCANNER"])(
      "a %s delegate of the human owner gets the unknown-slug error",
      async (delegateRole) => {
        const repos = makeRepos(hidden, { delegateRole });
        const unknown = observable(
          await caught(read.run(repos, UNKNOWN_SLUG, STRANGER_ID)),
        );
        expect(
          observable(await caught(read.run(repos, OLD_SLUG, STRANGER_ID))),
        ).toEqual(unknown);
        expect(
          observable(await caught(read.run(repos, CURRENT_SLUG, STRANGER_ID))),
        ).toEqual(unknown);
      },
    );

    it("an org SCANNER of an org event gets the unknown-slug error", async () => {
      const repos = makeRepos(
        { ...hidden, orgId: ORG_ID, humanId: null } as Partial<EventRecord>,
        { orgRole: "SCANNER" },
      );
      const unknown = observable(
        await caught(read.run(repos, UNKNOWN_SLUG, STRANGER_ID)),
      );
      expect(
        observable(await caught(read.run(repos, CURRENT_SLUG, STRANGER_ID))),
      ).toEqual(unknown);
    });

    it("the owner gets past the gate on the OLD slug", async () => {
      const repos = makeRepos(hidden);

      const settled = await read
        .run(repos, OLD_SLUG, OWNER_ID)
        .then((value) => ({ value }), (err: unknown) => ({ err }));

      if ("err" in settled) {
        // A read that does not follow redirects says so — which is only
        // ever said to someone who may read the event.
        expect(settled.err).toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
      } else {
        expect(settled.value).toMatchObject({
          currentSlug: CURRENT_SLUG,
          redirect: true,
        });
      }
    });
  });

  it("a PUBLISHED event's old slug is not hidden from anyone", async () => {
    const repos = makeRepos({});

    const settled = await read
      .run(repos, OLD_SLUG, null)
      .then((value) => ({ value }), (err: unknown) => ({ err }));

    if ("err" in settled) {
      expect(settled.err).toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
    } else {
      expect(settled.value).toMatchObject({ redirect: true });
    }
  });
});

describe("ensureEventReadableBySlug (the transport's pre-gate check)", () => {
  it.each(HIDDEN)(
    "a %s throws the use cases' unknown-slug error on its current AND old slug",
    async (_label, hidden) => {
      const repos = makeRepos(hidden);
      const unknown = observable(
        await caught(resolveEventBySlug({ repos }, { slug: UNKNOWN_SLUG })),
      );

      for (const slug of [CURRENT_SLUG, OLD_SLUG]) {
        expect(
          observable(
            await caught(
              ensureEventReadableBySlug(repos, { slug, viewerHumanId: null }),
            ),
          ),
        ).toEqual(unknown);
      }
    },
  );

  it("returns quietly for the owner, a published event, and an unknown slug", async () => {
    await expect(
      ensureEventReadableBySlug(makeRepos({ status: "DRAFT", publishedAt: null }), {
        slug: OLD_SLUG,
        viewerHumanId: OWNER_ID,
      }),
    ).resolves.toBeUndefined();
    await expect(
      ensureEventReadableBySlug(makeRepos({}), {
        slug: OLD_SLUG,
        viewerHumanId: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      ensureEventReadableBySlug(makeRepos({}), {
        slug: UNKNOWN_SLUG,
        viewerHumanId: null,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The same parity for the reads keyed by EVENT ID. An event id reaches a
// stranger in more ways than a slug does (links, embeds, API payloads), so
// a hidden event's id must answer like an id that does not exist: same code,
// same (absent) meta. `getEventGateState` is also the gate every id-keyed
// public read runs first (`ensureFullEventReadAccessByEventId`).
// ─────────────────────────────────────────────────────────────────────────────

const ID_READS: Array<{
  name: string;
  run: (
    repos: Repos,
    eventId: string,
    viewerHumanId: string | null,
  ) => Promise<unknown>;
  /** What an editor gets instead of NOT_FOUND. */
  editorGets: Record<string, unknown> | "NOT_FOUND";
}> = [
  {
    name: "getEventGateState",
    run: (repos, eventId, viewerHumanId) =>
      getEventGateState(
        { repos, clock: { now: () => new Date() } as never },
        { eventId, viewerHumanId },
      ),
    editorGets: { eventId: EVENT_ID, viewerCanBypass: true },
  },
  {
    name: "validateEventPassword",
    run: (repos, eventId, viewerHumanId) =>
      validateEventPassword({ repos }, { eventId, password: "x", viewerHumanId }),
    editorGets: { eventId: EVENT_ID, bypassed: true },
  },
  {
    // Public-only by design (no viewer input): stricter than N3, and
    // identical for unknown and hidden. Pinned so it stays that way.
    name: "getEventGatedPreview",
    run: (repos, eventId) =>
      getEventGatedPreview(
        { repos, clock: { now: () => new Date() } },
        { eventId },
      ),
    editorGets: "NOT_FOUND",
  },
  {
    // PUBLISHED-only by design: every hidden event is non-PUBLISHED.
    name: "getPublicEventApplicationForm",
    run: (repos, eventId) =>
      getPublicEventApplicationForm({ repos }, { eventId }),
    editorGets: "NOT_FOUND",
  },
];

describe.each(ID_READS)("$name — a hidden event's id answers like an unknown id", (read) => {
  describe.each(HIDDEN)("%s", (_label, hidden) => {
    it.each([
      ["anonymous", null, {}],
      ["a signed-in stranger", STRANGER_ID, {}],
      ["an org VIEWER", STRANGER_ID, { org: "VIEWER" }],
      ["an org SCANNER", STRANGER_ID, { org: "SCANNER" }],
      ["a VIEWER delegate", STRANGER_ID, { delegate: "VIEWER" }],
      ["a SCANNER delegate", STRANGER_ID, { delegate: "SCANNER" }],
    ] as const)("for %s", async (_who, viewer, opts) => {
      const repos = makeRepos(
        "org" in opts
          ? ({ ...hidden, orgId: ORG_ID, humanId: null } as Partial<EventRecord>)
          : hidden,
        "org" in opts
          ? { orgRole: opts.org }
          : "delegate" in opts
            ? { delegateRole: opts.delegate }
            : {},
      );

      const unknown = observable(await caught(read.run(repos, UNKNOWN_ID, viewer)));
      const hiddenErr = observable(await caught(read.run(repos, EVENT_ID, viewer)));

      expect(unknown).toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(hiddenErr).toEqual(unknown);
    });

    it.each(["OWNER", "ADMIN", "EDITOR"])(
      "a %s delegate of the human owner is not turned away as NOT_FOUND (unless the read is public-only)",
      async (delegateRole) => {
        const repos = makeRepos(hidden, { delegateRole });
        const settled = await read
          .run(repos, EVENT_ID, STRANGER_ID)
          .then((value) => ({ value }), (err: unknown) => ({ err }));
        if (read.editorGets !== "NOT_FOUND") {
          expect(repos.authz.getHumanDelegation).toHaveBeenCalledWith({
            principalId: OWNER_ID,
            delegateId: STRANGER_ID,
          });
        }

        if (read.editorGets === "NOT_FOUND") {
          expect(settled).toMatchObject({ err: { code: "EVENT_NOT_FOUND" } });
        } else {
          // Reads through the hidden-event gate AND bypasses like the owner:
          // `canViewerBypassEventGate` is `actorHoldsEventEditRole` (owner
          // ruling 2026-09-28 — edit-role delegates get the builder), so a
          // delegate's answer is the owner's answer, byte for byte.
          expect(settled).toMatchObject({ value: read.editorGets });
        }
      },
    );

    it("the owner is not turned away as NOT_FOUND (unless the read is public-only)", async () => {
      const repos = makeRepos(hidden);
      const settled = await read
        .run(repos, EVENT_ID, OWNER_ID)
        .then((value) => ({ value }), (err: unknown) => ({ err }));

      if (read.editorGets === "NOT_FOUND") {
        expect(settled).toMatchObject({ err: { code: "EVENT_NOT_FOUND" } });
      } else {
        expect(settled).toMatchObject({ value: read.editorGets });
      }
    });
  });
});
