import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

import * as listModule from "@th/core/use-cases/application-form-templates/list-application-form-templates";
import * as createModule from "@th/core/use-cases/application-form-templates/create-application-form-template";
import * as updateModule from "@th/core/use-cases/application-form-templates/update-application-form-template";
import * as archiveModule from "@th/core/use-cases/application-form-templates/archive-application-form-template";
import * as applyModule from "@th/core/use-cases/application-form-templates/apply-application-form-template";
import * as saveModule from "@th/core/use-cases/application-form-templates/save-form-as-template";

import { applicationFormTemplatesRouter } from "../application-form-templates";
import { createCaller } from "./test-helpers";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";

describe("applicationFormTemplatesRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards deps + the SESSION's actor to list (never a client-supplied one)", async () => {
    const spy = vi
      .spyOn(listModule, "listApplicationFormTemplates")
      .mockResolvedValue({ items: [], platform: [] });

    const { caller, ctx } = createCaller(applicationFormTemplatesRouter);

    const result = await caller.list({
      ownerScope: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(result).toEqual({ items: [], platform: [] });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, logger: expect.anything() }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        ownerScope: "ORGANIZATION",
        ownerId: ORG_ID,
      }),
    );
  });

  it("REJECTS a client-supplied actorHumanId — the input omits it", async () => {
    vi.spyOn(listModule, "listApplicationFormTemplates").mockResolvedValue({
      items: [],
      platform: [],
    });

    const { caller } = createCaller(applicationFormTemplatesRouter);

    // `.omit({ actorHumanId })` on a `.strict()` schema means an injected
    // actor is a 400, not a silently honoured impersonation.
    await expect(
      caller.list({
        ownerScope: "ORGANIZATION",
        ownerId: ORG_ID,
        actorHumanId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("forwards idempotency + clock to create", async () => {
    const spy = vi
      .spyOn(createModule, "createApplicationFormTemplate")
      .mockResolvedValue({ templateId: TEMPLATE_ID, name: "Vendor form" });

    const { caller, ctx } = createCaller(applicationFormTemplatesRouter);

    const result = await caller.create({
      ownerScope: "ORGANIZATION",
      ownerId: ORG_ID,
      name: "Vendor form",
      questions: [{ type: "SHORT_TEXT", label: "Stall name" }],
      clientKey: "create-key-1",
    });

    expect(result).toEqual({ templateId: TEMPLATE_ID, name: "Vendor form" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({ actorHumanId: ctx.actorHumanId }),
    );
  });

  it("maps TEMPLATE_NAME_TAKEN to CONFLICT", async () => {
    vi.spyOn(createModule, "createApplicationFormTemplate").mockRejectedValue(
      // A REAL AppError, the shape every use case throws — plain
      // `{ code, message }` objects take the legacy path and would prove
      // nothing about the `appCodeToTrpc` mapping this router relies on.
      new AppError("TEMPLATE_NAME_TAKEN"),
    );

    const { caller } = createCaller(applicationFormTemplatesRouter);

    await expect(
      caller.create({
        ownerScope: "HUMAN",
        ownerId: ORG_ID,
        name: "Taken",
        questions: [],
        clientKey: "create-key-2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps TEMPLATE_NOT_FOUND to NOT_FOUND on update", async () => {
    vi.spyOn(updateModule, "updateApplicationFormTemplate").mockRejectedValue(new AppError("TEMPLATE_NOT_FOUND"));

    const { caller } = createCaller(applicationFormTemplatesRouter);

    await expect(
      caller.update({
        templateId: TEMPLATE_ID,
        name: "Renamed",
        clientKey: "update-key-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("forwards archive and returns its result", async () => {
    const spy = vi
      .spyOn(archiveModule, "archiveApplicationFormTemplate")
      .mockResolvedValue({ ok: true });

    const { caller, ctx } = createCaller(applicationFormTemplatesRouter);

    const result = await caller.archive({
      templateId: TEMPLATE_ID,
      clientKey: "archive-key-1",
    });

    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency: ctx.idempotency }),
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        actorHumanId: ctx.actorHumanId,
      }),
    );
  });

  it("forwards applyToEvent and returns the created question ids", async () => {
    const spy = vi
      .spyOn(applyModule, "applyApplicationFormTemplate")
      .mockResolvedValue({
        formId: "77777777-7777-4777-8777-777777777777",
        createdQuestionIds: ["99999999-9999-4999-8999-999999999991"],
        created: ["Act name"],
      });

    const { caller, ctx } = createCaller(applicationFormTemplatesRouter);

    const result = await caller.applyToEvent({
      eventId: EVENT_ID,
      templateId: TEMPLATE_ID,
      clientKey: "apply-key-1",
    });

    expect(result.created).toEqual(["Act name"]);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventId: EVENT_ID,
        templateId: TEMPLATE_ID,
        actorHumanId: ctx.actorHumanId,
      }),
    );
  });

  it("maps APPLICATION_SUBMISSIONS_EXIST to CONFLICT", async () => {
    vi.spyOn(applyModule, "applyApplicationFormTemplate").mockRejectedValue(new AppError("APPLICATION_SUBMISSIONS_EXIST"));

    const { caller } = createCaller(applicationFormTemplatesRouter);

    await expect(
      caller.applyToEvent({
        eventId: EVENT_ID,
        templateId: TEMPLATE_ID,
        clientKey: "apply-key-2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forwards saveFromEvent with both the event and the destination scope", async () => {
    const spy = vi
      .spyOn(saveModule, "saveFormAsApplicationTemplate")
      .mockResolvedValue({
        templateId: TEMPLATE_ID,
        name: "Our open call",
        questionCount: 3,
      });

    const { caller, ctx } = createCaller(applicationFormTemplatesRouter);

    const result = await caller.saveFromEvent({
      eventId: EVENT_ID,
      ownerScope: "ORGANIZATION",
      ownerId: ORG_ID,
      name: "Our open call",
      clientKey: "save-key-1",
    });

    expect(result.questionCount).toBe(3);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventId: EVENT_ID,
        ownerScope: "ORGANIZATION",
        ownerId: ORG_ID,
        actorHumanId: ctx.actorHumanId,
      }),
    );
  });

  it("maps INSUFFICIENT_ROLE to FORBIDDEN on saveFromEvent", async () => {
    vi.spyOn(saveModule, "saveFormAsApplicationTemplate").mockRejectedValue(new AppError("INSUFFICIENT_ROLE"));

    const { caller } = createCaller(applicationFormTemplatesRouter);

    await expect(
      caller.saveFromEvent({
        eventId: EVENT_ID,
        ownerScope: "ORGANIZATION",
        ownerId: ORG_ID,
        name: "Nope",
        clientKey: "save-key-2",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("401s when the session carries no human id", async () => {
    const spy = vi.spyOn(listModule, "listApplicationFormTemplates");

    const { caller } = createCaller(applicationFormTemplatesRouter, {
      actorHumanId: null,
    });

    await expect(
      caller.list({ ownerScope: "ORGANIZATION", ownerId: ORG_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(spy).not.toHaveBeenCalled();
  });
});
