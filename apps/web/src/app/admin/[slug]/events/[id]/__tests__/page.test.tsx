import { beforeEach, describe, expect, it, vi } from "vitest";

// `redirect` throws by design (NEXT_REDIRECT) and terminates rendering; the
// mock mirrors that so the page can't accidentally continue past it.
const redirectMock = vi.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import AdminEventDetailRedirect from "../page";

/**
 * Invoke the (server-component) redirector and return the redirect target.
 * The old tab-driven page's loading / error / no-access / builder states are
 * covered by EventAdminPageShell.test.tsx — that scaffolding moved there
 * when this page became a pure redirector (event-builder regroup FR-201).
 */
const invoke = async (
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> => {
  await expect(
    AdminEventDetailRedirect({
      params: Promise.resolve({ slug: "acme-co", id: "evt-1" }),
      searchParams: Promise.resolve(searchParams),
    }),
  ).rejects.toThrow(/NEXT_REDIRECT/);
  expect(redirectMock).toHaveBeenCalledTimes(1);
  return redirectMock.mock.calls[0]?.[0] as string;
};

const BASE = "/admin/acme-co/events/evt-1";

describe("AdminEventDetailRedirect", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects to /edit when no tab is given", async () => {
    expect(await invoke()).toBe(`${BASE}/edit`);
  });

  it("redirects ?tab=edit to /edit", async () => {
    expect(await invoke({ tab: "edit" })).toBe(`${BASE}/edit`);
  });

  it("redirects ?tab=preview to /edit?view=preview (in-view toggle, D4 reversed)", async () => {
    expect(await invoke({ tab: "preview" })).toBe(
      `${BASE}/edit?view=preview`,
    );
  });

  it("redirects ?tab=seating to /edit?seating=legacy (opens the takeover, FR-205)", async () => {
    expect(await invoke({ tab: "seating" })).toBe(
      `${BASE}/edit?seating=legacy`,
    );
  });

  it.each([
    ["attendees", "attendees"],
    ["volunteers", "volunteers"],
    ["comp", "comp-tickets"],
    ["suggestions", "suggestions"],
    ["feedback", "feedback"],
  ])("redirects ?tab=%s to /%s", async (tab, segment) => {
    expect(await invoke({ tab })).toBe(`${BASE}/${segment}`);
  });

  it("redirects unknown tabs to /edit", async () => {
    expect(await invoke({ tab: "nonsense" })).toBe(`${BASE}/edit`);
  });

  it("preserves extra query params across the redirect (deep-link parity)", async () => {
    expect(await invoke({ tab: "comp", foo: "1" })).toBe(
      `${BASE}/comp-tickets?foo=1`,
    );
  });

  it("preserves repeated query params", async () => {
    expect(await invoke({ tab: "attendees", x: ["1", "2"] })).toBe(
      `${BASE}/attendees?x=1&x=2`,
    );
  });

  it("keeps extra params alongside the legacy seating flag", async () => {
    expect(await invoke({ tab: "seating", foo: "bar" })).toBe(
      `${BASE}/edit?foo=bar&seating=legacy`,
    );
  });

  it("ignores a non-string tab param and falls back to /edit", async () => {
    expect(await invoke({ tab: ["comp", "edit"] })).toBe(`${BASE}/edit`);
  });
});
