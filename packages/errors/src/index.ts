export {
  type AppErrorCode,
  APP_ERROR_CODES,
  USER_FACING_CODES,
  INTERNAL_CODES,
  isInternalCode,
  NETWORK_ERROR_MESSAGE,
  toKey,
  fromLegacyCode,
} from "./codes";

export {
  AppError,
  type AppErrorOptions,
  isAppError,
  fail,
} from "./app-error";

export {
  type NormalizedError,
  normalizeError,
  formatAuthErrorMessage,
  isWebAuthnCancel,
} from "./normalize-error";

export {
  LOCATION_SENSITIVE_KEYS,
  SCRUBBED,
  SCRUBBED_TRUNCATED,
  isLocationSensitiveKey,
  scrubLocationFromErrorEvent,
} from "./scrub-location-pii";

