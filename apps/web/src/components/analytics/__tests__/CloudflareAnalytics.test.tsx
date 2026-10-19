/**
 * CloudflareAnalytics — the beacon we inject ourselves.
 *
 * Cloudflare's automatic edge injection was enabled for this zone and
 * verifiably never injected the beacon, so the tag ships in the bundle. That
 * makes the token plumbing worth pinning: a typo in the `data-cf-beacon`
 * payload produces a script that loads fine and reports nothing, which looks
 * identical to working.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const mockEnv = vi.hoisted(() => ({
  cfBeaconToken: null as string | null,
}));
vi.mock("@/config/env.public", () => ({ publicRuntimeEnv: mockEnv }));

// next/script does not render a real <script> under jsdom; capture the props
// that actually matter instead.
vi.mock("next/script", () => ({
  default: (props: Record<string, string>) => (
    <div
      data-testid="beacon"
      data-src={props.src}
      data-payload={props["data-cf-beacon"]}
      data-strategy={props.strategy}
    />
  ),
}));

import { CloudflareAnalytics } from "@/components/analytics/CloudflareAnalytics";

beforeEach(() => {
  mockEnv.cfBeaconToken = null;
});

describe("CloudflareAnalytics", () => {
  it("emits nothing when no token is configured", () => {
    const { queryByTestId } = render(<CloudflareAnalytics />);
    expect(queryByTestId("beacon")).toBeNull();
  });

  it("emits the beacon with the token in a valid data-cf-beacon payload", () => {
    mockEnv.cfBeaconToken = "abc123def456";

    const { getByTestId } = render(<CloudflareAnalytics />);
    const el = getByTestId("beacon");

    expect(el.getAttribute("data-src")).toBe(
      "https://static.cloudflareinsights.com/beacon.min.js",
    );
    expect(el.getAttribute("data-strategy")).toBe("afterInteractive");

    // Cloudflare parses this attribute as JSON; a malformed payload silently
    // collects nothing.
    const payload = JSON.parse(el.getAttribute("data-payload") ?? "{}");
    expect(payload).toEqual({ token: "abc123def456" });
  });

  it("does not leak a token that is only whitespace", () => {
    // `normalizeString` in env.public collapses blank vars to null, so an
    // empty repo variable must not produce a beacon with an empty token.
    mockEnv.cfBeaconToken = null;
    const { queryByTestId } = render(<CloudflareAnalytics />);
    expect(queryByTestId("beacon")).toBeNull();
  });
});
