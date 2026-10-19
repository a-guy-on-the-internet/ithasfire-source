import { describe, expect, it } from "vitest";

import { listApplicationFormTemplates } from "../list-application-form-templates";
import {
  ACTOR_ID,
  ORG_ID,
  OTHER_ORG_ID,
  makeHarness,
  makeTemplate,
} from "./harness";

function input(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    ownerScope: "ORGANIZATION" as const,
    ownerId: ORG_ID,
    ...overrides,
  };
}

describe("listApplicationFormTemplates", () => {
  it("returns the owner's library and the platform catalogue in separate arrays", async () => {
    const owned = makeTemplate({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Our vendor form",
    });
    const platform = makeTemplate({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Vendor / market stall",
      isPlatform: true,
      ownerId: null,
      createdByHumanId: null,
    });
    const harness = makeHarness({
      ownedTemplates: [owned],
      platformTemplates: [platform],
    });

    const result = await listApplicationFormTemplates(harness.deps, input());

    expect(result.items.map((t) => t.id)).toEqual([owned.id]);
    expect(result.platform.map((t) => t.id)).toEqual([platform.id]);
    // The read-only flag and the null owner are what the picker branches on.
    expect(result.platform[0]!.isPlatform).toBe(true);
    expect(result.platform[0]!.ownerId).toBeNull();
    expect(result.items[0]!.isPlatform).toBe(false);
  });

  it("shows the platform catalogue to an owner with no templates of their own", async () => {
    const platform = makeTemplate({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      isPlatform: true,
      ownerId: null,
      createdByHumanId: null,
    });
    const harness = makeHarness({
      ownedTemplates: [],
      platformTemplates: [platform],
    });

    const result = await listApplicationFormTemplates(harness.deps, input());

    expect(result.items).toEqual([]);
    expect(result.platform).toHaveLength(1);
  });

  it("excludes archived rows — the repo reads are non-archived by construction", async () => {
    // Belt-and-braces on the CONTRACT: `list` / `listPlatformTemplates` are
    // the only reads, and both filter `archivedAt: null` in SQL. If a future
    // refactor widened them, this test would need the use case to re-filter —
    // so assert the calls stay the non-archived ones.
    const harness = makeHarness({ ownedTemplates: [], platformTemplates: [] });

    await listApplicationFormTemplates(harness.deps, input());

    // Open calls step 2 is behaviour-neutral: the attendee picker still
    // offers PERFORM templates (the seeded performer one) until step 11.
    expect(harness.mocks.applicationFormTemplates.list).toHaveBeenCalledWith(
      "ORGANIZATION",
      ORG_ID,
      ["ATTEND", "PERFORM"],
    );
    expect(
      harness.mocks.applicationFormTemplates.listPlatformTemplates,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.mocks.applicationFormTemplates.listPlatformTemplates,
    ).toHaveBeenCalledWith(["ATTEND", "PERFORM"]);
  });

  it("normalizes legacy option shapes on read (bare strings → canonical)", async () => {
    const legacy = makeTemplate({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      questions: [
        {
          type: "SINGLE_CHOICE",
          label: "Set length",
          description: null,
          // Hand-edited / legacy at-rest shape the canonical schema would
          // never write today.
          options: ["30 min", "45 min"] as never,
          isRequired: false,
        },
      ],
    });
    const harness = makeHarness({ ownedTemplates: [legacy] });

    const result = await listApplicationFormTemplates(harness.deps, input());

    expect(result.items[0]!.questions[0]!.options).toEqual([
      { id: "opt-1", label: "30 min" },
      { id: "opt-2", label: "45 min" },
    ]);
  });

  it("reports non-choice questions' options as null, never []", async () => {
    const harness = makeHarness({ ownedTemplates: [makeTemplate()] });

    const result = await listApplicationFormTemplates(harness.deps, input());

    expect(result.items[0]!.questions[0]!.type).toBe("SHORT_TEXT");
    expect(result.items[0]!.questions[0]!.options).toBeNull();
  });

  it("refuses a caller with no membership in the named org", async () => {
    const harness = makeHarness({ membershipRole: null });

    await expect(
      listApplicationFormTemplates(harness.deps, input()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // Nothing is read once access is denied — the caller learns nothing about
    // the scope they named, not even that the catalogue exists.
    expect(harness.mocks.applicationFormTemplates.list).not.toHaveBeenCalled();
    expect(
      harness.mocks.applicationFormTemplates.listPlatformTemplates,
    ).not.toHaveBeenCalled();
  });

  it("refuses a caller naming an org that does not exist", async () => {
    const harness = makeHarness();

    await expect(
      listApplicationFormTemplates(
        harness.deps,
        input({ ownerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
      ),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("refuses a HUMAN scope that is not the actor", async () => {
    const harness = makeHarness();

    await expect(
      listApplicationFormTemplates(
        harness.deps,
        input({ ownerScope: "HUMAN", ownerId: OTHER_ORG_ID }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("allows a HUMAN scope that IS the actor", async () => {
    const harness = makeHarness({ ownedTemplates: [] });

    const result = await listApplicationFormTemplates(
      harness.deps,
      input({ ownerScope: "HUMAN", ownerId: ACTOR_ID }),
    );

    expect(result.items).toEqual([]);
  });
});
