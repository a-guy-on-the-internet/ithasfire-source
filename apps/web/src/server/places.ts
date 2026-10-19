import "server-only";

import { cache } from "react";
import type { MetadataRoute } from "next";
import { TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@th/trpc";

import type {
  GetPlacePublicOutput,
  ResolvePlaceByIdOutput,
} from "@th/core/use-cases/places";

import type { ListPlaceEventsOutput } from "@th/core/use-cases/events";
import type { ListPlaceLineupHistoryOutput } from "@th/core/use-cases/place-reviews";

import { buildCanonicalUrl } from "@/config/site";
import { getServerTrpcClient } from "@/server/trpc-client";

const isNotFoundError = (
  error: unknown,
): error is TRPCClientError<AppRouter> => {
  if (!(error instanceof TRPCClientError)) {
    return false;
  }
  const code =
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data
      ? (error.data as { code?: string }).code
      : undefined;
  return code === "NOT_FOUND";
};

export const resolvePlaceById = cache(
  async (placeIdRaw: string): Promise<ResolvePlaceByIdOutput | null> => {
    const client = getServerTrpcClient();
    try {
      return await client.places.resolvePlaceById.query({
        placeId: placeIdRaw,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

export const loadPlacePublic = cache(
  async (placeId: string): Promise<GetPlacePublicOutput | null> => {
    const client = getServerTrpcClient();
    try {
      return await client.places.getPlacePublic.query({ placeId });
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

export type LoadPlaceEventsInput = {
  placeId: string;
  from: string | Date;
  to: string | Date;
  status: "upcoming" | "past";
  limit?: number;
  offset?: number;
};

export const loadPlaceEvents = cache(
  async (
    input: LoadPlaceEventsInput,
  ): Promise<ListPlaceEventsOutput | null> => {
    const client = getServerTrpcClient();

    const from = input.from instanceof Date ? input.from : new Date(input.from);
    const to = input.to instanceof Date ? input.to : new Date(input.to);

    try {
      return await client.places.listPlaceEvents.query({
        placeId: input.placeId,
        timeWindow: {
          from,
          to,
        },
        status: input.status,
        limit: input.limit,
        offset: input.offset,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

/**
 * Every act that has played a place — the Roster on `/p/[slug]/acts`
 * (venue-track-record-and-review-switch FR-016). `recentLimit: null` asks for
 * the whole set; `all` is what the page renders. Null for an unknown place,
 * the way the sibling public reads say it.
 */
export const loadPlaceLineupHistory = cache(
  async (placeId: string): Promise<ListPlaceLineupHistoryOutput | null> => {
    const client = getServerTrpcClient();
    try {
      return await client.places.getLineupHistory.query({
        placeId,
        recentLimit: null,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Sitemap
// ─────────────────────────────────────────────────────────────────────────────

type SitemapEntry = MetadataRoute.Sitemap[number];

const toDate = (value: string | null | undefined): Date | undefined => {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export const listPlaceSitemapEntries = cache(
  async (): Promise<SitemapEntry[]> => {
    const client = getServerTrpcClient();

    try {
      const payload = await client.places.listPlaceSitemapEntries.query({});
      return payload.map((item) => ({
        url: buildCanonicalUrl(`/places/id/${item.placeId}`),
        lastModified: toDate(item.updatedAt),
        changeFrequency: "weekly" as const,
        priority: 0.4,
      }));
    } catch (err) {
      if (isNotFoundError(err)) {
        return [];
      }
      throw err;
    }
  },
);
