import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord, EventSlugResolution } from "@th/ports/repos/events";
import type { EventBody } from "@th/schema";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  getPublicEventBody,
  type GetPublicEventBodyDeps,
} from "../get-public-event-body";

const BASE_EVENT: EventRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: null,
  humanId: "22222222-2222-4222-8222-222222222222",
  title: "Mission Supper Club",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-11-20T20:00:00.000Z"),
  endsAt: new Date("2024-11-20T23:00:00.000Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Valencia St",
  countryCode: "US",
  region: "CA",
  locality: "San Francisco",
  postalCode: "94103",
  lat: 37.7675,
  lng: -122.421,
  slug: "mission-supper-club",
  shortId: "msn123",
  regionCode: "us-ca",
  publishedAt: new Date("2024-10-01T00:00:00.000Z"),
  agreementPrimaryId: "33333333-3333-4333-8333-333333333333",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
  createdAt: new Date("2024-08-01T00:00:00.000Z"),
  updatedAt: new Date("2024-10-05T12:00:00.000Z"),
  heroImageUrl: null,
};

const SAMPLE_BODY: EventBody = {
  version: 1,
  sections: [
    {
      id: "sec-1",
      kind: "section",
      style: {
        background: "default",
        density: "normal",
        maxWidth: "prose",
        textAlign: "left",
      },
      layout: {
        type: "singleColumn",
        columns: [
          {
            blocks: [
              {
                type: "richText",
                id: "blk-1",
                html: "<p>Welcome to Mission Supper Club!</p>",
              },
            ],
          },
        ],
      },
    },
  ],
};

const createDeps = () => {
  const resolveBySlug = vi.fn<
    [slug: string],
    Promise<EventSlugResolution | null>
  >();
  const getById = vi.fn<[eventId: string], Promise<EventRecord | null>>();
  const getContent = vi.fn<
    [input: { eventId: string }],
    Promise<EventBody | null>
  >();
  const resolveByIds = vi
    .fn<[ids: string[]], Promise<never[]>>()
    .mockResolvedValue([]);

  const getOrgMembership = vi.fn(async () => null as { role: string } | null);
  const getStaffRolesForHumanId = vi.fn(async () => [] as string[]);

  const repos = {
    events: {
      resolveBySlug,
      getById,
      getContent,
    },
    images: {
      resolveByIds,
    },
    authz: {
      getOrgMembership,
      getStaffRolesForHumanId,
    },
  } as unknown as Repos;

  const logger = createTestLogger();

  const deps: GetPublicEventBodyDeps = {
    repos,
    authz: { hasStaffRole: async () => ({ allowed: false }) },
    logger,
  };

  return {
    deps,
    logger,
    resolveBySlug,
    getById,
    getContent,
    resolveByIds,
    getOrgMembership,
  };
};

describe("getPublicEventBody", () => {
  let context: ReturnType<typeof createDeps>;

  beforeEach(() => {
    context = createDeps();
  });

  it("returns event body for a published event", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.getContent.mockResolvedValue(SAMPLE_BODY);

    const result = await getPublicEventBody(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result).toMatchObject({
      eventId: BASE_EVENT.id,
      body: SAMPLE_BODY,
      imageMap: {},
    });
    expect(context.getContent).toHaveBeenCalledWith({ eventId: BASE_EVENT.id });
    expect(context.logger.info).toHaveBeenCalledWith(
      "events.get_public_body",
      expect.objectContaining({
        slug: "mission-supper-club",
        eventId: BASE_EVENT.id,
      }),
    );
  });

  it("returns null body when no content has been saved", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.getContent.mockResolvedValue(null);

    const result = await getPublicEventBody(context.deps, {
      slug: "mission-supper-club",
    });

    expect(result.eventId).toBe(BASE_EVENT.id);
    expect(result.body).toBeNull();
    expect(result.imageMap).toEqual({});
  });

  it("throws not_found when slug resolution fails", async () => {
    context.resolveBySlug.mockResolvedValue(null);

    await expect(
      getPublicEventBody(context.deps, { slug: "missing-event" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(context.getById).not.toHaveBeenCalled();
  });

  it("throws not_found when slug redirects", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: true,
    });
    // The readability check runs first, so the target must be readable.
    context.getById.mockResolvedValue(BASE_EVENT);

    await expect(
      getPublicEventBody(context.deps, { slug: "legacy-slug" }),
    ).rejects.toMatchObject({ code: "EVENT_SLUG_REDIRECT" });
  });

  it("throws not_found when event record does not exist", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(null);

    await expect(
      getPublicEventBody(context.deps, { slug: "missing-record" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("a DRAFT is the unknown-slug error to a stranger (N3)", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      status: "DRAFT",
      publishedAt: null,
    });

    await expect(
      getPublicEventBody(context.deps, { slug: "mission-supper-club" }),
    ).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
      meta: { via: "slug" },
    });
    expect(context.getContent).not.toHaveBeenCalled();
  });

  it("a DRAFT is still not served to its owner — EVENT_NOT_PUBLISHED, as before", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue({
      ...BASE_EVENT,
      status: "DRAFT",
      publishedAt: null,
    });

    await expect(
      getPublicEventBody(context.deps, {
        slug: "mission-supper-club",
        viewerHumanId: BASE_EVENT.humanId!,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
    expect(context.getContent).not.toHaveBeenCalled();
  });

  it("a once-live COMPLETED event keeps its EVENT_NOT_PUBLISHED answer (publicly readable)", async () => {
    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue({ ...BASE_EVENT, status: "COMPLETED" });

    await expect(
      getPublicEventBody(context.deps, { slug: "mission-supper-club" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });

  it("resolves imageBlock nodes inside richText ProseMirror docs", async () => {
    const imageId = "img-aaaa-bbbb-cccc-dddddddddddd";
    const bodyWithProseMirrorImages: EventBody = {
      version: 1,
      sections: [
        {
          id: "sec-1",
          kind: "section",
          style: {
            background: "default",
            density: "normal",
            maxWidth: "prose",
            textAlign: "left",
          },
          layout: {
            type: "singleColumn",
            columns: [
              {
                blocks: [
                  {
                    type: "richText",
                    id: "blk-1",
                    doc: {
                      type: "doc",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "Hello" }],
                        },
                        {
                          type: "imageBlock",
                          attrs: {
                            imageId,
                            src: "",
                            alt: "Test",
                            align: "center",
                            width: "100%",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    context.resolveBySlug.mockResolvedValue({
      eventId: BASE_EVENT.id,
      currentSlug: BASE_EVENT.slug!,
      redirect: false,
    });
    context.getById.mockResolvedValue(BASE_EVENT);
    context.getContent.mockResolvedValue(bodyWithProseMirrorImages);
    context.resolveByIds.mockResolvedValue([
      {
        id: imageId,
        ownerId: BASE_EVENT.id,
        uploadedAt: new Date(),
        publicUrl: "https://cdn.example.com/image.jpg",
      },
    ] as never[]);

    const result = await getPublicEventBody(context.deps, {
      slug: "mission-supper-club",
    });

    expect(context.resolveByIds).toHaveBeenCalledWith([imageId]);
    expect(result.imageMap).toEqual({
      [imageId]: "https://cdn.example.com/image.jpg",
    });
  });
});
