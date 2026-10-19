import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { ApiKeyRepoError } from "@th/ports/repos/api-keys";

import {
  extractDbFailure,
  rethrowApiKeyDbError,
  toApiKeyRepoError,
} from "../api-keys-errors";

// Unit coverage for the api-key DB error mapper. The integration suite
// (api-keys-guards.integration.test.ts) fires every guard through it on real
// Postgres; this file pins the error SHAPES and the guard message phrases.

/** The P2010 shape PrismaPg 7.1 produces for a failing raw query (measured). */
function p2010(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.$queryRaw()\` invocation:\n\nRaw query failed. Code: \`${code}\`. Message: \`${message}\``,
    {
      code: "P2010",
      clientVersion: "7.1.0",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: code,
            originalMessage: message,
            kind: "postgres",
            code,
            severity: "ERROR",
            message,
          },
        },
      },
    },
  );
}

// The guard functions as they ship: for each, the body from the LATEST
// migration (by folder name) that (re)defines it. A phrase the mapper matches
// on must be inside the body of the function the mapper attributes it to.
const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../db/prisma/migrations",
);

function latestFunctionBody(fn: string): { migration: string; body: string } {
  const header = new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION public\\."${fn}"\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  );
  const dirs = readdirSync(MIGRATIONS).sort().reverse();
  for (const dir of dirs) {
    let sql: string;
    try {
      sql = readFileSync(resolve(MIGRATIONS, dir, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    const m = header.exec(sql);
    if (m?.[1]) return { migration: dir, body: m[1] };
  }
  throw new Error(`no migration defines public."${fn}"()`);
}

const KEY_GUARD = latestFunctionBody("api_keys_guard");
const REQUEST_GUARD = latestFunctionBody("api_key_requests_guard");

describe("toApiKeyRepoError", () => {
  it("names the CHECK from the message (PrismaPg drops `constraint`)", () => {
    const err = toApiKeyRepoError(
      p2010(
        "23514",
        'new row for relation "api_key_requests" violates check constraint "api_key_requests_expiry_days_cap"',
      ),
    );
    expect(err).toBeInstanceOf(ApiKeyRepoError);
    expect(err).toMatchObject({
      code: "guard_refused",
      reason: "check_violation",
      constraint: "api_key_requests_expiry_days_cap",
      sqlState: "23514",
    });
  });

  it.each([
    [
      "key request: a request is inserted pending",
      "request_not_inserted_pending",
    ],
    ["key request: content is immutable", "request_content_immutable"],
    [
      "key request: auto-renew can only be switched off",
      "request_auto_renew_switch_on",
    ],
    ["key request: a decision names its decider", "decision_without_decider"],
    [
      "key request: request abc lapsed (14 days) and cannot be approved",
      "request_lapsed",
    ],
    [
      "key request: an undecided request has no decider",
      "undecided_with_decider",
    ],
    ["key request: decision is final", "decision_final"],
    ["key request: withdrawn_at is final once set", "withdrawal_final"],
    ["key request: withdrawal_reason is final once set", "withdrawal_final"],
    [
      "key request: request abc was withdrawn and cannot be decided",
      "request_withdrawn",
    ],
    [
      "key request: collected_at is written once, by the collect insert only",
      "collected_at_writer",
    ],
  ] as const)("maps api_key_requests_guard %j", (message, reason) => {
    expect(toApiKeyRepoError(p2010("23514", message))).toMatchObject({
      code: "guard_refused",
      reason,
      constraint: "api_key_requests_guard",
    });
  });

  it.each([
    ["api key: a new key has no revoke, notice or use yet", "key_born_dirty"],
    ["api key: request abc is not approved", "request_not_approved"],
    [
      "api key: request abc was withdrawn or closed for account security",
      "request_withdrawn",
    ],
    ["api key: expiry outside the request's term", "expiry_outside_term"],
    [
      "api key: request abc does not allow auto-renew",
      "auto_renew_not_allowed",
    ],
    [
      "api key: its request does not allow auto-renew",
      "auto_renew_not_allowed",
    ],
    [
      "api key: request abc is already collected or its collection window lapsed",
      "already_collected_or_collect_lapsed",
    ],
    [
      "api key: renewal must continue a live auto-renewing key on the same request, holder and label, in its last 7 days",
      "renewal_not_allowed",
    ],
    [
      "api key: request abc already has another live key; renew once the overlap ends",
      "renewal_overlap",
    ],
    [
      "api key: identity and scope columns are immutable",
      "key_identity_immutable",
    ],
    ["api key: revocation is final", "revocation_final"],
    ["api key: expiry can only move earlier", "expiry_only_earlier"],
  ] as const)("maps api_keys_guard %j", (message, reason) => {
    expect(toApiKeyRepoError(p2010("23514", message))).toMatchObject({
      code: "guard_refused",
      reason,
      constraint: "api_keys_guard",
    });
  });

  it("reads each guard body from a migration that defines it", () => {
    // The latest (re)definition wins, so a future CREATE OR REPLACE (e.g.
    // the step-10 cutover) is picked up without editing this test.
    expect(KEY_GUARD.migration).toMatch(/scoped_api_keys/);
    expect(REQUEST_GUARD.migration).toMatch(/scoped_api_keys/);
    expect(KEY_GUARD.body).toContain("TG_OP = 'INSERT'");
    expect(REQUEST_GUARD.body).toContain("TG_OP = 'INSERT'");
  });

  it.each([
    "a request is inserted pending",
    "content is immutable",
    "auto-renew can only be switched off",
    "a decision names its decider",
    "cannot be approved",
    "an undecided request has no decider",
    "decision is final",
    "withdrawn_at is final",
    "collected_at is written once",
    "withdrawal_reason is final",
    "was withdrawn and cannot be decided",
  ])(
    "request-guard phrase %j is in api_key_requests_guard's body",
    (phrase) => {
      expect(REQUEST_GUARD.body).toContain(phrase);
      expect(REQUEST_GUARD.body).toContain("'key request: ");
    },
  );

  it.each([
    "a new key has no revoke, notice or use yet",
    "is not approved",
    "expiry outside the request''s term", // SQL-escaped quote
    "already collected or its collection window lapsed",
    "renewal must continue",
    "already has another live key",
    "does not allow auto-renew",
    "identity and scope columns are immutable",
    "revocation is final",
    "expiry can only move earlier",
    "was withdrawn or closed for account security",
  ])("key-guard phrase %j is in api_keys_guard's body", (phrase) => {
    expect(KEY_GUARD.body).toContain(phrase);
  });

  it("every RAISE in each guard uses that guard's message prefix", () => {
    const raises = (body: string) =>
      [...body.matchAll(/RAISE EXCEPTION '([^']*(?:''[^']*)*)'/g)].map(
        (m) => m[1]!,
      );
    expect(raises(KEY_GUARD.body).length).toBeGreaterThan(5);
    for (const msg of raises(KEY_GUARD.body)) expect(msg).toMatch(/^api key: /);
    expect(raises(REQUEST_GUARD.body).length).toBeGreaterThan(5);
    for (const msg of raises(REQUEST_GUARD.body)) {
      expect(msg).toMatch(/^key request: /);
    }
  });

  it("a 23514 with no guard prefix and no CHECK name is unknown, not a named CHECK", () => {
    expect(
      toApiKeyRepoError(p2010("23514", "something else entirely")),
    ).toMatchObject({
      code: "guard_refused",
      reason: "guard_violation_unknown",
      constraint: null,
    });
  });

  it("an unknown guard message is still typed, never untyped", () => {
    expect(
      toApiKeyRepoError(p2010("23514", "api key: something new")),
    ).toMatchObject({
      code: "guard_refused",
      reason: "guard_violation_unknown",
      constraint: "api_keys_guard",
    });
  });

  it("maps a unique violation with its index name", () => {
    expect(
      toApiKeyRepoError(
        p2010(
          "23505",
          'duplicate key value violates unique constraint "api_keys_one_collect_per_request"',
        ),
      ),
    ).toMatchObject({
      code: "guard_refused",
      reason: "unique_violation",
      constraint: "api_keys_one_collect_per_request",
      sqlState: "23505",
    });
  });

  it("maps a composite scope FK violation", () => {
    expect(
      toApiKeyRepoError(
        p2010(
          "23503",
          'insert or update on table "api_keys" violates foreign key constraint "api_keys_request_scope_fkey"',
        ),
      ),
    ).toMatchObject({
      reason: "foreign_key_violation",
      constraint: "api_keys_request_scope_fkey",
    });
  });

  it.each(["40P01", "40001"])("maps %s to retryable", (code) => {
    expect(toApiKeyRepoError(p2010(code, "deadlock detected"))).toMatchObject({
      code: "retryable",
      reason: null,
      sqlState: code,
    });
  });

  it("maps P2034 (interactive-tx conflict) to retryable", () => {
    const err = new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2034",
      clientVersion: "7.1.0",
    });
    expect(toApiKeyRepoError(err)).toMatchObject({ code: "retryable" });
  });

  it("reads a bare DriverAdapterError (raised at COMMIT)", () => {
    const err = Object.assign(new Error("postgres"), {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23514",
        originalMessage: "api key: revocation is final",
      },
    });
    expect(toApiKeyRepoError(err)).toMatchObject({
      reason: "revocation_final",
      constraint: "api_keys_guard",
    });
  });

  it("reads a raw pg error, including its constraint field", () => {
    const err = Object.assign(new Error("api key: revocation is final"), {
      code: "23514",
      severity: "ERROR",
      constraint: "api_keys_guard",
    });
    expect(extractDbFailure(err)).toEqual({
      sqlState: "23514",
      message: "api key: revocation is final",
      constraint: "api_keys_guard",
    });
    expect(toApiKeyRepoError(err)).toMatchObject({
      reason: "revocation_final",
      constraint: "api_keys_guard",
    });
  });

  it("leaves unrelated errors alone", () => {
    const plain = new Error("boom");
    expect(toApiKeyRepoError(plain)).toBeNull();
    expect(toApiKeyRepoError(p2010("23502", "null value"))).toBeNull();
    expect(() => rethrowApiKeyDbError(plain)).toThrow(plain);
  });

  it("rethrows a mapped refusal as ApiKeyRepoError with the cause kept", () => {
    const original = p2010("23514", "key request: decision is final");
    try {
      rethrowApiKeyDbError(original);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiKeyRepoError);
      expect((err as ApiKeyRepoError).cause).toBe(original);
    }
  });
});
