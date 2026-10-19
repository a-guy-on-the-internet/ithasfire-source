import { requireEnv, serverRuntimeEnv } from "./env";

const normalizeSegment = (value: string): string =>
  value.replace(/^\/+|\/+$/g, "");

export const getApiBaseUrl = (): string =>
  requireEnv(
    serverRuntimeEnv.apiBaseUrl,
    "WEB_API_BASE_URL (or API_BASE_URL / NEXT_PUBLIC_API_BASE_URL) must be configured for server data access",
  );

export const getEventDetailsUrl = (slug: string): string => {
  const base = getApiBaseUrl();
  const eventResourcePath = serverRuntimeEnv.eventResourcePath;
  const normalizedSlug = normalizeSegment(slug);
  return `${base}${eventResourcePath}/${normalizedSlug}`;
};

export const getEventCollectionUrl = (): string => {
  const base = getApiBaseUrl();
  const eventResourcePath = serverRuntimeEnv.eventResourcePath;
  return `${base}${eventResourcePath}`;
};
