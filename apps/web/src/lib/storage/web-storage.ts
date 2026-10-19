/**
 * Small utilities around Web Storage.
 *
 * Goals:
 * - SSR-safe (no window access on the server)
 * - Defensive (storage can throw in Safari private mode / quota / disabled)
 * - Centralize JSON parsing + basic rate-limited "prompt" patterns
 */

export const safeGetItem = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const safeSetItem = (key: string, value: string): boolean => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

export const safeRemoveItem = (key: string): boolean => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const safeReadJson = <T>(
  key: string,
  parse: (value: unknown) => T | null,
): T | null => {
  const raw = safeGetItem(key);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return parse(parsed);
  } catch {
    return null;
  }
};

export const safeWriteJson = (key: string, value: unknown): boolean => {
  try {
    return safeSetItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
};

/**
 * Returns true if we should suppress a prompt (because it was shown recently).
 * Returns false if prompt is allowed AND records the prompt timestamp.
 */
export const isRateLimitedPrompt = (key: string, ttlMs: number): boolean => {
  if (typeof window === "undefined") return true;
  const raw = safeGetItem(key);
  const last = raw ? Number(raw) : 0;
  const now = Date.now();

  if (Number.isFinite(last) && last > 0 && now - last < ttlMs) {
    return true;
  }

  // Best-effort write.
  safeSetItem(key, String(now));
  return false;
};

export const parseV1StoredContext = (
  value: unknown,
): { contextId: string; updatedAt: number } | null => {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  if (typeof value.contextId !== "string" || value.contextId.length === 0)
    return null;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))
    return null;
  return { contextId: value.contextId, updatedAt: value.updatedAt };
};
