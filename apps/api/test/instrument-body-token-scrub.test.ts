import { describe, expect, it, vi } from "vitest";

/**
 * Invite accept/preview calls carry a bearer token in the POST body; with
 * `sendDefaultPii` it lands in `request.data`. beforeSend (and
 * beforeSendTransaction) must redact it (security review, 2026-09-29).
 */

const initMock = vi.fn();
vi.mock("@sentry/node", () => ({
  init: initMock,
  fastifyIntegration: vi.fn(() => ({ name: "Fastify" })),
  pinoIntegration: vi.fn(() => ({ name: "Pino" })),
}));
vi.mock("isbot", () => ({ isbot: () => false }));

type Hook = (e: Record<string, unknown>) => Record<string, any> | null;

async function hooks() {
  initMock.mockClear();
  vi.resetModules();
  process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
  const mod = await import("../src/instrument");
  const cfg = initMock.mock.calls.at(-1)?.[0] as {
    beforeSend: Hook;
    beforeSendTransaction: Hook;
  };
  return {
    ...cfg,
    scrubRequestBodyTokens: mod.scrubRequestBodyTokens,
    scrubRequestUrlTokens: mod.scrubRequestUrlTokens,
  };
}

const errorEvent = (data: unknown) => ({
  exception: { values: [{ type: "Error", value: "boom" }] },
  request: { url: "https://api/trpc/orgs.acceptInvitation", data },
});

