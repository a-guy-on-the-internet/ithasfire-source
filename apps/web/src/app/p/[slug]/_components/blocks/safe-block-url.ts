export function getSafeExternalHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

export function getSafeMailtoHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/[?#&%]/.test(trimmed)) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return undefined;
  return `mailto:${trimmed}`;
}

export function getSafeTelHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[+0-9().\-\s]{3,80}$/.test(trimmed)) return undefined;
  return `tel:${trimmed.replace(/[\s().-]/g, "")}`;
}
