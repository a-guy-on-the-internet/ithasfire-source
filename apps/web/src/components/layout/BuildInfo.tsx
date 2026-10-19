"use client";

import { publicRuntimeEnv } from "@/config/env.public";

/**
 * Tiny build-metadata badge rendered in the site footer.
 *
 * Shows: `v0.1.0 · 43adb38`  (version + short SHA)
 * Falls back to "local" when values aren't baked in (dev mode).
 */
export function BuildInfo() {
  const version = publicRuntimeEnv.appVersion;
  const sha = publicRuntimeEnv.buildSha;

  const label = [version ? `v${version}` : "v0.1.0", sha ?? "local"].join(
    " \u00b7 ",
  ); // middle-dot separator

  return (
    <span
      style={{
        fontSize: 10,
        letterSpacing: 0.5,
        opacity: 0.5,
        lineHeight: 1.4,
        userSelect: "all",
      }}
      title={`Build: ${sha ?? "local"}`}
    >
      {label}
    </span>
  );
}
