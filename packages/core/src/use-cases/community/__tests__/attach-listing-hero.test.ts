import { describe, expect, it, vi } from "vitest";

import {
  attachCommunityListingHero,
  type AttachCommunityListingHeroDeps,
} from "../attach-listing-hero";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";
import {
  ADMIN_ID,
  EVENT_ID,
  IMAGE_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeClock,
  makeCommunityEvent,
  makeImage,
  makeOrgEvent,
  makeStaffAuthz,
} from "./helpers";

const VALID_INPUT = {
  actorHumanId: MODERATOR_ID,
  eventId: EVENT_ID,
  imageId: IMAGE_ID,
};

function buildDeps(
  overrides: {
    rolesByHuman?: Record<string, string[]>;
    event?: EventRecord | null;
    image?: ImageRecord | null;
  } = {},
) {
  const rolesByHuman = overrides.rolesByHuman ?? {
    [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
    [ADMIN_ID]: ["ADMIN"],
  };

  const event = "event" in overrides ? overrides.event : makeCommunityEvent();
  const image = "image" in overrides ? overrides.image : makeImage();

  const applyCommunityEdit = vi.fn(
    async ({
      eventId,
      fields,
    }: {
      eventId: string;
      fields: { heroImageId?: string | null };
    }) => makeCommunityEvent({ id: eventId, ...fields }),
  );

  const attach = vi.fn(async () => undefined);
  const audit = { log: vi.fn() };

  const txRepos = {
    events: { applyCommunityEdit },
    images: { attach },
    audit,
  };

  const eventsGetById = vi.fn(async () => event);
  const imagesGetById = vi.fn(async () => image);

  const deps: AttachCommunityListingHeroDeps = {
    repos: {
      events: { getById: eventsGetById },
      images: { getById: imagesGetById },
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as AttachCommunityListingHeroDeps["repos"],
    authz: makeStaffAuthz(rolesByHuman),
    clock: makeClock(),
  };

  return {
    deps,
    applyCommunityEdit,
    attach,
    audit,
    eventsGetById,
    imagesGetById,
  };
}

describe("attachCommunityListingHero", () => {
  it("sets the hero on a PUBLISHED COMMUNITY listing, attaches the image, and audits the actor", async () => {
    const { deps, applyCommunityEdit, attach, audit } = buildDeps();

    const result = await attachCommunityListingHero(deps, VALID_INPUT);

    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { heroImageId: IMAGE_ID },
    });

    // The image is attached in the SAME tx so the orphan-upload sweep can't
    // reclaim it and it resolves on cards/search (`attached: true` filter).
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({
      ownerId: EVENT_ID,
      imageIds: [IMAGE_ID],
      attachedAt: NOW,
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "community_listing.hero_attached",
        data: expect.objectContaining({
          actorHumanId: MODERATOR_ID,
          imageId: IMAGE_ID,
        }),
        at: NOW,
      }),
    );

    expect(result).toEqual({ eventId: EVENT_ID, heroImageId: IMAGE_ID });
  });

  it("skips the attach when the image is already attached, but still sets the hero + audits", async () => {
    const { deps, applyCommunityEdit, attach, audit } = buildDeps({
      image: makeImage({ attached: true }),
    });

    const result = await attachCommunityListingHero(deps, VALID_INPUT);

    // Guard prevents a redundant attach on an already-attached image.
    expect(attach).not.toHaveBeenCalled();

    // The hero linkage + audit still run.
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { heroImageId: IMAGE_ID },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "community_listing.hero_attached" }),
    );
    expect(result).toEqual({ eventId: EVENT_ID, heroImageId: IMAGE_ID });
  });

  it("allows a platform ADMIN as well as a moderator", async () => {
    const { deps } = buildDeps();

    await expect(
      attachCommunityListingHero(deps, {
        ...VALID_INPUT,
        actorHumanId: ADMIN_ID,
      }),
    ).resolves.toEqual({ eventId: EVENT_ID, heroImageId: IMAGE_ID });
  });

  it("rejects non-staff actors with STAFF_ONLY and never writes", async () => {
    const { deps, applyCommunityEdit } = buildDeps();

    await expect(
      attachCommunityListingHero(deps, {
        ...VALID_INPUT,
        actorHumanId: USER_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects a non-COMMUNITY (owned) event as EVENT_NOT_FOUND", async () => {
    const { deps, applyCommunityEdit } = buildDeps({ event: makeOrgEvent() });

    await expect(
      attachCommunityListingHero(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  // DRAFT is now ACCEPTED. A community listing authored in the EventBuilder
  // needs its banner before it goes live, and the three-step
  // request → PUT → attach dance is the only way an image can reference an
  // event (storage keys embed the event id). No oracle risk: this use case is
  // requirePlatformStaff-gated before it reads anything, unlike
  // requestEventImageUpload's any-signed-in-user arm.
  it("ACCEPTS a DRAFT community listing — the builder attaches a hero before publishing", async () => {
    const { deps, applyCommunityEdit, audit } = buildDeps({
      event: makeCommunityEvent({ status: "DRAFT", publishedAt: null }),
    });

    const result = await attachCommunityListingHero(deps, VALID_INPUT);

    expect(result).toMatchObject({ eventId: EVENT_ID, heroImageId: IMAGE_ID });
    expect(applyCommunityEdit).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      fields: { heroImageId: IMAGE_ID },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "community_listing.hero_attached" }),
    );
  });

  it.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "still rejects a %s community listing as EVENT_NOT_FOUND (a hero on a dead listing is sweep fodder)",
    async (status) => {
      const { deps, applyCommunityEdit } = buildDeps({
        event: makeCommunityEvent({ status }),
      });

      await expect(
        attachCommunityListingHero(deps, VALID_INPUT),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(applyCommunityEdit).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing event as EVENT_NOT_FOUND", async () => {
    const { deps } = buildDeps({ event: null });

    await expect(
      attachCommunityListingHero(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects an image belonging to another event as IMAGE_NOT_FOUND (IDOR guard)", async () => {
    const { deps, applyCommunityEdit } = buildDeps({
      image: makeImage({ eventId: "00000000-0000-4000-8000-000000000000" }),
    });

    await expect(
      attachCommunityListingHero(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });

  it("rejects a missing image as IMAGE_NOT_FOUND", async () => {
    const { deps } = buildDeps({ image: null });

    await expect(
      attachCommunityListingHero(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("rejects an un-finalized image (uploadedAt null) as UPLOAD_NOT_COMPLETE", async () => {
    const { deps, applyCommunityEdit } = buildDeps({
      image: makeImage({ uploadedAt: null }),
    });

    await expect(
      attachCommunityListingHero(deps, VALID_INPUT),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_COMPLETE" });
    expect(applyCommunityEdit).not.toHaveBeenCalled();
  });
});
