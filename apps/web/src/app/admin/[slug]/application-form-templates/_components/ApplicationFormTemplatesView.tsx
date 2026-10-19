"use client";

/**
 * ApplicationFormTemplatesView — the org-workspace library of reusable
 * application forms (application-driven-events spec Phase 4: "Template
 * management lives in the org workspace, beside ticket-type templates").
 *
 * Deliberately SIMPLE, as scoped: list, create/edit (name + description +
 * intro + questions), archive. The question editor is the SHARED
 * `FormBuilder` (spec D8) — the same component the event's application-form
 * builder uses, which is the whole reason it was extracted.
 *
 * Platform catalogue rows appear in the list tagged "From Ithas Fire" and are
 * READ-ONLY here: the server refuses update/archive on one, so this surface
 * offers neither rather than rendering affordances that would only ever 404.
 * (There is no "Customise" fork for application templates — applying one
 * already copies its questions onto an event, and editing them there is the
 * customisation path.)
 *
 * Owner scope mirrors VolunteerTemplatesView / TicketTypeTemplateControls: the
 * admin slug resolves to the current owner entity, mapped to the template
 * API's {ownerScope, ownerId} pair. Unlike volunteer templates this DOES
 * support a HUMAN owner — a solo organizer has a library too.
 */

import { useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { nanoid } from "nanoid";
import { XStack, YStack } from "tamagui";
import { Pencil, Plus, Archive } from "lucide-react";

import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Modal,
  Text,
  TextInput,
  Tooltip,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { TableContainer } from "@/components/AdminTableParts";
import { PlatformTemplateTag } from "@/components/volunteering/PlatformTemplateTag";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import {
  FormBuilder,
  type FormBuilderQuestion,
} from "@/components/form-builder/FormBuilder";
import {
  findChoiceQuestionMissingOptions,
  toBuilderQuestions,
  toTemplateQuestionsPayload,
} from "@/components/form-builder/form-builder-helpers";

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  introText: string | null;
  isPlatform: boolean;
  questions: Array<{
    type: FormBuilderQuestion["type"];
    label: string;
    description: string | null;
    options: Array<{ id: string; label: string }> | null;
    isRequired: boolean;
  }>;
};

type DialogState =
  | null
  | { mode: "create" }
  | { mode: "edit"; template: TemplateRow };

