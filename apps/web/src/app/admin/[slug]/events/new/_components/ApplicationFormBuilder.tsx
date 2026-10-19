"use client";

/**
 * ApplicationFormBuilder — the EVENT-scoped wrapper around the generic
 * `FormBuilder` (spec D8: the builder was extracted so the org-workspace
 * template editor can reuse it outside any event context).
 *
 * Everything left in this file is event-specific: loading the form, persisting
 * questions through `events.upsertApplicationQuestion` /
 * `deleteApplicationQuestion`, and the two template affordances the spec puts
 * on this surface — "Start from a template" and "Save as template".
 *
 * Question ORDER is array position; the per-question upsert derives its
 * `order` from the index at save time.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import { LayoutTemplate, Plus, Save } from "lucide-react";

import { Button, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import {
  FormBuilder,
  type FormBuilderQuestion,
} from "@/components/form-builder/FormBuilder";
import {
  findChoiceQuestionMissingOptions,
  hasUnsavedFormChanges,
  questionSignature,
  toApiQuestionFields,
  toBuilderQuestions,
} from "@/components/form-builder/form-builder-helpers";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { EventEditorSheet } from "./EventEditorSheet";
import { ApplicationTemplatePickerDialog } from "./ApplicationTemplatePickerDialog";
import { SaveApplicationFormTemplateDialog } from "./SaveApplicationFormTemplateDialog";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";

export type ApplicationFormBuilderProps = {
  eventId: string;
  open: boolean;
  onClose: () => void;
  /**
   * The EVENT's owner — whose application-template library "Start from a
   * template" / "Save as template" use. Not the URL workspace: a delegate on
   * a principal's event works in the principal's library.
   */
  templateOwner: TemplateOwnerRef;
};

