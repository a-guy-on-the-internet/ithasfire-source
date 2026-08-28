import { createVerify } from "node:crypto";

import { z } from "zod";

/**
 * AWS SNS HTTP(S) envelope — shared by SubscriptionConfirmation,
 * Notification, and UnsubscribeConfirmation deliveries. Field names are
 * AWS's PascalCase wire format; extra fields (e.g. `UnsubscribeURL`,
 * `MessageAttributes`) pass through untouched.
 */
export const snsEnvelopeSchema = z
  .object({
    Type: z.enum([
      "Notification",
      "SubscriptionConfirmation",
      "UnsubscribeConfirmation",
    ]),
    MessageId: z.string().min(1),
    TopicArn: z.string().min(1).max(2048),
    Message: z.string().max(512 * 1024),
    Timestamp: z.string().min(1),
    SignatureVersion: z.enum(["1", "2"]),
    Signature: z.string().min(1),
    SigningCertURL: z.string().url(),
    Subject: z.string().optional(),
    SubscribeURL: z.string().url().optional(),
    Token: z.string().optional(),
  })
  .loose();

export type SnsEnvelope = z.infer<typeof snsEnvelopeSchema>;

/**
 * Hosts AWS actually serves SNS signing certs / subscribe confirmations from:
 * `sns.<region>.amazonaws.com` (plus the China partition suffix). Anything
 * else — http://, attacker-controlled hosts, lookalike domains — is rejected
 * BEFORE any network fetch (NFR-002).
 */
const AMAZON_SNS_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * The only path shape AWS serves SNS signing certs under. Anything else on a
 * legitimate SNS host (API endpoints, redirect-bearing paths) must never be
 * fetched as a "cert".
 */
const SIGNING_CERT_PATH_PATTERN =
  /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/;

/**
 * Parse + validate that a URL from an SNS envelope (SigningCertURL /
 * SubscribeURL) is an HTTPS URL on a real AWS SNS host. Throws on anything
 * else so callers fail closed. SubscribeURL keeps host-only validation — it
 * legitimately carries query params (Action/Token/TopicArn).
 */
export function assertAmazonSnsUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("sns_url_not_https");
  }
  if (!AMAZON_SNS_HOST_PATTERN.test(url.hostname)) {
    throw new Error("sns_url_untrusted_host");
  }
  return url;
}

/**
 * Stricter validation for `SigningCertURL` specifically: on top of the
 * host/protocol check, the pathname must be the canonical
 * `/SimpleNotificationService-<id>.pem` shape and carry NO query string.
 */
export function assertAmazonSnsCertUrl(rawUrl: string): URL {
  const url = assertAmazonSnsUrl(rawUrl);
  if (!SIGNING_CERT_PATH_PATTERN.test(url.pathname)) {
    throw new Error("sns_cert_url_bad_path");
  }
  if (url.search !== "") {
    throw new Error("sns_cert_url_has_query");
  }
  return url;
}

/**
 * Canonical string-to-sign per the AWS SNS signature spec: the sorted
 * `Name\nValue\n` pairs for the message type. `Subject` is included only
 * when present (Notification); SubscriptionConfirmation/Unsubscribe include
 * SubscribeURL + Token instead.
 */
export function buildSnsStringToSign(envelope: SnsEnvelope): string {
  const keys =
    envelope.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);

  let stringToSign = "";
  for (const key of keys) {
    const value = envelope[key];
    if (typeof value !== "string") continue; // optional Subject / absent fields
    stringToSign += `${key}\n${value}\n`;
  }
  return stringToSign;
}

/** Fetches the PEM (X.509 cert) the envelope's signature verifies against. */
export type FetchCertPem = (certUrl: string) => Promise<string>;

const certCache = new Map<string, string>();

/**
 * Cache bound: AWS uses one cert URL per region for long stretches, so a
 * handful of entries is normal. A flood of DISTINCT (signed-host, varying
 * path-id) URLs must not grow the map unboundedly — dump it and refill.
 */
const CERT_CACHE_MAX_ENTRIES = 32;

/** A real SNS signing cert is ~1-2 KB; anything huge is not a cert. */
const CERT_MAX_BYTES = 64 * 1024;

/**
 * Default cert fetcher: HTTPS GET of the (already host+path-validated)
 * SigningCertURL with a size-bounded in-process cache — AWS rotates certs
 * rarely and reuses the same URL across deliveries.
 */
export const defaultFetchCertPem: FetchCertPem = async (certUrl) => {
  const cached = certCache.get(certUrl);
  if (cached) return cached;
  const response = await fetch(certUrl);
  if (!response.ok) {
    throw new Error(`sns_cert_fetch_failed_${response.status}`);
  }
  const pem = await response.text();
  if (Buffer.byteLength(pem, "utf8") > CERT_MAX_BYTES) {
    throw new Error("sns_cert_too_large");
  }
  if (certCache.size >= CERT_CACHE_MAX_ENTRIES) {
    certCache.clear();
  }
  certCache.set(certUrl, pem);
  return pem;
};

/**
 * Verify an SNS envelope's signature (NFR-002). SignatureVersion "1" is
 * SHA1withRSA, "2" is SHA256withRSA. Returns false (never throws) for a
 * signature that simply doesn't match; throws for structural problems
 * (untrusted cert URL, cert fetch failure) so callers can distinguish
 * "forged" from "broken".
 */
export async function verifySnsSignature(
  envelope: SnsEnvelope,
  fetchCertPem: FetchCertPem = defaultFetchCertPem,
): Promise<boolean> {
  assertAmazonSnsCertUrl(envelope.SigningCertURL);
  const pem = await fetchCertPem(envelope.SigningCertURL);
  const algorithm =
    envelope.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const verifier = createVerify(algorithm);
  verifier.update(buildSnsStringToSign(envelope), "utf8");
  return verifier.verify(pem, envelope.Signature, "base64");
}
