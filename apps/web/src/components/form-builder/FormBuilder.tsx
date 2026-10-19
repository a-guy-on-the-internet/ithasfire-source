"use client";

/**
 * FormBuilder — the generic question-list editor, extracted out of
 * `ApplicationFormBuilder` per decision D8 of
 * docs/specs/2026-08-10/application-driven-events.spec.md (which absorbs the
 * 2026-03-23 generic-FormBuilder draft).
 *
 * CALLBACK-DRIVEN AND tRPC-FREE by contract. It owns exactly one thing: the
 * shape of a question list and the interactions that change it (add via type
 * picker, edit label/description/options, toggle required, reorder, remove).
 * It never fetches, never saves, and never knows what an "event" is — which is
 * what lets the SAME component back both the event's application form and the
 * org-workspace template editor, where there is no event at all.
 *
 * Two consumers today:
 *   - `ApplicationFormBuilder` (event scope) — persists through
 *     `events.upsertApplicationQuestion` / `deleteApplicationQuestion`.
 *   - `ApplicationFormTemplatesView` (org scope) — persists the whole array as
 *     one `questions` JSON payload.
 *
 * ORDER IS ARRAY POSITION. There is deliberately no `order` field on
 * `FormBuilderQuestion`: a stored number and an array index are two sources of
 * truth for one fact, and every reorder bug in this family comes from them
 * disagreeing. Hosts that persist an explicit order derive it from the index.
 *
 * The `ApplicationQuestionType → FormQuestionType` enum rename from the
 * 2026-03-23 draft is DROPPED (spec D8: churn, no behavioural gain), so the
 * type union here is spelled exactly as the API spells it.
 *
 * NOT in scope: volunteer forms. Their `formSchema` Json shape differs; the
 * spec records the migration as a follow-up, not part of Phase 4.
 */

import { useCallback, useState } from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import {
  AlignLeft,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  CircleDot,
  GripVertical,
  Plus,
  Trash2,
  Type,
  X,
} from "lucide-react";

import { Button, Switch, Text, TextInput, useTranslations } from "@th/ui";
import { useIsMobile } from "@/hooks/useIsMobile";

// ─────────────────────────────────────────────────────────────────────────────
// Styled — unchanged from the original ApplicationFormBuilder so the extraction
// is visually a no-op.
// ─────────────────────────────────────────────────────────────────────────────

const QuestionCard = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  overflow: "hidden",
});

const QuestionCardHeader = styled(XStack, {
  padding: 12,
  gap: 10,
  alignItems: "center",
  backgroundColor: "$surface",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceOverlay" },
});

const QuestionCardBody = styled(YStack, {
  padding: 16,
  gap: 12,
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
});

