import "server-only";

import { cache } from "react";

import { getServerTrpcClient } from "@/server/trpc-client";

import { FALLBACK_SUPPORT_EMAIL } from "@/lib/support-email";

/**
 * Resolve the public support/contact email server-side via the public
 * `platform.getFooterDefaults` query. This is the same address rendered in
 * email footers (derived from the platform `supportEmail` setting).
 */
export const getSupportEmail = cache(async (): Promise<string> => {
  try {
    const client = getServerTrpcClient();
    const { contactEmail } = await client.platform.getFooterDefaults.query();
    const trimmed = contactEmail?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : FALLBACK_SUPPORT_EMAIL;
  } catch {
    return FALLBACK_SUPPORT_EMAIL;
  }
});
