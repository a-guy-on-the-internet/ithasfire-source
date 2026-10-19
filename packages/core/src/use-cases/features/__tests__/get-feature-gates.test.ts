import { describe, it, expect, vi } from "vitest";
import {
  getFeatureGates,
  featureGatesSchema,
  getFeatureGatesOutputSchema,
} from "../get-feature-gates";
import {
  FEATURE_GATE_SLUGS,
  FEATURE_GATE_SETTING_KEYS,
} from "@th/types/repos/platform-settings";
import type { RoutingPort } from "@th/ports/routing.port";
import type { PlatformSettingsRepo } from "@th/ports/repos/platform-settings";

// The schema keys, the admin-toggle slug tuple and the `feature:<slug>`
// setting-key tuple are three hand-maintained lists of the same thing (see the
// "KEEP IN SYNC" note on `featureGatesSchema`). A slug missing from the tuples
// can't be toggled from the platform admin UI and throws "Invalid option:
// expected one of …", so assert the three agree instead of trusting a comment.
describe("feature gate registries stay in sync", () => {
  it("featureGatesSchema keys match FEATURE_GATE_SLUGS", () => {
    expect([...FEATURE_GATE_SLUGS].sort()).toEqual(
      Object.keys(featureGatesSchema.shape).sort(),
    );
  });

  it("FEATURE_GATE_SETTING_KEYS is FEATURE_GATE_SLUGS prefixed with 'feature:'", () => {
    expect([...FEATURE_GATE_SETTING_KEYS]).toEqual(
      FEATURE_GATE_SLUGS.map((slug) => `feature:${slug}`),
    );
  });

  it("includes the waitlists gate", () => {
    expect(FEATURE_GATE_SLUGS).toContain("waitlists");
  });

  it("includes the arrivalAreas gate", () => {
    expect(FEATURE_GATE_SLUGS).toContain("arrivalAreas");
    expect(FEATURE_GATE_SETTING_KEYS).toContain("feature:arrivalAreas");
  });

  // The FOURTH hand-maintained list is the explicit `return { … }` block in the
  // DB-override branch. A gate added to the schema and both tuples but
  // forgotten there passes all three assertions above while its admin toggle
  // silently does nothing — the row is written, `getAll()` returns it, and the
  // resolved value still comes from the env default. Drive every slug through
  // a real DB override to close that hole.
  it.each(FEATURE_GATE_SLUGS.map((slug) => [slug] as const))(
    "honours a DB override for `%s` (proves it is wired in the override block)",
    async (slug) => {
      const platformSettings: PlatformSettingsRepo = {
        get: vi.fn().mockResolvedValue(null),
        getAll: vi.fn().mockResolvedValue([
          {
            key: `feature:${slug}`,
            value: "true",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        upsert: vi.fn(),
      };

      // No env deps at all: every gate's env default is false EXCEPT
      // createEvents/buyTickets/promos, so assert on the override direction
      // that is meaningful for each.
      const onByDefault = new Set(["createEvents", "buyTickets", "promos"]);
      if (onByDefault.has(slug)) {
        // Already true from the env default — flip the DB row to "false" so the
        // assertion can only pass if the override block reads this key.
        (platformSettings.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(
          [
            {
              key: `feature:${slug}`,
              value: "false",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        );
        const result = await getFeatureGates({ platformSettings });
        expect(result[slug]).toBe(false);
        return;
      }

      const result = await getFeatureGates({ platformSettings });
      expect(result[slug]).toBe(true);
    },
  );
});

describe("getFeatureGates", () => {
  const fakeRouting: RoutingPort = {
    getRoute: async () => null,
    health: async () => ({ ok: false }),
  };

  // ── travelTime gate ────────────────────────────────────────────────────

  it("returns travelTime: true when routing adapter is present", async () => {
    const result = await getFeatureGates({ routing: fakeRouting });
    expect(result).toMatchObject({ travelTime: true });
  });

  it("returns travelTime: false when routing is null", async () => {
    const result = await getFeatureGates({ routing: null });
    expect(result).toMatchObject({ travelTime: false });
  });

  it("returns travelTime: false when routing is undefined", async () => {
    const result = await getFeatureGates({ routing: undefined });
    expect(result).toMatchObject({ travelTime: false });
  });

  it("returns travelTime: false when deps has no routing key", async () => {
    const result = await getFeatureGates({});
    expect(result).toMatchObject({ travelTime: false });
  });

  // ── createEvents gate ──────────────────────────────────────────────────

  it("returns createEvents: true by default", async () => {
    const result = await getFeatureGates({});
    expect(result.createEvents).toBe(true);
  });

  it("returns createEvents: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableCreateEvents: true });
    expect(result.createEvents).toBe(true);
  });

  it("returns createEvents: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableCreateEvents: false });
    expect(result.createEvents).toBe(false);
  });

  // ── buyTickets gate ────────────────────────────────────────────────────

  it("returns buyTickets: true by default", async () => {
    const result = await getFeatureGates({});
    expect(result.buyTickets).toBe(true);
  });

  it("returns buyTickets: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableBuyTickets: true });
    expect(result.buyTickets).toBe(true);
  });

  it("returns buyTickets: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableBuyTickets: false });
    expect(result.buyTickets).toBe(false);
  });

  // ── promos gate ────────────────────────────────────────────────────────

  it("returns promos: true by default", async () => {
    const result = await getFeatureGates({});
    expect(result.promos).toBe(true);
  });

  it("returns promos: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enablePromos: true });
    expect(result.promos).toBe(true);
  });

  it("returns promos: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enablePromos: false });
    expect(result.promos).toBe(false);
  });

  // ── maintenanceMode gate ───────────────────────────────────────────────

  it("returns maintenanceMode: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.maintenanceMode).toBe(false);
  });

  it("returns maintenanceMode: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableMaintenanceMode: true });
    expect(result.maintenanceMode).toBe(true);
  });

  it("returns maintenanceMode: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableMaintenanceMode: false });
    expect(result.maintenanceMode).toBe(false);
  });

  // ── unifiedScanResolver gate ─────────────────────────────

  it("returns unifiedScanResolver: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.unifiedScanResolver).toBe(false);
  });

  it("returns unifiedScanResolver: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableUnifiedScanResolver: true });
    expect(result.unifiedScanResolver).toBe(true);
  });

  it("returns unifiedScanResolver: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableUnifiedScanResolver: false });
    expect(result.unifiedScanResolver).toBe(false);
  });

  // ── waivers gate ───────────────────────────────────────────────────────

  it("returns waivers: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.waivers).toBe(false);
  });

  it("returns waivers: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableWaivers: true });
    expect(result.waivers).toBe(true);
  });

  it("returns waivers: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableWaivers: false });
    expect(result.waivers).toBe(false);
  });

  // ── entityPageEditor gate ──────────────────────────────────────────────

  it("returns entityPageEditor: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.entityPageEditor).toBe(false);
  });

  it("returns entityPageEditor: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableEntityPageEditor: true });
    expect(result.entityPageEditor).toBe(true);
  });

  it("returns entityPageEditor: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableEntityPageEditor: false });
    expect(result.entityPageEditor).toBe(false);
  });

  // ── broadcasts gate ────────────────────────────────────────────────────

  it("returns broadcasts: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.broadcasts).toBe(false);
  });

  it("returns broadcasts: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableBroadcasts: true });
    expect(result.broadcasts).toBe(true);
  });

  it("returns broadcasts: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableBroadcasts: false });
    expect(result.broadcasts).toBe(false);
  });

  // ── resale gate ────────────────────────────────────────────────────────

  it("returns resale: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.resale).toBe(false);
  });

  it("returns resale: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableResale: true });
    expect(result.resale).toBe(true);
  });

  it("returns resale: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableResale: false });
    expect(result.resale).toBe(false);
  });

  // ── humanProfilesPublic gate ───────────────────────────────────────────

  it("returns humanProfilesPublic: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.humanProfilesPublic).toBe(false);
  });

  it("returns humanProfilesPublic: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableHumanProfilesPublic: true });
    expect(result.humanProfilesPublic).toBe(true);
  });

  it("returns humanProfilesPublic: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableHumanProfilesPublic: false });
    expect(result.humanProfilesPublic).toBe(false);
  });

  // ── waitlists gate ─────────────────────────────────────────────────────

  it("returns waitlists: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.waitlists).toBe(false);
  });

  it("returns waitlists: true when explicitly enabled", async () => {
    const result = await getFeatureGates({ enableWaitlists: true });
    expect(result.waitlists).toBe(true);
  });

  it("returns waitlists: false when explicitly disabled", async () => {
    const result = await getFeatureGates({ enableWaitlists: false });
    expect(result.waitlists).toBe(false);
  });

  // ── arrivalAreas gate ──────────────────────────────────────────────────
  // No env flag (like seatingLayouts): off until a platform admin turns it on.

  it("returns arrivalAreas: false by default", async () => {
    const result = await getFeatureGates({});
    expect(result.arrivalAreas).toBe(false);
  });

  // ── combined (env only) ────────────────────────────────────────────────

  it("returns all gates correctly when fully configured (env only)", async () => {
    const result = await getFeatureGates({
      routing: fakeRouting,
      enableCreateEvents: false,
      enableBuyTickets: false,
      enablePromos: false,
      enableMaintenanceMode: true,
      enableUnifiedScanResolver: true,
      enableEntityPageEditor: true,
      enableBroadcasts: true,
      enableResale: true,
      enableHumanProfilesPublic: true,
      enableWaitlists: true,
    });
    expect(result).toEqual({
      travelTime: true,
      createEvents: false,
      buyTickets: false,
      promos: false,
      maintenanceMode: true,
      seatingLayouts: false,
      unifiedScanResolver: true,
      waivers: false,
      entityPageEditor: true,
      broadcasts: true,
      resale: true,
      humanProfilesPublic: true,
      waitlists: true,
      arrivalAreas: false,
      sms: false,
    });
  });

  // ── sms capability ─────────────────────────────────────────────────────
  // A capability, not a gate: derived from whether the API holds an SMS
  // adapter, never stored, never toggled from /platform.

  it("returns sms: true when the API holds an SMS adapter", async () => {
    const result = await getFeatureGates({ smsConfigured: true });
    expect(result.sms).toBe(true);
  });

  it("returns sms: false when the API has no SMS adapter", async () => {
    const result = await getFeatureGates({ smsConfigured: false });
    expect(result.sms).toBe(false);
  });

  it("returns sms: false when omitted (fail closed)", async () => {
    const result = await getFeatureGates({});
    expect(result.sms).toBe(false);
  });

  it("sms is not an admin-toggleable gate", () => {
    expect(FEATURE_GATE_SLUGS).not.toContain("sms");
    expect(FEATURE_GATE_SETTING_KEYS).not.toContain("feature:sms");
    expect(Object.keys(featureGatesSchema.shape)).not.toContain("sms");
  });

  it("a `feature:sms` DB row cannot claim SMS works", async () => {
    const platformSettings: PlatformSettingsRepo = {
      get: vi.fn().mockResolvedValue(null),
      getAll: vi.fn().mockResolvedValue([
        { key: "feature:sms", value: "true", createdAt: new Date(), updatedAt: new Date() },
        { key: "feature:promos", value: "false", createdAt: new Date(), updatedAt: new Date() },
      ]),
      upsert: vi.fn(),
    };
    const result = await getFeatureGates({
      platformSettings,
      smsConfigured: false,
    });
    expect(result.sms).toBe(false);
    // the override branch did run
    expect(result.promos).toBe(false);
  });

  it("keeps the capability when the settings read fails", async () => {
    const platformSettings: PlatformSettingsRepo = {
      get: vi.fn().mockResolvedValue(null),
      getAll: vi.fn().mockRejectedValue(new Error("db down")),
      upsert: vi.fn(),
    };
    const result = await getFeatureGates({
      platformSettings,
      smsConfigured: true,
    });
    expect(result.sms).toBe(true);
  });

  it("the output schema requires sms (the router would otherwise strip or reject it)", () => {
    expect(
      getFeatureGatesOutputSchema.safeParse({
        ...featureGatesSchema.parse(
          Object.fromEntries(FEATURE_GATE_SLUGS.map((s) => [s, false])),
        ),
      }).success,
    ).toBe(false);
  });

  // ── DB overrides ───────────────────────────────────────────────────────

  describe("DB overrides", () => {
    const makePlatformSettings = (
      rows: Array<{ key: string; value: string }>,
    ): PlatformSettingsRepo => ({
      get: vi.fn().mockResolvedValue(null),
      getAll: vi
        .fn()
        .mockResolvedValue(
          rows.map((r) => ({
            key: r.key,
            value: r.value,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        ),
      upsert: vi
        .fn()
        .mockResolvedValue({
          key: "",
          value: "",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
    });

    it("overrides env default with DB 'true'", async () => {
      const ps = makePlatformSettings([
        { key: "feature:promos", value: "true" },
      ]);
      const result = await getFeatureGates({
        enablePromos: false,
        platformSettings: ps,
      });
      expect(result.promos).toBe(true);
    });

    it("overrides env default with DB 'false'", async () => {
      const ps = makePlatformSettings([
        { key: "feature:createEvents", value: "false" },
      ]);
      const result = await getFeatureGates({
        enableCreateEvents: true,
        platformSettings: ps,
      });
      expect(result.createEvents).toBe(false);
    });

    it("overrides unifiedScanResolver via DB", async () => {
      const ps = makePlatformSettings([
        { key: "feature:unifiedScanResolver", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableUnifiedScanResolver: false,
        platformSettings: ps,
      });
      expect(result.unifiedScanResolver).toBe(true);
    });

    it("overrides entityPageEditor via DB", async () => {
      const ps = makePlatformSettings([
        { key: "feature:entityPageEditor", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableEntityPageEditor: false,
        platformSettings: ps,
      });
      expect(result.entityPageEditor).toBe(true);
    });

    it("overrides broadcasts via DB", async () => {
      const ps = makePlatformSettings([
        { key: "feature:broadcasts", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableBroadcasts: false,
        platformSettings: ps,
      });
      expect(result.broadcasts).toBe(true);
    });

    it("overrides resale via DB", async () => {
      const ps = makePlatformSettings([
        { key: "feature:resale", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableResale: false,
        platformSettings: ps,
      });
      expect(result.resale).toBe(true);
    });

    it("overrides humanProfilesPublic via DB (env off → DB true)", async () => {
      const ps = makePlatformSettings([
        { key: "feature:humanProfilesPublic", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableHumanProfilesPublic: false,
        platformSettings: ps,
      });
      expect(result.humanProfilesPublic).toBe(true);
    });

    it("overrides humanProfilesPublic via DB (env on → DB false)", async () => {
      const ps = makePlatformSettings([
        { key: "feature:humanProfilesPublic", value: "false" },
      ]);
      const result = await getFeatureGates({
        enableHumanProfilesPublic: true,
        platformSettings: ps,
      });
      expect(result.humanProfilesPublic).toBe(false);
    });

    it("overrides waitlists via DB (env off → DB true)", async () => {
      const ps = makePlatformSettings([
        { key: "feature:waitlists", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableWaitlists: false,
        platformSettings: ps,
      });
      expect(result.waitlists).toBe(true);
    });

    it("overrides waitlists via DB (env on → DB false)", async () => {
      const ps = makePlatformSettings([
        { key: "feature:waitlists", value: "false" },
      ]);
      const result = await getFeatureGates({
        enableWaitlists: true,
        platformSettings: ps,
      });
      expect(result.waitlists).toBe(false);
    });

    it("keeps waitlists fail-closed when other feature rows exist", async () => {
      // A populated `feature:*` map with no `waitlists` row must NOT flip the
      // gate on — the env default (false) has to survive the DB merge.
      const ps = makePlatformSettings([
        { key: "feature:promos", value: "true" },
      ]);
      const result = await getFeatureGates({ platformSettings: ps });
      expect(result.waitlists).toBe(false);
    });

    it("turns arrivalAreas on via DB", async () => {
      const ps = makePlatformSettings([
        { key: "feature:arrivalAreas", value: "true" },
      ]);
      const result = await getFeatureGates({ platformSettings: ps });
      expect(result.arrivalAreas).toBe(true);
    });

    it("keeps arrivalAreas off when other feature rows exist", async () => {
      const ps = makePlatformSettings([
        { key: "feature:promos", value: "true" },
      ]);
      const result = await getFeatureGates({ platformSettings: ps });
      expect(result.arrivalAreas).toBe(false);
    });

    it("falls back to env default when DB key is absent", async () => {
      const ps = makePlatformSettings([
        { key: "feature:promos", value: "true" },
      ]);
      const result = await getFeatureGates({
        enableCreateEvents: false,
        platformSettings: ps,
      });
      // createEvents has no DB row → falls back to env (false)
      expect(result.createEvents).toBe(false);
      // promos has DB row → overridden to true
      expect(result.promos).toBe(true);
    });

    it("ignores non-feature keys from DB", async () => {
      const ps = makePlatformSettings([
        { key: "supportEmail", value: "test@example.com" },
        { key: "feature:buyTickets", value: "false" },
      ]);
      const result = await getFeatureGates({
        enableBuyTickets: true,
        platformSettings: ps,
      });
      expect(result.buyTickets).toBe(false);
    });

    it("returns env defaults when DB has no feature keys", async () => {
      const ps = makePlatformSettings([
        { key: "supportEmail", value: "x@y.com" },
      ]);
      const result = await getFeatureGates({
        enableBuyTickets: false,
        platformSettings: ps,
      });
      expect(result.buyTickets).toBe(false);
    });

    it("ignores malformed DB values (not 'true'/'false')", async () => {
      const ps = makePlatformSettings([
        { key: "feature:promos", value: "yes" },
      ]);
      const result = await getFeatureGates({
        enablePromos: false,
        platformSettings: ps,
      });
      // "yes" is not "true"/"false" → parseBoolOverride returns undefined → env default wins
      expect(result.promos).toBe(false);
    });

    it("falls back to env defaults when DB read throws", async () => {
      const ps: PlatformSettingsRepo = {
        get: vi.fn().mockRejectedValue(new Error("DB down")),
        getAll: vi.fn().mockRejectedValue(new Error("DB down")),
        upsert: vi.fn().mockRejectedValue(new Error("DB down")),
      };
      const result = await getFeatureGates({
        enableCreateEvents: false,
        enablePromos: false,
        platformSettings: ps,
      });
      expect(result.createEvents).toBe(false);
      expect(result.promos).toBe(false);
      expect(result.buyTickets).toBe(true); // default
    });

    it("returns env defaults when platformSettings is null", async () => {
      const result = await getFeatureGates({
        enablePromos: false,
        platformSettings: null,
      });
      expect(result.promos).toBe(false);
    });
  });

  // ── swallowed DB-read failure reporting ──────────────────────────────────
  // The env-defaults fallback keeps gates resolving, but broadcasts/resale are
  // FAIL-CLOSED — without the reporter a persistent settings outage would
  // silently hide admin surfaces (cf. the 2026-06 silent-search outage).
  describe("swallowed DB-read failure reporting", () => {
    const throwingSettings = (): PlatformSettingsRepo => ({
      get: vi.fn().mockRejectedValue(new Error("DB down")),
      getAll: vi.fn().mockRejectedValue(new Error("DB down")),
      upsert: vi.fn().mockRejectedValue(new Error("DB down")),
    });

    it("reports the underlying error and still returns env defaults", async () => {
      const dbError = new Error("DB down");
      const ps: PlatformSettingsRepo = {
        get: vi.fn().mockRejectedValue(dbError),
        getAll: vi.fn().mockRejectedValue(dbError),
        upsert: vi.fn().mockRejectedValue(dbError),
      };
      const reportError = vi.fn();

      const result = await getFeatureGates({
        enableBroadcasts: false,
        platformSettings: ps,
        reportError,
      });

      // Fail-closed fallback preserved.
      expect(result.broadcasts).toBe(false);
      expect(result.buyTickets).toBe(true);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(dbError, {
        tags: { useCase: "get-feature-gates" },
        extra: { stage: "platform-settings-read" },
      });
    });

    it("still returns env defaults when reportError is not wired", async () => {
      const result = await getFeatureGates({
        enablePromos: false,
        platformSettings: throwingSettings(),
      });

      expect(result.promos).toBe(false);
      expect(result.buyTickets).toBe(true);
    });

    it("a throwing reporter never breaks the env-defaults fallback", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });

      await expect(
        getFeatureGates({
          enableResale: false,
          platformSettings: throwingSettings(),
          reportError,
        }),
      ).resolves.toMatchObject({ resale: false, buyTickets: true });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const ps: PlatformSettingsRepo = {
        get: vi.fn().mockResolvedValue(null),
        getAll: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({
          key: "",
          value: "",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };
      const reportError = vi.fn();

      await getFeatureGates({ platformSettings: ps, reportError });

      expect(reportError).not.toHaveBeenCalled();
    });
  });
});
