import { describe, expect, it } from "vitest";

import { createApplicationFormTemplate } from "../create-application-form-template";
import { updateApplicationFormTemplate } from "../update-application-form-template";
import { archiveApplicationFormTemplate } from "../archive-application-form-template";
import {
  ACTOR_ID,
  ORG_ID,
  OTHER_ORG_ID,
  TEMPLATE_ID,
  makeHarness,
  makeTemplate,
} from "./harness";

const NEW_QUESTIONS = [
  { type: "SHORT_TEXT" as const, label: "Stall name", isRequired: true },
  {
    type: "MULTI_CHOICE" as const,
    label: "Booth needs",
    options: [{ value: "Table" }, { value: "Power" }],
    isRequired: false,
  },
];

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    ownerScope: "ORGANIZATION" as const,
    ownerId: ORG_ID,
    name: "Vendor form",
    questions: NEW_QUESTIONS,
    clientKey: "create-template-key",
    ...overrides,
  };
}

function updateInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    templateId: TEMPLATE_ID,
    clientKey: "update-template-key",
    ...overrides,
  };
}

function archiveInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    templateId: TEMPLATE_ID,
    clientKey: "archive-template-key",
    ...overrides,
  };
}

describe("createApplicationFormTemplate", () => {
  it("creates an owner-scoped template with canonicalized options", async () => {
    const harness = makeHarness();

    const result = await createApplicationFormTemplate(
      harness.deps,
      createInput(),
    );

    expect(result.name).toBe("Vendor form");
    const created =
      harness.mocks.applicationFormTemplates.create.mock.calls[0]![0];
    expect(created.ownerId).toBe(ORG_ID);
    expect(created.createdByHumanId).toBe(ACTOR_ID);
    // Builder-shape `{ value }` in, canonical `{ id, label }` stored.
    expect(created.questions[1]!.options).toEqual([
      { id: "opt-1", label: "Table" },
      { id: "opt-2", label: "Power" },
    ]);
  });

  it("refuses a choice question with no options", async () => {
    const harness = makeHarness();

    await expect(
      createApplicationFormTemplate(
        harness.deps,
        createInput({
          questions: [{ type: "SINGLE_CHOICE", label: "Pick", options: [] }],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses options on a NON-choice question", async () => {
    const harness = makeHarness();

    await expect(
      createApplicationFormTemplate(
        harness.deps,
        createInput({
          questions: [
            {
              type: "SHORT_TEXT",
              label: "Name",
              options: [{ value: "nope" }],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a question type outside the four shipped ones", async () => {
    const harness = makeHarness();

    await expect(
      createApplicationFormTemplate(
        harness.deps,
        createInput({
          questions: [{ type: "NUMBER", label: "How many?" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("sanitizes HTML out of a label before the length check", async () => {
    const harness = makeHarness();

    await createApplicationFormTemplate(
      harness.deps,
      createInput({
        questions: [
          {
            type: "SHORT_TEXT",
            label: "<script>alert(1)</script>Act name",
            isRequired: false,
          },
        ],
      }),
    );

    const created =
      harness.mocks.applicationFormTemplates.create.mock.calls[0]![0];
    expect(created.questions[0]!.label).toBe("Act name");
  });

  it("refuses a name already used in the owner's library", async () => {
    const harness = makeHarness({
      nameCollision: makeTemplate({ name: "Vendor form" }),
    });

    await expect(
      createApplicationFormTemplate(harness.deps, createInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });

  it("refuses a caller with no membership in the destination org", async () => {
    const harness = makeHarness({ membershipRole: null });

    await expect(
      createApplicationFormTemplate(harness.deps, createInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(
      harness.mocks.applicationFormTemplates.create,
    ).not.toHaveBeenCalled();
  });

  it("refuses an org VIEWER (create needs edit rights)", async () => {
    const harness = makeHarness({ membershipRole: "VIEWER" });

    await expect(
      createApplicationFormTemplate(harness.deps, createInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("replays a repeated clientKey", async () => {
    const harness = makeHarness();

    const first = await createApplicationFormTemplate(
      harness.deps,
      createInput(),
    );
    const second = await createApplicationFormTemplate(
      harness.deps,
      createInput(),
    );

    expect(second).toEqual(first);
    expect(
      harness.mocks.applicationFormTemplates.create,
    ).toHaveBeenCalledTimes(1);
  });
});

describe("updateApplicationFormTemplate", () => {
  it("renames a template", async () => {
    const harness = makeHarness();

    const result = await updateApplicationFormTemplate(
      harness.deps,
      updateInput({ name: "Renamed" }),
    );

    expect(result.name).toBe("Renamed");
    expect(
      harness.mocks.applicationFormTemplates.update.mock.calls[0]![0],
    ).toMatchObject({ templateId: TEMPLATE_ID, name: "Renamed" });
  });

  it("leaves untouched fields ABSENT so a partial edit can't clobber the rest", async () => {
    const harness = makeHarness();

    await updateApplicationFormTemplate(
      harness.deps,
      updateInput({ name: "Renamed" }),
    );

    const payload =
      harness.mocks.applicationFormTemplates.update.mock.calls[0]![0];
    expect(Object.keys(payload)).not.toContain("questions");
    expect(Object.keys(payload)).not.toContain("introText");
    expect(Object.keys(payload)).not.toContain("description");
  });

  it("passes an explicit null through as a CLEAR", async () => {
    const harness = makeHarness();

    await updateApplicationFormTemplate(
      harness.deps,
      updateInput({ introText: null }),
    );

    const payload =
      harness.mocks.applicationFormTemplates.update.mock.calls[0]![0];
    expect(payload).toHaveProperty("introText", null);
  });

  it("allows re-saving under the same name (a self-collision is not a collision)", async () => {
    const harness = makeHarness({
      // findByName would return the row itself for an unchanged name; the
      // guard must not even reach it.
      nameCollision: makeTemplate(),
    });

    await updateApplicationFormTemplate(
      harness.deps,
      updateInput({ name: "Performer application" }),
    );

    expect(
      harness.mocks.applicationFormTemplates.findByName,
    ).not.toHaveBeenCalled();
  });

  it("refuses a rename onto another template's name", async () => {
    const harness = makeHarness({
      nameCollision: makeTemplate({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        name: "Taken",
      }),
    });

    await expect(
      updateApplicationFormTemplate(harness.deps, updateInput({ name: "Taken" })),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });

  it("refuses editing a PLATFORM catalogue row, with the same code a stranger's row gets", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        isPlatform: true,
        ownerId: null,
        createdByHumanId: null,
      }),
    });

    await expect(
      updateApplicationFormTemplate(harness.deps, updateInput({ name: "Mine" })),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(
      harness.mocks.applicationFormTemplates.update,
    ).not.toHaveBeenCalled();
  });

  it("refuses a mis-shaped platform row (flag set WITH an ownerId)", async () => {
    const harness = makeHarness({
      template: makeTemplate({ isPlatform: true, ownerId: ORG_ID }),
    });

    await expect(
      updateApplicationFormTemplate(harness.deps, updateInput({ name: "Mine" })),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("refuses another org's template", async () => {
    const harness = makeHarness({
      template: makeTemplate({ ownerId: OTHER_ORG_ID }),
    });

    await expect(
      updateApplicationFormTemplate(harness.deps, updateInput({ name: "Mine" })),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses editing an archived template", async () => {
    const harness = makeHarness({
      template: makeTemplate({ archivedAt: new Date("2026-08-05T00:00:00Z") }),
    });

    await expect(
      updateApplicationFormTemplate(harness.deps, updateInput({ name: "Mine" })),
    ).rejects.toMatchObject({ code: "TEMPLATE_ARCHIVED" });
  });

  it("refuses a missing template", async () => {
    const harness = makeHarness({ template: null });

    await expect(
      updateApplicationFormTemplate(harness.deps, updateInput({ name: "Mine" })),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});

describe("archiveApplicationFormTemplate", () => {
  it("archives an owned template and audits it", async () => {
    const harness = makeHarness();

    const result = await archiveApplicationFormTemplate(
      harness.deps,
      archiveInput(),
    );

    expect(result).toEqual({ ok: true });
    expect(
      harness.mocks.applicationFormTemplates.archive,
    ).toHaveBeenCalledTimes(1);
    expect(harness.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "application_form_template",
        action: "archived",
      }),
    );
  });

  it("is a no-op on an already-archived template", async () => {
    const harness = makeHarness({
      template: makeTemplate({ archivedAt: new Date("2026-08-05T00:00:00Z") }),
    });

    const result = await archiveApplicationFormTemplate(
      harness.deps,
      archiveInput(),
    );

    expect(result).toEqual({ ok: true });
    expect(
      harness.mocks.applicationFormTemplates.archive,
    ).not.toHaveBeenCalled();
  });

  it("refuses archiving a PLATFORM catalogue row", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        isPlatform: true,
        ownerId: null,
        createdByHumanId: null,
      }),
    });

    await expect(
      archiveApplicationFormTemplate(harness.deps, archiveInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(
      harness.mocks.applicationFormTemplates.archive,
    ).not.toHaveBeenCalled();
  });

  it("refuses another org's template", async () => {
    const harness = makeHarness({
      template: makeTemplate({ ownerId: OTHER_ORG_ID }),
    });

    await expect(
      archiveApplicationFormTemplate(harness.deps, archiveInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses an org VIEWER", async () => {
    const harness = makeHarness({ membershipRole: "VIEWER" });

    await expect(
      archiveApplicationFormTemplate(harness.deps, archiveInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
