import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import {
  buildSnsStringToSign,
  type SnsEnvelope,
} from "../src/routes/aws/sns-verify";
import { classifyInboundKeyword } from "../src/routes/aws/sms-inbound";

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:th-sms-inbound";
const SIGNING_CERT_URL =
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem";
const SUBSCRIBE_URL = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC_ARN}&Token=tok123`;
const PHONE = "+15555550123";
// The fake clock pins "now" to 12:00Z; envelope timestamps must sit inside
// the route's ±1h freshness window.
const FRESH_TIMESTAMP = "2026-07-07T11:59:00.000Z";
const STALE_TIMESTAMP = "2026-07-06T12:00:00.000Z";

// One keypair for the whole suite; the fake cert fetcher hands the verifier
// the public key PEM in place of AWS's X.509 cert.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function signEnvelope(
  unsigned: Omit<SnsEnvelope, "Signature">,
  algorithm: "RSA-SHA1" | "RSA-SHA256" = "RSA-SHA1",
): Record<string, unknown> {
  const signer = createSign(algorithm);
  signer.update(buildSnsStringToSign(unsigned as SnsEnvelope), "utf8");
  return { ...unsigned, Signature: signer.sign(privateKey, "base64") };
}

function makeNotificationEnvelope(
  message: Record<string, unknown>,
  overrides: Partial<SnsEnvelope> = {},
) {
  const unsigned = {
    Type: "Notification",
    MessageId: "msg-1",
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(message),
    Timestamp: FRESH_TIMESTAMP,
    SignatureVersion: "1",
    SigningCertURL: SIGNING_CERT_URL,
    ...overrides,
  } as Omit<SnsEnvelope, "Signature">;
  return signEnvelope(
    unsigned,
    unsigned.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1",
  );
}

function makeFakeRepos() {
  const smsConsent = {
    getByPhone: vi.fn(async () => null),
    upsertStatus: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
    })),
    recordEvent: vi.fn(async () => {}),
  };
  const volunteering = {
    clearSmsOptInByPhone: vi.fn(async () => 2),
  };
  const audit = { log: vi.fn(async () => {}) };
  const repos = {
    smsConsent,
    volunteering,
    audit,
    tx: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({ smsConsent, volunteering, audit }),
  };
  return { repos, smsConsent, volunteering, audit };
}

async function makeApp(input?: {
  topicArn?: string | undefined;
  repos?: ReturnType<typeof makeFakeRepos>["repos"];
  confirmSubscription?: (url: string) => Promise<void>;
  fetchCertPem?: (url: string) => Promise<string>;
}) {
  vi.resetModules();
  if (input && "topicArn" in input && input.topicArn === undefined) {
    delete process.env.AWS_SNS_SMS_INBOUND_TOPIC_ARN;
  } else {
    process.env.AWS_SNS_SMS_INBOUND_TOPIC_ARN = input?.topicArn ?? TOPIC_ARN;
  }
  process.env.NODE_ENV = "test";

  const { default: rawBody } = await import("../src/plugins/raw-body");
  const { default: smsInbound } = await import("../src/routes/aws/sms-inbound");

  const app = Fastify({ logger: false });
  const logger = makeLogger();
  const fakes = makeFakeRepos();
  const repos = input?.repos ?? fakes.repos;

  app.decorate("deps", {
    logger,
    trpc: {
      repos,
      clock: { now: () => new Date("2026-07-07T12:00:00.000Z") },
    },
  });

  await app.register(rawBody);
  await app.register(smsInbound as never, {
    fetchCertPem: input?.fetchCertPem ?? (async () => PUBLIC_PEM),
    confirmSubscription: input?.confirmSubscription,
  } as never);

  return { app, logger, fakes };
}

async function postEnvelope(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  envelope: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/webhooks/aws/sms-inbound",
    headers: { "content-type": "text/plain; charset=UTF-8" },
    payload: JSON.stringify(envelope),
  });
}

describe("classifyInboundKeyword", () => {
  it("classifies STOP-family body tokens case-insensitively, ignoring trailing punctuation", () => {
    expect(classifyInboundKeyword({ originationNumber: PHONE, messageBody: "stop!" }))
      .toEqual({ kind: "opt_out", keyword: "STOP" });
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "Unsubscribe me please",
      }),
    ).toEqual({ kind: "opt_out", keyword: "UNSUBSCRIBE" });
  });

  it("classifies START-family replies as opt-in", () => {
    expect(
      classifyInboundKeyword({ originationNumber: PHONE, messageBody: "START" }),
    ).toEqual({ kind: "opt_in", keyword: "START" });
  });

  it("falls back to the provider messageKeyword when the body is empty", () => {
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "",
        messageKeyword: "STOP",
      }),
    ).toEqual({ kind: "opt_out", keyword: "STOP" });
  });

  it("treats non-keyword chatter as other", () => {
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "what time do doors open?",
      }).kind,
    ).toBe("other");
  });

  it("classifies REVOKE as a STOP-family keyword", () => {
    expect(
      classifyInboundKeyword({ originationNumber: PHONE, messageBody: "revoke" }),
    ).toEqual({ kind: "opt_out", keyword: "REVOKE" });
  });

  it("handles two-word forms via the first two tokens joined", () => {
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "opt out",
      }),
    ).toEqual({ kind: "opt_out", keyword: "OPT OUT" });
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "Opt in!",
      }),
    ).toEqual({ kind: "opt_in", keyword: "OPT IN" });
  });

  it("prefers AWS's matched messageKeyword over body token parsing", () => {
    // "Please stop" defeats first-token parsing; the provider's
    // matched-keyword echo is authoritative.
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "Please stop",
        messageKeyword: "STOP",
      }),
    ).toEqual({ kind: "opt_out", keyword: "STOP" });
  });

  it("falls back to body parsing when messageKeyword is not a consent keyword", () => {
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "STOP",
        messageKeyword: "KEYWORD_HELLO",
      }),
    ).toEqual({ kind: "opt_out", keyword: "STOP" });
  });
});

describe("sns sms-inbound webhook route", () => {
  it("records an opt-out (and clears volunteer sms opt-ins) for a signed STOP notification", async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      destinationNumber: "+15555550999",
      messageKeyword: "STOP",
      messageBody: "STOP",
      inboundMessageId: "inbound-1",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "opted_out" });
    expect(fakes.smsConsent.upsertStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: PHONE,
        status: "OPTED_OUT",
        source: "sns_inbound",
        reasonKeyword: "STOP",
        providerMessageId: "inbound-1",
      }),
    );
    expect(fakes.volunteering.clearSmsOptInByPhone).toHaveBeenCalledWith(PHONE);
    expect(fakes.audit.log).toHaveBeenCalled();

    await app.close();
  });

  it("records a provider opt-in signal for a signed START notification", async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "START",
      inboundMessageId: "inbound-2",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "opted_in" });
    expect(fakes.smsConsent.upsertStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: PHONE,
        status: "OPTED_IN",
        source: "sns_inbound",
      }),
    );
    // START must never silently re-enable volunteer reminder subscriptions.
    expect(fakes.volunteering.clearSmsOptInByPhone).not.toHaveBeenCalled();

    await app.close();
  });

  it("acks non-keyword chatter without touching the ledger", async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "what time do doors open?",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "ignored" });
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a tampered payload (bad signature) without touching the ledger", async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "STOP",
    });
    // Tamper AFTER signing.
    envelope.Message = JSON.stringify({
      originationNumber: "+15555550666",
      messageBody: "STOP",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "bad_signature" });
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects an untrusted SigningCertURL host before fetching anything", async () => {
    const fetchCertPem = vi.fn(async () => PUBLIC_PEM);
    const { app, fakes } = await makeApp({ fetchCertPem });
    const envelope = signEnvelope({
      Type: "Notification",
      MessageId: "msg-evil",
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify({ originationNumber: PHONE, messageBody: "STOP" }),
      Timestamp: FRESH_TIMESTAMP,
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com.evil.example/cert.pem",
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "bad_signature" });
    expect(fetchCertPem).not.toHaveBeenCalled();
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects envelopes for a topic outside the allow-list", async () => {
    const { app, fakes } = await makeApp();
    const envelope = signEnvelope({
      Type: "Notification",
      MessageId: "msg-other-topic",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:some-other-topic",
      Message: JSON.stringify({ originationNumber: PHONE, messageBody: "STOP" }),
      Timestamp: FRESH_TIMESTAMP,
      SignatureVersion: "1",
      SigningCertURL: SIGNING_CERT_URL,
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "topic_not_allowed" });
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("confirms a signed SubscriptionConfirmation via its SubscribeURL", async () => {
    const confirmSubscription = vi.fn(async () => {});
    const { app } = await makeApp({ confirmSubscription });
    const envelope = signEnvelope({
      Type: "SubscriptionConfirmation",
      MessageId: "msg-sub",
      TopicArn: TOPIC_ARN,
      Message: "You have chosen to subscribe...",
      Timestamp: FRESH_TIMESTAMP,
      SignatureVersion: "1",
      SigningCertURL: SIGNING_CERT_URL,
      SubscribeURL: SUBSCRIBE_URL,
      Token: "tok123",
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      action: "subscription_confirmed",
    });
    expect(confirmSubscription).toHaveBeenCalledWith(SUBSCRIBE_URL);

    await app.close();
  });

  it("acks malformed nested messages so SNS stops retrying", async () => {
    const { app, fakes } = await makeApp();
    const envelope = signEnvelope({
      Type: "Notification",
      MessageId: "msg-mangled",
      TopicArn: TOPIC_ARN,
      Message: "not-json-at-all",
      Timestamp: FRESH_TIMESTAMP,
      SignatureVersion: "1",
      SigningCertURL: SIGNING_CERT_URL,
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "ignored" });
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 500 on a transient ledger failure so SNS redelivers", async () => {
    const fakes = makeFakeRepos();
    fakes.smsConsent.upsertStatus.mockRejectedValueOnce(
      new Error("db unavailable"),
    );
    const { app } = await makeApp({ repos: fakes.repos });
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "STOP",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(500);

    await app.close();
  });

  it("accepts a SignatureVersion 2 (RSA-SHA256) envelope", async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope(
      { originationNumber: PHONE, messageBody: "STOP" },
      { SignatureVersion: "2" },
    );

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "opted_out" });
    expect(fakes.smsConsent.upsertStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phoneE164: PHONE, status: "OPTED_OUT" }),
    );

    await app.close();
  });

  it("rejects a stale-timestamp envelope (replay bound) before any cert fetch", async () => {
    const fetchCertPem = vi.fn(async () => PUBLIC_PEM);
    const { app, fakes } = await makeApp({ fetchCertPem });
    const envelope = makeNotificationEnvelope(
      { originationNumber: PHONE, messageBody: "STOP" },
      { Timestamp: STALE_TIMESTAMP },
    );

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "stale_timestamp" });
    expect(fetchCertPem).not.toHaveBeenCalled();
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a SigningCertURL with a non-cert path before fetching", async () => {
    const fetchCertPem = vi.fn(async () => PUBLIC_PEM);
    const { app, fakes } = await makeApp({ fetchCertPem });
    const envelope = makeNotificationEnvelope(
      { originationNumber: PHONE, messageBody: "STOP" },
      {
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/evil-cert.pem",
      },
    );

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "bad_signature" });
    expect(fetchCertPem).not.toHaveBeenCalled();
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a SigningCertURL carrying a query string before fetching", async () => {
    const fetchCertPem = vi.fn(async () => PUBLIC_PEM);
    const { app, fakes } = await makeApp({ fetchCertPem });
    const envelope = makeNotificationEnvelope(
      { originationNumber: PHONE, messageBody: "STOP" },
      {
        SigningCertURL: `${SIGNING_CERT_URL}?redirect=https://evil.example`,
      },
    );

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "bad_signature" });
    expect(fetchCertPem).not.toHaveBeenCalled();
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 503 when the inbound topic ARN is not configured", async () => {
    const { app, fakes } = await makeApp({ topicArn: undefined });
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "STOP",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "not_configured" });
    expect(fakes.smsConsent.upsertStatus).not.toHaveBeenCalled();

    await app.close();
  });
});
