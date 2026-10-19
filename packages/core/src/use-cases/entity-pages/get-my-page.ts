import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";
import type { ReporterPort } from "@th/ports/reporter";
import { sanitizeAnnouncementHtml } from "../../lib/announcement-html";
import type { AnnouncementRecord } from "@th/types/repos/announcements";
import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";
import type { ClockPort } from "@th/ports/clock";
import { fail, isAppError } from "@th/errors";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { entitySummarySchema, loadEntitySummary } from "./entity-summary";
import { COMMUNITY_SEED_TEMPLATE_OP } from "./community-handover-state";
import { needsTemplateSeed, resolveCategory } from "./page-templates";
import { seedPageTemplateBlocks } from "./seed-page-template-blocks";
import {
  COMMUNITY_PAGE_REFUSAL_CODES,
  logCommunityPageUpdate,
  recheckCommunityPageEditor,
  resolveEntityPageEditor,
  type EntityPageEditor,
} from "./entity-page-access";
import { PUBLIC_LINEUP_ROLES } from "../../lib/event-human-roles";
import { toHumanShowSummary } from "../event-humans/list-human-shows";
import { PAST_SHOWS_LIMIT } from "../event-humans/list-human-shows";
import { loadHumanUpcomingEventItems } from "./derive-human-upcoming-events";
import { buildPerformerStatsBlockData } from "../../lib/performer-stats";

const DERIVED_ANNOUNCEMENT_LIMIT = 10;

// ── Schemas ────────────────────────────────────────────────────────────────

const pageOwnerTypeSchema = z.enum(["HUMAN", "ORGANIZATION", "PLACE"]);

export const getMyPageInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    ownerType: pageOwnerTypeSchema,
    ownerId: z.string().min(1),
  })
  .strict();

const blockSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  kind: z.string(),
  orderIndex: z.number(),
  data: z.unknown(),
  visible: z.boolean(),
  /** Page surface ("main" | "memberships"); adapter defaults it to "main". */
  section: z.string().default("main"),
});

const themeSchema = z
  .object({
    id: z.string(),
    pageId: z.string(),
    colorPrimary: z.string().nullable(),
    colorBg: z.string().nullable(),
    colorText: z.string().nullable(),
    fontKey: z.string().nullable(),
    layoutKey: z.string().nullable(),
  })
  .nullable();