export function ApplicationFormTemplatesView() {
  const t = useTranslations();
  const { toast } = useNotify();
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);
  // The nav entry is ORG_CONTENT_VIEW (VIEWER included) because reading the
  // library is genuinely useful to a VIEWER, but create/update/archive are
  // ORG_EDIT_ROLES server-side. HIDE the write affordances rather than
  // disable them — same treatment platform rows already get. A disabled
  // button still advertises a capability; a VIEWER pressing one only ever
  // earned a generic INSUFFICIENT_ROLE toast. UX-only; the server is the gate.
  const { canEdit } = useAdminOwnerCapabilities(currentOwner);
  const utils = trpc.useUtils();

  const owner = useMemo(() => {
    if (!currentOwner) return null;
    return currentOwner.kind === "org"
      ? ({ ownerScope: "ORGANIZATION", ownerId: currentOwner.orgId } as const)
      : ({ ownerScope: "HUMAN", ownerId: currentOwner.humanId } as const);
  }, [currentOwner]);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [archiveTarget, setArchiveTarget] = useState<TemplateRow | null>(null);

  const { data, isLoading, error, refetch } =
    trpc.applicationFormTemplates.list.useQuery(
      {
        ownerScope: owner?.ownerScope ?? "ORGANIZATION",
        ownerId: owner?.ownerId ?? "",
      },
      { enabled: !!owner, staleTime: 30_000 },
    );

  const archiveMutation = trpc.applicationFormTemplates.archive.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const rows = useMemo<TemplateRow[]>(() => {
    const own = (data?.items ?? []) as TemplateRow[];
    const platform = (data?.platform ?? []) as TemplateRow[];
    // The org's own rows first — the catalogue is reference material, not the
    // thing they came here to manage.
    return [...own, ...platform];
  }, [data]);

  const handleArchive = useCallback(async () => {
    if (!archiveTarget) return;
    try {
      await archiveMutation.mutateAsync({
        templateId: archiveTarget.id,
        clientKey: nanoid(12),
      });
      toast.success({
        id: "application-template-archived",
        title: t("admin.aftArchivedTitle") as string,
      });
      await utils.applicationFormTemplates.list.invalidate();
      setArchiveTarget(null);
    } catch (err) {
      toast.danger({
        id: "application-template-archive-failed",
        title: t("admin.aftArchiveFailed") as string,
        message: formatErrorMessage(err, t),
      });
    }
  }, [archiveTarget, archiveMutation, toast, t, utils]);

  const columns = useMemo<DataTableColumn<TemplateRow>[]>(
    () => [
      {
        id: "name",
        header: String(t("admin.aftNameColumn")),
        width: 2.5,
        sortValue: (row) => row.name,
        cell: (row) => (
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="body" style={{ fontWeight: 700 }}>
              {row.name}
            </Text>
            {row.isPlatform ? (
              <PlatformTemplateTag
                testId={`application-template-platform-tag-${row.id}`}
              />
            ) : null}
          </XStack>
        ),
      },
      {
        id: "description",
        header: String(t("admin.aftDescriptionColumn")),
        width: 4,
        cell: (row) => (
          <Text
            variant="caption"
            tone="muted"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 480,
            }}
          >
            {row.description ?? "—"}
          </Text>
        ),
      },
      {
        id: "questions",
        header: String(t("admin.aftQuestionsColumn")),
        width: 1.2,
        sortValue: (row) => row.questions.length,
        cell: (row) => (
          <Badge tone="neutral" size="sm">
            {String(t("admin.aftQuestionCount", { count: row.questions.length }))}
          </Badge>
        ),
      },
    ],
    [t],
  );

  const rowActions = useMemo(
    () =>
      // No actions column at all for a read-only role — an empty column of
      // "Read-only" labels is noise when nothing in the table is editable.
      !canEdit
        ? undefined
        : {
      header: "",
      width: 1.4,
      render: (row: TemplateRow) =>
        row.isPlatform ? (
          // Read-only: the server refuses update/archive on a catalogue row.
          <XStack justifyContent="flex-end">
            <Text variant="caption" tone="muted">
              {String(t("admin.aftReadOnly"))}
            </Text>
          </XStack>
        ) : (
          <XStack gap="$2" justifyContent="flex-end">
            <Tooltip
              anchor={
                <Button
                  size="$2"
                  variant="ghost"
                  icon
                  onPress={() => setDialog({ mode: "edit", template: row })}
                  aria-label={String(
                    t("admin.aftEditTooltip", { name: row.name }),
                  )}
                  data-testid={`application-template-edit-${row.id}`}
                >
                  <Pencil size={14} />
                </Button>
              }
              placement="top"
            >
              {String(t("admin.aftEditTooltipShort"))}
            </Tooltip>
            <Tooltip
              anchor={
                <Button
                  size="$2"
                  variant="ghost"
                  icon
                  onPress={() => setArchiveTarget(row)}
                  aria-label={String(
                    t("admin.aftArchiveTooltip", { name: row.name }),
                  )}
                  data-testid={`application-template-archive-${row.id}`}
                >
                  <Archive size={14} />
                </Button>
              }
              placement="top"
            >
              {String(t("admin.aftArchiveTooltipShort"))}
            </Tooltip>
          </XStack>
        ),
    },
    [t, canEdit],
  );

  // ── Early returns ────────────────────────────────────────────────────────

  if (isOwnerLoading || (isLoading && !!owner)) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.aftLoading"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!owner) {
    return (
      <YStack padding="$4">
        <Text>{String(t("admin.unableToDetermineOwnerAudiences"))}</Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {formatErrorMessage(error)}
        </Text>
        <Button variant="secondary" size="$2" onPress={() => refetch()}>
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

  const hasRows = rows.length > 0;

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      <AdminPageHeader
        title={String(t("admin.aftPageTitle"))}
        subtitle={String(t("admin.aftPageSubtitle"))}
        sectionNumber="06"
        trailing={
          /* Wrap + shrink + minWidth 0: without them this cluster is one flex
             item whose min-content width pans the whole document on phones
             (the same trap VolunteerTemplatesView documents). */
          <XStack
            gap="$3"
            alignItems="center"
            flexWrap="wrap"
            flexShrink={1}
            minWidth={0}
          >
            {canEdit ? (
              <Button
                variant="primary"
                size="$3"
                onPress={() => setDialog({ mode: "create" })}
                data-testid="application-templates-new-btn"
              >
                <Plus size={18} aria-hidden />
                {String(t("admin.aftNewCta"))}
              </Button>
            ) : null}
          </XStack>
        }
      />

      {/* The 640px table floor lives INSIDE TableContainer (the overflow:auto
          box) so on phones the table scrolls within its own container instead
          of forcing the whole document wide. */}
      <YStack flex={1} minWidth={0}>
        <TableContainer>
          <YStack minWidth={640}>
            <DataTable
              rows={rows}
              columns={columns}
              clientSort
              getRowKey={(row) => row.id}
              isLoading={isLoading}
              rowActions={rowActions}
              emptyState={
                !hasRows ? (
                  <YStack padding="$8" alignItems="center" gap="$3">
                    <Text variant="h4" weight="bold" textAlign="center">
                      {String(t("admin.aftEmptyTitle"))}
                    </Text>
                    <Text
                      variant="body"
                      tone="muted"
                      textAlign="center"
                      maxWidth={360}
                    >
                      {String(t("admin.aftEmptyDescription"))}
                    </Text>
                    {canEdit ? (
                      <Button
                        variant="secondary"
                        size="$3"
                        onPress={() => setDialog({ mode: "create" })}
                        data-testid="application-templates-create-first-btn"
                      >
                        <Plus size={18} aria-hidden />
                        {String(t("admin.aftCreateFirst"))}
                      </Button>
                    ) : null}
                  </YStack>
                ) : undefined
              }
            />
          </YStack>
        </TableContainer>
      </YStack>

      {dialog ? (
        <ApplicationTemplateDialog
          owner={owner}
          template={dialog.mode === "edit" ? dialog.template : null}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void utils.applicationFormTemplates.list.invalidate();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={!!archiveTarget}
        title={String(t("admin.aftArchiveConfirmTitle"))}
        description={String(
          t("admin.aftArchiveConfirmBody", { name: archiveTarget?.name ?? "" }),
        )}
        confirmLabel={String(t("admin.aftArchiveConfirmCta"))}
        onConfirm={() => {
          void handleArchive();
        }}
        onCancel={() => setArchiveTarget(null)}
      />
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create / edit dialog
// ─────────────────────────────────────────────────────────────────────────────

type ApplicationTemplateDialogProps = {
  owner: { ownerScope: "ORGANIZATION" | "HUMAN"; ownerId: string };
  /** Null = create. */
  template: TemplateRow | null;
  onClose: () => void;
  onSaved: () => void;
};

function ApplicationTemplateDialog({
  owner,
  template,
  onClose,
  onSaved,
}: ApplicationTemplateDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();

  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [introText, setIntroText] = useState(template?.introText ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<FormBuilderQuestion[]>(() =>
    // The stored entries carry no ids (a template's questions are a JSON
    // array, not rows), so `toBuilderQuestions` mints local keys for them.
    toBuilderQuestions(template?.questions ?? []),
  );
  const [typePickerOpen, setTypePickerOpen] = useState(false);

  const createMutation = trpc.applicationFormTemplates.create.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const updateMutation = trpc.applicationFormTemplates.update.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || isSaving) return;
    setNameError(null);
    // Pre-check BEFORE posting: the server refuses a choice question with no
    // options (OPTIONS_REQUIRED) for the WHOLE array, so without this the
    // organizer gets a generic failure toast and no idea which question.
    const missingOptions = findChoiceQuestionMissingOptions(questions);
    if (missingOptions) {
      setQuestionsError(
        t("admin.afOptionsRequiredError", {
          label: missingOptions.label.trim(),
        }) as string,
      );
      return;
    }
    setQuestionsError(null);
    const payload = {
      name: trimmed,
      description: description.trim() || null,
      introText: introText.trim() || null,
      questions: toTemplateQuestionsPayload(questions),
      clientKey: nanoid(12),
    };
    try {
      if (template) {
        await updateMutation.mutateAsync({
          templateId: template.id,
          ...payload,
        });
      } else {
        await createMutation.mutateAsync({
          ownerScope: owner.ownerScope,
          ownerId: owner.ownerId,
          ...payload,
        });
      }
      toast.success({
        id: "application-template-saved",
        title: t("admin.aftSavedTitle") as string,
        message: t("admin.aftTemplateSavedMessage", {
          name: trimmed,
        }) as string,
      });
      onSaved();
    } catch (err) {
      if (getAppErrorCode(err) === "TEMPLATE_NAME_TAKEN") {
        setNameError(t("admin.aftNameTaken", { name: trimmed }) as string);
        return;
      }
      toast.danger({
        id: "application-template-save-failed",
        title: t("admin.aftSaveFailed") as string,
        message: formatErrorMessage(err, t),
      });
    }
  };

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={640} data-testid="application-template-dialog">
        <Modal.Header
          title={String(
            t(template ? "admin.aftEditDialogTitle" : "admin.aftNewDialogTitle"),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$4">
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.aftNameLabel"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={(v: string) => {
                  setName(v);
                  if (nameError) setNameError(null);
                }}
                placeholder={t("admin.aftNamePlaceholder") as string}
                maxLength={80}
                fullWidth
                testId="application-template-dialog-name"
              />
              {nameError ? (
                <Text
                  variant="caption"
                  tone="error"
                  role="alert"
                  data-testid="application-template-dialog-name-error"
                >
                  {nameError}
                </Text>
              ) : null}
            </YStack>

            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.aftDescriptionLabel"))}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder={t("admin.aftDescriptionPlaceholder") as string}
                maxLength={500}
                fullWidth
                testId="application-template-dialog-description"
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.aftIntroLabel"))}
              </Text>
              <TextInput
                value={introText}
                onChangeText={setIntroText}
                placeholder={t("admin.aftIntroPlaceholder") as string}
                maxLength={2000}
                fullWidth
                testId="application-template-dialog-intro"
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.aftIntroHint"))}
              </Text>
            </YStack>

            {/* The SHARED builder (spec D8) — identical question editing to the
                event's application form, with no event in sight. */}
            <FormBuilder
              testId="application-template-form-builder"
              questions={questions}
              onQuestionsChange={(next) => {
                setQuestions(next);
                if (questionsError) setQuestionsError(null);
              }}
              typePickerOpen={typePickerOpen}
              onTypePickerOpenChange={setTypePickerOpen}
              disabled={isSaving}
              emptyStateText={String(t("admin.aftQuestionsEmpty"))}
            />

            {questionsError ? (
              <Text
                variant="caption"
                tone="error"
                role="alert"
                data-testid="application-template-dialog-questions-error"
              >
                {questionsError}
              </Text>
            ) : null}

            <XStack>
              <Button
                variant="secondary"
                size="$2"
                minHeight={44}
                disabled={isSaving}
                onPress={() => setTypePickerOpen((v) => !v)}
                data-testid="application-template-add-question-btn"
              >
                <Plus size={16} aria-hidden />
                {String(t("admin.afAddQuestion"))}
              </Button>
            </XStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            size="$2"
            onPress={onClose}
            disabled={isSaving}
            data-testid="application-template-dialog-cancel"
          >
            {String(t("admin.afCancel"))}
          </Button>
          <Button
            variant="primary"
            size="$2"
            onPress={() => {
              void handleSave();
            }}
            disabled={!name.trim() || isSaving}
            data-testid="application-template-dialog-save"
          >
            {isSaving
              ? String(t("admin.aftSaving"))
              : String(t("admin.aftSaveCta"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

export default ApplicationFormTemplatesView;
