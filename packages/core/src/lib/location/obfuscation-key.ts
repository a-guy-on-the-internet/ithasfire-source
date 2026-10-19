import { createHmac, hkdfSync } from "node:crypto";

import type { ReporterPort } from "@th/ports/reporter";

/**
 * The server-side key behind every public obfuscation circle.
 *
 * WHY A KEY. A circle's offset used to be a pure function of the TRUE point
 * (`C(R) = P + R·v`, with `v` seeded by `P` alone). That leaked twice:
 *   · two radii for the same place are collinear with it, so two published
 *     circles solve for `P` exactly — `P = (R2·C1 − R1·C2) / (R2 − R1)`;
 *   · the seed was public, so anyone holding a guessed address could compute
 *     its circle and confirm the guess against the published one.
 * Every step of a circle is now drawn from `HMAC-SHA256(key, scope ‖
 * subjectId ‖ rung)` — nobody without the key can reproduce one — and a
 * subject's circles are NESTED along the radius ladder (see
 * `obfuscateCoordinate` in `redact-location.ts`), so however many radii of
 * one subject are published they reveal no more than the smallest.
 *
 * WHERE THE KEY COMES FROM. HKDF-SHA256 over an existing server secret with a
 * domain label, so the derived key is independent of every other use of that
 * secret. The composition roots pick the secret (`UNSUBSCRIBE_SECRET` — the one
 * HMAC secret both the API and the jobs service carry in every environment;
 * see `apps/api/src/lib/dep.ts` and `apps/jobs/src/lib/container.ts`). The API
 * and jobs MUST derive the same key: the search index (jobs) and the event
 * page (API) draw the same circle, and two different circles for one radius
 * are two samples of the true point.
 *
 * ROTATING THE SECRET MOVES EVERY CIRCLE — and a moved circle is a second,
 * independent sample for anyone who saved the first. Rotate it only for a
 * reason that outweighs that, and follow the runbook
 * (`docs/runbooks/rotate-unsubscribe-secret.md`): the event rows at withheld
 * venues STORE the venue's circle centre and must be re-projected.
 *
 * FAIL CLOSED. No key → no circle. `obfuscateCoordinate` returns null and
 * every caller renders the location fully hidden (label only). The absence is
 * reported ONCE per process (`logger.error` + `reportError`) — at configure
 * time when the root wires an empty secret, or at first use when nothing
 * configured the module at all.
 *
 * This is module state on purpose: the circle is computed by dozens of public
 * read paths across core, the adapters and the API routes, several of them
 * finished code that must not change shape, and a key threaded through every
 * `deps` is a key some caller eventually forgets — which, failing closed, is
 * a feature outage rather than a leak, but still an outage.
 */

/** HKDF `info` — the domain label. Bump the version to rotate every circle deliberately. */
export const LOCATION_OBFUSCATION_KEY_LABEL = "ithasfire.location-obfuscation.v1";

/**
 * Which namespace a circle belongs to; part of the HMAC message, so the same
 * id string in two namespaces never shares a circle. The event namespaces are
 * chosen by `eventCircleSubject`.
 */
export type LocationObfuscationScope =
  | "place"
  | "event-point"
  | "event-series"
  | "event";

interface ErrorLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

interface KeyState {
  key: Buffer | null;
  logger: ErrorLogger | null;
  reportError: ReporterPort | null;
  missingReported: boolean;
  /**
   * Memo of step uniforms by HMAC message, for the CURRENT key only (cleared
   * whenever the key changes). A large circle is a chain of up to one step
   * per ladder rung, and the geo reads draw hundreds of circles per request.
   */
  uniforms: Map<string, { u1: number; u2: number }>;
}

const state: KeyState = {
  key: null,
  logger: null,
  reportError: null,
  missingReported: false,
  uniforms: new Map(),
};

/** Memo bound — past it the memo is dropped and refilled, never grown. */
const UNIFORMS_MEMO_MAX = 50_000;

function reportMissingKeyOnce(reason: string): void {
  if (state.missingReported) return;
  state.missingReported = true;
  const meta = {
    reason,
    effect: "every obscured location renders fully hidden (no circle)",
  };
  if (state.logger) {
    try {
      state.logger.error("location_obfuscation.key_missing", meta);
    } catch {
      // Best-effort — a throwing logger never changes behaviour.
    }
  } else {
    // Nothing configured this module (a script, or a root that forgot).
    // Still say so once: silently hiding every circle is an outage.
    console.error("location_obfuscation.key_missing", meta);
  }
  try {
    state.reportError?.(new Error("location_obfuscation_key_missing"), {
      tags: { module: "location-obfuscation", reason },
      extra: meta,
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}

/**
 * Wire the obfuscation key. Call ONCE from each composition root that serves
 * public locations (API, jobs). An empty/absent `secret` leaves the module
 * keyless — every circle fails closed — and reports that immediately.
 */
export function configureLocationObfuscation(options: {
  secret: string | null | undefined;
  logger?: ErrorLogger | null;
  reportError?: ReporterPort | null;
}): { keyed: boolean } {
  state.logger = options.logger ?? null;
  state.reportError = options.reportError ?? null;
  state.uniforms = new Map();
  const secret = options.secret ?? "";
  if (secret.length === 0) {
    state.key = null;
    reportMissingKeyOnce("configured_without_secret");
    return { keyed: false };
  }
  state.key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.alloc(0),
      LOCATION_OBFUSCATION_KEY_LABEL,
      32,
    ),
  );
  state.missingReported = false;
  return { keyed: true };
}

/** Test-only: forget the key and the once-per-process report latch. */
export function resetLocationObfuscationForTests(): void {
  state.key = null;
  state.logger = null;
  state.reportError = null;
  state.missingReported = false;
  state.uniforms = new Map();
}

/** Whether a key is configured in THIS module instance. */
export function isLocationObfuscationKeyed(): boolean {
  return state.key !== null;
}

/**
 * Two independent uniforms in [0, 1) for one step of a circle, or null when
 * there is no key (reported once) or no subject to bind the circle to.
 *
 * The message is `scope ␟ subjectId ␟ rung` — the unit separator cannot
 * appear in a uuid, a decimal or a subject built by `eventCircleSubject`
 * (whose own separator is ␞), so no two distinct triples share a message.
 */
export function locationOffsetUniforms(
  scope: LocationObfuscationScope,
  subjectId: string | null | undefined,
  radiusMeters: number,
): { u1: number; u2: number } | null {
  if (!state.key) {
    reportMissingKeyOnce("obfuscation_without_key");
    return null;
  }
  if (typeof subjectId !== "string" || subjectId.length === 0) {
    return null;
  }
  const message = `${scope}\u001f${subjectId}\u001f${String(radiusMeters)}`;
  const memo = state.uniforms.get(message);
  if (memo) return memo;
  const mac = createHmac("sha256", state.key).update(message).digest();
  // 48 bits each: exactly representable in a double, far finer than a metre.
  const uniforms = {
    u1: mac.readUIntBE(0, 6) / 2 ** 48,
    u2: mac.readUIntBE(6, 6) / 2 ** 48,
  };
  if (state.uniforms.size >= UNIFORMS_MEMO_MAX) state.uniforms = new Map();
  state.uniforms.set(message, uniforms);
  return uniforms;
}