const pageSchema = z.object({
  id: z.string(),
  ownerType: pageOwnerTypeSchema,
  ownerId: z.string(),
  slug: z.string(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  visibility: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

type PageForDerivedData = z.infer<typeof pageSchema>;
// z.input, not z.infer: repo records may omit `section` (the output schema
// defaults it to "main"), and the derivation only spreads blocks through.
type BlockForDerivedData = z.input<typeof blockSchema>;

export const getMyPageOutputSchema = z
  .object({
    page: pageSchema,
    /** All blocks, including hidden ones (visible=false). */
    blocks: z.array(blockSchema),
    theme: themeSchema,
    /**
     * The owner's REAL entity — the identical summary `getPublicPage` ships,
     * built by the identical loader (see entity-summary.ts). The editor renders
     * the public block components, and those branch on this object (venue vs
     * artist booking CTA, `placeAcceptsBookingRequests` for the request-to-book
     * buttons, …), so anything less than the real thing makes the live preview
     * disagree with the live page.
     *
     * Nullable: an authorized owner whose entity row has gone missing still
     * gets their editor — a data-integrity anomaly they cannot fix must not
     * brick the page they came to edit. Clients treat null as "no entity data",
     * not as "not a venue".
     */
    entity: entitySummarySchema.nullable(),
  })
  .strict();

export type GetMyPageInput = z.infer<typeof getMyPageInputSchema>;
export type GetMyPageOutput = z.infer<typeof getMyPageOutputSchema>;

// ── Deps ───────────────────────────────────────────────────────────────────

export type GetMyPageDeps = {
  repos: Pick<
    Repos,
    | "entityPages"
    | "authz"
    | "announcements"
    // humans/organizations/places back the shared entity loader (all three
    // owner types); places additionally feeds the location_map derivation,
    // which now reads the SAME loaded entity rather than re-querying.
    | "humans"
    | "organizations"
    | "places"
    | "performerProfiles"
    | "eventHumans"
    | "humanStats"
    // Availability-onboarding FR-005: the shared entity loader counts a
    // PLACE's availability rows to fold "has hours" into acceptance.
    | "calendars"
    // The PLACE summary's `claimable` hint (shared claim-state helper).
    | "placeVerificationRequests"
    // The community moderator path: access rules (places + events), and the
    // template seed's claim-lock re-check and audit row (tx).
    | "events"
    | "tx"
  >;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports the deliberately-swallowed template-seed failure (below) to the
   * error tracker. Required by the repo's Sentry error-reporting convention:
   * the seed catch returns a degraded result (the un-seeded page), and a seed
   * that throws on every load would otherwise be invisible to Sentry forever
   * (`templateAppliedCategories` only advances on success → infinite retry).
   */
  reportError?: ReporterPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function getMyPage(
  deps: GetMyPageDeps,
  rawInput: unknown,
): Promise<GetMyPageOutput> {
  const logger = deps.logger?.child({ useCase: "getMyPage" });

  const execute = async (): Promise<GetMyPageOutput> => {
    const input = parseInput(getMyPageInputSchema, rawInput);

    // Authorize: human owns their own page, org members need EDIT roles,
    // places their manager, or a community moderator while nobody owns it.
    const editor = await resolveEntityPageEditor(deps, input);

    const page = await deps.repos.entityPages.getByOwner(
      input.ownerType,
      input.ownerId,
    );
    if (!page) {
      throw fail("PAGE_NOT_FOUND");
    }

    // Lazy, additive template seeding on editor load (FR-004). Deliberately a
    // side-effecting read: idempotent (FR-003 guard), scoped to the owner's own
    // page, and the single code path covering every past/future creation site
    // AND every category transition (e.g. enabling performer mode). Seed
    // failure must NOT fail the read — log and continue; the next load retries
    // because `templateAppliedCategories` only updates on a successful seed.
    await maybeSeedTemplate(deps, page, editor, input.actorHumanId, logger);

    // The entity load rides ALONG the existing blocks/theme reads rather than
    // after them: it adds 1 query (PLACE) or 2 (HUMAN/ORGANIZATION owner row +
    // performer profile) but no extra round-trip to the editor's load. It must
    // stay after the seed only because the seed can create blocks — it never
    // touches the owner row, so the ordering above is preserved.
    const [blocks, theme, entity] = await Promise.all([
      deps.repos.entityPages.listBlocks(page.id),
      deps.repos.entityPages.getTheme(page.id),
      loadEntitySummary(deps, page.ownerType, page.ownerId),
    ]);

    // Return ALL blocks (including hidden) for the editor, with canonical
    // derived payloads injected for data-backed block kinds.
    const derivedBlocks = await expandDerivedBlocks(deps, page, blocks, entity);

    return getMyPageOutputSchema.parse({
      page,
      blocks: derivedBlocks,
      theme,
      entity,
    });
  };

  if (logger) {
    return logger.withTime("getMyPage", execute);
  }
  return execute();
}

// ── Template seeding ─────────────────────────────────────────────────────────

async function maybeSeedTemplate(
  deps: GetMyPageDeps,
  page: EntityPageRecord,
  editor: EntityPageEditor,
  actorHumanId: string,
  logger?: LoggerPort,
): Promise<void> {
  try {
    // Only HUMAN pages consult performer mode; PLACE/ORG resolve to a fixed
    // category, so the flag is irrelevant for them.
    let performerEnabled = false;
    if (page.ownerType === "HUMAN") {
      const profile = await deps.repos.performerProfiles.getByOwner({
        ownerType: "human",
        ownerId: page.ownerId,
      });
      performerEnabled = isPerformerEnabled(profile);
    }

    const category = resolveCategory(page.ownerType, { performerEnabled });

    // Revision-aware: skips only when the applied revision for this category
    // is current. A template that gained `sinceRevision`-tagged kinds since
    // the page was seeded falls through and seeds exactly those kinds once
    // (see page-templates.ts "TEMPLATE REVISIONS").
    if (
      !needsTemplateSeed(page.templateAppliedCategories, page.ownerType, category)
    ) {
      return;
    }

    const seedInput = {
      pageId: page.id,
      ownerType: page.ownerType,
      category,
      page,
    };
    if (editor.kind === "owner") {
      await seedPageTemplateBlocks(deps, seedInput);
      return;
    }
    // A community moderator's seed is a write like any other: under the
    // place's claim lock, re-checked, audited when it added blocks.
    await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();
      await recheckCommunityPageEditor(tx, editor, now);
      const added = await seedPageTemplateBlocks(
        { repos: tx, logger },
        seedInput,
      );
      if (added.length === 0) return;
      await logCommunityPageUpdate(
        tx,
        editor,
        {
          actorHumanId,
          pageId: page.id,
          op: COMMUNITY_SEED_TEMPLATE_OP,
          fields: added.map((block) => `blocks.${block.id}`),
          from: null,
          to: {
            category,
            blocks: added.map((block) => ({
              blockId: block.id,
              kind: block.kind,
            })),
          },
        },
        now,
      );
    });
  } catch (err) {
    // A moderator who lost the page between the access check and the seed
    // (a claim landed) is refused, not served a degraded read.
    if (
      editor.kind === "community_moderator" &&
      isAppError(err) &&
      COMMUNITY_PAGE_REFUSAL_CODES.has(err.code)
    ) {
      throw err;
    }
    // Seeding is best-effort; never fail the editor read. The next load
    // retries because the category is only recorded on a successful seed.
    logger?.warn?.("getMyPage template seed failed", {
      err,
      pageId: page.id,
      ownerType: page.ownerType,
    });
    // `logger.warn` is NOT captured by Sentry, so report explicitly (repo
    // Sentry convention) — otherwise a seed that throws every load stays
    // invisible indefinitely. Guarded so a throwing reporter never turns the
    // graceful read into a thrown error.
    try {
      deps.reportError?.(err, {
        tags: { useCase: "getMyPage", step: "templateSeed" },
        extra: { pageId: page.id, ownerType: page.ownerType },
      });
    } catch {
      // Reporting is best-effort; swallow reporter failures.
    }
  }
}

async function expandDerivedBlocks(
  deps: GetMyPageDeps,
  page: PageForDerivedData,
  blocks: BlockForDerivedData[],
  entity: EntitySummary | null,
): Promise<BlockForDerivedData[]> {
  if (blocks.length === 0) return blocks;

  const hasAnnouncements = blocks.some(
    (block) => block.kind === "announcements",
  );
  const announcementItems = hasAnnouncements
    ? await loadAnnouncementItems(deps, page)
    : null;

  // The location_map derivation reads the ALREADY-loaded entity instead of
  // issuing its own places.getById — same source as get-public-page's
  // location_map, and one query fewer than the previous re-fetch.
  const place = entity?.type === "PLACE" ? entity : null;

  // Musician EPK derived data (HUMAN pages only). Each query is guarded by a
  // block-presence check so pages without these blocks pay nothing. The editor
  // shows ALL blocks, so stats is ALWAYS injected (even eligible:false) so the
  // owner can see whether they can toggle the public block on.
  const isHuman = page.ownerType === "HUMAN";
  // `upcoming_events` on a HUMAN page derives from the SAME performances path
  // as `shows`, but ONLY when no `shows` block exists among the blocks being
  // expanded (mirrors get-public-page — HumanEntityLayout zones both kinds
  // together, so deriving both would double-list every event). With zero
  // upcoming performances the loader returns null and the stored static list
  // is left untouched, keeping the editor preview consistent with public.
  // DELIBERATE divergence from get-public-page: the editor expands ALL blocks
  // (hidden included, since it renders them), so even a HIDDEN `shows` block
  // suppresses the `upcoming_events` derivation here — otherwise the editor
  // would double-list every event across the two blocks it displays. The
  // public path counts only VISIBLE blocks. Do not "unify" the two checks;
  // see the matching comment in get-public-page.ts.
  const hasShowsBlock = blocks.some((b) => b.kind === "shows");
  const [upcomingShows, pastShows, statsBlockData, humanUpcomingEventItems] =
    await Promise.all([
      isHuman && hasShowsBlock
        ? loadHumanShows(deps, page.ownerId, "upcoming")
        : Promise.resolve(null),
      isHuman && blocks.some((b) => b.kind === "past_shows")
        ? loadHumanShows(deps, page.ownerId, "past")
        : Promise.resolve(null),
      isHuman && blocks.some((b) => b.kind === "stats")
        ? deps.repos.humanStats
            .findByHumanId(page.ownerId)
            .then((stats) => buildPerformerStatsBlockData(stats))
        : Promise.resolve(null),
      isHuman &&
      !hasShowsBlock &&
      blocks.some((b) => b.kind === "upcoming_events")
        ? loadHumanUpcomingEventItems(deps, page.ownerId)
        : Promise.resolve(null),
    ]);

  return blocks.map((block) => {
    if (block.kind === "announcements" && announcementItems) {
      return {
        ...block,
        data: {
          ...toBlockData(block.data),
          dataSource: "announcements",
          announcements: announcementItems,
        },
      };
    }

    if (block.kind === "location_map" && place) {
      // Same already-redacted summary the public page renders — see the
      // matching comment in get-public-page. The owner's preview shows what a
      // stranger sees, which for a withheld venue is the point.
      return {
        ...block,
        data: {
          ...toBlockData(block.data),
          dataSource: "place",
          address:
            place.formattedAddress ?? place.areaLabel ?? formatPlaceRegion(place),
          lat: place.lat ?? undefined,
          lng: place.lng ?? undefined,
          isExact: place.locationIsExact !== false,
          hidden: place.locationHidden === true,
          radiusMeters: place.locationRadiusMeters ?? undefined,
        },
      };
    }

    if (block.kind === "shows" && upcomingShows) {
      return {
        ...block,
        data: { ...toBlockData(block.data), dataSource: "shows", events: upcomingShows },
      };
    }

    if (block.kind === "past_shows" && pastShows) {
      return {
        ...block,
        data: { ...toBlockData(block.data), dataSource: "shows", events: pastShows },
      };
    }

    if (block.kind === "upcoming_events" && humanUpcomingEventItems) {
      return {
        ...block,
        data: {
          ...toBlockData(block.data),
          // Same trusted marker as the `shows` derivation — the data comes
          // from the identical performances path (see get-public-page).
          dataSource: "shows",
          events: humanUpcomingEventItems,
        },
      };
    }

    if (block.kind === "stats" && statsBlockData) {
      return {
        ...block,
        data: { ...toBlockData(block.data), dataSource: "stats", ...statsBlockData },
      };
    }

    return block;
  });
}

async function loadHumanShows(
  deps: GetMyPageDeps,
  humanId: string,
  when: "upcoming" | "past",
): Promise<ReturnType<typeof toHumanShowSummary>[]> {
  const performances = await deps.repos.eventHumans.listPerformancesByHuman({
    humanId,
    roles: PUBLIC_LINEUP_ROLES,
    when,
    now: new Date(),
    limit: when === "past" ? PAST_SHOWS_LIMIT : undefined,
  });
  return performances.map(toHumanShowSummary);
}

async function loadAnnouncementItems(
  deps: GetMyPageDeps,
  page: PageForDerivedData,
): Promise<ReturnType<typeof toAnnouncementItem>[]> {
  if (page.ownerType === "ORGANIZATION") {
    const result = await deps.repos.announcements.listByOrg({
      orgId: page.ownerId,
      limit: DERIVED_ANNOUNCEMENT_LIMIT,
      offset: 0,
    });
    return result.items.map(toAnnouncementItem);
  }

  if (page.ownerType === "HUMAN") {
    const result = await deps.repos.announcements.listBySender({
      humanId: page.ownerId,
      limit: DERIVED_ANNOUNCEMENT_LIMIT,
      offset: 0,
    });
    return result.items.map(toAnnouncementItem);
  }

  return [];
}

function toAnnouncementItem(announcement: AnnouncementRecord) {
  return {
    id: announcement.id,
    title: announcement.subject,
    bodyHtml: sanitizeAnnouncementHtml(announcement.bodyHtml),
    date: (announcement.sentAt ?? announcement.createdAt).toISOString(),
  };
}

function toBlockData(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>) }
    : {};
}

function formatPlaceRegion(place: {
  city: string | null;
  region: string | null;
}): string | undefined {
  return [place.city, place.region].filter(Boolean).join(", ") || undefined;
}
