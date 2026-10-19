import { describe, expect, it } from "vitest";

import {
  findChoiceQuestionMissingOptions,
  hasEmptyChoiceOptions,
  hasUnsavedFormChanges,
  questionSignature,
  toApiQuestionFields,
  toBuilderOptions,
  toBuilderQuestions,
  toTemplateQuestionsPayload,
} from "../form-builder-helpers";
import type { FormBuilderQuestion } from "../FormBuilder";

function question(
  overrides: Partial<FormBuilderQuestion> = {},
): FormBuilderQuestion {
  return {
    key: "k1",
    type: "SHORT_TEXT",
    label: "Act name",
    description: "",
    options: [],
    isRequired: false,
    ...overrides,
  };
}

describe("toBuilderOptions", () => {
  it("reads the canonical { id, label } shape", () => {
    expect(
      toBuilderOptions([
        { id: "opt-1", label: "30 min" },
        { id: "opt-2", label: "45 min" },
      ]),
    ).toEqual([{ value: "30 min" }, { value: "45 min" }]);
  });

  it("reads the builder { value } shape", () => {
    expect(toBuilderOptions([{ value: "Table" }])).toEqual([
      { value: "Table" },
    ]);
  });

  it("reads bare strings and finite numbers (legacy at-rest rows)", () => {
    expect(toBuilderOptions(["Yes", "No", 15])).toEqual([
      { value: "Yes" },
      { value: "No" },
      { value: "15" },
    ]);
  });

  it("prefers a non-blank label over value on a mixed row", () => {
    expect(toBuilderOptions([{ id: "x", label: "  ", value: "Fallback" }])).toEqual(
      [{ value: "Fallback" }],
    );
  });

  it("drops blank and unusable entries instead of rendering empty inputs", () => {
    expect(toBuilderOptions(["", "  ", null, {}, 42])).toEqual([
      { value: "42" },
    ]);
  });

  it("returns [] for a non-array", () => {
    expect(toBuilderOptions(null)).toEqual([]);
    expect(toBuilderOptions("nope")).toEqual([]);
  });
});

describe("toBuilderQuestions", () => {
  it("uses the server id as BOTH key and serverId when present", () => {
    const [built] = toBuilderQuestions([
      {
        id: "q-1",
        type: "SHORT_TEXT",
        label: "Act name",
        description: null,
        isRequired: true,
      },
    ]);
    expect(built!.key).toBe("q-1");
    expect(built!.serverId).toBe("q-1");
  });

  it("mints a local key and leaves serverId ABSENT for an id-less entry", () => {
    // Template questions are a JSON array with no ids — they must not look
    // like persisted rows, or the host would try to PATCH them.
    const [built] = toBuilderQuestions([
      { type: "LONG_TEXT", label: "Why?", isRequired: false },
    ]);
    expect(built!.key).toMatch(/^local-\d+$/);
    expect(built).not.toHaveProperty("serverId");
  });

  it("drops options on a non-choice question", () => {
    const [built] = toBuilderQuestions([
      {
        type: "SHORT_TEXT",
        label: "Name",
        options: [{ id: "opt-1", label: "stale" }],
        isRequired: false,
      },
    ]);
    expect(built!.options).toEqual([]);
  });
});

describe("toApiQuestionFields", () => {
  it("sends options as undefined (never []) for a non-choice type", () => {
    // `[]` is still "options", and the server refuses options on a
    // non-choice question (OPTIONS_NOT_ALLOWED).
    expect(toApiQuestionFields(question()).options).toBeUndefined();
  });

  it("drops blank option rows — the trailing empty row is an affordance", () => {
    const fields = toApiQuestionFields(
      question({
        type: "SINGLE_CHOICE",
        options: [{ value: "Yes" }, { value: "   " }, { value: "No" }],
      }),
    );
    expect(fields.options).toEqual([{ value: "Yes" }, { value: "No" }]);
  });

  it("trims the label and sends a blank description as undefined", () => {
    const fields = toApiQuestionFields(
      question({ label: "  Act name  ", description: "   " }),
    );
    expect(fields.label).toBe("Act name");
    expect(fields.description).toBeUndefined();
  });
});

describe("toTemplateQuestionsPayload", () => {
  it("drops label-less questions and sends description as null", () => {
    const payload = toTemplateQuestionsPayload([
      question({ key: "a", label: "Act name" }),
      question({ key: "b", label: "   " }),
    ]);
    expect(payload).toEqual([
      {
        type: "SHORT_TEXT",
        label: "Act name",
        description: null,
        isRequired: false,
      },
    ]);
  });

  it("omits the options key entirely for non-choice questions", () => {
    const [entry] = toTemplateQuestionsPayload([question()]);
    expect(Object.keys(entry!)).not.toContain("options");
  });

  it("keeps canonicalizable options on choice questions", () => {
    const [entry] = toTemplateQuestionsPayload([
      question({
        type: "MULTI_CHOICE",
        label: "Booth needs",
        options: [{ value: "Table" }, { value: "Power" }],
      }),
    ]);
    expect(entry!.options).toEqual([{ value: "Table" }, { value: "Power" }]);
  });
});

