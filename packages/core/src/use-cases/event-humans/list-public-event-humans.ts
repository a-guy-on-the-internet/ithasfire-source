import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { pickListenUrl, toMusicListenUrl } from "../../lib/embeds";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

const EVENT_HUMAN_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "OTHER",
] as const;

export const listPublicEventHumansInput = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const listPublicEventHumansOutput = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    role: z.enum(EVENT_HUMAN_ROLES),
    customRoleLabel: z.string().nullable(),
    profileUrl: z.string().nullable(),
    sortOrder: z.number().int(),
    /**
     * Playable music URL for the act, derived at read time from their PUBLIC
     * profile page's visible blocks (tracks → music → links priority), or —
     * for external entries — from `externalUrl` when it is a music-provider
     * iframe embed. URL only; the client re-derives embed attrs via
     * `parseEmbedUrl` (no raw iframe src crosses the wire).
     */
    listenUrl: z.string().nullable(),
  }),
);

export type ListPublicEventHumansInput = z.infer<
  typeof listPublicEventHumansInput
>;
export type ListPublicEventHumansOutput = z.infer<
  typeof listPublicEventHumansOutput
>;

export type ListPublicEventHumansDeps = {
  repos: Pick<Repos, "events" | "eventHumans" | "humans" | "entityPages">;
  logger?: LoggerPort;
};

/**
 * Public (unauthenticated) listing of event humans for a published event.
 *
 * Only returns records for published events. Resolves display names for
 * linked platform humans; falls back to `externalName`.
 */
export async function listPublicEventHumans(
  deps: ListPublicEventHumansDeps,
  rawInput: unknown,
): Promise<ListPublicEventHumansOutput> {
  const input = parseInput(listPublicEventHumansInput, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_PUBLISHED", { category: "NOT_FOUND" });
  }

  return buildPublicLineup(deps, event.id);
}

/**
 * The public lineup of an event — the projection behind
 * {@link listPublicEventHumans}, WITHOUT its published-event check. Exported
 * for the open-call page's "Booked so far" (open calls FR-003, Q29), which is
 * deliberately readable while the event is a draft; every caller owns its
 * own readability decision.
 */
export async function buildPublicLineup(
  deps: Pick<ListPublicEventHumansDeps, "repos">,
  eventId: string,
): Promise<ListPublicEventHumansOutput> {
  const allRecords = await deps.repos.eventHumans.listByEvent(eventId);
  // Volunteers (role="VOLUNTEER") are operational assignments, not part of
  // the public lineup. They live on EventHuman so the volunteer flow can
  // reuse the relation, but they MUST NOT surface on the public detail
  // page — and the public output schema intentionally omits the
  // "VOLUNTEER" enum member, so leaving them in would crash Zod.
  const records = allRecords.filter((r) => r.role !== "VOLUNTEER");
  if (records.length === 0) {
    return [];
  }

  // Resolve display names for linked humans in a single bulk query
  const linkedHumanIds = records
    .map((r) => r.humanId)
    .filter((id): id is string => id !== null);

  const humanNames = new Map<string, string>();
  if (linkedHumanIds.length > 0) {
    const humans = await deps.repos.humans.getByIds(linkedHumanIds);
    for (const human of humans) {
      if (human.name) {
        humanNames.set(human.id, human.name);
      }
    }
  }

  // Derive a playable "listen" URL per linked human from their PUBLIC profile
  // page's visible blocks (lineup-listen-embeds spec §3). Batched: exactly one
  // pages query + one blocks query regardless of lineup size. A missing page,
  // non-PUBLIC page, or page with nothing playable simply yields null — the
  // lineup itself never depends on this derivation succeeding.
  const listenUrls = await deriveListenUrls(deps, linkedHumanIds);

  const result = records.map((r) => {
    const resolvedName =
      (r.humanId && humanNames.get(r.humanId)) || r.externalName || "Unknown";

    // External entries (no linked human): the organizer-entered externalUrl
    // doubles as the listen URL iff it is a music-provider iframe embed —
    // same restriction as links-block candidates.
    const listenUrl = r.humanId
      ? (listenUrls.get(r.humanId) ?? null)
      : toMusicListenUrl(r.externalUrl);

    return {
      id: r.id,
      name: resolvedName,
      role: r.role,
      customRoleLabel: r.customRoleLabel ?? null,
      profileUrl: r.externalUrl,
      sortOrder: r.sortOrder,
      listenUrl,
    };
  });

  return listPublicEventHumansOutput.parse(result);
}

/** humanId → listen URL, for linked humans whose PUBLIC page yields one. */
async function deriveListenUrls(
  deps: Pick<ListPublicEventHumansDeps, "repos">,
  linkedHumanIds: string[],
): Promise<Map<string, string>> {
  const listenUrls = new Map<string, string>();
  if (linkedHumanIds.length === 0) return listenUrls;

  const pages = await deps.repos.entityPages.getByOwners(
    "HUMAN",
    linkedHumanIds,
  );
  // Only PUBLIC pages feed the public lineup — PRIVATE and UNLISTED pages
  // must not leak their curation onto event pages.
  const publicPages = pages.filter((page) => page.visibility === "PUBLIC");
  if (publicPages.length === 0) return listenUrls;

  const blocks = await deps.repos.entityPages.listBlocksByPageIds(
    publicPages.map((page) => page.id),
  );
  const blocksByPage = new Map<string, PageBlockRecord[]>();
  for (const block of blocks) {
    const list = blocksByPage.get(block.pageId);
    if (list) list.push(block);
    else blocksByPage.set(block.pageId, [block]);
  }

  for (const page of publicPages) {
    // Same visibility rule as get-public-page: only visible blocks render
    // publicly, so only visible blocks may contribute a listen URL.
    const visibleBlocks = (blocksByPage.get(page.id) ?? []).filter(
      (block) => block.visible,
    );
    const url = pickListenUrl(visibleBlocks);
    if (url) listenUrls.set(page.ownerId, url);
  }

  return listenUrls;
}
