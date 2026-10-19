import { render, screen, waitFor } from "@testing-library/react";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verdict: "signedOut" as "signedIn" | "signedOut" | "unknown",
  pathname: "/events/event/us/nashville/show--abc",
}));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/hooks/useSessionVerdict", () => ({
  useSessionVerdict: () => ({ verdict: mocks.verdict }),
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
}));
// next/dynamic resolves the lazy import; stub the body it loads.
vi.mock("next/dynamic", () => ({
  default: () =>
    function EventPageBodyStub({ data }: { data: { event: { name: string } } }) {
      return <h1>EVENT: {data.event.name}</h1>;
    },
}));

import {
  eventSlugFromPathname,
  HolderEventRecheck,
} from "../HolderEventRecheck";

const fetchMock = vi.fn();

function respond(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

describe("HolderEventRecheck", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    mocks.verdict = "signedOut";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("anonymous: renders the 404 and makes NO request", async () => {
    render(<HolderEventRecheck>404 PAGE</HolderEventRecheck>);
    expect(screen.getByText("404 PAGE")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed-in non-holder: one uncached POST, the 404 stays", async () => {
    mocks.verdict = "signedIn";
    respond({ access: "none" });
    render(<HolderEventRecheck>404 PAGE</HolderEventRecheck>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/events/holder-view",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify({ slug: "event/us/nashville/show--abc" }),
      }),
    );
    expect(screen.getByText("404 PAGE")).toBeInTheDocument();
  });

  it("signed-in holder: the event page replaces the 404", async () => {
    mocks.verdict = "signedIn";
    respond({
      access: "holder",
      data: superjson.serialize({ event: { name: "The Show" } }),
    });
    render(<HolderEventRecheck>404 PAGE</HolderEventRecheck>);
    expect(await screen.findByText("EVENT: The Show")).toBeInTheDocument();
    expect(screen.queryByText("404 PAGE")).not.toBeInTheDocument();
  });

  it("sets the event tab title on reveal and restores it on unmount", async () => {
    mocks.verdict = "signedIn";
    document.title = "Event not found • Ithas Fire";
    respond({
      access: "holder",
      data: superjson.serialize({ event: { name: "The Show" } }),
    });
    const { unmount } = render(<HolderEventRecheck>404 PAGE</HolderEventRecheck>);
    await screen.findByText("EVENT: The Show");
    expect(document.title).toBe("The Show • Ithas Fire");
    unmount();
    expect(document.title).toBe("Event not found • Ithas Fire");
  });

  it("leaves the next page's title alone on unmount after a soft navigation", async () => {
    mocks.verdict = "signedIn";
    document.title = "Event not found • Ithas Fire";
    respond({
      access: "holder",
      data: superjson.serialize({ event: { name: "The Show" } }),
    });
    const { unmount } = render(<HolderEventRecheck>404 PAGE</HolderEventRecheck>);
    await screen.findByText("EVENT: The Show");
    // The next route's <title> commits before passive unmount cleanups run.
    document.title = "Other page";
    unmount();
    expect(document.title).toBe("Other page");
  });

  it("leaves the title alone when the 404 stands", async () => {
    mocks.verdict = "signedIn";
    document.title = "Event not found • Ithas Fire";
    respond({ access: "none" });
    render(<HolderEventRecheck>404 PAGE</HolderEventRecheck>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.title).toBe("Event not found • Ithas Fire");
  });

  it("parses the slug from the path", () => {
    expect(eventSlugFromPathname("/events/event/us/x/y--z")).toBe(
      "event/us/x/y--z",
    );
    expect(eventSlugFromPathname("/events/a%20b/")).toBe("a b");
    expect(eventSlugFromPathname("/places/x")).toBeNull();
    expect(eventSlugFromPathname(null)).toBeNull();
  });
});