describe("Sentry request-body token redaction", () => {
  it("redacts a top-level token and keeps other keys", async () => {
    const { beforeSend } = await hooks();
    const sent = beforeSend(errorEvent({ token: "SECRET", orgId: "o1" }));
    expect(sent?.request.data).toEqual({ token: "[redacted]", orgId: "o1" });
  });

  it("redacts inside the tRPC envelope, single and batched, object or JSON string", async () => {
    const { beforeSend } = await hooks();
    const single = beforeSend(errorEvent({ json: { token: "S1" } }));
    expect(JSON.stringify(single?.request.data)).not.toContain("S1");

    const batched = beforeSend(
      errorEvent(JSON.stringify({ "0": { json: { token: "S2", x: 1 } } })),
    );
    expect(batched?.request.data).not.toContain("S2");
    expect(JSON.parse(batched?.request.data)["0"].json.x).toBe(1);
  });

  it("redacts a non-JSON form body textually", async () => {
    const { scrubRequestBodyTokens } = await hooks();
    const e = scrubRequestBodyTokens({ request: { data: "a=1&token=S3" } });
    expect(e.request.data).toBe("a=1&token=[redacted]");
  });

  it("beforeSendTransaction redacts too", async () => {
    const { beforeSendTransaction } = await hooks();
    const sent = beforeSendTransaction({
      transaction: "POST /trpc/delegates.acceptInvite",
      request: { data: { json: { token: "S4" } } },
    });
    expect(JSON.stringify(sent)).not.toContain("S4");
  });

  // `embeds.confirmGuestPayment` posts a Stripe PaymentIntent client secret,
  // the guest's only proof of ownership. gitleaks:allow (fake test fixtures)
  it("redacts a clientSecret in the tRPC envelope, object or JSON string, and keeps the other keys", async () => {
    const { beforeSend } = await hooks();
    const body = {
      json: {
        embedId: "e1",
        hostOrigin: "https://shop.example.com",
        clientSecret: "pi_3Abc_secret_FakeBodyFixtureA",
      },
    };
    const asObject = beforeSend(errorEvent(body));
    expect(asObject?.request.data).toEqual({
      json: {
        embedId: "e1",
        hostOrigin: "https://shop.example.com",
        clientSecret: "[redacted]",
      },
    });

    const batched = beforeSend(
      errorEvent(
        JSON.stringify({
          "0": {
            json: { embedId: "e1", clientSecret: "pi_3Abc_secret_FakeBodyFixtureB" },
          },
        }),
      ),
    );
    expect(batched?.request.data).not.toContain("FakeBodyFixtureB");
    expect(JSON.parse(batched?.request.data)["0"].json.embedId).toBe("e1");
  });

  it("redacts a clientSecret in a body that is not valid JSON, and in a transaction", async () => {
    const { scrubRequestBodyTokens, beforeSendTransaction } = await hooks();
    const e = scrubRequestBodyTokens({
      request: { data: '{"clientSecret":"pi_3Abc_secret_FakeBodyFixtureC", ' },
    });
    expect(e.request.data).toBe('{"clientSecret":"[redacted]", ');

    const sent = beforeSendTransaction({
      transaction: "POST /trpc/embeds.confirmGuestPayment",
      request: { data: { json: { clientSecret: "pi_3Abc_secret_FakeBodyFixtureD" } } },
    });
    expect(JSON.stringify(sent)).not.toContain("FakeBodyFixtureD");
  });

  it("redacts a checkout clientKey (with the guest's email and cart it replays the create answer, secret included), every body shape", async () => {
    const { beforeSend, beforeSendTransaction, scrubRequestBodyTokens } =
      await hooks();
    const body = {
      json: {
        embedId: "e1",
        guestEmail: "guest@example.com",
        clientKey: "emb_1760184000000_FakeKeyFixtureA",
      },
    };

    const asObject = beforeSend(errorEvent(body));
    expect(asObject?.request.data).toEqual({
      json: {
        embedId: "e1",
        guestEmail: "guest@example.com",
        clientKey: "[redacted]",
      },
    });

    const batched = beforeSend(
      errorEvent(
        JSON.stringify({
          "0": { json: { embedId: "e1", clientKey: "FakeKeyFixtureB-uuid" } },
        }),
      ),
    );
    expect(batched?.request.data).not.toContain("FakeKeyFixtureB");
    expect(JSON.parse(batched?.request.data)["0"].json.embedId).toBe("e1");

    // Not valid JSON: the textual pass.
    const broken = scrubRequestBodyTokens({
      request: { data: '{"clientKey":"FakeKeyFixtureC", ' },
    });
    expect(broken.request.data).toBe('{"clientKey":"[redacted]", ');

    const sent = beforeSendTransaction({
      transaction: "POST /trpc/embeds.createGuestCheckout",
      request: { data: { json: { clientKey: "FakeKeyFixtureD" } } },
    });
    expect(JSON.stringify(sent)).not.toContain("FakeKeyFixtureD");
  });

  it("walks arrays: a body sent as an array of calls is redacted too", async () => {
    const { beforeSend } = await hooks();
    const sent = beforeSend(
      errorEvent([
        { json: { token: "A1", orgId: "o1" } },
        { json: { clientSecret: "pi_3Abc_secret_FakeArrayFixtureA" } },
      ]),
    );
    expect(sent?.request.data).toEqual([
      { json: { token: "[redacted]", orgId: "o1" } },
      { json: { clientSecret: "[redacted]" } },
    ]);

    const nested = beforeSend(
      errorEvent(
        JSON.stringify({ json: { items: [{ inviteToken: "A2", n: 1 }] } }),
      ),
    );
    expect(nested?.request.data).not.toContain("A2");
    expect(JSON.parse(nested?.request.data).json.items[0].n).toBe(1);
  });

  it("redacts token= and secret= values in request.url and request.query_string, and keeps the rest", async () => {
    const { beforeSend, beforeSendTransaction } = await hooks();
    const event = () => ({
      exception: { values: [{ type: "Error", value: "boom" }] },
      request: {
        url: "https://api/embed/return?embedId=e1&payment_intent_client_secret=pi_3Abc_secret_FakeUrlFixtureA&redirect_status=succeeded",
        query_string:
          "embedId=e1&payment_intent_client_secret=pi_3Abc_secret_FakeUrlFixtureA&token=U1&redirect_status=succeeded",
      },
    });

    const sent = beforeSend(event());
    expect(sent?.request.url).toBe(
      "https://api/embed/return?embedId=e1&payment_intent_client_secret=[redacted]&redirect_status=succeeded",
    );
    expect(sent?.request.query_string).toBe(
      "embedId=e1&payment_intent_client_secret=[redacted]&token=[redacted]&redirect_status=succeeded",
    );

    const tx = beforeSendTransaction({ transaction: "GET /embed/return", ...event() });
    expect(JSON.stringify(tx)).not.toMatch(/FakeUrlFixture|U1/);
  });

  it("redacts a secret inside a tRPC GET input (URL-encoded JSON) and in object / pair query strings", async () => {
    const { scrubRequestUrlTokens } = await hooks();
    const encoded = encodeURIComponent(
      JSON.stringify({ json: { embedId: "e1", clientSecret: "pi_3Abc_secret_FakeUrlFixtureB" } }),
    );
    const asString = scrubRequestUrlTokens({
      request: { url: `https://api/trpc/x?input=${encoded}`, query_string: `input=${encoded}` },
    });
    expect(JSON.stringify(asString)).not.toContain("FakeUrlFixtureB");
    expect(asString.request.url).toContain("embedId");

    const asObject = scrubRequestUrlTokens({
      request: { query_string: { clientSecret: "pi_3Abc_secret_FakeUrlFixtureC", page: "2" } },
    });
    expect(asObject.request.query_string).toEqual({ clientSecret: "[redacted]", page: "2" });

    const asPairs = scrubRequestUrlTokens({
      request: { query_string: [["token", "U2"], ["page", "2"]] },
    });
    expect(asPairs.request.query_string).toEqual([["token", "[redacted]"], ["page", "2"]]);
  });

  it("keeps the key name and redacts the value for prefixed keys, in a URL and in a form body", async () => {
    const { scrubRequestUrlTokens, scrubRequestBodyTokens } = await hooks();
    const query =
      "a=1&refreshToken=K1&client_secret=K2&payment_intent_client_secret=K3&invite-token=K4&x.token=K5&b=2";
    const expected =
      "a=1&refreshToken=[redacted]&client_secret=[redacted]&payment_intent_client_secret=[redacted]&invite-token=[redacted]&x.token=[redacted]&b=2";

    const url = scrubRequestUrlTokens({
      request: { url: `https://api/x?${query}#frag`, query_string: query },
    });
    expect(url.request.url).toBe(`https://api/x?${expected}#frag`);
    expect(url.request.query_string).toBe(expected);

    // The form-body fallback (a body that is not JSON) uses the same shape.
    const body = scrubRequestBodyTokens({ request: { data: query } });
    expect(body.request.data).toBe(expected);
  });

  it("stays linear on a long URL or body with nothing to redact (16 KB of letters in well under 50 ms)", async () => {
    const { scrubRequestUrlTokens, scrubRequestBodyTokens } = await hooks();
    const letters = "a".repeat(16 * 1024);
    // The body pass only runs its patterns on a string naming token/secret.
    const body = `${letters}token`;

    const started = performance.now();
    const url = scrubRequestUrlTokens({
      request: { url: `https://api/x?${letters}`, query_string: letters },
    });
    const data = scrubRequestBodyTokens({ request: { data: body } });
    const elapsedMs = performance.now() - started;

    expect(url.request.url).toBe(`https://api/x?${letters}`);
    expect(url.request.query_string).toBe(letters);
    expect(data.request.data).toBe(body);
    expect(elapsedMs).toBeLessThan(50);
  });

  it("leaves a URL and query string without tokens untouched", async () => {
    const { beforeSend } = await hooks();
    const sent = beforeSend({
      exception: { values: [{ type: "Error", value: "boom" }] },
      request: { url: "https://api/trpc/events.list?page=2", query_string: "page=2" },
    });
    expect(sent?.request.url).toBe("https://api/trpc/events.list?page=2");
    expect(sent?.request.query_string).toBe("page=2");
  });

  it("leaves bodies without tokens untouched", async () => {
    const { beforeSend } = await hooks();
    const sent = beforeSend(errorEvent({ json: { orgId: "o1" } }));
    expect(sent?.request.data).toEqual({ json: { orgId: "o1" } });
  });
});

