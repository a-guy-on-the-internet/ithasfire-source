// Single implementation lives in the shared `@th/errors` package so web,
// scanner, and mobile all resolve errors identically. This module is kept as a
// thin re-export under its original path so existing
// `@/lib/errors/normalize-error` imports keep working.
export {
  normalizeError,
  type NormalizedError,
  NETWORK_ERROR_MESSAGE,
} from "@th/errors";
