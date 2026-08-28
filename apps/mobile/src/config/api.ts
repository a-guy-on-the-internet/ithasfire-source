const normalize = (value: string | undefined | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : null;
};

const DEFAULT_API_BASE_URL = "http://localhost:3001";
const DEFAULT_WEB_BASE_URL = "http://localhost:3000";

interface ExpoProcessEnv {
  EXPO_PUBLIC_API_BASE_URL?: string;
  EXPO_PUBLIC_WEB_BASE_URL?: string;
}

const readEnv = (): ExpoProcessEnv | undefined => {
  const envSource = globalThis as typeof globalThis & {
    process?: { env?: ExpoProcessEnv };
  };
  return envSource.process?.env;
};

export const getApiBaseUrl = (): string =>
  normalize(readEnv()?.EXPO_PUBLIC_API_BASE_URL) ?? DEFAULT_API_BASE_URL;

export const getWebBaseUrl = (): string =>
  normalize(readEnv()?.EXPO_PUBLIC_WEB_BASE_URL) ?? DEFAULT_WEB_BASE_URL;

export const getTrpcHttpUrl = (): string => `${getApiBaseUrl()}/trpc`;
