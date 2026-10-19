"use client";

import {
  useState,
  useCallback,
  useRef,
  useMemo,
  useEffect,
  useId,
} from "react";
import type { ComponentType, ReactNode } from "react";
import { YStack, XStack, styled, useTheme } from "tamagui";
import { Text, Button, Spinner, useNotify, useTranslations } from "@th/ui";
import {
  Send,
  AlertTriangle,
  Upload,
  FileText,
  Image as ImageIcon,
  Trash2,
  Info,
  XCircle,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";
import { formatBytes } from "@/lib/format";
import { getPlaceVerificationEligibility } from "@th/core/use-cases/places";

// ─────────────────────────────────────────────────────────────────────────────
// THE single place-verification request implementation (spec FR-012/FR-013).
//
// It was inline in `settings/_components/VerificationSection.tsx` and reachable
// only from the `/verify` route. It now lives here so exactly ONE component
// owns document staging, HEIC conversion, presign→PUT upload, the
// reuse-docs-on-resubmit toggle and `submitPlaceVerification` — rendered by:
//
//   1. VerificationSection (the `/verify` route, inline expand/collapse), and
//   2. RequestVerificationModal (the `/edit` header button + the PlacesTable
//      row action).
//
// The two presentations differ ONLY in their wrappers, which is why the body
// and the action row are handed to slot components: the modal passes
// `Modal.Body` / `Modal.Footer` (so the actions stay pinned below a scrolling
// body) and the inline caller takes the plain-stack defaults. Do NOT fork a
// second copy of the submit flow for a new entry point — add a caller.
//
// ── Slot contract ────────────────────────────────────────────────────────────
// `BodySlot` / `ActionsSlot` MUST be STABLE, module-level component references
// — never an inline arrow (`BodySlot={({children}) => <X>{children}</X>}`) and
// never a component defined inside a caller's render. React identifies element
// types by reference, so a fresh function each render is a NEW type: the whole
// subtree unmounts and remounts on every parent render, which here would drop
// `stagedFiles`' object URLs and reset the hidden `<input type="file">`
// mid-selection. All four values in use today (the two defaults below,
// `Modal.Body`, `Modal.Footer`) are module-level and stable. Keep it that way.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ───────────────────────────────────────────────────────────────

const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileIcon(contentType: string) {
  if (contentType.startsWith("image/")) return ImageIcon;
  return FileText;
}

// ─── Styled ──────────────────────────────────────────────────────────────────

const DropZone = styled(YStack, {
  name: "DropZone",
  borderWidth: 2,
  borderStyle: "dashed",
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: "$4",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  cursor: "pointer",
  minHeight: 120,
  transition: "all 150ms ease",
  hoverStyle: {
    borderColor: "$borderColorStrong",
    backgroundColor: "$surfaceMuted",
  },
  variants: {
    active: {
      true: {
        borderColor: "$accent",
        backgroundColor: "$surfaceMuted",
      },
    },
    disabled: {
      true: {
        opacity: 0.5,
        cursor: "not-allowed",
        pointerEvents: "none",
      },
    },
  } as const,
});

const FileRow = styled(XStack, {
  name: "FileRow",
  padding: "$2",
  paddingHorizontal: "$3",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  alignItems: "center",
  gap: "$2",
  backgroundColor: "$surface",
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface StagedFile {
  file: File;
  id: string; // local unique ID
}

/** The (possibly unsaved) values eligibility is judged against. */
export interface VerificationFormState {
  name: string;
  addressLine1: string;
  city: string;
  countryCode: string;
}

type SlotProps = { children: ReactNode };

/**
 * How much in-progress work would be destroyed by closing this form right now.
 *
 * A presentation that can be dismissed by accident (the modal's backdrop) needs
 * to know: the form owns `stagedFiles`, and `Modal` unmounts its children on
 * close, so a stray click would silently bin up to five 10MB uploads.
 *
 *  - `none`      — nothing staged, close freely.
 *  - `staged`    — documents are staged; discarding needs explicit intent.
 *  - `uploading` — presign/PUT loop is mid-flight; do not close at all.
 */
export type VerificationFormGuard = "none" | "staged" | "uploading";

export interface VerificationRequestFormProps {
  placeId: string;
  /** Owners with access — the org id is required by submitPlaceVerification. */
  access: { orgIds: string[]; humanIds: string[] };
  formState: VerificationFormState;
  /**
   * Unsaved edits block submission: the reviewer judges what the SERVER has,
   * so a draft name/address would make the request unreviewable.
   */
  isDirty: boolean;
  onCancel: () => void;
  /** Fired after a request is successfully created (modal uses it to close). */
  onSubmitted?: () => void;
  /**
   * Reports how destructive closing would be. MUST be referentially stable
   * (a `useState` setter, or a `useCallback`) — it is an effect dependency.
   */
  onGuardChange?: (guard: VerificationFormGuard) => void;
  /** Wraps the field stack. The modal passes `Modal.Body`. */
  BodySlot?: ComponentType<SlotProps>;
  /** Wraps the Cancel/Submit row. The modal passes `Modal.Footer`. */
  ActionsSlot?: ComponentType<SlotProps>;
}

// Inline defaults — what the `/verify` route rendered before the extraction.
function DefaultBodySlot({ children }: SlotProps) {
  return <YStack gap="$3">{children}</YStack>;
}

function DefaultActionsSlot({ children }: SlotProps) {
  return (
    <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
      {children}
    </XStack>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function VerificationRequestForm({
  placeId,
  access,
  formState,
  isDirty,
  onCancel,
  onSubmitted,
  onGuardChange,
  BodySlot = DefaultBodySlot,
  ActionsSlot = DefaultActionsSlot,
}: VerificationRequestFormProps) {
  const { toast } = useNotify();
  const t = useTranslations();
  const utils = trpc.useUtils();
  const theme = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Two presentations can be on screen at once in principle (this is a shared
  // component), so the checkbox↔label pairing must not rely on a literal id —
  // duplicate ids would point every label at the FIRST checkbox.
  const reuseDocsId = useId();

  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // Default ON — the spec wants resubmissions to carry forward the rejected
  // request's documents unless the organizer explicitly opts out, so they
  // don't have to re-upload a 9MB business license to fix a one-line note.
  const [reuseDocs, setReuseDocs] = useState(true);

  // Shares the cache key + staleTime with VerificationSection's own read, so
  // rendering this form inside that section costs no extra round-trip.
  const detailQuery = trpc.places.getPlaceDetail.useQuery(
    { placeId },
    { staleTime: 30_000 },
  );
  const lastRejected = useMemo(
    () =>
      detailQuery.data?.verification.history.find(
        (h) => h.status === "REJECTED",
      ) ?? null,
    [detailQuery.data?.verification.history],
  );

  // Mutations
  const presignMutation =
    trpc.places.requestVerificationDocUpload.useMutation();
  const submitMutation = trpc.places.submitPlaceVerification.useMutation();

  const verificationEligibility = useMemo(
    () =>
      getPlaceVerificationEligibility({
        name: formState.name,
        addressLine1: formState.addressLine1,
        city: formState.city,
        countryCode: formState.countryCode,
        orgIdsWithAccess: access.orgIds,
        humanIdsWithAccess: access.humanIds,
      }),
    [formState, access],
  );

  const reusableCount = useMemo(
    () => lastRejected?.documents.filter((d) => !d.deletedAt).length ?? 0,
    [lastRejected],
  );
  const hasReusable = reuseDocs && reusableCount > 0;

  // Tell the presentation how destructive closing would be right now. Only the
  // modal acts on it (the inline `/verify` presentation has no accidental
  // dismiss surface), but the state lives here because the files do.
  const guard: VerificationFormGuard = isUploading
    ? "uploading"
    : stagedFiles.length > 0
      ? "staged"
      : "none";
  useEffect(() => {
    onGuardChange?.(guard);
  }, [guard, onGuardChange]);

  // ── File handling ──────────────────────────────────────────────────────

  const validateAndAddFiles = useCallback(
    async (files: FileList | File[]) => {
      const newFiles: StagedFile[] = [];
      const errors: string[] = [];

      for (let file of Array.from(files)) {
        if (stagedFiles.length + newFiles.length >= MAX_FILES) {
          errors.push(
            String(t("admin.placeVerifMaxFilesError", { max: MAX_FILES })),
          );
          break;
        }
        // Convert HEIC/HEIF (iPhone photos) to JPEG up front so the staged
        // file already has a server-supported content-type and the size check
        // below runs against the JPEG. PDFs and other formats pass through
        // unchanged.
        try {
          file = await prepareImageForUpload(file);
        } catch {
          errors.push(
            String(
              t("admin.placeVerifUnsupportedFormat", { fileName: file.name }),
            ),
          );
          continue;
        }
        if (!ALLOWED_TYPES.has(file.type)) {
          errors.push(
            String(
              t("admin.placeVerifUnsupportedFormat", { fileName: file.name }),
            ),
          );
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          errors.push(
            String(t("admin.placeVerifFileTooLarge", { fileName: file.name })),
          );
          continue;
        }
        // Check for duplicates by name + size
        const isDuplicate = stagedFiles.some(
          (sf) => sf.file.name === file.name && sf.file.size === file.size,
        );
        if (isDuplicate) {
          errors.push(
            String(t("admin.placeVerifDuplicateFile", { fileName: file.name })),
          );
          continue;
        }
        newFiles.push({
          file,
          id: crypto.randomUUID(),
        });
      }

      if (errors.length > 0) {
        toast.warning({
          id: "file-validation-error",
          title: t("admin.placeVerifSomeFilesNotAdded") as string,
          message: errors.join("\n"),
        });
      }

      if (newFiles.length > 0) {
        setStagedFiles((prev) => [...prev, ...newFiles]);
      }
    },
    [stagedFiles, toast, t],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        void validateAndAddFiles(e.target.files);
      }
      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [validateAndAddFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      if (e.dataTransfer.files) {
        void validateAndAddFiles(e.dataTransfer.files);
      }
    },
    [validateAndAddFiles],
  );

  const removeFile = useCallback((id: string) => {
    setStagedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  // ── Submit flow ────────────────────────────────────────────────────────

  const handleSubmitVerification = useCallback(async () => {
    if (stagedFiles.length === 0 && !hasReusable) {
      toast.warning({
        id: "no-files",
        title: t("admin.placeVerifNoDocuments") as string,
        message: t("admin.placeVerifNoDocumentsMessage") as string,
      });
      return;
    }

    if (isDirty) {
      toast.info({
        id: "save-before-verify",
        title: t("admin.placeVerifSaveFirstTitle") as string,
        message: t("admin.placeVerifSaveFirstMessage") as string,
      });
      return;
    }

    if (!verificationEligibility.eligible) return;

    const orgId = access.orgIds[0];
    if (!orgId) {
      toast.danger({
        id: "no-org",
        title: t("admin.placeVerifNoOrg") as string,
        message: t("admin.placeVerifNoOrgMessage") as string,
      });
      return;
    }

    setIsUploading(true);

    try {
      // Step 1: Get presigned URLs and upload each file
      const uploadedDocs: {
        storageKey: string;
        fileName: string;
        contentType: "application/pdf" | "image/jpeg" | "image/png";
        sizeBytes: number;
      }[] = [];

      for (const staged of stagedFiles) {
        // Get presigned URL
        const { key, uploadUrl } = await presignMutation.mutateAsync({
          placeId,
          contentType: staged.file.type as
            | "application/pdf"
            | "image/jpeg"
            | "image/png",
          sizeBytes: staged.file.size,
          fileName: staged.file.name,
        });

        // Upload directly to R2
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": staged.file.type },
          body: staged.file,
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `Upload failed for "${staged.file.name}" (${uploadResponse.status})`,
          );
        }

        uploadedDocs.push({
          storageKey: key,
          fileName: staged.file.name,
          contentType: staged.file.type as
            | "application/pdf"
            | "image/jpeg"
            | "image/png",
          sizeBytes: staged.file.size,
        });
      }

      // Step 2: Submit the verification request. If this is a resubmit
      // after a REJECTED request and the organizer kept the "reuse
      // documents" checkbox on, point at the prior request so the
      // server attaches its non-deleted docs to the new one — the
      // client doesn't need to re-upload them.
      await submitMutation.mutateAsync({
        placeId,
        orgId,
        documents: uploadedDocs,
        ...(reuseDocs && lastRejected
          ? { reuseFromRequestId: lastRejected.id }
          : {}),
      });

      toast.success({
        id: "verification-submitted",
        title: t("admin.placeVerifSubmitted") as string,
        message: t("admin.placeVerifSubmittedMessage") as string,
      });

      // Clean up
      setStagedFiles([]);

      // Refresh data — including the light title query behind the rail badge
      // + header chip (staleTime 60s), and the detail query the queue/status
      // panels read (staleTime 30s); without these both show pre-submit
      // state until their windows lapse.
      void utils.places.getPlaceForEdit.invalidate({ placeId });
      void utils.places.getPlaceDetail.invalidate({ placeId });
      void utils.places.getPlaceTitle.invalidate({ placeId });
      void utils.places.listHumanPlaces.invalidate();

      onSubmitted?.();
    } catch (err) {
      toast.danger({
        id: "verification-submit-failed",
        title: t("admin.placeVerifSubmitFailed") as string,
        message: formatErrorMessage(err, t),
      });
    } finally {
      setIsUploading(false);
    }
  }, [
    stagedFiles,
    hasReusable,
    isDirty,
    verificationEligibility.eligible,
    access.orgIds,
    placeId,
    presignMutation,
    submitMutation,
    toast,
    t,
    utils,
    reuseDocs,
    lastRejected,
    onSubmitted,
  ]);

  // A submit is impossible while the place is ineligible or the editor has
  // unsaved edits. The `/verify` route gates its trigger on both so this panel
  // never renders there; the modal entry points do NOT gate their trigger —
  // a disabled button with no stated reason is worse than an open dialog that
  // says exactly what is missing.
  const blockers: string[] = [
    ...(isDirty ? [String(t("admin.placeVerifSaveFirst"))] : []),
    ...verificationEligibility.reasons,
  ];

  const canSubmit =
    !isUploading &&
    (stagedFiles.length > 0 || hasReusable) &&
    !isDirty &&
    verificationEligibility.eligible;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      <BodySlot>
        {/* Blocking requirements — only when something actually blocks. */}
        {blockers.length > 0 && (
          <YStack
            gap="$2"
            padding="$3"
            borderWidth={2}
            borderColor="$warning"
            borderRadius={0}
            backgroundColor="$surfaceMuted"
          >
            <XStack gap="$2" alignItems="center">
              <AlertTriangle size={14} color={theme.warning?.val} />
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.placeVerifBlockedHeading"))}
              </Text>
            </XStack>
            {blockers.map((reason) => (
              <XStack key={reason} gap="$2" alignItems="flex-start">
                <XCircle
                  size={13}
                  color={theme.danger?.val}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <Text variant="caption" tone="error" flexShrink={1}>
                  {reason}
                </Text>
              </XStack>
            ))}
          </YStack>
        )}

        {/* Instructions */}
        <YStack
          gap="$2"
          padding="$3"
          borderRadius="$0"
          backgroundColor="$surfaceMuted"
        >
          <XStack gap="$2" alignItems="center">
            <Info size={14} color={theme.info?.val} />
            <Text variant="bodySmall" weight="bold">
              {String(t("admin.placeVerifWhatToUpload"))}
            </Text>
          </XStack>
          <Text variant="caption" tone="muted">
            {String(t("admin.placeVerifUploadInstructions"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.placeVerifAcceptedFormats"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.placeVerifSecureStorage"))}
          </Text>
        </YStack>

        {/* Drop zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{ cursor: "pointer" }}
        >
          <DropZone
            active={dragActive}
            disabled={isUploading || stagedFiles.length >= MAX_FILES}
            onPress={() => fileInputRef.current?.click()}
          >
            <Upload
              size={24}
              color={theme.colorMuted?.val}
              style={{ opacity: 0.6 }}
            />
            <Text variant="bodySmall" tone="muted" textAlign="center">
              {stagedFiles.length >= MAX_FILES
                ? String(t("admin.placeVerifMaxFilesReached"))
                : String(t("admin.placeVerifDropOrBrowse"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("admin.placeVerifFormatHint"))}
            </Text>
          </DropZone>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif"
          multiple
          onChange={handleFileInputChange}
          style={{ display: "none" }}
        />

        {/* Reuse documents from rejected request — opt-in on by default */}
        {lastRejected ? (
          <XStack gap="$2" alignItems="flex-start">
            <input
              type="checkbox"
              checked={reuseDocs}
              onChange={(e) => setReuseDocs(e.target.checked)}
              id={reuseDocsId}
            />
            <YStack flex={1}>
              <label htmlFor={reuseDocsId} style={{ cursor: "pointer" }}>
                <Text variant="bodySmall" weight="bold">
                  {String(t("admin.placeVerifReuseDocsLabel"))}
                </Text>
              </label>
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.placeVerifReuseDocsHint", { count: reusableCount }),
                )}
              </Text>
            </YStack>
          </XStack>
        ) : null}

        {/* Staged files list */}
        {stagedFiles.length > 0 && (
          <YStack gap="$2">
            <Text variant="caption" tone="muted">
              {String(
                t("admin.placeVerifFilesCount", {
                  count: stagedFiles.length,
                  max: MAX_FILES,
                }),
              )}
            </Text>
            {stagedFiles.map((staged) => {
              const Icon = fileIcon(staged.file.type);
              return (
                <FileRow key={staged.id}>
                  <Icon
                    size={16}
                    color={theme.colorMuted?.val}
                    style={{ flexShrink: 0 }}
                  />
                  <YStack flex={1} minWidth={0}>
                    <Text
                      variant="bodySmall"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {staged.file.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatBytes(staged.file.size)}
                    </Text>
                  </YStack>
                  <Button
                    variant="ghost"
                    size="$1"
                    icon
                    onPress={() => removeFile(staged.id)}
                    disabled={isUploading}
                    aria-label={
                      t("admin.placeVerifRemoveFile", {
                        fileName: staged.file.name,
                      }) as string
                    }
                  >
                    <Trash2 size={14} color={theme.danger?.val} />
                  </Button>
                </FileRow>
              );
            })}
          </YStack>
        )}
      </BodySlot>

      <ActionsSlot>
        <Button
          variant="secondary"
          size="$2"
          onPress={onCancel}
          disabled={isUploading}
        >
          {String(t("admin.placeVerifCancel"))}
        </Button>
        <Button
          variant="primary"
          size="$2"
          onPress={() => void handleSubmitVerification()}
          disabled={!canSubmit}
        >
          {isUploading ? (
            <>
              <Spinner size="sm" />
              {String(t("admin.placeVerifUploading"))}
            </>
          ) : (
            <>
              <Send size={14} />
              {String(t("admin.placeVerifSubmitForReview"))}
            </>
          )}
        </Button>
      </ActionsSlot>
    </>
  );
}