export function ApplicationFormBuilder({
  eventId,
  open,
  onClose,
  templateOwner,
}: ApplicationFormBuilderProps) {
  const t = useTranslations();
  const trpcUtils = trpc.useUtils();

  const [formId, setFormId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<FormBuilderQuestion[]>([]);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);

  /**
   * Content signature of each question as LOADED. A question is re-sent only
   * when its signature changed or its position moved — without this, every
   * save re-POSTs the whole form.
   */
  const [loadedSignatures, setLoadedSignatures] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [loadedOrder, setLoadedOrder] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const formQuery = trpc.events.getApplicationForm.useQuery(
    { eventId },
    { enabled: open },
  );

  const hydrate = useCallback(
    (data: NonNullable<typeof formQuery.data>) => {
      if (data.form) setFormId(data.form.id);
      const next = toBuilderQuestions(data.questions);
      setQuestions(next);
      setLoadedSignatures(
        new Map(
          next
            .filter((q) => q.serverId)
            .map((q) => [q.serverId!, questionSignature(q)]),
        ),
      );
      setLoadedOrder(
        new Map(
          next.flatMap((q, index) => (q.serverId ? [[q.serverId, index]] : [])),
        ),
      );
      setPendingDeletes([]);
    },
    [],
  );

  useEffect(() => {
    if (!formQuery.data) return;
    hydrate(formQuery.data);
  }, [formQuery.data, hydrate]);

  const upsertFormMut = trpc.events.upsertApplicationForm.useMutation();
  const upsertQuestionMut = trpc.events.upsertApplicationQuestion.useMutation();
  const deleteQuestionMut = trpc.events.deleteApplicationQuestion.useMutation();

  /** Ensure the form row exists (idempotent) and return its id. */
  const ensureForm = useCallback(async (): Promise<string> => {
    if (formId) return formId;
    const res = await upsertFormMut.mutateAsync({
      eventId,
      defaults: {
        includeName: true,
        includeReason: true,
        includeSocialLinks: false,
      },
    });
    setFormId(res.formId);
    return res.formId;
  }, [formId, eventId, upsertFormMut]);

  const handleRemovePersisted = useCallback((serverId: string) => {
    setPendingDeletes((prev) =>
      prev.includes(serverId) ? prev : [...prev, serverId],
    );
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      // Pre-check BEFORE the first write. The loop below posts one question
      // at a time, so a choice question with no options would commit every
      // question above it and then throw OPTIONS_REQUIRED — a partial save
      // the organizer can neither see nor undo.
      const missingOptions = findChoiceQuestionMissingOptions(questions);
      if (missingOptions) {
        setSaveError(
          t("admin.afOptionsRequiredError", {
            label: missingOptions.label.trim(),
          }) as string,
        );
        return;
      }

      const targetFormId = await ensureForm();

      for (const questionId of pendingDeletes) {
        await deleteQuestionMut.mutateAsync({
          eventId,
          formId: targetFormId,
          questionId,
        });
      }
      setPendingDeletes([]);

      for (const [index, question] of questions.entries()) {
        const fields = toApiQuestionFields(question);
        // A label-less question is a card the organizer opened and abandoned;
        // the server would reject it (min length 1) and fail the whole save.
        if (!fields.label) continue;

        if (question.serverId) {
          const unchanged =
            loadedSignatures.get(question.serverId) ===
              questionSignature(question) &&
            loadedOrder.get(question.serverId) === index;
          if (unchanged) continue;
        }

        await upsertQuestionMut.mutateAsync({
          eventId,
          formId: targetFormId,
          questionId: question.serverId,
          ...fields,
          order: index,
        });
      }

      await trpcUtils.events.getApplicationForm.invalidate({ eventId });
      onClose();
    } catch (error) {
      console.error("Failed to save application form:", error);
      setSaveError(formatErrorMessage(error, t));
    } finally {
      setIsSaving(false);
    }
  }, [
    ensureForm,
    pendingDeletes,
    questions,
    loadedSignatures,
    loadedOrder,
    eventId,
    deleteQuestionMut,
    upsertQuestionMut,
    trpcUtils,
    onClose,
    t,
  ]);

  /**
   * Unsaved local work. Applying a template RE-HYDRATES from the server, so
   * this gates the CTA behind a confirm rather than silently discarding.
   */
  const isDirty = useMemo(
    () =>
      hasUnsavedFormChanges({
        questions,
        loadedSignatures,
        loadedOrder,
        pendingDeletes,
      }),
    [questions, loadedSignatures, loadedOrder, pendingDeletes],
  );

  /**
   * The picker is a sheet ON TOP of this one, so the builder can't be edited
   * while it is open — checking dirtiness here is therefore still true at the
   * moment the apply lands.
   */
  const handleStartFromTemplate = useCallback(() => {
    if (isDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setPickerOpen(true);
  }, [isDirty]);

  /** Refetch after an apply so the forked rows show up immediately. */
  const handleTemplateApplied = useCallback(async () => {
    setPickerOpen(false);
    const fresh = await trpcUtils.events.getApplicationForm.fetch({ eventId });
    if (fresh) hydrate(fresh);
  }, [trpcUtils, eventId, hydrate]);

  const savedQuestionCount = useMemo(
    () => questions.filter((q) => q.label.trim().length > 0).length,
    [questions],
  );

  const footer = (
    <XStack flex={1} gap={8} alignItems="center" flexWrap="wrap">
      <XStack flex={1} minWidth={0}>
        <Button
          variant="secondary"
          size="$3"
          minHeight={44}
          disabled={isSaving}
          onPress={() => setTypePickerOpen((v) => !v)}
          data-testid="app-add-question-btn"
        >
          <Plus size={16} aria-hidden />
          {String(t("admin.afAddQuestion"))}
        </Button>
      </XStack>
      <Button
        variant="secondary"
        size="$3"
        minHeight={44}
        onPress={onClose}
        data-testid="app-form-cancel-btn"
      >
        {String(t("admin.afCancel"))}
      </Button>
      <Button
        variant="primary"
        size="$3"
        minHeight={44}
        onPress={() => {
          void handleSave();
        }}
        disabled={isSaving}
        data-testid="app-form-save-btn"
      >
        {isSaving ? String(t("admin.afSaving")) : String(t("admin.afSave"))}
      </Button>
    </XStack>
  );

  /**
   * Builder header (spec Phase 4): the two template affordances. Rendered
   * inside the scroll body rather than in `EventEditorSheet`'s chrome so the
   * shared sheet keeps its single-purpose header contract.
   */
  const headerSlot = (
    <XStack
      gap={8}
      flexWrap="wrap"
      alignItems="center"
      data-testid="application-form-template-actions"
    >
      <Button
        variant="ghost"
        size="$2"
        minHeight={44}
        disabled={isSaving}
        onPress={handleStartFromTemplate}
        data-testid="application-template-start-btn"
      >
        <LayoutTemplate size={14} aria-hidden />
        {String(t("admin.aftStartFromTemplate"))}
      </Button>
      <Button
        variant="ghost"
        size="$2"
        minHeight={44}
        disabled={isSaving || savedQuestionCount === 0}
        onPress={() => setSaveTemplateOpen(true)}
        data-testid="application-template-save-btn"
      >
        <Save size={14} aria-hidden />
        {String(t("admin.aftSaveAsTemplate"))}
      </Button>
    </XStack>
  );

  return (
    <>
      <EventEditorSheet
        open={open}
        onClose={onClose}
        title={t("admin.afTitle") as string}
        subtitle={t("admin.afSubtitle", { count: questions.length }) as string}
        desktopWidth={580}
        footer={footer}
      >
        {formQuery.isLoading ? (
          <YStack
            flex={1}
            justifyContent="center"
            alignItems="center"
            padding={32}
            data-testid="application-form-builder"
          >
            <Text tone="muted">{String(t("admin.afLoading"))}</Text>
          </YStack>
        ) : (
          <YStack gap={12}>
            <FormBuilder
              testId="application-form-builder"
              questions={questions}
              onQuestionsChange={setQuestions}
              onRemovePersisted={handleRemovePersisted}
              typePickerOpen={typePickerOpen}
              onTypePickerOpenChange={setTypePickerOpen}
              disabled={isSaving}
              headerSlot={headerSlot}
            />
            {saveError ? (
              <Text
                style={{ fontSize: 12 }}
                tone="error"
                role="alert"
                data-testid="application-form-save-error"
              >
                {saveError}
              </Text>
            ) : null}
          </YStack>
        )}
      </EventEditorSheet>

      {pickerOpen ? (
        <ApplicationTemplatePickerDialog
          owner={templateOwner}
          eventId={eventId}
          onApplied={() => {
            void handleTemplateApplied();
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      <ConfirmDialog
        open={discardConfirmOpen}
        tone="danger"
        title={String(t("admin.aftDiscardConfirmTitle"))}
        description={String(t("admin.aftDiscardConfirmBody"))}
        confirmLabel={String(t("admin.aftDiscardConfirmCta"))}
        cancelLabel={String(t("admin.afCancel"))}
        onConfirm={() => {
          // Discarding is explicit: drop the queued deletes, re-read from the
          // server, THEN open the picker — so the apply lands on exactly what
          // is stored, with nothing of the organizer's silently lost.
          setDiscardConfirmOpen(false);
          setPendingDeletes([]);
          void trpcUtils.events.getApplicationForm
            .fetch({ eventId })
            .then((fresh) => {
              if (fresh) hydrate(fresh);
              setPickerOpen(true);
            });
        }}
        onCancel={() => setDiscardConfirmOpen(false)}
      />

      {saveTemplateOpen ? (
        <SaveApplicationFormTemplateDialog
          owner={templateOwner}
          eventId={eventId}
          questionCount={savedQuestionCount}
          onClose={() => setSaveTemplateOpen(false)}
        />
      ) : null}
    </>
  );
}

export default ApplicationFormBuilder;
