import { describe, expect, it } from "vitest";

import manifestJson from "../../jobs.manifest.json";
import {
  checkScheduledEntryFields,
  SCHEDULED_ENTRY_KEYS,
} from "../scripts/scheduled-entry-fields";

/**
 * The test-suite half of validate-manifest's field check. `generated-jobs.tf`
 * reads `retry` as `try(cfg.retry, true)`, so a misspelt key or a non-boolean
 * value would leave retries ON for a job marked unsafe to run twice at once.
 */

const base = {
  description: "x",
  cron: "*/30 * * * *",
  timezone: "Etc/UTC",
};

describe("checkScheduledEntryFields", () => {
  it("accepts an entry without retry, and retry true or false", () => {
    expect(checkScheduledEntryFields("a.b", base)).toEqual([]);
    expect(checkScheduledEntryFields("a.b", { ...base, retry: true })).toEqual(
      [],
    );
    expect(
      checkScheduledEntryFields("a.b", { ...base, retry: false }),
    ).toEqual([]);
  });

  it.each([["false"], [0], [null], [{}]])(
    "rejects retry %j (not a boolean)",
    (retry) => {
      const errors = checkScheduledEntryFields("a.b", { ...base, retry });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('"a.b" has retry');
    },
  );

  it("rejects a misspelt key that Terraform would silently ignore", () => {
    const errors = checkScheduledEntryFields("a.b", {
      ...base,
      retries: false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown key "retries"');
  });

  it("rejects a non-object entry", () => {
    expect(checkScheduledEntryFields("a.b", "nope")).toHaveLength(1);
  });

  it("passes every committed scheduled entry", () => {
    const scheduled = manifestJson.scheduled as Record<string, unknown>;
    // Guard against a vacuous pass on a moved or emptied manifest.
    expect(Object.keys(scheduled).length).toBeGreaterThan(10);
    const errors = Object.entries(scheduled).flatMap(([name, entry]) =>
      checkScheduledEntryFields(name, entry),
    );
    expect(errors).toEqual([]);
  });

  it("knows the retry key", () => {
    expect(SCHEDULED_ENTRY_KEYS.has("retry")).toBe(true);
  });
});
