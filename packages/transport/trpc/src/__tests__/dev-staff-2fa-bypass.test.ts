import { describe, expect, it } from "vitest";

import { resolveStaffSecondFactorBypass } from "../dev-staff-2fa-bypass";

/**
 * The one decision behind `staffSecondFactorBypassEnabled`, which the API
 * composition root hands to the authz adapter and the two status probes read.
 * With it on, every staff role check stops asking for a second factor, so it
 * is an allowlist: not on Cloud Run (`K_SERVICE`), `NODE_ENV` unset, empty,
 * or exactly `development` or `test`, and the flag set. Unset counts as local
 * (the local API and the e2e job run without one); the deployed images set
 * `production` and run on Cloud Run, so they are refused twice over.
 */

const ON_FLAGS = ["true", "1"] as const;
const OFF_FLAGS = ["false", "0", "", "TRUE", "yes", undefined] as const;

/** Every `NODE_ENV` in the table, allowed or not. */
const NODE_ENVS = [
  [undefined, true],
  ["", true],
  ["staging", false],
  ["production", false],
  ["Production", false],
  ["prod", false],
  ["dev", false],
  ["DEVELOPMENT", false],
  ["development", true],
  ["test", true],
] as const;

describe("resolveStaffSecondFactorBypass", () => {
  describe.each(NODE_ENVS)("NODE_ENV=%s", (nodeEnv, allowed) => {
    it.each(ON_FLAGS)(
      `is ${allowed ? "on" : "off"} off Cloud Run with DEV_BYPASS_STAFF_2FA=%s`,
      (flag) => {
        expect(
          resolveStaffSecondFactorBypass({
            NODE_ENV: nodeEnv,
            DEV_BYPASS_STAFF_2FA: flag,
          }),
        ).toBe(allowed);
      },
    );

    it.each(ON_FLAGS)(
      "is off on Cloud Run (K_SERVICE set) with DEV_BYPASS_STAFF_2FA=%s",
      (flag) => {
        expect(
          resolveStaffSecondFactorBypass({
            NODE_ENV: nodeEnv,
            DEV_BYPASS_STAFF_2FA: flag,
            K_SERVICE: "hf-dev-api",
          }),
        ).toBe(false);
      },
    );

    it.each(OFF_FLAGS)(
      "is off without the flag (DEV_BYPASS_STAFF_2FA=%s), on or off Cloud Run",
      (flag) => {
        expect(
          resolveStaffSecondFactorBypass({
            NODE_ENV: nodeEnv,
            DEV_BYPASS_STAFF_2FA: flag,
          }),
        ).toBe(false);
        expect(
          resolveStaffSecondFactorBypass({
            NODE_ENV: nodeEnv,
            DEV_BYPASS_STAFF_2FA: flag,
            K_SERVICE: "hf-dev-api",
          }),
        ).toBe(false);
      },
    );
  });

  // A Cloud Run job execution sets CLOUD_RUN_JOB, not K_SERVICE.
  it.each([undefined, "", "development", "test"])(
    "is off in a Cloud Run job (CLOUD_RUN_JOB set) with NODE_ENV=%s",
    (nodeEnv) => {
      expect(
        resolveStaffSecondFactorBypass({
          NODE_ENV: nodeEnv,
          DEV_BYPASS_STAFF_2FA: "true",
          CLOUD_RUN_JOB: "hf-dev-backup",
        }),
      ).toBe(false);
    },
  );

  // An empty K_SERVICE is "not on Cloud Run", the same reading
  // `shouldBlockOnDrift` gives it.
  it("treats an empty K_SERVICE as not set", () => {
    expect(
      resolveStaffSecondFactorBypass({
        NODE_ENV: "development",
        DEV_BYPASS_STAFF_2FA: "true",
        K_SERVICE: "",
      }),
    ).toBe(true);
  });
});
