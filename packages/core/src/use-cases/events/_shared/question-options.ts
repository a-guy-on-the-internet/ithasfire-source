import type { EventApplicationQuestionOption } from "@th/ports/repos/events";

/**
 * Normalize a question's raw `options` value to the CANONICAL `{ id, label }`
 * shape. Shared by:
 *
 *  - `upsert-event-application-question` (write path — after zod validates/
 *    sanitizes the accepted input union),
 *  - `submit-event-application`'s `buildQuestionsSnapshot` (spec D3 — the
 *    snapshot must only ever contain canonical entries, even when the live
 *    question row carries a legacy shape),
 *  - the submission record schema's tolerant `options` read.
 *
 * PARITY RULE: accepts every at-rest shape the gate's `parseQuestionOptions`
 * (packages/ui EventApplicationGate.tsx) knows about — plain strings, finite
 * numbers, builder-shape `{ value, label? }` and canonical `{ id, label }` —
 * and drops anything else (blank display text included). Entries without a
 * usable id get deterministic positional ids (`opt-1`, `opt-2`, …), which is
 * safe because answers reference options by their human-readable text, not
 * by id — ids only need uniqueness within one question.
 */
export function normalizeQuestionOptions(
  raw: unknown,
): EventApplicationQuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: EventApplicationQuestionOption[] = [];

  for (const entry of raw) {
    let label: string | null = null;
    let id: string | null = null;

    if (typeof entry === "string") {
      label = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      // Numeric option lists ([15, 30, 45]) keep their string form rather
      // than vanishing (same rule as the gate).
      label = String(entry);
    } else if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const rawLabel = typeof record.label === "string" ? record.label : null;
      const rawValue = typeof record.value === "string" ? record.value : null;
      // Builder shape puts the display text in `value` (label optional);
      // canonical shape puts it in `label`. Prefer `label` when non-blank.
      label = rawLabel?.trim() ? rawLabel : rawValue;
      id =
        typeof record.id === "string" && record.id.trim().length > 0
          ? record.id
          : null;
    }

    const trimmed = label?.trim();
    if (!trimmed) {
      continue;
    }

    normalized.push({
      id: id ?? `opt-${normalized.length + 1}`,
      label: trimmed,
    });
  }

  return normalized;
}
