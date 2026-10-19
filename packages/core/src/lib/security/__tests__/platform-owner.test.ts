import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PLATFORM_OWNER_HUMAN_IDS,
  isPlatformOwner,
  platformOwnerEnvironment,
  platformOwnerHumanId,
} from "../platform-owner";

// The dev seed's dev-login admin, READ from apps/api/src/scripts/seed/ids.ts
// (core cannot import the api app): if the seed id drifts, this fails.
const SEED_IDS = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../../apps/api/src/scripts/seed/ids.ts",
  ),
  "utf8",
);
const DEV_SEED_ADMIN = (() => {
  const m = /^\s*devUser:\s*"([0-9a-f-]{36})"/m.exec(SEED_IDS);
  if (!m?.[1]) throw new Error("DEMO_IDS.devUser not found in seed ids.ts");
  return m[1];
})();

describe("platform owner (R26)", () => {
  it("is the dev seed admin in development", () => {
    expect(platformOwnerHumanId("development")).toBe(DEV_SEED_ADMIN);
    expect(isPlatformOwner(DEV_SEED_ADMIN, "development")).toBe(true);
  });

  it("is nobody in production until the owner commits an id (fail closed)", () => {
    expect(PLATFORM_OWNER_HUMAN_IDS.production).toBeNull();
    expect(platformOwnerHumanId("production")).toBeNull();
    expect(isPlatformOwner(DEV_SEED_ADMIN, "production")).toBe(false);
  });

  it("refuses unknown environments and prototype keys", () => {
    for (const env of ["", "staging", "test", "toString", "__proto__"]) {
      expect(platformOwnerHumanId(env)).toBeNull();
      expect(isPlatformOwner(DEV_SEED_ADMIN, env)).toBe(false);
    }
  });

  it("refuses a missing or different human", () => {
    expect(isPlatformOwner(null, "development")).toBe(false);
    expect(isPlatformOwner(undefined, "development")).toBe(false);
    expect(isPlatformOwner("", "development")).toBe(false);
    expect(
      isPlatformOwner("00000000-0000-4000-8000-00000000d004", "development"),
    ).toBe(false);
  });

  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(PLATFORM_OWNER_HUMAN_IDS)).toBe(true);
  });

  it("reads the dev seed admin from the seed file, not a retyped copy", () => {
    expect(DEV_SEED_ADMIN).toMatch(/^[0-9a-f-]{36}$/);
    expect(PLATFORM_OWNER_HUMAN_IDS.development).toBe(DEV_SEED_ADMIN);
  });
});

describe("platformOwnerEnvironment (SENTRY_ENVIRONMENT gates self-approval)", () => {
  it("maps the two known values", () => {
    expect(
      platformOwnerEnvironment({ SENTRY_ENVIRONMENT: "development" }),
    ).toBe("development");
    expect(platformOwnerEnvironment({ SENTRY_ENVIRONMENT: "production" })).toBe(
      "production",
    );
  });

  it("is null when unset or empty (never defaults to development)", () => {
    expect(platformOwnerEnvironment({})).toBeNull();
    expect(platformOwnerEnvironment({ SENTRY_ENVIRONMENT: "" })).toBeNull();
    expect(platformOwnerEnvironment({ SENTRY_ENVIRONMENT: "   " })).toBeNull();
  });

  it("ignores NODE_ENV entirely", () => {
    expect(platformOwnerEnvironment({ NODE_ENV: "development" })).toBeNull();
    expect(platformOwnerEnvironment({ NODE_ENV: "production" })).toBeNull();
  });

  it("is null for staging and anything unknown", () => {
    for (const v of ["staging", "test", "Production", "dev", "prod"]) {
      expect(platformOwnerEnvironment({ SENTRY_ENVIRONMENT: v })).toBeNull();
    }
  });

  it("an unset variable grants nobody self-approval end to end", () => {
    const env = platformOwnerEnvironment({ NODE_ENV: "development" });
    expect(env).toBeNull();
    expect(isPlatformOwner(DEV_SEED_ADMIN, env ?? "")).toBe(false);
  });
});
