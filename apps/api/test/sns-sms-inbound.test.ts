import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import {
  buildSnsStringToSign,
  defaultFetchCertPem,
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
  algorithm: "RSA-SHA1" | "RSA-SHA256" = "RSA-SHA256",
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
    SignatureVersion: "2",
    SigningCertURL: SIGNING_CERT_URL,
    ...overrides,
  } as Omit<SnsEnvelope, "Signature">;
  return signEnvelope(
    unsigned,
    unsigned.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1",
  );
}

type FakeConsentRow = {
  status: "OPTED_IN" | "OPTED_OUT";
  optedInAt: Date | null;
  optedOutAt: Date | null;
};

function makeFakeRepos() {
  // Stateful ledger following the port's ordering rule, so redelivery
  // order can be exercised end to end through the route.
  const rows = new Map<string, FakeConsentRow>();
  const smsConsent = {
    rows,
    getByPhone: vi.fn(async (phone: string) => rows.get(phone) ?? null),
    applyDecisionIfNewer: vi.fn(
      async (input: {
        phoneE164: string;
        status: "OPTED_IN" | "OPTED_OUT";
        eventAt: Date;
      }) => {
        const current = rows.get(input.phoneE164);
        const t = input.eventAt.getTime();
        const outAt = current?.optedOutAt?.getTime() ?? null;
        const inAt = current?.optedInAt?.getTime() ?? null;
        const stale =
          input.status === "OPTED_IN"
            ? (outAt !== null && t <= outAt) || (inAt !== null && t < inAt)
            : (inAt !== null && t < inAt) || (outAt !== null && t < outAt);
        if (current && stale) return { applied: false, record: current };
        const record: FakeConsentRow = {
          status: input.status,
          optedInAt:
            input.status === "OPTED_IN"
              ? input.eventAt
              : (current?.optedInAt ?? null),
          optedOutAt:
            input.status === "OPTED_OUT"
              ? input.eventAt
              : (current?.optedOutAt ?? null),
        };
        rows.set(input.phoneE164, record);
        return { applied: true, record };
      },
    ),
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
  reportError?: (err: unknown, ctx?: unknown) => void;
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
      reportError: input?.reportError,
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
  });

  it("opts in only on the carrier-standard START and UNSTOP", () => {
    expect(
      classifyInboundKeyword({ originationNumber: PHONE, messageBody: "unstop" }),
    ).toEqual({ kind: "opt_in", keyword: "UNSTOP" });
    // Conversation-like words are not consent: "Yes thanks" to a reminder
    // must never opt a number back in.
    for (const messageBody of ["YES", "Yes thanks", "optin", "Opt in!"]) {
      expect(
        classifyInboundKeyword({ originationNumber: PHONE, messageBody }).kind,
      ).toBe("other");
    }
    expect(
      classifyInboundKeyword({
        originationNumber: PHONE,
        messageBody: "yes",
        messageKeyword: "YES",
      }).kind,
    ).toBe("other");
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
    expect(fakes.smsConsent.applyDecisionIfNewer).toHaveBeenCalledWith(
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
    expect(fakes.smsConsent.applyDecisionIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: PHONE,
        status: "OPTED_IN",
        source: "sns_inbound",
        // Consent evidence: the provider message id, same as on STOP.
        providerMessageId: "inbound-2",
      }),
    );
    expect(fakes.smsConsent.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "opt_in",
        providerMessageId: "inbound-2",
      }),
    );
    // START must never silently re-enable volunteer reminder subscriptions.
    expect(fakes.volunteering.clearSmsOptInByPhone).not.toHaveBeenCalled();

    await app.close();
  });

  it('a "Yes thanks" reply to a reminder opts nobody in', async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "Yes thanks",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "ignored" });
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

    await app.close();
  });

  it("passes the envelope Timestamp through as the decision time", async () => {
    const { app, fakes } = await makeApp();
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "STOP",
    });

    await postEnvelope(app, envelope);

    expect(fakes.smsConsent.applyDecisionIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ eventAt: new Date(FRESH_TIMESTAMP) }),
    );

    await app.close();
  });

  it("a redelivered START older than the STOP leaves the number opted out; a newer START opts in", async () => {
    const fakes = makeFakeRepos();
    const { app } = await makeApp({ repos: fakes.repos });
    const t1 = "2026-07-07T11:40:00.000Z";
    const t2 = "2026-07-07T11:50:00.000Z";
    const t3 = "2026-07-07T11:55:00.000Z";

    const stop = await postEnvelope(
      app,
      makeNotificationEnvelope(
        { originationNumber: PHONE, messageBody: "STOP" },
        { Timestamp: t2 },
      ),
    );
    expect(stop.json()).toEqual({ ok: true, action: "opted_out" });

    const staleStart = await postEnvelope(
      app,
      makeNotificationEnvelope(
        { originationNumber: PHONE, messageBody: "START" },
        { Timestamp: t1, MessageId: "start-redelivered" },
      ),
    );
    expect(staleStart.statusCode).toBe(200);
    expect(staleStart.json()).toEqual({ ok: true, action: "ignored" });
    expect(fakes.smsConsent.rows.get(PHONE)?.status).toBe("OPTED_OUT");

    const freshStart = await postEnvelope(
      app,
      makeNotificationEnvelope(
        { originationNumber: PHONE, messageBody: "START" },
        { Timestamp: t3, MessageId: "start-new" },
      ),
    );
    expect(freshStart.json()).toEqual({ ok: true, action: "opted_in" });
    expect(fakes.smsConsent.rows.get(PHONE)?.status).toBe("OPTED_IN");

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
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
      SignatureVersion: "2",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com.evil.example/cert.pem",
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "bad_signature" });
    expect(fetchCertPem).not.toHaveBeenCalled();
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
      SignatureVersion: "2",
      SigningCertURL: SIGNING_CERT_URL,
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "topic_not_allowed" });
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
      SignatureVersion: "2",
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
      SignatureVersion: "2",
      SigningCertURL: SIGNING_CERT_URL,
    } as Omit<SnsEnvelope, "Signature">);

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, action: "ignored" });
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 500 on a transient ledger failure so SNS redelivers", async () => {
    const fakes = makeFakeRepos();
    fakes.smsConsent.applyDecisionIfNewer.mockRejectedValueOnce(
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

  it("a ledger failure that echoes the number reaches neither the log nor the thrown error", async () => {
    const fakes = makeFakeRepos();
    fakes.smsConsent.applyDecisionIfNewer.mockRejectedValueOnce(
      new Error(
        `Invalid \`smsConsent.updateMany()\` invocation: { phoneE164: "${PHONE}" }`,
      ),
    );
    const { app, logger } = await makeApp({ repos: fakes.repos });
    const thrown: unknown[] = [];
    app.addHook("onError", async (_req, _reply, err) => {
      thrown.push(err);
    });
    const envelope = makeNotificationEnvelope({
      originationNumber: PHONE,
      messageBody: "STOP",
    });

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(500);
    const digits = PHONE.slice(-7);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(digits);
    expect(thrown).toHaveLength(1);
    const err = thrown[0] as Error;
    expect(err.message).toContain("smsConsent.updateMany");
    expect(err.message).not.toContain(digits);
    expect(err.stack ?? "").not.toContain(digits);

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
    expect(fakes.smsConsent.applyDecisionIfNewer).toHaveBeenCalledWith(
      expect.objectContaining({ phoneE164: PHONE, status: "OPTED_OUT" }),
    );

    await app.close();
  });

  it("refuses a SignatureVersion 1 (SHA1) envelope before any cert fetch", async () => {
    const fetchCertPem = vi.fn(async () => PUBLIC_PEM);
    const reportError = vi.fn();
    const { app, fakes, logger } = await makeApp({ fetchCertPem, reportError });
    // Validly signed with SHA1 by the trusted key: still refused.
    const envelope = signEnvelope(
      {
        Type: "Notification",
        MessageId: "msg-v1",
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify({
          originationNumber: PHONE,
          messageBody: "STOP",
        }),
        Timestamp: FRESH_TIMESTAMP,
        SignatureVersion: "1",
        SigningCertURL: SIGNING_CERT_URL,
      } as unknown as Omit<SnsEnvelope, "Signature">,
      "RSA-SHA1",
    );

    const response = await postEnvelope(app, envelope);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "unsupported_signature_version",
    });
    expect(fetchCertPem).not.toHaveBeenCalled();
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();
    // Our topic switched to SHA1 would drop every STOP: logged at error
    // (Sentry) and reported, never a quiet warn.
    expect(logger.error).toHaveBeenCalledWith(
      "sns_sms_inbound_unsupported_signature_version",
      { signatureVersion: "1" },
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { stage: "signature_version" },
      extra: { signatureVersion: "1" },
    });

    await app.close();
  });

  it("a flood of SignatureVersion 1 envelopes reports and logs at error once per window", async () => {
    const reportError = vi.fn();
    const { app, logger } = await makeApp({ reportError });
    const unsigned = {
      Type: "Notification",
      MessageId: "msg-v1-flood",
      TopicArn: TOPIC_ARN,
      Message: "{}",
      Timestamp: FRESH_TIMESTAMP,
      SignatureVersion: "1",
      Signature: "not-verified",
      SigningCertURL: SIGNING_CERT_URL,
    };

    for (let i = 0; i < 5; i += 1) {
      const response = await postEnvelope(app, unsigned);
      expect(response.statusCode).toBe(400);
    }

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(5);

    await app.close();
  });

  it("checks the topic before the signature version: a foreign SHA1 envelope is a quiet 403", async () => {
    const reportError = vi.fn();
    const { app, logger } = await makeApp({ reportError });

    const response = await postEnvelope(app, {
      Type: "Notification",
      MessageId: "msg-foreign-v1",
      TopicArn: "arn:aws:sns:us-east-1:999999999999:someone-else",
      Message: "{}",
      Timestamp: FRESH_TIMESTAMP,
      SignatureVersion: "1",
      Signature: "x",
      SigningCertURL: SIGNING_CERT_URL,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "topic_not_allowed" });
    expect(logger.error).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();

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
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

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
    expect(fakes.smsConsent.applyDecisionIfNewer).not.toHaveBeenCalled();

    await app.close();
  });
});

describe("defaultFetchCertPem — fetch hardening", () => {
  const certUrl = (id: string) =>
    `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${id}.pem`;

  it("never follows a redirect", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PUBLIC_PEM, { status: 200 }));
    try {
      await defaultFetchCertPem(certUrl("redirectcheck"));
      expect(fetchSpy).toHaveBeenCalledWith(certUrl("redirectcheck"), {
        redirect: "error",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses a declared oversize cert before reading the body", async () => {
    const text = vi.fn(async () => PUBLIC_PEM);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(64 * 1024 + 1) }),
      body: null,
      text,
    } as unknown as Response);
    try {
      await expect(defaultFetchCertPem(certUrl("oversize"))).rejects.toThrow(
        "sns_cert_too_large",
      );
      expect(text).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