describe("questionSignature", () => {
  it("ignores identity and position — only content matters", () => {
    expect(questionSignature(question({ key: "a" }))).toBe(
      questionSignature(question({ key: "b", serverId: "s" })),
    );
  });

  it("changes when a field changes", () => {
    expect(questionSignature(question())).not.toBe(
      questionSignature(question({ isRequired: true })),
    );
  });

  it("ignores a blank trailing option (it is not saved either)", () => {
    const withBlank = question({
      type: "SINGLE_CHOICE",
      options: [{ value: "Yes" }, { value: "" }],
    });
    const without = question({
      type: "SINGLE_CHOICE",
      options: [{ value: "Yes" }],
    });
    expect(questionSignature(withBlank)).toBe(questionSignature(without));
  });
});

describe("hasEmptyChoiceOptions", () => {
  it("flags a labelled choice question with no usable options", () => {
    expect(
      hasEmptyChoiceOptions([
        question({ type: "SINGLE_CHOICE", label: "Pick", options: [{ value: "" }] }),
      ]),
    ).toBe(true);
  });

  it("ignores an unlabelled draft card", () => {
    expect(
      hasEmptyChoiceOptions([
        question({ type: "SINGLE_CHOICE", label: "", options: [] }),
      ]),
    ).toBe(false);
  });

  it("ignores non-choice questions", () => {
    expect(hasEmptyChoiceOptions([question()])).toBe(false);
  });
});

describe("findChoiceQuestionMissingOptions", () => {
  it("returns the offending question so the message can name it", () => {
    const bad = question({
      key: "b",
      type: "SINGLE_CHOICE",
      label: "Set length",
      options: [{ value: "  " }],
    });
    expect(
      findChoiceQuestionMissingOptions([question(), bad])?.label,
    ).toBe("Set length");
  });

  it("returns null when every choice question has a usable option", () => {
    expect(
      findChoiceQuestionMissingOptions([
        question({ type: "MULTI_CHOICE", options: [{ value: "Table" }] }),
      ]),
    ).toBeNull();
  });
});

describe("hasUnsavedFormChanges", () => {
  const loaded = (
    questions: FormBuilderQuestion[],
  ): {
    loadedSignatures: Map<string, string>;
    loadedOrder: Map<string, number>;
  } => ({
    loadedSignatures: new Map(
      questions.flatMap((q) =>
        q.serverId ? [[q.serverId, questionSignature(q)] as const] : [],
      ),
    ),
    loadedOrder: new Map(
      questions.flatMap((q, i) => (q.serverId ? [[q.serverId, i] as const] : [])),
    ),
  });

  const persisted = [
    question({ key: "s1", serverId: "s1", label: "Act name" }),
    question({ key: "s2", serverId: "s2", label: "Genre" }),
  ];

  it("is false for a pristine, freshly hydrated form", () => {
    expect(
      hasUnsavedFormChanges({
        questions: persisted,
        ...loaded(persisted),
        pendingDeletes: [],
      }),
    ).toBe(false);
  });

  it("is true for a queued delete", () => {
    expect(
      hasUnsavedFormChanges({
        questions: persisted,
        ...loaded(persisted),
        pendingDeletes: ["s2"],
      }),
    ).toBe(true);
  });

  it("is true for a NEW question that has a label", () => {
    expect(
      hasUnsavedFormChanges({
        questions: [...persisted, question({ key: "new", label: "Extra" })],
        ...loaded(persisted),
        pendingDeletes: [],
      }),
    ).toBe(true);
  });

  it("is FALSE for a blank draft card — the save handlers skip those", () => {
    expect(
      hasUnsavedFormChanges({
        questions: [...persisted, question({ key: "new", label: "   " })],
        ...loaded(persisted),
        pendingDeletes: [],
      }),
    ).toBe(false);
  });

  it("is true when a persisted question's CONTENT changed", () => {
    const edited = [
      { ...persisted[0]!, label: "Act or band name" },
      persisted[1]!,
    ];
    expect(
      hasUnsavedFormChanges({
        questions: edited,
        ...loaded(persisted),
        pendingDeletes: [],
      }),
    ).toBe(true);
  });

  it("is true when a persisted question only MOVED (content is identical)", () => {
    // Reorder is invisible to a signature-only check — this is the case a
    // naive dirty-check misses.
    expect(
      hasUnsavedFormChanges({
        questions: [persisted[1]!, persisted[0]!],
        ...loaded(persisted),
        pendingDeletes: [],
      }),
    ).toBe(true);
  });
});
