import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// arrival-areas FR-010: one "Parking and drop-off: see the map" line linking
// to the event page. Core sets `gettingThereUrl` only when the line is owed;
// the template still never prints it beside a locked address.

const URL = "https://ithasfire.com/events/indie-fest-2025";

describe("ticket.issued: the getting-there line", () => {
  it("renders the line as a link to the event page when gettingThereUrl is set", async () => {
    const props = { ...sampleInputFor("ticket.issued"), gettingThereUrl: URL };
    const { html, text } = await render({ templateId: "ticket.issued", props });
    expect(html).toContain(`href="${URL}"`);
    expect(html).toContain("Parking and drop-off: see the map");
    expect(text).toContain("Parking and drop-off: see the map");
    // Never the raw catalog key.
    expect(html).not.toContain("gettingThereLink");
  });

  it("renders nothing without it", async () => {
    const { html } = await render({
      templateId: "ticket.issued",
      props: sampleInputFor("ticket.issued"),
    });
    expect(html).not.toContain(URL);
    expect(html).not.toContain("Parking and drop-off");
  });

  it("never beside a locked address", async () => {
    const props = {
      ...sampleInputFor("ticket.issued"),
      gettingThereUrl: URL,
      addressRevealAtISO: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    const { html } = await render({ templateId: "ticket.issued", props });
    expect(html).not.toContain(URL);
  });

  it("Spanish: the line in Spanish, never the raw key or the English", async () => {
    const props = { ...sampleInputFor("ticket.issued"), gettingThereUrl: URL };
    const { html, text } = await render({ templateId: "ticket.issued", props, locale: "es" });
    expect(html).toContain(`href="${URL}"`);
    expect(html).toContain("Dónde estacionar y dejar pasajeros: ver el mapa");
    expect(text).toContain("Dónde estacionar y dejar pasajeros: ver el mapa");
    expect(html).not.toContain("gettingThereLink");
    expect(html).not.toContain("Parking and drop-off");
  });
});