describe("Sentry frame-locals token redaction", () => {
  it("redacts *token keys in exception frame vars, including nested input objects", async () => {
    const { beforeSend } = await hooks();
    const sent = beforeSend({
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                { function: "acceptInvitation", vars: { token: "F1", orgId: "o1" } },
                { function: "execute", vars: { input: { actorHumanId: "h1", token: "F2" } } },
                { function: "noVars" },
              ],
            },
          },
        ],
      },
    });
    const frames = sent?.exception.values[0].stacktrace.frames;
    expect(JSON.stringify(frames)).not.toMatch(/F[12]/);
    expect(frames[0].vars).toEqual({ token: "[redacted]", orgId: "o1" });
    expect(frames[1].vars.input.actorHumanId).toBe("h1");
    expect(frames[2]).toEqual({ function: "noVars" });
  });

  it("redacts *secret keys in exception frame vars (confirmEmbedGuestPayment's locals)", async () => {
    const { beforeSend } = await hooks();
    const sent = beforeSend({
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                {
                  function: "confirmEmbedGuestPayment",
                  vars: {
                    paymentIntentId: "pi_3Abc",
                    input: { embedId: "e1", clientSecret: "pi_3Abc_secret_FakeFrameFixtureA" },
                  },
                },
                {
                  function: "retrieveWhenSecretMatches",
                  vars: {
                    presentedSecret: "pi_3Abc_secret_FakeFrameFixtureB",
                    retrieved: { id: "pi_3Abc", clientSecret: "pi_3Abc_secret_FakeFrameFixtureC" },
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const frames = sent?.exception.values[0].stacktrace.frames;
    expect(JSON.stringify(frames)).not.toContain("FakeFrameFixture");
    expect(frames[0].vars.paymentIntentId).toBe("pi_3Abc");
    expect(frames[0].vars.input.embedId).toBe("e1");
    expect(frames[1].vars.retrieved.id).toBe("pi_3Abc");
  });
});
