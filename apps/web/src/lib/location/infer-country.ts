export function inferCountryCodeFromNavigator(): string | null {
  if (typeof navigator === "undefined") return null;

  const raw = navigator.language?.trim();
  if (!raw) return null;

  // Common shapes:
  // - en-US
  // - en_US
  // - fr
  // - es-419 (region isn't a country, so ignore)
  const parts = raw.replace(/_/g, "-").split("-");
  if (parts.length < 2) return null;

  const candidate = parts[parts.length - 1] ?? "";
  if (!/^[A-Za-z]{2}$/.test(candidate)) return null;

  return candidate.toUpperCase();
}
