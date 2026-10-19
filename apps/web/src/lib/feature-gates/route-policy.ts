import { isUnderPath } from "@/middleware/path-match";

const MAINTENANCE_EXEMPT_PREFIXES = [
  "/admin",
  "/platform",
  "/auth",
  "/embed",
  "/login",
  "/api",
] as const;
const MAINTENANCE_EXEMPT_PATHS = [
  "/",
  "/privacy",
  "/cookie-policy",
  "/terms",
  "/acceptable-use",
  "/about",
  "/contact",
  "/house-shows",
  "/access-denied",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
] as const;

function isPathMatch(
  pathname: string,
  paths: readonly string[],
  prefixes: readonly string[],
): boolean {
  if (paths.includes(pathname)) return true;
  return prefixes.some((prefix) => isUnderPath(pathname, prefix));
}

export function isMaintenanceExemptPath(pathname: string): boolean {
  return isPathMatch(
    pathname,
    MAINTENANCE_EXEMPT_PATHS,
    MAINTENANCE_EXEMPT_PREFIXES,
  );
}
