import { describe, expect, it, vi } from "vitest";

import { makeApplicationFormTemplatesRepo } from "../application-form-templates";
import type { PrismaClientOrTx } from "../types";

/**
 * Open calls v1: template reads filter by a REQUIRED purposes list. Prisma
 * drops an `undefined` filter, so a missing list would read every template;
 * the adapter throws instead.
 */
describe("makeApplicationFormTemplatesRepo — purposes filter", () => {
  const createPrisma = () => {
    const applicationFormTemplate = {
      findMany: vi.fn().mockResolvedValue([]),
    };
    return {
      prisma: { applicationFormTemplate } as unknown as PrismaClientOrTx,
      applicationFormTemplate,
    };
  };

  it("filters owned and platform reads by the purposes given", async () => {
    const { prisma, applicationFormTemplate } = createPrisma();
    const repo = makeApplicationFormTemplatesRepo(prisma);

    await repo.list("ORGANIZATION", "org-1", ["ATTEND", "PERFORM"]);
    await repo.listPlatformTemplates(["ATTEND"]);

    expect(applicationFormTemplate.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          purpose: { in: ["ATTEND", "PERFORM"] },
          isPlatform: false,
        }),
      }),
    );
    expect(applicationFormTemplate.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          purpose: { in: ["ATTEND"] },
          isPlatform: true,
        }),
      }),
    );
  });

  it("throws on a missing or empty purposes list before any query", async () => {
    const { prisma, applicationFormTemplate } = createPrisma();
    const repo = makeApplicationFormTemplatesRepo(prisma);
    const missing = undefined as unknown as ["ATTEND"];

    await expect(repo.list("ORGANIZATION", "org-1", missing)).rejects.toThrow(
      /list: purposes is required/,
    );
    await expect(repo.listPlatformTemplates([])).rejects.toThrow(
      /listPlatformTemplates: purposes is required/,
    );
    expect(applicationFormTemplate.findMany).not.toHaveBeenCalled();
  });
});
