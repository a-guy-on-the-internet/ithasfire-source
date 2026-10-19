import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

const base = {
  locale: "es",
  subject: "Esta vez no: Noches de Viernes",
  heading: "Esta vez no: Noches de Viernes",
  rows: [],
  paragraphs: ["Gracias por postularte. Esta vez quienes organizan no te eligieron."],
  quote: { label: "Su nota", text: "Nos encantó.\nLa próxima <b>sí</b>." },
  action: { label: "Abrir tu postulación", url: "https://ithasfire.com/my-applications" },
  links: [],
  footer: "Recibes este correo porque te postulaste a una convocatoria en Ithas Fire.",
};

describe("open_call.notice", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "open_call.notice",
      props: sampleInputFor("open_call.notice"),
    });
    expect(out.subject).toBe("You're on the lineup for Friday Night Sessions");
    expect(out.html).toContain('lang="en"');
    expect(out.text).toContain("Pay as posted: A split of the door: 70/30 after costs");
    expect(out.html).toContain('href="https://ithasfire.com/my-lineups"');
    expect(out.text).toContain("Drop out");
  });

  it("writes exactly the strings core sends, in their locale, with the note escaped and quoted", async () => {
    const out = await render({ templateId: "open_call.notice", props: base });
    expect(out.subject).toBe("Esta vez no: Noches de Viernes");
    expect(out.html).toContain('lang="es"');
    expect(out.text).toContain("Gracias por postularte.");
    expect(out.text).toContain("Su nota");
    // Free text is text: no markup survives.
    expect(out.html).not.toContain("<b>sí</b>");
    expect(out.html).toContain("&lt;b&gt;sí&lt;/b&gt;");
    expect(out.html).toContain('href="https://ithasfire.com/my-applications"');
  });

  it("refuses a non-http(s) link", async () => {
    await expect(
      render({
        templateId: "open_call.notice",
        props: { ...base, action: { label: "x", url: "javascript:alert(1)" } },
      }),
    ).rejects.toMatchObject({ code: "render_failed" });
    await expect(
      render({
        templateId: "open_call.notice",
        props: { ...base, links: [{ label: "x", url: "javascript:alert(1)" }] },
      }),
    ).rejects.toMatchObject({ code: "render_failed" });
  });
});
