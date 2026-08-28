import Constants from "expo-constants";

type RecordedChannel = "pilot" | "preview" | "production";

const readEnv = (key: string): string | undefined => {
  const envSource = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return envSource.process?.env?.[key];
};

/**
 * Best-effort runtime version. Falls back to `0.0.0` so we can still satisfy
 * the bootstrap-telemetry contract on dev devices that have no embedded
 * version metadata.
 */
export const getAppVersion = (): string => {
  const fromExpo = Constants.expoConfig?.version;
  if (typeof fromExpo === "string" && fromExpo.length > 0) {
    return fromExpo;
  }
  return "0.0.0";
};

/**
 * Display label for the runtime channel. May return `dev` for local builds
 * outside the pilot/preview/production rollout pipeline.
 */
export const getChannelLabel = (): string => {
  const fromEnv = readEnv("EXPO_PUBLIC_RELEASE_CHANNEL");
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return "dev";
};

/**
 * The channel value sent to `scanner.recordBootstrap`. The use case enum is
 * narrow ({pilot, preview, production}), so dev/local builds are reported as
 * `preview` to avoid lying about pilot/production rollout.
 */
export const getRecordedChannel = (): RecordedChannel => {
  const label = getChannelLabel().toLowerCase();
  if (label === "pilot" || label === "preview" || label === "production") {
    return label;
  }
  return "preview";
};
