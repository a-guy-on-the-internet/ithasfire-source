import "server-only";

import { cache } from "react";
import { TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@th/trpc";
import type { GetPublicPageOutput } from "@th/core/use-cases/entity-pages";

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

export type EntityPageResult = {
  data: GetPublicPageOutput;
  /** When true the slug was historical; the caller should redirect to data.page.slug. */
  redirect: boolean;
};

/**
 * Load a public entity page by slug.
 * Returns null for not-found or private pages.
 * Includes a `redirect` flag when the slug was resolved from history.
 */
export const loadEntityPageBySlug = cache(
  async (slug: string): Promise<EntityPageResult | null> => {
    const client = getServerTrpcClient();
    try {
      const data = await client.entityPages.getBySlug.query({ slug });
      return { data, redirect: data.redirect === true };
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  },
);
