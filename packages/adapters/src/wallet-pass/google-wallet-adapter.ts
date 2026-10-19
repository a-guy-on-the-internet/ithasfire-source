import { createHash } from "node:crypto";

import { GoogleAuth, type AuthClient } from "google-auth-library";
import type {
  WalletPassTicketData,
  WalletPassResult,
} from "@th/ports/wallet-pass.port";
import { createWalletPassError } from "@th/ports/wallet-pass.port";
import type { LoggerPort } from "@th/ports/logger";
import { formatOrderCode } from "@th/types/order-identifier";

// ── Types ────────────────────────────────────────────────────────────────────

export type GoogleWalletAdapterConfig = {
  /** Google Wallet Issuer ID from the Google Pay & Wallet console. */
  issuerId: string;
  /**
   * Service account email to sign Wallet JWTs as. When omitted, defaults to
   * the runtime SA exposed via Application Default Credentials (i.e. the
   * Cloud Run service's attached service account). The runtime SA must have
   * `roles/iam.serviceAccountTokenCreator` on itself, and must be added as a
   * Developer/Admin on the Wallet issuer in the Pay & Wallet Console.
   */
  signerEmail?: string;
  /**
   * Absolute URI of the pass logo. Must point at the SAME environment's web
   * origin (dev passes → web-dev, prod passes → ithasfire.com): Google fetches
   * it at save time, and the prod URL 404s until prod's web has deployed the
   * asset. Falls back to the prod URL when omitted.
   */
  logoUri?: string;
  logger?: LoggerPort;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function localizedString(value: string, language = "en-US") {
  return {
    defaultValue: { language, value },
  };
}

function formatDateTimeGoogle(isoString: string): string {
  return new Date(isoString).toISOString();
}

/**
 * Short, stable key for a LOCKED pass's venue block (label + notice). Two
 * locked passes showing the same venue text share a class; any change to that
 * text (a moved reveal date, a switch to NEVER) mints a new one. Only the
 * already-redacted text goes in, so the key cannot encode the street.
 */
function lockedVenueKey(ticketData: WalletPassTicketData): string {
  return createHash("sha256")
    .update(`${ticketData.venueName ?? ""}\u0000${ticketData.venueAddress ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class GoogleWalletAdapter {
  private readonly config: GoogleWalletAdapterConfig;
  private readonly auth: GoogleAuth;
  private resolvedSignerEmail: string | null = null;

  constructor(config: GoogleWalletAdapterConfig) {
    this.config = config;
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }

  /**
   * Resolve which SA email to sign as. Caches after the first call.
   * - Explicit `signerEmail` config wins.
   * - Otherwise pull from ADC's resolved credentials (runtime SA on Cloud
   *   Run, gcloud user on local dev). Local dev with a user account will
   *   succeed only if the user has tokenCreator on the target SA — in
   *   practice, set `signerEmail` to the SA explicitly when developing
   *   locally.
   */
  private async getSignerEmail(client: AuthClient): Promise<string> {
    if (this.resolvedSignerEmail) return this.resolvedSignerEmail;
    if (this.config.signerEmail) {
      this.resolvedSignerEmail = this.config.signerEmail;
      return this.resolvedSignerEmail;
    }
    const credentials = await this.auth.getCredentials();
    const email =
      credentials.client_email ?? (client as { email?: string }).email;
    if (!email) {
      throw createWalletPassError(
        "dependency_failed",
        "Google Wallet adapter could not resolve a signer email from ADC. Set `signerEmail` explicitly.",
      );
    }
    this.resolvedSignerEmail = email;
    return this.resolvedSignerEmail;
  }

  /**
   * Sign the Wallet JWT via IAM Credentials API. GCP holds the SA's key;
   * we never touch a private key locally. Costs ~30ms (one network call to
   * iamcredentials.googleapis.com).
   */
  private async signJwt(claims: Record<string, unknown>): Promise<string> {
    const client = await this.auth.getClient();
    const signerEmail = await this.getSignerEmail(client);
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(signerEmail)}:signJwt`;
    const res = await client.request<{ keyId: string; signedJwt: string }>({
      url,
      method: "POST",
      // IAM signJwt expects `payload` as a JSON-encoded string. The API
      // fills `iat`/`exp` if absent, but we set them so the JWT lifetime
      // is predictable across signer impls.
      data: { payload: JSON.stringify(claims) },
    });
    return res.data.signedJwt;
  }

  async generate(ticketData: WalletPassTicketData): Promise<WalletPassResult> {
    try {
      // One class per event, EXCEPT while the address is locked. A class is
      // INSERT-ONCE and carries `venue.address`, so a locked pass saved after
      // an unlocked one (a venue that hid its address, an event switched to
      // NEVER) would otherwise attach to the older class and show the street
      // before its reveal, or forever. A locked pass gets its own class, keyed
      // by the exact locked venue text, so a later change to that text (a new
      // reveal date, NEVER) also gets a fresh class rather than the stale one.
      // Unlocked ids are unchanged.
      const eventClassSuffix = `ithasfire_event_${ticketData.eventId.replace(/-/g, "_")}`;
      const classSuffix = ticketData.addressLocked
        ? `${eventClassSuffix}_locked_${lockedVenueKey(ticketData)}`
        : eventClassSuffix;
      const objectSuffix = `ticket_${ticketData.ticketId.replace(/-/g, "_")}`;

      const classId = `${this.config.issuerId}.${classSuffix}`;
      const objectId = `${this.config.issuerId}.${objectSuffix}`;

      // Build EventTicketClass
      const eventTicketClass: Record<string, unknown> = {
        id: classId,
        issuerName: ticketData.organizerName ?? "Ithas Fire",
        reviewStatus: "UNDER_REVIEW",
        eventName: localizedString(ticketData.eventTitle),
        dateTime: {
          start: formatDateTimeGoogle(ticketData.eventStartsAt),
          ...(ticketData.eventEndsAt
            ? { end: formatDateTimeGoogle(ticketData.eventEndsAt) }
            : {}),
        },
        logo: {
          // MUST be a logo with an OPAQUE background. The brand icons
          // (ithasfire-icon-*.png) are a white mark on transparency, which
          // measures 1.00:1 against white — invisible on the pay.google.com
          // save page, which is predominantly white. Google composites this
          // onto different surfaces (white on the save page, the card's
          // hexBackgroundColor in the wallet), so the only safe logo is one
          // that carries its own background. Do not "simplify" this back to
          // a transparent brand icon.
          //
          // Google caches logos by URI, so changing the artwork requires a
          // NEW filename — overwriting the file in place can keep serving
          // the stale image.
          sourceUri: {
            uri:
              this.config.logoUri ??
              "https://ithasfire.com/brand/ithasfire-wallet-logo-512.png",
          },
        },
        hexBackgroundColor: "#35589a",
      };

      // Organiser artwork. Google fetches this URI itself at save time, so
      // there is nothing to download here — unlike Apple, which must embed the
      // bytes. Note the asset is cropped SQUARE for Apple's thumbnail while
      // `heroImage` renders ~3:1, so it letterboxes; OQ-4 in
      // `docs/specs/2026-09-07/wallet-pass-image.spec.yaml` decides whether
      // Google eventually gets its own crop.
      //
      // Classes are INSERT-ONCE under the shared issuer, so the image a class
      // is born with is the one it keeps — changing the event's wallet image
      // later will not repaint an already-created class.
      if (ticketData.walletImageUrl) {
        eventTicketClass.heroImage = {
          sourceUri: { uri: ticketData.walletImageUrl },
        };
      }

      if (ticketData.venueName) {
        eventTicketClass.venue = {
          name: localizedString(ticketData.venueName),
          ...(ticketData.venueAddress
            ? { address: localizedString(ticketData.venueAddress) }
            : {}),
        };
      }

      // Build EventTicketObject
      const eventTicketObject: Record<string, unknown> = {
        id: objectId,
        classId,
        state: "ACTIVE",
        ticketHolderName: ticketData.holderName ?? "Guest",
        // Fall back through `formatOrderCode`, never a `slice(0, 8)` of some
        // other id: the HEAD of a UUID is also 8 hex chars, so it satisfies
        // the search parser's identifier shape, produces an `id endsWith
        // <head>` clause and then matches NOTHING — a pass holder quoting it
        // to support gets an empty result with no signal anything is wrong.
        // Slicing the TICKET id made that worse still, because it is not the
        // order's id at all. Mirrors the Apple adapter's `.pkpass` filename.
        // `orderRef` is null only when the order id could not be resolved (a
        // comp ticket with no order), in which case `orderId` is "" and this
        // renders empty — no number beats a wrong one.
        ticketNumber:
          ticketData.orderRef ?? formatOrderCode(ticketData.orderId),
        barcode: {
          type: "QR_CODE",
          value: ticketData.ticketCode,
          alternateText: ticketData.ticketCode,
        },
        textModulesData: [
          {
            id: "ticket_type",
            header: "TICKET TYPE",
            body: ticketData.ticketTypeName,
          },
          ...(ticketData.orderRef
            ? [
                {
                  id: "order_id",
                  header: "ORDER",
                  body: ticketData.orderRef,
                },
              ]
            : []),
        ],
        linksModuleData: {
          uris: [
            {
              uri: "https://ithasfire.com",
              description: "Ithas Fire",
              id: "ithasfire_link",
            },
          ],
        },
      };

      eventTicketObject.groupingInfo = {
        groupingId: ticketData.orderId,
      };

      // IAM signJwt requires `iat` / `exp` inside the payload, plus the
      // usual JWT iss/aud/typ that Save-to-Wallet expects.
      const now = Math.floor(Date.now() / 1000);
      const client = await this.auth.getClient();
      const signerEmail = await this.getSignerEmail(client);
      const claims = {
        iss: signerEmail,
        aud: "google",
        typ: "savetowallet",
        iat: now,
        exp: now + 60 * 60,
        origins: ["https://ithasfire.com", "https://web-dev.ithasfire.com"],
        payload: {
          eventTicketClasses: [eventTicketClass],
          eventTicketObjects: [eventTicketObject],
        },
      };

      const jwt = await this.signJwt(claims);
      const saveUrl = `https://pay.google.com/gp/v/save/${jwt}`;

      return {
        type: "google" as const,
        saveUrl,
      };
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "dependency_failed"
      ) {
        throw err;
      }
      this.config.logger?.error("google-wallet.generate.failed", {
        ticketId: ticketData.ticketId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw createWalletPassError(
        "dependency_failed",
        `Google Wallet pass generation failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }
}
