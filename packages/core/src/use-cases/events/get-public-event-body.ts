import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import {
  canViewerReadEvent,
  eventNotFoundBySlug,
  type EventStaffReadProbe,
} from "./_shared/event-public-readability";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const getPublicEventBodyInputSchema = z
  .object({
    slug: z.string().trim().min(1).max(255),
    // Injected by the transport from the session, never taken from the
    // client (the router omits it from its public input).
    viewerHumanId: z.string().uuid().nullish(),
  })
  .strict();

/**
 * The body is opaque JSON (EventBody) — we intentionally use `z.unknown()`
 * so the transport layer doesn't need to know the internal structure.
 *
 * `imageMap` is a dictionary of image-id → publicUrl so the renderer can
 * resolve `<image>` blocks without a second round-trip.
 */
export const getPublicEventBodyOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    body: z.unknown().nullable(),
    imageMap: z.record(z.string(), z.string()),
  })
  .strict();

export type GetPublicEventBodyInput = z.infer<
  typeof getPublicEventBodyInputSchema
>;
export type GetPublicEventBodyOutput = z.infer<
  typeof getPublicEventBodyOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetPublicEventBodyDeps = {
  repos: Repos;
  /**
   * The staff probe behind a community moderator's read of a hidden
   * COMMUNITY listing.
   */
  authz: EventStaffReadProbe;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public use case: fetch the structured body content for a published event.
 *
 * Returns `{ eventId, body }` where body is the raw `EventBody` JSON
 * (or null if no body has been saved yet). Throws `not_found` for
 * missing/redirected slugs and non-published events — and, for an event the
 * viewer may not read (N3), exactly the unknown-slug error.
 */
export async function getPublicEventBody(
  deps: GetPublicEventBodyDeps,
  rawInput: unknown,
): Promise<GetPublicEventBodyOutput> {
  const input = parseInput(getPublicEventBodyInputSchema, rawInput);

  const resolution = await deps.repos.events.resolveBySlug(input.slug);
  if (!resolution) {
    throw eventNotFoundBySlug();
  }

  const event = await deps.repos.events.getById(resolution.eventId, {
    withOwnerStanding: true,
  });
  if (!event) {
    throw eventNotFoundBySlug();
  }

  // N3 BEFORE the redirect and status checks: for an event the caller may
  // not read, `EVENT_SLUG_REDIRECT` or `EVENT_NOT_PUBLISHED` would each say
  // "this slug is a real event". Such a caller gets the unknown-slug error.
  if (
    !(await canViewerReadEvent(
      deps.repos.authz,
      event,
      input.viewerHumanId,
      deps.repos.tickets,
      deps.authz,
    ))
  ) {
    throw eventNotFoundBySlug();
  }

  if (resolution.redirect) {
    throw fail("EVENT_SLUG_REDIRECT");
  }

  // Only serve body content for published events.
  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_PUBLISHED", { category: "NOT_FOUND" });
  }

  const body = await deps.repos.events.getContent({ eventId: event.id });

  // Resolve image URLs so the client can render image blocks without extra fetches.
  const imageMap = await resolveBodyImageMap(deps, event.id, body);

  deps.logger?.info("events.get_public_body", {
    slug: input.slug,
    eventId: event.id,
  });

  return getPublicEventBodyOutputSchema.parse({
    eventId: event.id,
    body: body ?? null,
    imageMap,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the body JSON to extract image asset IDs, then batch-resolve their
 * public URLs from the images repo.
 */
async function resolveBodyImageMap(
  deps: GetPublicEventBodyDeps,
  eventId: string,
  body: unknown,
): Promise<Record<string, string>> {
  if (!body || typeof body !== "object") return {};

  const imageIds = extractImageAssetIds(body);
  if (imageIds.length === 0) return {};

  const images = await deps.repos.images.resolveByIds(imageIds);
  const map: Record<string, string> = {};
  for (const img of images) {
    // Only include uploaded images that belong to this event.
    if (img.ownerId === eventId && img.uploadedAt) {
      map[img.id] = img.publicUrl;
    }
  }
  return map;
}

/**
 * Extract all `asset.assetId` values from image blocks found anywhere in the
 * body JSON.  Handles v1 (sections -> columns -> blocks) shape only.
 */
function extractImageAssetIds(body: unknown): string[] {
  const ids = new Set<string>();
  if (!body || typeof body !== "object") return [];

  const bodyObj = body as Record<string, unknown>;

  // v1: sections[].layout.columns[].blocks[]
  if (Array.isArray(bodyObj.sections)) {
    for (const section of bodyObj.sections) {
      const layout = (section as any)?.layout;
      const columns = Array.isArray(layout?.columns) ? layout.columns : [];
      for (const col of columns) {
        const blocks = Array.isArray(col?.blocks) ? col.blocks : [];
        for (const block of blocks) {
          collectImageId(block, ids);
        }
      }
    }
  }

  return [...ids];
}

function collectImageId(block: unknown, ids: Set<string>): void {
  if (!block || typeof block !== "object") return;
  const b = block as Record<string, unknown>;

  // v1 schema: { type: "image", asset: { assetId } }
  if (b.type === "image") {
    const asset = b.asset as Record<string, unknown> | undefined;
    if (asset?.assetId && typeof asset.assetId === "string") {
      ids.add(asset.assetId);
    }
    return;
  }

  // richText blocks contain a ProseMirror doc; walk it for imageBlock nodes.
  if (b.type === "richText" && b.doc && typeof b.doc === "object") {
    collectProseMirrorImageIds(b.doc, ids);
  }
}

/**
 * Recursively walk a ProseMirror JSON doc for `imageBlock` nodes and collect
 * their `attrs.imageId` values.
 */
function collectProseMirrorImageIds(node: unknown, ids: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;

  if (n.type === "imageBlock") {
    const attrs = n.attrs as Record<string, unknown> | undefined;
    if (attrs?.imageId && typeof attrs.imageId === "string") {
      ids.add(attrs.imageId);
    }
    return;
  }

  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      collectProseMirrorImageIds(child, ids);
    }
  }
}
