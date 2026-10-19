import { describe, expect, it, vi } from "vitest";

import { resolveEventBySlug } from "../resolve-event-by-slug";
import type { ResolveEventBySlugDeps } from "../resolve-event-by-slug";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_SLUG = "acme/us/ca/launch-party-2024-05-01--abcdef";

function makeDeps(
  overrides: {
    resolveResult?: {
      eventId: string;
      currentSlug: string;
      redirect: boolean;
    } | null;
    loggerEnabled?: boolean;
    event?: EventRecord | null;
    orgRole?: string | null;
    staffRoles?: string[];
    /** `false` → the staff role holder has no second factor enrolled. */
    staffSecondFactor?: boolean;
  } = {},
) {
  const resolveResult = Object.prototype.hasOwnProperty.call(
    overrides,
    "resolveResult",
  )
    ? (overrides.resolveResult ?? null)
    : { eventId: DEFAULT_EVENT_ID, currentSlug: DEFAULT_SLUG, redirect: false };

  const eventsRepo = {
    resolveBySlug: vi.fn(async (slug: string) => {
      if (!resolveResult) {
        return null;
      }
      return slug === DEFAULT_SLUG ? resolveResult : null;
    }),
  };

  (eventsRepo as Record<string, unknown>).getById = vi.fn(async () =>
    Object.prototype.hasOwnProperty.call(overrides, "event")
      ? (overrides.event ?? null)
      : makeEvent(),
  );

  const authz = {
    getOrgMembership: vi.fn(async () =>
      overrides.orgRole ? { role: overrides.orgRole } : null,
    ),
    getStaffRolesForHumanId: vi.fn(async () => overrides.staffRoles ?? []),
    getHumanDelegation: vi.fn(async () => null),
  };

  const repos = {
    events: eventsRepo,
    authz,
  } as unknown as Repos;

  const logger =
    overrides.loggerEnabled === false ? undefined : createTestLogger();

  // The authz PORT's staff probe, as the adapter answers it: a role holder
  // with no second factor enrolled is refused.
  const hasStaffRole = vi.fn(
    async ({ requiredRoles }: { requiredRoles: string[] }) => {
      const holds = (overrides.staffRoles ?? []).some((role) =>
        requiredRoles.includes(role),
      );
      if (!holds) return { allowed: false };
      return overrides.staffSecondFactor === false
        ? { allowed: false, secondFactorRequired: true as const }
        : { allowed: true };
    },
  );

  const deps: ResolveEventBySlugDeps = {
    repos,
    logger,
    authz: { hasStaffRole },
  };

  return {
    deps,
    eventsRepo: eventsRepo as typeof eventsRepo & {
      getById: ReturnType<typeof vi.fn>;
    },
    authz,
    hasStaffRole,
    logger,
  };
}

const OWNER_HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const STRANGER_HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const OLD_SLUG = DEFAULT_SLUG;
const CURRENT_SLUG = "acme/us/ca/renamed-party-2024-05-01--abcdef";
const REDIRECT = {
  eventId: DEFAULT_EVENT_ID,
  currentSlug: CURRENT_SLUG,
  redirect: true,
};
const LIVE_AT = new Date("2024-04-01T00:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    slug: CURRENT_SLUG,
    status: "PUBLISHED",
    publishedAt: LIVE_AT,
    orgId: null,
    humanId: OWNER_HUMAN_ID,
    stewardship: "OWNED",
    gateType: "NONE",
    ...overrides,
  } as unknown as EventRecord;
}

