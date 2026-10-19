const normalize = (value: string | undefined | null): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const STORAGE_KEY = "th:clientKey:v1";

const generateClientKey = (): string => {
  // Prefer crypto.randomUUID() when available.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  // Fallback: not cryptographically strong, but okay for idempotency keys.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
    .toString(16)
    .slice(2)}`;
};

export const getAppClientKey = (): string => {
  const fromEnv = normalize(process.env.NEXT_PUBLIC_APP_CLIENT_KEY);

  // If the deploy wants a fixed client key (e.g. to simplify logs), allow it.
  if (fromEnv) {
    return fromEnv;
  }

  // Client-side: persist a stable key for this browser.
  if (typeof window !== "undefined") {
    const existing = normalize(window.localStorage.getItem(STORAGE_KEY));
    if (existing) {
      return existing;
    }

    const next = generateClientKey();
    window.localStorage.setItem(STORAGE_KEY, next);
    return next;
  }

  // Server-side fallback: shouldn't be used for user-triggered mutations since
  // they run client-side, but keep deterministic-ish value.
  return "web-ssr";
};
