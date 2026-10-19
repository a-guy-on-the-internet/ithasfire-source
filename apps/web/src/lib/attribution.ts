const ATTRIBUTION_KEY = "hf:attribution";

export interface AttributionParams {
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  eventSlug: string;
  capturedAt: string;
}

export function captureAttribution(params: AttributionParams): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(params));
  } catch {
    // sessionStorage unavailable (private mode, etc.)
  }
}

export function getAttribution(): AttributionParams | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Shape + type check — guards against tampered sessionStorage blobs
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.eventSlug !== "string" ||
      (parsed.ref !== undefined && typeof parsed.ref !== "string") ||
      (parsed.utmSource !== undefined &&
        typeof parsed.utmSource !== "string") ||
      (parsed.utmMedium !== undefined &&
        typeof parsed.utmMedium !== "string") ||
      (parsed.utmCampaign !== undefined &&
        typeof parsed.utmCampaign !== "string") ||
      typeof parsed.capturedAt !== "string"
    ) {
      return null;
    }
    return parsed as AttributionParams;
  } catch {
    return null;
  }
}

export function clearAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(ATTRIBUTION_KEY);
  } catch {
    // noop
  }
}
