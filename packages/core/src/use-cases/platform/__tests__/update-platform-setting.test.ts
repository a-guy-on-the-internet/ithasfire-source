import { describe, expect, it, vi } from "vitest";

import { updatePlatformSetting } from "../update-platform-setting";
import type { UpdatePlatformSettingDeps } from "../update-platform-setting";
import type { PlatformSettingRecord } from "@th/types/repos/platform-settings";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const NOW = new Date("2026-04-13T12:00:00Z");

function makeSetting(
  overrides: Partial<PlatformSettingRecord> = {},
): PlatformSettingRecord {
  return {
    key: "homepage:heroStyle",
    value: "map",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    allowed?: boolean;
    upsertResult?: PlatformSettingRecord;
  } = {},
): UpdatePlatformSettingDeps {
  const allowed = overrides.allowed ?? true;
  const upsertResult = overrides.upsertResult ?? makeSetting();

  const platformSettings = {
    upsert: vi.fn(async () => upsertResult),
  };
  const audit = {
    log: vi.fn(),
  };

  return {
    repos: {
      platformSettings,
      audit,
      tx: vi.fn(async (fn: any) => fn({ platformSettings, audit })),
    } as unknown as UpdatePlatformSettingDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as UpdatePlatformSettingDeps["authz"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("updatePlatformSetting", () => {
  it("sets homepage:heroStyle to 'map' (happy path)", async () => {
    const deps = buildDeps({
      upsertResult: makeSetting({ key: "homepage:heroStyle", value: "map" }),
    });

    const result = await updatePlatformSetting(deps, {
      actorHumanId: ACTOR_ID,
      key: "homepage:heroStyle",
      value: "map",
    });

    expect(result.setting.key).toBe("homepage:heroStyle");
    expect(result.setting.value).toBe("map");
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect((deps.repos as any).audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "PlatformSetting",
        entityId: "homepage:heroStyle",
        action: "platform_setting.update",
      }),
    );
  });

  it("sets supportEmail to a valid email (happy path)", async () => {
    const deps = buildDeps({
      upsertResult: makeSetting({
        key: "supportEmail",
        value: "help@example.com",
      }),
    });

    const result = await updatePlatformSetting(deps, {
      actorHumanId: ACTOR_ID,
      key: "supportEmail",
      value: "help@example.com",
    });

    expect(result.setting.key).toBe("supportEmail");
    expect(result.setting.value).toBe("help@example.com");
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect((deps.repos as any).audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "PlatformSetting",
        entityId: "supportEmail",
        action: "platform_setting.update",
      }),
    );
  });

  it("throws forbidden when actor lacks staff role", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      updatePlatformSetting(deps, {
        actorHumanId: ACTOR_ID,
        key: "homepage:heroStyle",
        value: "map",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    // tx and audit must not be called
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect((deps.repos as any).audit.log).not.toHaveBeenCalled();
  });

  it("throws invalid_input for an unrecognised heroStyle value (authorised actor)", async () => {
    const deps = buildDeps();

    await expect(
      updatePlatformSetting(deps, {
        actorHumanId: ACTOR_ID,
        key: "homepage:heroStyle",
        value: "bad",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });

    // tx and audit must not be called
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect((deps.repos as any).audit.log).not.toHaveBeenCalled();
  });

  it("rejects the retired bare maintenanceMode key (the switch is feature:maintenanceMode)", async () => {
    const deps = buildDeps();

    await expect(
      updatePlatformSetting(deps, {
        actorHumanId: ACTOR_ID,
        key: "maintenanceMode",
        value: "true",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });
});
