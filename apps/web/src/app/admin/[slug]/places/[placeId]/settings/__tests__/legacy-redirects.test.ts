import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminPlaceEditRedirect from "../../edit/page";
import AdminPlaceVerifyRedirect from "../../verify/page";
import { placeSettingsHref } from "../_lib/settings-href";

// `redirect()` throws in Next to unwind the render; the stand-in records the
// target and throws the same way, so a route that forgot to redirect (or
// redirected twice) fails here.
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const PLACE_ID = "44444444-4444-4444-8444-444444444444";
const params = Promise.resolve({ slug: "acme-co", placeId: PLACE_ID });

describe("placeSettingsHref (FR-401 redirect target)", () => {
  it("points at the settings route", () => {
    expect(placeSettingsHref({ slug: "acme-co", placeId: PLACE_ID })).toBe(
      `/admin/acme-co/places/${PLACE_ID}/settings`,
    );
  });

  it("keeps every query parameter, repeated ones included", () => {
    expect(
      placeSettingsHref({
        slug: "acme-co",
        placeId: PLACE_ID,
        searchParams: { ref: "email", tag: ["a", "b"], empty: undefined },
      }),
    ).toBe(`/admin/acme-co/places/${PLACE_ID}/settings?ref=email&tag=a&tag=b`);
  });

  it("appends the section as the fragment, after the query", () => {
    expect(
      placeSettingsHref({
        slug: "acme-co",
        placeId: PLACE_ID,
        searchParams: { ref: "email" },
        section: "verification",
      }),
    ).toBe(
      `/admin/acme-co/places/${PLACE_ID}/settings?ref=email#verification`,
    );
  });

  it("leaves a personal-workspace slug exactly as routed", () => {
    expect(
      placeSettingsHref({ slug: "@steve-mcqueen", placeId: PLACE_ID }),
    ).toBe(`/admin/@steve-mcqueen/places/${PLACE_ID}/settings`);
  });
});

describe("the retired routes redirect to /settings", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("/edit → /settings, query preserved, no fragment of its own", async () => {
    await expect(
      AdminPlaceEditRedirect({
        params,
        searchParams: Promise.resolve({ ref: "email" }),
      }),
    ).rejects.toThrow("REDIRECT:");
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith(
      `/admin/acme-co/places/${PLACE_ID}/settings?ref=email`,
    );
  });

  it("/verify → /settings#verification", async () => {
    await expect(
      AdminPlaceVerifyRedirect({
        params,
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("REDIRECT:");
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith(
      `/admin/acme-co/places/${PLACE_ID}/settings#verification`,
    );
  });
});