const TypeTag = styled(XStack, {
  paddingHorizontal: 8,
  paddingVertical: 2,
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

/**
 * In-flow type picker. Lives at the end of the scroll body (above any pinned
 * footer) instead of a fixed full-screen overlay, so on a 360px phone it can't
 * overlap the footer or clip past the viewport.
 */
const TypePickerCard = styled(YStack, {
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  padding: 8,
  gap: 4,
});

const TypePickerOption = styled(XStack, {
  padding: 12,
  minHeight: 44,
  borderRadius: 0,
  gap: 12,
  alignItems: "center",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  pressStyle: { backgroundColor: "$surfaceMuted", opacity: 0.85 },
  focusStyle: { backgroundColor: "$surfaceMuted" },
});

const OptionRow = styled(XStack, {
  gap: 8,
  alignItems: "center",
});

/**
 * Bold, single-line primary label. Ellipsizes so a long question label can't
 * wrap the card header (same treatment as `EditorCardTitle` in the event
 * builder's `_mobile-bits`, inlined here so this component stays free of
 * admin-route imports).
 */
const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four SHIPPED question types. Deliberately NOT renamed to
 * `FormQuestionType` (spec D8 drops that rename as churn).
 */
export type ApplicationQuestionType =
  | "SHORT_TEXT"
  | "LONG_TEXT"
  | "SINGLE_CHOICE"
  | "MULTI_CHOICE";

/**
 * Builder-shape option: display text in `value`. This is the shape the API's
 * question/template write paths accept and normalize to the canonical
 * `{ id, label }` pair server-side — the builder never invents ids.
 */
export type FormBuilderOption = { value: string; label?: string };

export type FormBuilderQuestion = {
  /**
   * Stable identity WITHIN the builder for React keys and per-row callbacks.
   * For a persisted row the host sets it to the server id; for a new row use
   * {@link makeFormBuilderKey}. Never rendered.
   */
  key: string;
  /** Server id when the question already exists; undefined for a new one. */
  serverId?: string;
  type: ApplicationQuestionType;
  label: string;
  description: string;
  /** Non-empty only for the two choice types. */
  options: FormBuilderOption[];
  isRequired: boolean;
};

export const QUESTION_TYPE_META: Record<
  ApplicationQuestionType,
  { labelKey: string; descriptionKey: string; icon: typeof Type }
> = {
  SHORT_TEXT: {
    labelKey: "admin.afShortText",
    descriptionKey: "admin.afShortTextDesc",
    icon: Type,
  },
  LONG_TEXT: {
    labelKey: "admin.afLongText",
    descriptionKey: "admin.afLongTextDesc",
    icon: AlignLeft,
  },
  SINGLE_CHOICE: {
    labelKey: "admin.afSingleChoice",
    descriptionKey: "admin.afSingleChoiceDesc",
    icon: CircleDot,
  },
  MULTI_CHOICE: {
    labelKey: "admin.afMultiChoice",
    descriptionKey: "admin.afMultiChoiceDesc",
    icon: CheckSquare,
  },
};

export const isChoiceType = (type: ApplicationQuestionType) =>
  type === "SINGLE_CHOICE" || type === "MULTI_CHOICE";

let nextKeySeq = 0;
/** Monotonic local key for a not-yet-persisted question. */
export function makeFormBuilderKey(): string {
  nextKeySeq += 1;
  return `local-${nextKeySeq}`;
}

/** A blank question of the given type, ready to append. */
export function createFormBuilderQuestion(
  type: ApplicationQuestionType,
): FormBuilderQuestion {
  return {
    key: makeFormBuilderKey(),
    type,
    label: "",
    description: "",
    options: isChoiceType(type) ? [{ value: "" }] : [],
    isRequired: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export type FormBuilderProps = {
  /** The controlled question list. Position IS the order. */
  questions: FormBuilderQuestion[];
  /** Called with the WHOLE next list on any structural or field edit. */
  onQuestionsChange: (next: FormBuilderQuestion[]) => void;
  /**
   * Called with the server id of a question the user removed, so the host can
   * schedule a delete. Fired only for rows that were persisted; removing a
   * never-saved row is purely local.
   */
  onRemovePersisted?: (serverId: string) => void;
  /** Controlled visibility of the in-flow type picker. */
  typePickerOpen: boolean;
  onTypePickerOpenChange: (open: boolean) => void;
  /** Disables every interactive control (e.g. while the host is saving). */
  disabled?: boolean;
  /** Rendered above the list — the host's template affordances, etc. */
  headerSlot?: React.ReactNode;
  /** Copy shown when there are no questions and the picker is closed. */
  emptyStateText?: string;
  testId?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FormBuilder({
  questions,
  onQuestionsChange,
  onRemovePersisted,
  typePickerOpen,
  onTypePickerOpenChange,
  disabled = false,
  headerSlot,
  emptyStateText,
  testId = "form-builder",
}: FormBuilderProps) {
  const t = useTranslations();
  const theme = useTheme();
  const isMobile = useIsMobile();

  // Expansion is pure presentation and never leaves the builder — putting it in
  // the host's model would make every accordion toggle look like a form edit.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const patchQuestion = useCallback(
    (key: string, patch: Partial<FormBuilderQuestion>) => {
      onQuestionsChange(
        questions.map((q) => (q.key === key ? { ...q, ...patch } : q)),
      );
    },
    [questions, onQuestionsChange],
  );

  const addQuestion = useCallback(
    (type: ApplicationQuestionType) => {
      const question = createFormBuilderQuestion(type);
      onQuestionsChange([...questions, question]);
      // A brand-new question opens straight into its editor; a collapsed blank
      // card reads as "nothing happened".
      setExpandedKeys((prev) => new Set(prev).add(question.key));
      onTypePickerOpenChange(false);
    },
    [questions, onQuestionsChange, onTypePickerOpenChange],
  );

  const removeQuestion = useCallback(
    (key: string) => {
      const target = questions.find((q) => q.key === key);
      if (target?.serverId) onRemovePersisted?.(target.serverId);
      onQuestionsChange(questions.filter((q) => q.key !== key));
    },
    [questions, onQuestionsChange, onRemovePersisted],
  );

  const moveQuestion = useCallback(
    (key: string, direction: "up" | "down") => {
      const index = questions.findIndex((q) => q.key === key);
      if (index < 0) return;
      const swapIndex = direction === "up" ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= questions.length) return;
      const next = [...questions];
      [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
      onQuestionsChange(next);
    },
    [questions, onQuestionsChange],
  );

  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const addOption = useCallback(
    (key: string) => {
      const target = questions.find((q) => q.key === key);
      if (!target) return;
      patchQuestion(key, { options: [...target.options, { value: "" }] });
    },
    [questions, patchQuestion],
  );

  const updateOption = useCallback(
    (key: string, index: number, value: string) => {
      const target = questions.find((q) => q.key === key);
      if (!target) return;
      const options = [...target.options];
      options[index] = { ...options[index]!, value };
      patchQuestion(key, { options });
    },
    [questions, patchQuestion],
  );

  const removeOption = useCallback(
    (key: string, index: number) => {
      const target = questions.find((q) => q.key === key);
      if (!target) return;
      patchQuestion(key, {
        options: target.options.filter((_, i) => i !== index),
      });
    },
    [questions, patchQuestion],
  );

  // Reorder / remove targets grow to 44px on touch so they clear the tap
  // minimum; on desktop they stay compact to match the dense modal density.
  const reorderTouch = isMobile ? 44 : 24;
  const removeTouch = isMobile ? 44 : 24;

  return (
    <YStack gap={12} data-testid={testId}>
      {headerSlot}

      {questions.length === 0 && !typePickerOpen ? (
        <YStack
          flex={1}
          justifyContent="center"
          alignItems="center"
          gap={8}
          padding={32}
        >
          <Text style={{ fontSize: 15, textAlign: "center" }} tone="muted">
            {emptyStateText ?? String(t("admin.afEmptyState"))}
          </Text>
        </YStack>
      ) : (
        questions.map((question, index) => {
          const meta = QUESTION_TYPE_META[question.type];
          const IconComp = meta.icon;
          const isFirst = index === 0;
          const isLast = index === questions.length - 1;
          const expanded = expandedKeys.has(question.key);
          return (
            <QuestionCard
              key={question.key}
              data-testid="app-question-card"
            >
              <QuestionCardHeader
                onPress={() => toggleExpand(question.key)}
              >
                {/* Reorder arrows — ghost icon buttons matching LineupEditor's
                    reorder affordance (disabled at bounds, >=44px on touch).
                    stopPropagation keeps a tap on an arrow from toggling the
                    accordion header it lives inside. */}
                <YStack gap={isMobile ? 4 : 0} flexShrink={0}>
                  <Button
                    variant="ghost"
                    size={isMobile ? "$4" : "$2"}
                    icon
                    minWidth={reorderTouch}
                    minHeight={isMobile ? 44 : 14}
                    disabled={disabled || isFirst}
                    aria-label={String(t("admin.toolbarMoveUp"))}
                    onPress={(e: { stopPropagation?: () => void }) => {
                      e.stopPropagation?.();
                      moveQuestion(question.key, "up");
                    }}
                  >
                    <ChevronUp size={16} color={theme.colorMuted?.val} />
                  </Button>
                  <Button
                    variant="ghost"
                    size={isMobile ? "$4" : "$2"}
                    icon
                    minWidth={reorderTouch}
                    minHeight={isMobile ? 44 : 14}
                    disabled={disabled || isLast}
                    aria-label={String(t("admin.toolbarMoveDown"))}
                    onPress={(e: { stopPropagation?: () => void }) => {
                      e.stopPropagation?.();
                      moveQuestion(question.key, "down");
                    }}
                  >
                    <ChevronDown size={16} color={theme.colorMuted?.val} />
                  </Button>
                </YStack>

                {/* Drag handle is a desktop affordance only; reorder is driven
                    entirely by the up/down buttons on both breakpoints, so the
                    grip is purely decorative — hide it from AT. */}
                {!isMobile && (
                  <GripVertical
                    size={16}
                    color={theme.borderColor?.val}
                    aria-hidden="true"
                  />
                )}

                <YStack flex={1} gap={2} minWidth={0}>
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    minWidth={0}
                    style={ELLIPSIS_STYLE}
                  >
                    {question.label ||
                      String(t("admin.afUntitledQuestion"))}
                  </Text>
                  {/* On phones the type tag wraps under the title instead of
                      competing for the same row. */}
                  {isMobile && (
                    <XStack gap={4} alignItems="center">
                      <IconComp size={12} color={theme.colorMuted?.val} />
                      <Text style={{ fontSize: 11 }} tone="muted">
                        {String(t(meta.labelKey))}
                      </Text>
                    </XStack>
                  )}
                </YStack>

                {!isMobile && (
                  <TypeTag>
                    <XStack gap={4} alignItems="center">
                      <IconComp size={12} color={theme.colorMuted?.val} />
                      <Text style={{ fontSize: 11 }} tone="muted">
                        {String(t(meta.labelKey))}
                      </Text>
                    </XStack>
                  </TypeTag>
                )}

                <XStack
                  role="button"
                  aria-label={String(
                    t("admin.afRemoveQuestion", {
                      label:
                        question.label ||
                        String(t("admin.afUntitledQuestion")),
                    }),
                  )}
                  cursor="pointer"
                  flexShrink={0}
                  width={removeTouch}
                  height={removeTouch}
                  alignItems="center"
                  justifyContent="center"
                  onPress={(e: { stopPropagation?: () => void }) => {
                    e.stopPropagation?.();
                    if (disabled) return;
                    removeQuestion(question.key);
                  }}
                  borderRadius={0}
                  hoverStyle={{ backgroundColor: "$dangerMuted" }}
                  pressStyle={{
                    backgroundColor: "$dangerMuted",
                    opacity: 0.8,
                  }}
                >
                  <Trash2 size={16} color={theme.danger?.val} />
                </XStack>
              </QuestionCardHeader>

              {expanded && (
                <QuestionCardBody>
                  <YStack gap={4}>
                    <Text
                      style={{ fontSize: 12, fontWeight: "500" }}
                      color="$color"
                    >
                      {String(t("admin.afLabel"))}
                    </Text>
                    <TextInput
                      value={question.label}
                      onChangeText={(v: string) =>
                        patchQuestion(question.key, { label: v })
                      }
                      placeholder={t("admin.afLabelPlaceholder") as string}
                      maxLength={200}
                      editable={!disabled}
                      fullWidth
                      minHeight={44}
                    />
                  </YStack>

                  <YStack gap={4}>
                    <Text
                      style={{ fontSize: 12, fontWeight: "500" }}
                      color="$color"
                    >
                      {String(t("admin.afDescriptionOptional"))}
                    </Text>
                    <TextInput
                      value={question.description}
                      onChangeText={(v: string) =>
                        patchQuestion(question.key, { description: v })
                      }
                      placeholder={
                        t("admin.afDescriptionPlaceholder") as string
                      }
                      maxLength={2000}
                      editable={!disabled}
                      fullWidth
                      minHeight={44}
                    />
                  </YStack>

                  {isChoiceType(question.type) && (
                    <YStack gap={8}>
                      <Text
                        style={{ fontSize: 12, fontWeight: "500" }}
                        color="$color"
                      >
                        {String(t("admin.afOptions"))}
                      </Text>
                      {question.options.map((option, optionIndex) => (
                        <OptionRow key={optionIndex}>
                          <TextInput
                            value={option.value}
                            onChangeText={(v: string) =>
                              updateOption(question.key, optionIndex, v)
                            }
                            placeholder={
                              t("admin.afOptionPlaceholder", {
                                number: optionIndex + 1,
                              }) as string
                            }
                            maxLength={200}
                            editable={!disabled}
                            fullWidth
                            minHeight={44}
                            style={{ flex: 1 }}
                          />
                          <XStack
                            role="button"
                            aria-label={String(
                              t("admin.afRemoveOption", {
                                number: optionIndex + 1,
                              }),
                            )}
                            cursor="pointer"
                            flexShrink={0}
                            width={44}
                            height={44}
                            alignItems="center"
                            justifyContent="center"
                            onPress={() => {
                              if (disabled) return;
                              removeOption(question.key, optionIndex);
                            }}
                            borderRadius={0}
                            hoverStyle={{ backgroundColor: "$dangerMuted" }}
                            pressStyle={{
                              backgroundColor: "$dangerMuted",
                              opacity: 0.8,
                            }}
                          >
                            <X size={16} color={theme.danger?.val} />
                          </XStack>
                        </OptionRow>
                      ))}
                      <Button
                        variant="ghost"
                        size="$2"
                        minHeight={44}
                        alignSelf="flex-start"
                        disabled={disabled}
                        onPress={() => addOption(question.key)}
                      >
                        <Plus size={14} aria-hidden />
                        {String(t("admin.afAddOption"))}
                      </Button>
                    </YStack>
                  )}

                  {/* Required toggle — the sanctioned @th/ui Switch (v2
                      radius-0 square track), not an ad-hoc rounded pill. */}
                  <Switch
                    size="small"
                    checked={question.isRequired}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      patchQuestion(question.key, { isRequired: next })
                    }
                    label={String(t("admin.afRequired"))}
                  />
                </QuestionCardBody>
              )}
            </QuestionCard>
          );
        })
      )}

      {/* In-flow type picker — opened by the host's "Add question" control.
          Sits at the end of the list so it never overlays a pinned footer or
          clips past a narrow viewport. */}
      {typePickerOpen && (
        <TypePickerCard data-testid="app-question-type-picker">
          <XStack
            justifyContent="space-between"
            alignItems="center"
            paddingHorizontal={12}
            paddingTop={8}
            paddingBottom={4}
          >
            <Text style={{ fontSize: 13, fontWeight: "700" }} color="$color">
              {String(t("admin.afChooseType"))}
            </Text>
            <XStack
              role="button"
              aria-label={String(t("common.close"))}
              cursor="pointer"
              width={32}
              height={32}
              alignItems="center"
              justifyContent="center"
              borderRadius={0}
              hoverStyle={{ backgroundColor: "$surfaceMuted" }}
              onPress={() => onTypePickerOpenChange(false)}
              data-testid="app-question-type-picker-close"
            >
              <X size={16} color={theme.colorMuted?.val} />
            </XStack>
          </XStack>
          {(
            Object.entries(QUESTION_TYPE_META) as [
              ApplicationQuestionType,
              (typeof QUESTION_TYPE_META)[ApplicationQuestionType],
            ][]
          ).map(([type, meta]) => {
            const IconComp = meta.icon;
            return (
              <TypePickerOption
                key={type}
                role="button"
                onPress={() => {
                  if (disabled) return;
                  addQuestion(type);
                }}
                data-testid={`app-question-type-${type.toLowerCase()}`}
              >
                <XStack
                  width={36}
                  height={36}
                  flexShrink={0}
                  borderRadius={0}
                  backgroundColor="$surfaceMuted"
                  alignItems="center"
                  justifyContent="center"
                >
                  <IconComp size={18} color={theme.color?.val} />
                </XStack>
                <YStack flex={1} gap={1} minWidth={0}>
                  <Text
                    style={{ fontSize: 14, fontWeight: "500" }}
                    color="$color"
                  >
                    {String(t(meta.labelKey))}
                  </Text>
                  <Text style={{ fontSize: 12 }} tone="muted">
                    {String(t(meta.descriptionKey))}
                  </Text>
                </YStack>
              </TypePickerOption>
            );
          })}
        </TypePickerCard>
      )}
    </YStack>
  );
}

export default FormBuilder;
