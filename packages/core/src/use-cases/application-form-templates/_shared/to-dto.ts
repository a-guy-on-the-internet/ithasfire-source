import type { ApplicationFormTemplateRecord } from "@th/types";

import { normalizeQuestionOptions } from "../../events/_shared/question-options";
import type { ApplicationFormTemplateDTO } from "../schemas";

const CHOICE_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);

/**
 * Record → DTO. The only interesting part is `options`: rows written before
 * the canonical `{ id, label }` shape settled (or seeded by hand) can hold the
 * builder shape or bare strings, so every read goes through the SAME
 * `normalizeQuestionOptions` helper the question write path and the submit-time
 * snapshot use. Non-choice questions read `null`, never `[]` — that is the
 * shape `EventApplicationQuestion.options` stores, and apply copies across
 * verbatim.
 */
export function toApplicationFormTemplateDto(
  record: ApplicationFormTemplateRecord,
): ApplicationFormTemplateDTO {
  return {
    id: record.id,
    ownerScope: record.ownerScope,
    ownerId: record.ownerId,
    name: record.name,
    description: record.description,
    introText: record.introText,
    questions: record.questions.map((question) => {
      const options = normalizeQuestionOptions(question.options);
      return {
        type: question.type,
        label: question.label,
        description: question.description ?? null,
        options:
          CHOICE_TYPES.has(question.type) && options.length > 0
            ? options
            : null,
        isRequired: question.isRequired,
      };
    }),
    isPlatform: record.isPlatform,
    archivedAt: record.archivedAt,
    createdByHumanId: record.createdByHumanId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
