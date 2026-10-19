import { PKPass } from "passkit-generator";
import forge from "node-forge";
import type {
  WalletPassTicketData,
  WalletPassResult,
} from "@th/ports/wallet-pass.port";
import { createWalletPassError } from "@th/ports/wallet-pass.port";
import type { LoggerPort } from "@th/ports/logger";
import { formatOrderCode } from "@th/types/order-identifier";
import { PASS_IMAGES } from "./apple-pass-images.js";

// ── Apple WWDR G4 intermediate certificate (public, expires 2030-12-10) ──────
// This is Apple's Worldwide Developer Relations G4 intermediate CA certificate.
// It is publicly distributed by Apple and is NOT secret material.
// Download: https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
//
// This blob was previously CORRUPT — one base64 character short, so it failed
// to parse and EVERY Apple pass generation died with the deeply unhelpful
// "Too few bytes to parse DER." Nothing caught it, because no test ever parsed
// the constant and the error surfaces only when a real certificate is
// configured (otherwise the stub adapter runs). Exported solely so
// `apple-wallet-adapter.test.ts` can assert it still parses — do not hand-edit;
// re-download from the URL above and replace wholesale.
export const APPLE_WWDR_G4_PEM = `-----BEGIN CERTIFICATE-----
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQEL
BQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsT
HUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS
b290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UE
Aww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJbmMu
MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAf
eKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjo
v9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41t
QSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB
5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVl
PNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64D
YyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8G
A1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0
BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJv
b3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290
LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0PAQH/BAQD
AgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbD
eeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWv
p50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPef
x4elUWY0GzlxOSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJ
EtHlgepZAE9bPFo22noicwkJac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQ
A1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xKX+udO7xPiEAGE/+QF4oIRynoYpgp
pU8RBWk6z/Kf
-----END CERTIFICATE-----`;

// ── Types ────────────────────────────────────────────────────────────────────

