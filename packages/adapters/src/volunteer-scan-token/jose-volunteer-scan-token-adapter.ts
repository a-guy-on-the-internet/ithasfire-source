import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import type {
  VolunteerScanTokenPayload,
  VolunteerScanTokenPort,
  VolunteerScanTokenSignInput,
  VolunteerScanTokenSignResult,
} from "@th/ports/volunteer-scan-token";

/**
 * jose-based implementation of `VolunteerScanTokenPort`.
 *
 * Signs an HS256 JWT scoped to a (humanId, eventId) pair. The token does
 * NOT include any PII or signupId — it just authorizes scanner-side
 * lookups for a human's eligible signups on a single event.
 *
 * Verification errors are normalized to the two typed codes the use cases
 * expect:
 *   - `volunteer_qr_expired`  — `exp` is in the past
 *   - `volunteer_qr_invalid`  — anything else (bad signature, malformed,
 *     unknown issuer, missing claims, etc.)
 *
 * SINGLE KEY, NO ROTATION SCHEME. A `kid` header is emitted for forensics
 * (you can tell which secret generation signed a captured token), but verify
 * uses ONE key and ignores it. This used to claim a future rotation scheme
 * could "swap secrets without breaking outstanding tokens" — it cannot, and
 * leaving that in was worse than saying nothing, because it implies a
 * revocation lever that does not exist. Today the only way to invalidate an
 * issued token early is to change `secret`, which voids EVERY outstanding
 * token platform-wide, organizer badges included. Implementing real rotation
 * means accepting a set of keys here and selecting by `kid` on verify; until
 * someone does that, treat secret rotation as break-glass.
 */
export interface CreateJoseVolunteerScanTokenAdapterOptions {
  /** HMAC secret used for both signing and verifying. */
  secret: string;
  /** Stable identifier for the secret. Defaults to `"v1"`. */
  kid?: string;
}

const ISSUER = "ithasfire:volunteer-scan";

export function createJoseVolunteerScanTokenAdapter(
  opts: CreateJoseVolunteerScanTokenAdapterOptions,
): VolunteerScanTokenPort {
  const key = new TextEncoder().encode(opts.secret);
  const kid = opts.kid ?? "v1";

  return {
    async sign(
      input: VolunteerScanTokenSignInput,
    ): Promise<VolunteerScanTokenSignResult> {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + input.ttlSeconds;

      const token = await new SignJWT({
        humanId: input.humanId,
        eventId: input.eventId,
        kind: input.kind,
      })
        .setProtectedHeader({ alg: "HS256", kid })
        .setIssuer(ISSUER)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        // Caller-supplied so the mint transaction's audit row can carry the
        // same id — see `VolunteerScanTokenSignInput.jti`.
        .setJti(input.jti)
        .sign(key);

      return { token, expiresAt: new Date(exp * 1000) };
    },

    async verify(token: string): Promise<VolunteerScanTokenPayload> {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: ISSUER });
        const { humanId, eventId, kind, iat, exp, jti } = payload as Record<
          string,
          unknown
        >;

        if (
          typeof humanId !== "string" ||
          typeof eventId !== "string" ||
          (kind !== "short" && kind !== "print") ||
          typeof iat !== "number" ||
          typeof exp !== "number"
        ) {
          throw {
            code: "volunteer_qr_invalid",
            message: "missing_or_invalid_claims",
          } as const;
        }

        // `jti` is NOT required here: tokens minted before it existed are
        // still in circulation with live expiries, and hard-failing them
        // would void every outstanding badge on deploy. See the payload docs.
        return {
          humanId,
          eventId,
          kind,
          iat,
          exp,
          ...(typeof jti === "string" ? { jti } : {}),
        };
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) {
          throw {
            code: "volunteer_qr_expired",
            message: "token_expired",
          } as const;
        }
        // Re-throw our own typed errors as-is
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === "volunteer_qr_invalid"
        ) {
          throw err;
        }
        throw {
          code: "volunteer_qr_invalid",
          message: "token_invalid",
        } as const;
      }
    },
  };
}
