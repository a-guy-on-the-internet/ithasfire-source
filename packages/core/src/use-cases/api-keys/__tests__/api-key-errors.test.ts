import { describe, expect, it } from "vitest";

import {
  ApiKeyRepoError,
  type ApiKeyRepoRefusalReason,
} from "@th/ports/repos/api-keys";

import {
  API_KEY_ERROR_CATEGORIES,
  isApiKeyUseCaseError,
  mapApiKeyRepoError,
} from "../_shared/errors";

// Every reason the port declares. A new reason added to the port without a
// line here fails the `satisfies` below at typecheck time.
const ALL_REASONS = {
  check_violation: true,
  request_not_inserted_pending: true,
  request_content_immutable: true,
  request_auto_renew_switch_on: true,
  decision_without_decider: true,
  undecided_with_decider: true,
  request_lapsed: true,
  decision_final: true,
  withdrawal_final: true,
  request_withdrawn: true,
  collected_at_writer: true,
  key_born_dirty: true,
  request_not_approved: true,
  expiry_outside_term: true,
  auto_renew_not_allowed: true,
  already_collected_or_collect_lapsed: true,
  renewal_not_allowed: true,
  renewal_overlap: true,
  key_identity_immutable: true,
  revocation_final: true,
  expiry_only_earlier: true,
  unique_violation: true,
  foreign_key_violation: true,
  guard_violation_unknown: true,
} satisfies Record<ApiKeyRepoRefusalReason, true>;

// Keys of `errorCodeMap` in packages/transport/trpc/src/utils.ts that these
// codes use (core cannot import the transport). An unmapped category would
// reach the client as a 500.
const errorCodeMapKeysForTest = [
  "invalid_input",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
];

const SECRET = 'constraint "api_keys_secret_name" detail: key_hash=deadbeef';

describe("mapApiKeyRepoError", () => {
  it.each([...Object.keys(ALL_REASONS), null])(
    "maps reason %s to a stable code without the DB text",
    (reason) => {
      const mapped = mapApiKeyRepoError(
        new ApiKeyRepoError({
          code: "guard_refused",
          reason: reason as ApiKeyRepoRefusalReason | null,
          constraint: "api_keys_secret_name",
          sqlState: "23514",
          message: SECRET,
        }),
        { useCase: "test" },
      );
      expect(isApiKeyUseCaseError(mapped)).toBe(true);
      expect(Object.keys(API_KEY_ERROR_CATEGORIES)).toContain(mapped.message);
      expect(
        JSON.stringify({ ...mapped, message: mapped.message }),
      ).not.toContain("api_keys_secret_name");
      expect(mapped.cause).toBeUndefined();
    },
  );

  it("maps retryable to api_key_busy_retry", () => {
    expect(
      mapApiKeyRepoError(
        new ApiKeyRepoError({
          code: "retryable",
          reason: null,
          constraint: null,
          sqlState: "40P01",
          message: "deadlock detected",
        }),
        { useCase: "test" },
      ).message,
    ).toBe("api_key_busy_retry");
  });

  it("every category is one the tRPC boundary maps (no silent 500)", () => {
    for (const category of new Set(Object.values(API_KEY_ERROR_CATEGORIES))) {
      expect(errorCodeMapKeysForTest).toContain(category);
    }
  });
});
