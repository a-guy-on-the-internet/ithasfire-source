import { describe, expect, it, vi } from "vitest";

import { GoogleCloudTranslationAdapter } from "../google-cloud-translation-adapter";
import { FakeTranslator } from "../fake-translator";

function makeAdapter(fetchImpl: typeof fetch) {
  return new GoogleCloudTranslationAdapter({
    projectId: "proj-1",
    getAccessToken: async () => "tok",
    fetchImpl,
  });
}

const ok = (translatedText: string) =>
  new Response(JSON.stringify({ translations: [{ translatedText }] }), {
    status: 200,
  });

describe("GoogleCloudTranslationAdapter", () => {
  it("posts text/plain translateText with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => ok("Música"));
    const out = await makeAdapter(
      fetchImpl as unknown as typeof fetch,
    ).translate({ text: "Music", source: "en", targets: ["es"] });
    expect(out).toEqual({ es: "Música" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://translation.googleapis.com/v3/projects/proj-1/locations/global:translateText",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      contents: ["Music"],
      sourceLanguageCode: "en",
      targetLanguageCode: "es",
      mimeType: "text/plain",
    });
  });

  it("keeps a literal ampersand", async () => {
    const fetchImpl = vi.fn(async () => ok("Comida & bebida"));
    const out = await makeAdapter(
      fetchImpl as unknown as typeof fetch,
    ).translate({ text: "Food & Drink", source: "en", targets: ["es"] });
    expect(out.es).toBe("Comida & bebida");
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.contents).toEqual(["Food & Drink"]);
  });

  it("makes one request per target and skips the source locale", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const target = JSON.parse(init?.body as string).targetLanguageCode;
      return ok(`${target}-x`);
    });
    const out = await makeAdapter(
      fetchImpl as unknown as typeof fetch,
    ).translate({
      text: "Music",
      source: "en",
      targets: ["es", "fr", "en", "es"],
    });
    expect(out).toEqual({ es: "es-x", fr: "fr-x" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws with the status on a non-2xx answer", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("denied", { status: 403 }),
    );
    await expect(
      makeAdapter(fetchImpl as unknown as typeof fetch).translate({
        text: "Music",
        source: "en",
        targets: ["es"],
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("keeps the input text out of the error message", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("echo: Secret Name", { status: 403 }),
    );
    const err = await makeAdapter(fetchImpl as unknown as typeof fetch)
      .translate({ text: "Secret Name", source: "en", targets: ["es"] })
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain("Secret Name");
  });

  it("URL-encodes the project id in the path", async () => {
    const fetchImpl = vi.fn(async () => ok("x"));
    await new GoogleCloudTranslationAdapter({
      projectId: "a/b c",
      getAccessToken: async () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).translate({ text: "Music", source: "en", targets: ["es"] });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain(
      "/projects/a%2Fb%20c/locations/",
    );
  });

  it("bounds a stalled token fetch with the request timeout", async () => {
    const adapter = new GoogleCloudTranslationAdapter({
      projectId: "p",
      getAccessToken: () => new Promise(() => {}),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      timeoutMs: 20,
    });
    await expect(
      adapter.translate({ text: "Music", source: "en", targets: ["es"] }),
    ).rejects.toThrow(/timed out/);
  });

  it("omits a target the service returned nothing for", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const out = await makeAdapter(
      fetchImpl as unknown as typeof fetch,
    ).translate({ text: "Music", source: "en", targets: ["es"] });
    expect(out).toEqual({});
  });

  it("throws when no access token is available", async () => {
    const adapter = new GoogleCloudTranslationAdapter({
      projectId: "p",
      getAccessToken: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      adapter.translate({ text: "Music", source: "en", targets: ["es"] }),
    ).rejects.toThrow(/access token/);
  });
});

describe("FakeTranslator", () => {
  it("is deterministic and prefers the dictionary", async () => {
    const fake = new FakeTranslator({ "es:Music": "Música" });
    expect(
      await fake.translate({ text: "Music", source: "en", targets: ["es"] }),
    ).toEqual({ es: "Música" });
    expect(
      await fake.translate({ text: "Art", source: "en", targets: ["es"] }),
    ).toEqual({ es: "[es] Art" });
  });
});
