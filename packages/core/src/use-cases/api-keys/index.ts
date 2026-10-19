// ── Legacy (router until plan step 5; FR-001 removes create) ────────────────
export { createApiKey, type CreateApiKeyDeps } from "./create-api-key";
export { listApiKeys, type ListApiKeysDeps } from "./list-api-keys";
export { revokeApiKey, type RevokeApiKeyDeps } from "./revoke-api-key";

// ── Scoped API keys (docs/specs/2026-10-08/scoped-api-keys.spec.yaml) ───────
export { requestApiKey, type RequestApiKeyDeps } from "./request-api-key";
export {
  decideApiKeyRequest,
  type DecideApiKeyRequestDeps,
} from "./decide-api-key-request";
export {
  withdrawApiKeyRequest,
  type WithdrawApiKeyRequestDeps,
} from "./withdraw-api-key-request";
export { collectApiKey, type CollectApiKeyDeps } from "./collect-api-key";
export {
  renewApiKeySelf,
  type RenewApiKeySelfDeps,
} from "./renew-api-key-self";
export {
  revokeScopedApiKey,
  type RevokeScopedApiKeyDeps,
} from "./revoke-scoped-api-key";
export {
  setApiKeyAutoRenew,
  type SetApiKeyAutoRenewDeps,
} from "./set-api-key-auto-renew";
export {
  API_KEY_LIST_LIMIT,
  listMyApiKeys,
  type ListMyApiKeysDeps,
} from "./list-my-api-keys";
export { listOrgApiKeys, type ListOrgApiKeysDeps } from "./list-org-api-keys";
export {
  listPlatformApiKeys,
  type ListPlatformApiKeysDeps,
} from "./list-platform-api-keys";
export {
  sweepApiKeyLifecycle,
  type SweepApiKeyLifecycleDeps,
} from "./sweep-api-key-lifecycle";
export {
  API_KEY_ERROR_CATEGORIES,
  ApiKeyUseCaseError,
  isApiKeyUseCaseError,
  type ApiKeyErrorCode,
} from "./_shared/errors";
export type {
  ApiKeyNotice,
  ApiKeyNoticeAudience,
  ApiKeyNotifier,
} from "./_shared/notices";
export {
  MAX_KEYS_PER_HOLDER_PER_SUBJECT,
  MAX_KEYS_PER_ORG,
  PLATFORM_STAFF_ROLES,
  STAFF_ADMIN_ROLES,
  STAFF_KEY_REQUESTER_ROLES,
} from "./_shared/rules";
export { deriveKeyStatus, deriveRequestStatus } from "./_shared/views";

export * from "./schemas";