describe("resolveEventBySlug", () => {
  it("returns event resolution and logs the lookup", async () => {
    const { deps, eventsRepo, logger } = makeDeps();

    const result = await resolveEventBySlug(deps, { slug: DEFAULT_SLUG });

    expect(result).toEqual({
      eventId: DEFAULT_EVENT_ID,
      currentSlug: DEFAULT_SLUG,
      redirect: false,
    });
    expect(eventsRepo.resolveBySlug).toHaveBeenCalledWith(DEFAULT_SLUG);
    expect(logger!.info).toHaveBeenCalledWith("event.slug_resolved", {
      slug: DEFAULT_SLUG,
      eventId: DEFAULT_EVENT_ID,
      redirect: false,
    });
  });

  it("throws when no resolution exists", async () => {
    const { deps } = makeDeps({ resolveResult: null });

    await expect(
      resolveEventBySlug(deps, { slug: DEFAULT_SLUG }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("validates the incoming slug", async () => {
    const { deps } = makeDeps({ loggerEnabled: false });

    await expect(resolveEventBySlug(deps, { slug: "" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  describe("history-slug redirect is gated by N3 readability", () => {
    const NOT_FOUND = { code: "EVENT_NOT_FOUND", meta: { via: "slug" } };

    it("a DRAFT's old slug does not redirect an anonymous viewer", async () => {
      const { deps, logger } = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({ status: "DRAFT", publishedAt: null }),
      });

      await expect(
        resolveEventBySlug(deps, { slug: OLD_SLUG }),
      ).rejects.toMatchObject(NOT_FOUND);
      // The withheld target never reaches the success log line.
      expect(logger!.info).not.toHaveBeenCalledWith(
        "event.slug_resolved",
        expect.anything(),
      );
    });

    it("a DRAFT's old slug answers EXACTLY like a slug that never existed", async () => {
      const hidden = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({ status: "DRAFT", publishedAt: null }),
      });
      const missing = makeDeps({ resolveResult: null });

      const hiddenErr: unknown = await resolveEventBySlug(hidden.deps, {
        slug: OLD_SLUG,
      }).catch((e: unknown) => e);
      const missingErr: unknown = await resolveEventBySlug(missing.deps, {
        slug: OLD_SLUG,
      }).catch((e: unknown) => e);

      expect(hiddenErr).toEqual(missingErr);
    });

    it("a DRAFT's old slug does not redirect a signed-in non-editor", async () => {
      const { deps, authz } = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({ status: "DRAFT", publishedAt: null }),
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: OLD_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).rejects.toMatchObject(NOT_FOUND);
      expect(authz.getOrgMembership).not.toHaveBeenCalled();
    });

    it("an org DRAFT's old slug does not redirect an org VIEWER (not an edit role)", async () => {
      const { deps } = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({
          status: "DRAFT",
          publishedAt: null,
          orgId: ORG_ID,
          humanId: null,
        }),
        orgRole: "VIEWER",
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: OLD_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).rejects.toMatchObject(NOT_FOUND);
    });

    it("a DRAFT's old slug redirects its owning human", async () => {
      const { deps } = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({ status: "DRAFT", publishedAt: null }),
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: OLD_SLUG,
          viewerHumanId: OWNER_HUMAN_ID,
        }),
      ).resolves.toEqual({
        eventId: DEFAULT_EVENT_ID,
        currentSlug: CURRENT_SLUG,
        redirect: true,
      });
    });

    it("an org DRAFT's old slug redirects an org EDITOR", async () => {
      const { deps, authz } = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({
          status: "DRAFT",
          publishedAt: null,
          orgId: ORG_ID,
          humanId: null,
        }),
        orgRole: "EDITOR",
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: OLD_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).resolves.toMatchObject({ currentSlug: CURRENT_SLUG, redirect: true });
      expect(authz.getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: STRANGER_HUMAN_ID,
      });
    });

    it("an ownerless COMMUNITY draft's old slug redirects a community moderator only", async () => {
      const event = makeEvent({
        status: "DRAFT",
        publishedAt: null,
        humanId: null,
        stewardship: "COMMUNITY",
      } as Partial<EventRecord>);
      const mod = makeDeps({
        resolveResult: REDIRECT,
        event,
        staffRoles: ["COMMUNITY_MODERATOR"],
      });
      const nobody = makeDeps({ resolveResult: REDIRECT, event });

      await expect(
        resolveEventBySlug(mod.deps, {
          slug: OLD_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).resolves.toMatchObject({ redirect: true });
      await expect(
        resolveEventBySlug(nobody.deps, {
          slug: OLD_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).rejects.toMatchObject(NOT_FOUND);
    });

    // The moderator read is a staff grant: it needs the second factor the
    // authz port asks of every staff role.
    it("an ownerless COMMUNITY draft is hidden from a moderator with no second factor enrolled", async () => {
      const event = makeEvent({
        status: "DRAFT",
        publishedAt: null,
        humanId: null,
        stewardship: "COMMUNITY",
      } as Partial<EventRecord>);
      const unenrolled = makeDeps({
        resolveResult: REDIRECT,
        event,
        staffRoles: ["COMMUNITY_MODERATOR"],
        staffSecondFactor: false,
      });

      await expect(
        resolveEventBySlug(unenrolled.deps, {
          slug: OLD_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).rejects.toMatchObject(NOT_FOUND);
      expect(unenrolled.hasStaffRole).toHaveBeenCalledWith({
        actorHumanId: STRANGER_HUMAN_ID,
        requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
      });
    });

    it.each([
      ["PUBLISHED", LIVE_AT],
      ["COMPLETED", LIVE_AT],
      // Legacy COMPLETED row with no publishedAt: completeEvent only moves a
      // PUBLISHED event, so it was live.
      ["COMPLETED", null],
      ["CANCELLED", LIVE_AT],
      ["ARCHIVED", LIVE_AT],
    ] as const)(
      "a %s event (publishedAt %s) redirects an anonymous viewer",
      async (status, publishedAt) => {
        const { deps, authz } = makeDeps({
          resolveResult: REDIRECT,
          event: makeEvent({ status, publishedAt } as Partial<EventRecord>),
        });

        await expect(
          resolveEventBySlug(deps, { slug: OLD_SLUG }),
        ).resolves.toEqual({
          eventId: DEFAULT_EVENT_ID,
          currentSlug: CURRENT_SLUG,
          redirect: true,
        });
        // Publicly readable: no viewer lookup needed.
        expect(authz.getOrgMembership).not.toHaveBeenCalled();
      },
    );

    it.each(["CANCELLED", "ARCHIVED"] as const)(
      "a never-live %s event's old slug does not redirect an anonymous viewer",
      async (status) => {
        const { deps } = makeDeps({
          resolveResult: REDIRECT,
          event: makeEvent({ status, publishedAt: null }),
        });

        await expect(
          resolveEventBySlug(deps, { slug: OLD_SLUG }),
        ).rejects.toMatchObject(NOT_FOUND);
      },
    );

    it("a never-live CANCELLED event's old slug still redirects its owner", async () => {
      const { deps } = makeDeps({
        resolveResult: REDIRECT,
        event: makeEvent({ status: "CANCELLED", publishedAt: null }),
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: OLD_SLUG,
          viewerHumanId: OWNER_HUMAN_ID,
        }),
      ).resolves.toMatchObject({ redirect: true });
    });

    it.each(["PASSWORD", "APPLICATION"] as const)(
      "a %s-gated PUBLISHED event still redirects: the gate applies on the canonical URL",
      async (gateType) => {
        const { deps } = makeDeps({
          resolveResult: REDIRECT,
          event: makeEvent({ gateType } as Partial<EventRecord>),
        });

        await expect(
          resolveEventBySlug(deps, { slug: OLD_SLUG }),
        ).resolves.toMatchObject({ currentSlug: CURRENT_SLUG, redirect: true });
      },
    );

    it("the redirect target vanishing between reads is NOT_FOUND", async () => {
      const { deps } = makeDeps({ resolveResult: REDIRECT, event: null });

      await expect(
        resolveEventBySlug(deps, { slug: OLD_SLUG }),
      ).rejects.toMatchObject(NOT_FOUND);
    });

    it("a DRAFT's CURRENT slug is the unknown-slug error to a stranger (no event id)", async () => {
      const { deps } = makeDeps({
        event: makeEvent({ status: "DRAFT", publishedAt: null }),
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: DEFAULT_SLUG,
          viewerHumanId: STRANGER_HUMAN_ID,
        }),
      ).rejects.toMatchObject(NOT_FOUND);
    });

    it("a DRAFT's CURRENT slug resolves for its owner", async () => {
      const { deps } = makeDeps({
        event: makeEvent({ status: "DRAFT", publishedAt: null }),
      });

      await expect(
        resolveEventBySlug(deps, {
          slug: DEFAULT_SLUG,
          viewerHumanId: OWNER_HUMAN_ID,
        }),
      ).resolves.toEqual({
        eventId: DEFAULT_EVENT_ID,
        currentSlug: DEFAULT_SLUG,
        redirect: false,
      });
    });

    it("rejects a non-uuid viewerHumanId", async () => {
      const { deps } = makeDeps();

      await expect(
        resolveEventBySlug(deps, { slug: DEFAULT_SLUG, viewerHumanId: "x" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
