const normalize = (value: string | undefined | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : null;
};

const DEFAULT_API_BASE_URL = "http://localhost:3001";
const DEFAULT_WEB_BASE_URL = "http://localhost:3000";

// Direct `process.env.EXPO_PUBLIC_*` references, read once at module scope.
// `babel-preset-expo` inlines only that literal form at bundle time. The old
// `readEnv()` helper went through `globalThis.process.env`, which stays a
// runtime read: on Hermes in an EAS build it is `undefined`, so both URLs
// silently fell back to localhost. Same trap as apps/scanner/src/config/api.ts.
const ENV_API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
const ENV_WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_BASE_URL;

export const getApiBaseUrl = (): string =>
  normalize(ENV_API_BASE_URL) ?? DEFAULT_API_BASE_URL;

export const getWebBaseUrl = (): string =>
  normalize(ENV_WEB_BASE_URL) ?? DEFAULT_WEB_BASE_URL;

export const getTrpcHttpUrl = (): string => `${getApiBaseUrl()}/trpc`;
