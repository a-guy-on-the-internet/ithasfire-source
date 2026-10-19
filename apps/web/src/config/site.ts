import { publicRuntimeEnv } from "./env.public";

export const getSiteUrl = (): string =>
  publicRuntimeEnv.siteUrl ?? "http://localhost:3000";

export const getSiteName = (): string => publicRuntimeEnv.siteName;

export const buildCanonicalUrl = (path: string): string => {
  const base = getSiteUrl();
  const pathname = path.startsWith("/") ? path : `/${path}`;
  return new URL(pathname, `${base}/`).toString();
};
