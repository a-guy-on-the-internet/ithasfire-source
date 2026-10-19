import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_IMAGE_CREATE_PATHS,
  PROVIDER_IMAGE_UPDATE_PATHS,
  dropUnverifiedImageOnCreate,
  hookPath,
  refuseUnverifiedImageUpdate,
  syncProviderAvatarToPage,
} from "../src/auth/profile-image-sync";

// Security review N1 (image strip step 2, round 2): any signed-in user could
// `POST /api/auth/update-user {"image": "<anything>"}` (or sign up with one)
// and the user hooks copied it into `EntityPage.avatarUrl`, past updatePage's
// owned-copy check, and `auth_user.image` is shown to others in the ticket
// transfer recipient search. Only a provider's picture may be stored.

function makeLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

const TRACKER = "https://tracker.example/pixel.gif";

describe("hookPath", () => {
  it("reads the route template, and nothing from a context-less call", () => {
    expect(hookPath({ path: "/update-user" })).toBe("/update-user");
    expect(hookPath(null)).toBeUndefined();
    expect(hookPath({ path: 7 })).toBeUndefined();
  });
});

describe("dropUnverifiedImageOnCreate (user.create.before)", () => {
  it("drops an image sent to /sign-up/email: the sign-up goes on without it", () => {
    expect(dropUnverifiedImageOnCreate({ email: "a@b.c", image: TRACKER }, "/sign-up/email")).toEqual({
      data: { image: null },
    });
  });

  it("drops it from any other non-provider endpoint too (e.g. email-code sign-up)", () => {
    expect(dropUnverifiedImageOnCreate({ image: TRACKER }, "/sign-in/email-otp")).toEqual({
      data: { image: null },
    });
  });

  it("keeps a provider's picture on every OAuth create endpoint", () => {
    for (const path of PROVIDER_IMAGE_CREATE_PATHS) {
      expect(dropUnverifiedImageOnCreate({ image: "https://lh3.googleusercontent.com/a/x" }, path)).toBeUndefined();
    }
    expect(PROVIDER_IMAGE_CREATE_PATHS.has("/callback/:id")).toBe(true);
    expect(PROVIDER_IMAGE_CREATE_PATHS.has("/oauth-proxy-callback")).toBe(true);
  });

  it("leaves a create with no image (or a null one) alone", () => {
    expect(dropUnverifiedImageOnCreate({ email: "a@b.c" }, "/sign-up/email")).toBeUndefined();
    expect(dropUnverifiedImageOnCreate({ image: null }, "/sign-up/email")).toBeUndefined();
  });

  it("trusts server code with no request context", () => {
    expect(dropUnverifiedImageOnCreate({ image: TRACKER }, undefined)).toBeUndefined();
  });

  it("drops object, array and blank-string shapes too (fails closed)", () => {
    for (const image of [{ set: TRACKER }, [TRACKER], {}, "  "]) {
      expect(dropUnverifiedImageOnCreate({ image }, "/sign-up/email")).toEqual({
        data: { image: null },
      });
    }
  });

  it("leaves an explicit clear alone on create", () => {
    expect(dropUnverifiedImageOnCreate({ image: "" }, "/sign-up/email")).toBeUndefined();
    expect(dropUnverifiedImageOnCreate({ image: undefined }, "/sign-up/email")).toBeUndefined();
  });
});

describe("refuseUnverifiedImageUpdate (user.update.before)", () => {
  it("refuses setting an image through /update-user", () => {
    expect(() => refuseUnverifiedImageUpdate({ image: TRACKER }, "/update-user")).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("refuses it from any non-provider endpoint", () => {
    expect(() => refuseUnverifiedImageUpdate({ image: TRACKER, name: "x" }, "/admin/update-user")).toThrow();
  });

  it("lets /update-user change the name, and clear the image", () => {
    expect(() => refuseUnverifiedImageUpdate({ name: "New" }, "/update-user")).not.toThrow();
    expect(() => refuseUnverifiedImageUpdate({ image: null }, "/update-user")).not.toThrow();
    expect(() => refuseUnverifiedImageUpdate({ image: "" }, "/update-user")).not.toThrow();
  });

  it("refuses object, array, empty-object and blank-string shapes (fails closed)", () => {
    for (const image of [{ set: TRACKER }, [TRACKER], {}, "  "]) {
      expect(() => refuseUnverifiedImageUpdate({ image }, "/update-user")).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    }
  });

  it("lets a provider link refresh the picture", () => {
    for (const path of PROVIDER_IMAGE_UPDATE_PATHS) {
      expect(() => refuseUnverifiedImageUpdate({ image: "https://lh3.googleusercontent.com/a/x" }, path)).not.toThrow();
    }
  });
});

describe("syncProviderAvatarToPage (user.update.after)", () => {
  function setup(page: { avatarUrl: string | null } | null = { avatarUrl: null }) {
    const entityPages = {
      getByOwner: vi.fn(async () =>
        page ? { slug: "me", displayName: "Me", ...page } : null,
      ),
      upsert: vi.fn(async (input: object) => input),
    };
    const logger = makeLogger();
    const reportError = vi.fn();
    return {
      entityPages,
      logger,
      reportError,
      deps: { entityPages: entityPages as any, logger, reportError },
    };
  }

  it("copies a picture set by /link-social onto the page", async () => {
    const s = setup();
    await syncProviderAvatarToPage(s.deps, {
      path: "/link-social",
      humanId: "h1",
      image: "https://lh3.googleusercontent.com/a/x",
    });
    expect(s.entityPages.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "h1", avatarUrl: "https://lh3.googleusercontent.com/a/x" }),
    );
  });

  it("never copies from /update-user (or any non-provider endpoint, or no request)", async () => {
    const s = setup();
    for (const path of ["/update-user", "/sign-up/email", undefined]) {
      await syncProviderAvatarToPage(s.deps, { path, humanId: "h1", image: TRACKER });
    }
    expect(s.entityPages.getByOwner).not.toHaveBeenCalled();
    expect(s.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("does nothing when the page already shows it", async () => {
    const s = setup({ avatarUrl: "https://lh3.googleusercontent.com/a/x" });
    await syncProviderAvatarToPage(s.deps, {
      path: "/link-social",
      humanId: "h1",
      image: "https://lh3.googleusercontent.com/a/x",
    });
    expect(s.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("a failed sync is swallowed, reported and logged at error (not warn)", async () => {
    const s = setup();
    s.entityPages.upsert.mockRejectedValueOnce(new Error("db_down"));
    await expect(
      syncProviderAvatarToPage(s.deps, {
        path: "/link-social",
        humanId: "h1",
        image: "https://lh3.googleusercontent.com/a/x",
      }),
    ).resolves.toBeUndefined();
    expect(s.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "db_down" }), {
      tags: { area: "auth", op: "provider_avatar_sync" },
      extra: { humanId: "h1" },
    });
    expect(s.logger.error).toHaveBeenCalledWith(
      "auth_user_update_avatar_sync_failed",
      expect.objectContaining({ humanId: "h1" }),
    );
    expect(s.logger.warn).not.toHaveBeenCalled();
  });

  it("a throwing reporter does not change the outcome", async () => {
    const s = setup();
    s.entityPages.upsert.mockRejectedValueOnce(new Error("db_down"));
    s.reportError.mockImplementation(() => {
      throw new Error("sentry_down");
    });
    await expect(
      syncProviderAvatarToPage(s.deps, { path: "/link-social", humanId: "h1", image: "https://x.example/a.jpg" }),
    ).resolves.toBeUndefined();
  });
});