export type AppleWalletAdapterConfig = {
  /** Base64-encoded PKCS#12 bundle containing the Pass Type ID certificate + private key. */
  certificateP12Base64: string;
  /** Password that unlocks the PKCS#12 bundle. */
  certificatePassword: string;
  /** Apple Developer Team Identifier (e.g. "ABCD1234EF"). */
  teamIdentifier: string;
  /** Registered Pass Type Identifier (e.g. "pass.com.ithasfire.tickets"). Pass Type IDs are immutable in Apple Developer — use whatever is actually registered, even if it predates the rebrand. */
  passTypeIdentifier: string;
  logger?: LoggerPort;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Well-known PKCS#12 bag type OIDs
const CERT_BAG_OID = "1.2.840.113549.1.12.10.1.3";
const PKCS8_SHROUDED_KEY_BAG_OID = "1.2.840.113549.1.12.10.1.2";

/**
 * How long the wallet-image fetch may take before the pass is built without
 * it. Pass generation used to be purely local; this is the only network call
 * in the path, so it gets a hard ceiling rather than inheriting the caller's.
 */
const WALLET_IMAGE_FETCH_TIMEOUT_MS = 3_000;

/** Apple rejects a pass whose image bag is not a PNG, so the type is checked. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * Fetch the organiser's wallet image for embedding as `thumbnail.png`.
 *
 * NEVER throws. Every failure path — bad URL, non-HTTPS, timeout, non-200,
 * not a PNG — resolves to `null`, and the caller builds the same artwork-free
 * pass it would have built with no image configured. A ticket must not become
 * unavailable because a CDN blinked.
 *
 * Returns the raw bytes; there is deliberately NO resizing here. The repo has
 * no server-side image library (no sharp, no image-size), so the crop the
 * organiser made in the builder is embedded as-is — see OQ-1 in
 * `docs/specs/2026-09-07/wallet-pass-image.spec.yaml`.
 */
export async function fetchWalletImage(
  url: string,
  logger?: LoggerPort,
): Promise<Buffer | null> {
  try {
    // Refuse anything but HTTPS: this runs server-side with the API's own
    // network position, so a http:// or file:// URL in the DB would be an
    // SSRF primitive rather than a broken image.
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      logger?.error("apple-wallet.thumbnail.rejected_scheme", {
        protocol: parsed.protocol,
      });
      return null;
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(WALLET_IMAGE_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      logger?.error("apple-wallet.thumbnail.fetch_failed", {
        status: res.status,
        url,
      });
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.subarray(0, 4).equals(PNG_MAGIC)) {
      logger?.error("apple-wallet.thumbnail.not_png", {
        url,
        head: buffer.subarray(0, 4).toString("hex"),
      });
      return null;
    }
    return buffer;
  } catch (err) {
    // Includes the AbortSignal timeout. Logged at error (NOT warn) so Sentry's
    // pinoIntegration captures it — a silently artwork-less pass is exactly
    // the kind of degradation that otherwise goes unnoticed for weeks.
    logger?.error("apple-wallet.thumbnail.fetch_threw", {
      err,
      url,
    });
    return null;
  }
}

function extractCertAndKeyFromP12(
  p12Base64: string,
  password: string,
): { signerCert: string; signerKey: string } {
  const p12Der = forge.util.decode64(p12Base64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  // Extract certificate
  const certBags = p12.getBags({ bagType: CERT_BAG_OID });
  const certBag = certBags[CERT_BAG_OID];
  if (!certBag || certBag.length === 0 || !certBag[0]?.cert) {
    throw createWalletPassError(
      "dependency_failed",
      "No certificate found in PKCS#12 bundle.",
    );
  }
  const signerCert = forge.pki.certificateToPem(certBag[0].cert);

  // Extract private key
  const keyBags = p12.getBags({ bagType: PKCS8_SHROUDED_KEY_BAG_OID });
  const keyBag = keyBags[PKCS8_SHROUDED_KEY_BAG_OID];
  if (!keyBag || keyBag.length === 0 || !keyBag[0]?.key) {
    throw createWalletPassError(
      "dependency_failed",
      "No private key found in PKCS#12 bundle.",
    );
  }
  const signerKey = forge.pki.privateKeyToPem(keyBag[0].key);

  return { signerCert, signerKey };
}

function formatPassDate(isoString: string): string {
  // Apple passes use ISO 8601 with timezone offset
  return new Date(isoString).toISOString();
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class AppleWalletAdapter {
  private readonly config: AppleWalletAdapterConfig;
  private certCache: { signerCert: string; signerKey: string } | null = null;

  constructor(config: AppleWalletAdapterConfig) {
    this.config = config;
  }

  private getCertificates(): { signerCert: string; signerKey: string } {
    if (!this.certCache) {
      this.certCache = extractCertAndKeyFromP12(
        this.config.certificateP12Base64,
        this.config.certificatePassword,
      );
    }
    return this.certCache;
  }

  async generate(ticketData: WalletPassTicketData): Promise<WalletPassResult> {
    const { signerCert, signerKey } = this.getCertificates();

    // Organiser artwork, when the event has one and it is reachable. Fetched
    // BEFORE the PKPass is constructed because the image bag is a constructor
    // argument. `fetchWalletImage` never throws, so a null here is the normal
    // artwork-free pass rather than a failure.
    const walletImage = ticketData.walletImageUrl
      ? await fetchWalletImage(ticketData.walletImageUrl, this.config.logger)
      : null;

    // Same buffer under both names on purpose. Apple wants 90/180/270px for
    // 1x/2x/3x and there is no server-side resizer in this repo, so the single
    // cropped asset is offered at both densities: retina devices pick @2x and
    // get the sharper render, and a pass that declares only 1x would be
    // upscaled. See OQ-1 in the spec — a real-device check decides whether the
    // third density is worth a client-side resize at crop time.
    const images = walletImage
      ? {
          ...PASS_IMAGES,
          "thumbnail.png": walletImage,
          "thumbnail@2x.png": walletImage,
        }
      : PASS_IMAGES;

    try {
      const pass = new PKPass(
        images,
        {
          wwdr: APPLE_WWDR_G4_PEM,
          signerCert,
          signerKey,
        },
        {
          formatVersion: 1,
          serialNumber: ticketData.ticketId,
          teamIdentifier: this.config.teamIdentifier,
          passTypeIdentifier: this.config.passTypeIdentifier,
          organizationName: "Ithas Fire",
          description: `${ticketData.eventTitle} — ${ticketData.ticketTypeName}`,
          logoText: "Ithas Fire",
          foregroundColor: "rgb(255, 255, 255)",
          backgroundColor: "rgb(53, 88, 154)", // STEEL_BLUE
          labelColor: "rgb(200, 214, 240)",
        },
      );

      // Event ticket pass type
      pass.type = "eventTicket";

      // ── Front-of-pass layout ────────────────────────────────────────────
      //
      // Ordered by what a holder needs at the door: date (glanceable while
      // stacked) → event → where and when → which ticket → support code.
      //
      // `headerFields` is the ONLY row Wallet keeps visible when passes are
      // collapsed in the stack, so it must carry something. It was empty,
      // which made a stacked Ithas Fire pass show nothing but the logo. It is
      // also narrow (it shares the header with `logoText`), so it gets the
      // SHORT date and nothing else — a medium date truncates there.
      pass.headerFields.push({
        key: "date",
        label: "DATE",
        value: formatPassDate(ticketData.eventStartsAt),
        dateStyle: "PKDateStyleShort" as any,
        timeStyle: "PKDateStyleNone" as any,
      });

      // Primary — the event. No label: the primary field is already the
      // visually dominant line on the pass, so "EVENT" above it just spends
      // a row of the label colour restating what the value obviously is.
      pass.primaryFields.push({
        key: "event",
        value: ticketData.eventTitle,
      });

      // Secondary — where and when. Venue is promoted out of auxiliary: at
      // the door it outranks the ticket type. The clock lives here rather
      // than in the header so the date is not printed twice.
      if (ticketData.venueName) {
        pass.secondaryFields.push({
          key: "venue",
          label: "PLACE",
          value: ticketData.venueName,
        });
      }
      pass.secondaryFields.push({
        key: "startsAt",
        label: "STARTS",
        value: formatPassDate(ticketData.eventStartsAt),
        dateStyle: "PKDateStyleNone" as any,
        timeStyle: "PKDateStyleShort" as any,
      });

      // Auxiliary — the admission detail and the code support will ask for.
      pass.auxiliaryFields.push({
        key: "ticketType",
        label: "TICKET",
        value: ticketData.ticketTypeName,
      });
      if (ticketData.orderRef) {
        pass.auxiliaryFields.push({
          key: "order",
          label: "ORDER",
          value: ticketData.orderRef,
        });
      }

      // Back fields — full details
      pass.backFields.push({
        key: "holderName",
        label: "TICKET HOLDER",
        value: ticketData.holderName ?? "Guest",
      });
      if (ticketData.venueAddress) {
        pass.backFields.push({
          key: "address",
          label: "ADDRESS",
          value: ticketData.venueAddress,
        });
      }
      pass.backFields.push({
        key: "ticketId",
        label: "TICKET ID",
        value: ticketData.ticketId,
      });
      pass.backFields.push({
        key: "powered",
        label: "POWERED BY",
        value: "Ithas Fire — ithasfire.com",
      });

      // Barcode — QR carrying the ticket code.
      //
      // `altText` is DELIBERATELY the raw ticket code, not the prettier order
      // code. Wallet prints it under the barcode as the fallback a door
      // operator types when the QR will not scan, and the scan resolver keys
      // on `ticketCode` (`core/use-cases/scanning/resolve-scan-payload.ts`) —
      // an order code identifies the ORDER, not this ticket, so swapping it
      // for looks would break manual admission. Leave it machine-shaped.
      pass.setBarcodes({
        format: "PKBarcodeFormatQR",
        message: ticketData.ticketCode,
        messageEncoding: "iso-8859-1",
        altText: ticketData.ticketCode,
      });

      // Relevance — show on lock screen near event time
      if (ticketData.eventStartsAt) {
        pass.setRelevantDate(new Date(ticketData.eventStartsAt));
      }

      // Location relevance — show near venue
      // (could add lat/lng if available in the future)

      const passBuffer = pass.getAsBuffer();

      // Fall back through `formatOrderCode`, never `slice(0, 8)`: the HEAD of a
      // UUID is 8 hex chars, so it parses as a valid order code and then
      // resolves to nothing. A user can read a download filename back to
      // support, so it has to carry the same code as every other surface.
      const filename = `ithasfire-${ticketData.orderRef ?? formatOrderCode(ticketData.orderId)}.pkpass`;

      return {
        type: "apple" as const,
        passBuffer,
        filename,
      };
    } catch (err) {
      this.config.logger?.error("apple-wallet.generate.failed", {
        ticketId: ticketData.ticketId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw createWalletPassError(
        "dependency_failed",
        `Apple Wallet pass generation failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }
}
