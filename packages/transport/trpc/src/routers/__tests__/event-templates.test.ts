import { beforeEach, describe, expect, it, vi } from "vitest";

import * as createEventTemplateModule from "@th/core/use-cases/event-templates/create-event-template";
import * as listEventTemplatesModule from "@th/core/use-cases/event-templates/list-event-templates";

import { eventTemplatesRouter } from "../event-templates";
import { createCaller } from "./test-helpers";

describe("eventTemplatesRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards dependencies and actor human id to createEventTemplate", async () => {
    const createSpy = vi
      .spyOn(createEventTemplateModule, "createEventTemplate")
      .mockResolvedValue({
        templateId: "88888888-8888-4888-8888-888888888888",
      });

    const { caller, ctx } = createCaller(eventTemplatesRouter);

    const input = {
      ownerScope: "ORGANIZATION" as const,
      ownerId: "33333333-3333-4333-8333-333333333333",
      name: "Default Template",
      clientKey: "template-key",
    };

    const result = await caller.createEventTemplate(input);

    expect(result).toEqual({
      templateId: "88888888-8888-4888-8888-888888888888",
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        ownerScope: "ORGANIZATION",
        ownerId: input.ownerId,
      }),
    );
  });

  it("maps use case errors from createEventTemplate", async () => {
    vi.spyOn(
      createEventTemplateModule,
      "createEventTemplate",
    ).mockRejectedValue({
      code: "conflict",
      message: "template_name_taken",
    });

    const { caller } = createCaller(eventTemplatesRouter);

    await expect(
      caller.createEventTemplate({
        ownerScope: "HUMAN",
        ownerId: "44444444-4444-4444-8444-444444444444",
        name: "Personal Template",
        clientKey: "template-key",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "template_name_taken",
    });
  });

  it("forwards dependencies to listEventTemplates", async () => {
    const now = new Date("2024-03-15T15:00:00.000Z");
    const listSpy = vi
      .spyOn(listEventTemplatesModule, "listEventTemplates")
      .mockResolvedValue({
        items: [
          {
            id: "99999999-9999-4999-8999-999999999999",
            ownerScope: "ORGANIZATION" as const,
            ownerId: "33333333-3333-4333-8333-333333333333",
            name: "Template",
            description: null,
            active: true,
            defaults: undefined,
            createdBy: "11111111-1111-4111-8111-111111111111",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ],
        nextCursor: undefined,
      });

    const { caller, ctx } = createCaller(eventTemplatesRouter);

    const result = await caller.listEventTemplates({
      ownerScope: "ORGANIZATION",
      ownerId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result.items).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, logger: expect.anything() }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        ownerScope: "ORGANIZATION",
        ownerId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects when actor human id missing for create", async () => {
    const createSpy = vi
      .spyOn(createEventTemplateModule, "createEventTemplate")
      .mockResolvedValue({
        templateId: "88888888-8888-4888-8888-888888888888",
      });

    const overrides = {
      actorHumanId: null,
      auth: null,
      authToken: null,
    } as const;
    const { caller } = createCaller(eventTemplatesRouter, overrides);

    await expect(
      caller.createEventTemplate({
        ownerScope: "ORGANIZATION",
        ownerId: "33333333-3333-4333-8333-333333333333",
        name: "Template",
        clientKey: "template-key",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(createSpy).not.toHaveBeenCalled();
  });
});
