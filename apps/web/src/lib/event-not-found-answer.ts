/**
 * True only for the API's expected "this event has no open application form"
 * answer (`NOT_FOUND` + `appCode: EVENT_NOT_FOUND`). A bare `NOT_FOUND`
 * (e.g. "No procedure found", web/API skew) stays loud. Mirrors the SSR
 * seed's rule in `fetchPublicApplicationFormSeed` (server/events.ts).
 */
export function isEventNotFoundAnswer(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    data?: { code?: unknown; appCode?: unknown } | null;
    shape?: { data?: { code?: unknown; appCode?: unknown } | null } | null;
  };
  const d = e.data ?? e.shape?.data;
  return d?.code === "NOT_FOUND" && d?.appCode === "EVENT_NOT_FOUND";
}
