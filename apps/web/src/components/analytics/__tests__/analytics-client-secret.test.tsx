/**
 * A redirect payment method (Amazon Pay, Cash App Pay) returns the buyer to
 * the checkout with `payment_intent_client_secret=pi_X_secret_Y` on the URL,
 * and the page keeps it for the visit. Plausible, the Cloudflare beacon and
 * GA4 read `location.href` themselves, so none may run while it is there; and
 * the last-visited-URL tracker must never store it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const state = vi.hoisted(() => ({ pathname: "/events/x/checkout" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/config/env.public", () => ({
  publicRuntimeEnv: {
    plausibleDomain: "ithasfire.com",
    plausibleSrc: null,
    cfBeaconToken: "cf-token",
    gaMeasurementId: "G-TEST",
  },
}));
vi.mock("next/script", () => ({
  default: (props: Record<string, string>) => (
    <div data-testid="script" data-src={props.src} />
  ),
}));
vi.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: () => <div data-testid="ga" />,
}));
vi.mock("@/components/gdpr/ConsentProvider", () => ({
  useConsentContext: () => ({ consent: "all", ready: true }),
}));

import { PlausibleAnalytics } from "../PlausibleAnalytics";
import { CloudflareAnalytics } from "../CloudflareAnalytics";
import { GoogleAnalyticsLoader } from "../GoogleAnalyticsLoader";
import { LastVisitedUrlTracker } from "../LastVisitedUrlTracker";
import {
  ANALYTICS_URL_SCRUBBED_EVENT,
  searchCarriesClientSecret,
  stripClientSecretParams,
} from "../analytics-url-guard";

const SECRET = "pi_3Abc_secret_XyZ123"; // gitleaks:allow (fake test fixture)
const gaFlag = () =>
  (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"];

function setSearch(search: string) {
  window.history.replaceState({}, "", `/events/x/checkout${search}`);
}

const all = () => (
  <>
    <PlausibleAnalytics />
    <CloudflareAnalytics />
    <GoogleAnalyticsLoader />
  </>
);

describe("analytics on a URL carrying a Stripe client secret", () => {
  beforeEach(() => {
    state.pathname = "/events/x/checkout";
    delete (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"];
  });
  afterEach(() => setSearch(""));

  it("loads no loader and switches GA off", () => {
    setSearch(
      `?payment_intent=pi_3Abc&payment_intent_client_secret=${SECRET}&redirect_status=succeeded`,
    );
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    expect(queryAllByTestId("ga")).toHaveLength(0);
    expect(gaFlag()).toBe(true);
  });

  it("loads all three on checkout without the secret", () => {
    setSearch("?step=pay");
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(2);
    expect(queryAllByTestId("ga")).toHaveLength(1);
    expect(gaFlag()).toBe(false);
  });

  it("loads once the param is gone on a later navigation", () => {
    setSearch(`?payment_intent_client_secret=${SECRET}`);
    const { queryAllByTestId, rerender } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    setSearch("");
    state.pathname = "/events/x";
    rerender(all());
    expect(queryAllByTestId("script")).toHaveLength(2);
  });
});

describe("LastVisitedUrlTracker", () => {
  beforeEach(() => {
    state.pathname = "/events/x/checkout";
    window.sessionStorage.clear();
  });
  afterEach(() => setSearch(""));

  it("never stores the client secret", () => {
    setSearch(
      `?payment_intent=pi_3Abc&payment_intent_client_secret=${SECRET}&redirect_status=succeeded`,
    );
    render(<LastVisitedUrlTracker />);
    const stored = window.sessionStorage.getItem("th:last_url") ?? "";
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("XyZ123");
    expect(stored).toContain("payment_intent=pi_3Abc");
  });

  it("stores an ordinary query string unchanged", () => {
    setSearch("?step=pay&x=1");
    render(<LastVisitedUrlTracker />);
    expect(window.sessionStorage.getItem("th:last_url")).toBe(
      "/events/x/checkout?step=pay&x=1",
    );
  });
});

describe("guard helpers", () => {
  it("detects and strips only secret params", () => {
    expect(searchCarriesClientSecret("?a=1")).toBe(false);
    expect(searchCarriesClientSecret(`?payment_intent_client_secret=${SECRET}`)).toBe(true);
    expect(stripClientSecretParams(`?a=1&payment_intent_client_secret=${SECRET}`)).toBe("?a=1");
    expect(stripClientSecretParams(`?payment_intent_client_secret=${SECRET}`)).toBe("");
    expect(stripClientSecretParams("?a=1")).toBe("?a=1");
  });

  it("redacts a token param in FIRST position of what remains", () => {
    expect(
      stripClientSecretParams(
        `?claim_token=TOPSECRETVALUE&payment_intent_client_secret=${SECRET}&a=1`,
      ),
    ).toBe("?claim_token=[redacted]&a=1");
  });
});

describe("event invite links (`?invite=<token>`)", () => {
  const TOKEN = "inv_TOPSECRETVALUE";

  afterEach(() => setSearch(""));

  it("matches and strips `invite` in first position", () => {
    expect(searchCarriesClientSecret(`?invite=${TOKEN}`)).toBe(true);
    expect(stripClientSecretParams(`?invite=${TOKEN}`)).toBe("");
    expect(stripClientSecretParams(`?invite=${TOKEN}&utm_source=mail`)).toBe(
      "?utm_source=mail",
    );
  });

  it("matches and strips `invite` in a later position", () => {
    expect(searchCarriesClientSecret(`?utm_source=mail&invite=${TOKEN}`)).toBe(
      true,
    );
    expect(
      stripClientSecretParams(`?utm_source=mail&invite=${TOKEN}&a=1`),
    ).toBe("?utm_source=mail&a=1");
  });

  it("leaves `invited` and other look-alikes untouched", () => {
    expect(searchCarriesClientSecret("?invited=1")).toBe(false);
    expect(stripClientSecretParams("?invited=1")).toBe("?invited=1");
    expect(searchCarriesClientSecret("?reinvite=1&invitee=2")).toBe(false);
  });

  it("matches a percent-encoded key and a token nested URL-encoded in another param", () => {
    expect(searchCarriesClientSecret(`?%69nvite=${TOKEN}`)).toBe(true);
    expect(stripClientSecretParams(`?%69nvite=${TOKEN}&a=1`)).toBe("?a=1");
    const nested = `?redirect=%2Fevents%2Fx%3Finvite%3D${TOKEN}`;
    expect(searchCarriesClientSecret(nested)).toBe(true);
    expect(stripClientSecretParams(nested)).not.toContain(TOKEN);
  });

  it("keeps every loader off and switches GA off while the token is on the URL", () => {
    state.pathname = "/events/x";
    setSearch(`?invite=${TOKEN}`);
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    expect(queryAllByTestId("ga")).toHaveLength(0);
    expect(gaFlag()).toBe(true);
  });

  it("re-checks when the page strips it in place (no pathname change)", () => {
    state.pathname = "/events/x";
    setSearch(`?invite=${TOKEN}`);
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    act(() => {
      setSearch("");
      window.dispatchEvent(new Event(ANALYTICS_URL_SCRUBBED_EVENT));
    });
    expect(queryAllByTestId("script")).toHaveLength(2);
    expect(queryAllByTestId("ga")).toHaveLength(1);
  });

  it("the last-visited URL never stores it", () => {
    state.pathname = "/events/x";
    window.sessionStorage.clear();
    setSearch(`?a=1&invite=${TOKEN}`);
    render(<LastVisitedUrlTracker />);
    const stored = window.sessionStorage.getItem("th:last_url") ?? "";
    expect(stored).toBe("/events/x?a=1");
  });
});

describe("a document that LOADED with a credential (Navigation Timing keeps the URL)", () => {
  const TOKEN = "inv_TOPSECRETVALUE";
  const navEntry = (name: string) =>
    vi
      .spyOn(performance, "getEntriesByType")
      .mockImplementation((type: string) =>
        type === "navigation"
          ? ([{ name }] as unknown as PerformanceEntryList)
          : [],
      );

  beforeEach(() => {
    state.pathname = "/events/x";
    delete (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setSearch("");
  });

  it("an entry with ?invite= keeps every loader off on a clean URL, also after the scrubbed event", () => {
    navEntry(`https://ithasfire.com/events/x?invite=${TOKEN}`);
    setSearch("");
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    expect(queryAllByTestId("ga")).toHaveLength(0);
    expect(gaFlag()).toBe(true);

    act(() => {
      window.dispatchEvent(new Event(ANALYTICS_URL_SCRUBBED_EVENT));
    });
    expect(queryAllByTestId("script")).toHaveLength(0);
    expect(queryAllByTestId("ga")).toHaveLength(0);
  });

  it("stays off across a soft navigation (only a new document clears it)", () => {
    navEntry(`https://ithasfire.com/events/x?a=1&invite=${TOKEN}`);
    const { queryAllByTestId, rerender } = render(all());
    state.pathname = "/events/y";
    rerender(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
  });

  it("a clean entry still loads once the in-place strip is announced", () => {
    navEntry("https://ithasfire.com/events/x?utm_source=mail");
    setSearch(`?invite=${TOKEN}`);
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    act(() => {
      setSearch("");
      window.dispatchEvent(new Event(ANALYTICS_URL_SCRUBBED_EVENT));
    });
    expect(queryAllByTestId("script")).toHaveLength(2);
    expect(queryAllByTestId("ga")).toHaveLength(1);
  });

  it("covers the other secrets the guard handles: a Stripe return in the entry keeps loaders off", () => {
    navEntry(
      `https://ithasfire.com/events/x/checkout?payment_intent_client_secret=${SECRET}`,
    );
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
  });

  it("an unavailable entry (or a throwing API) falls back to the current URL", () => {
    vi.spyOn(performance, "getEntriesByType").mockImplementation(() => {
      throw new Error("no timing");
    });
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(2);
  });
});

describe("a RELOADED invite landing (clean URL and entry, token stashed)", () => {
  const KEY = "th:invite:11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    state.pathname = "/events/x";
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    setSearch("");
  });

  it("keeps every loader off while a token is stashed, and loads once it is cleared", () => {
    window.sessionStorage.setItem(KEY, "inv_TOPSECRETVALUE");
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
    expect(queryAllByTestId("ga")).toHaveLength(0);

    act(() => {
      window.sessionStorage.removeItem(KEY);
      window.dispatchEvent(new Event(ANALYTICS_URL_SCRUBBED_EVENT));
    });
    expect(queryAllByTestId("script")).toHaveLength(2);
    expect(queryAllByTestId("ga")).toHaveLength(1);
  });

  it("other sessionStorage keys do not turn analytics off", () => {
    window.sessionStorage.setItem("th:last_url", "/events/x");
    window.sessionStorage.setItem("th-event-just-unlocked:abc", "1");
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(2);
  });
});

describe("token routes (`?token=`): /invites/stop and the accept pages", () => {
  const TOKEN = "optout_TOPSECRETVALUE";
  const navEntry = (name: string) =>
    vi
      .spyOn(performance, "getEntriesByType")
      .mockImplementation((type: string) =>
        type === "navigation"
          ? ([{ name }] as unknown as PerformanceEntryList)
          : [],
      );

  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>)["ga-disable-G-TEST"];
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it.each(["/invites/stop", "/invite/accept"])(
    "a document loaded on %s?token= keeps every loader off after a soft navigation to /",
    (path) => {
      navEntry(`https://ithasfire.com${path}?token=${TOKEN}`);
      window.history.replaceState({}, "", "/");
      state.pathname = "/";
      const { queryAllByTestId } = render(all());
      expect(queryAllByTestId("script")).toHaveLength(0);
      expect(queryAllByTestId("ga")).toHaveLength(0);
      expect(gaFlag()).toBe(true);
    },
  );

  it("an entry on a token route counts even with its query already gone", () => {
    navEntry("https://ithasfire.com/invites/stop");
    window.history.replaceState({}, "", "/");
    state.pathname = "/";
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(0);
  });

  it("an ordinary entry still loads everything on /", () => {
    navEntry("https://ithasfire.com/?utm_source=mail");
    window.history.replaceState({}, "", "/");
    state.pathname = "/";
    const { queryAllByTestId } = render(all());
    expect(queryAllByTestId("script")).toHaveLength(2);
  });

  it("treats a bare `token` key as a credential, exact key only", () => {
    expect(searchCarriesClientSecret(`?token=${TOKEN}`)).toBe(true);
    expect(searchCarriesClientSecret(`?a=1&token=${TOKEN}`)).toBe(true);
    expect(searchCarriesClientSecret(`?redirect=%2Fx%3Ftoken%3D${TOKEN}`)).toBe(
      true,
    );
    expect(searchCarriesClientSecret("?tokens=3&tokenized=1")).toBe(false);
    expect(stripClientSecretParams(`?token=${TOKEN}&a=1`)).toBe("?a=1");
  });

  it("the last-visited URL never stores ?token=, on any route", () => {
    state.pathname = "/reset-password";
    window.history.replaceState({}, "", `/reset-password?token=${TOKEN}&a=1`);
    render(<LastVisitedUrlTracker />);
    expect(window.sessionStorage.getItem("th:last_url")).toBe(
      "/reset-password?a=1",
    );
  });

  it("the last-visited URL skips /invites/stop entirely", () => {
    state.pathname = "/invites/stop";
    window.history.replaceState({}, "", `/invites/stop?token=${TOKEN}`);
    render(<LastVisitedUrlTracker />);
    expect(window.sessionStorage.getItem("th:last_url")).toBeNull();
  });
});
