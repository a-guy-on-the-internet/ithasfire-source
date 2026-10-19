"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { YStack, XStack, styled } from "tamagui";
import {
  Button,
  LabeledTextInput,
  Modal,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";
import {
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Trash2,
  Upload,
} from "lucide-react";

import { trpc } from "@/trpc";
import { normalizeError } from "@/lib/errors/normalize-error";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";
import { formatBytes } from "@/lib/format";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const);
type AllowedType = "application/pdf" | "image/jpeg" | "image/png";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;
const MIN_REASON = 10;

/** Web-only a11y props Tamagui's Stack surface doesn't type. */
const webA11y = (props: Record<string, unknown>): object => props;

type StagedFile = { id: string; file: File };

type Props = {
  placeId: string;
  placeName: string;
  open: boolean;
  onClose: () => void;
};

const DropZone = styled(YStack, {
  name: "DisputeDropZone",
  borderWidth: 2,
  borderStyle: "dashed",
  borderColor: "$borderColor",
  padding: "$3",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  cursor: "pointer",
  minHeight: 88,
  hoverStyle: {
    borderColor: "$borderColorStrong",
    backgroundColor: "$surfaceMuted",
  },
});

const FileRow = styled(XStack, {
  name: "DisputeFileRow",
  padding: "$2",
  paddingHorizontal: "$3",
  borderWidth: 1,
  borderColor: "$borderColor",
  alignItems: "center",
  gap: "$2",
  backgroundColor: "$surface",
});

/**
 * FR-008 dispute path. For a venue that already has a verified owner, a
 * signed-in user files an OWNERSHIP_DISPUTE (reason required, documents
 * optional) routed to platform admins. Disputes never mutate ownership — the
 * backstop is manual review. Filed on behalf of the signed-in human.
 */
export function OwnershipDisputeDialog({
  placeId,
  placeName,
  open,
  onClose,
}: Props) {
  const t = useTranslations();
  const tk = t as unknown as (key: string) => string;
  const ownersQuery = useEventOwnerEntities({ enabled: open });

  // The canonical human id comes from the owner-entities query — the Better
  // Auth user id is NOT guaranteed to equal the human id in prod.
  const humanId = useMemo(() => {
    const human = (ownersQuery.ownersWithSlugs ?? []).find(
      (o) => o.kind === "human",
    );
    return human?.kind === "human" ? human.humanId : null;
  }, [ownersQuery.ownersWithSlugs]);

  const [reason, setReason] = useState("");
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const presign = trpc.places.requestClaimDocUpload.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const fileDispute = trpc.places.filePlaceOwnershipDispute.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const busy = isUploading || fileDispute.isPending;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const next: StagedFile[] = [];
      for (let file of Array.from(files)) {
        if (stagedFiles.length + next.length >= MAX_FILES) break;
        try {
          file = await prepareImageForUpload(file);
        } catch {
          setFormError(
            String(t("places.claimFileUnsupported", { fileName: file.name })),
          );
          continue;
        }
        if (!ALLOWED_TYPES.has(file.type as AllowedType)) {
          setFormError(
            String(t("places.claimFileUnsupported", { fileName: file.name })),
          );
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          setFormError(
            String(t("places.claimFileTooLarge", { fileName: file.name })),
          );
          continue;
        }
        next.push({ id: crypto.randomUUID(), file });
      }
      if (next.length > 0) setStagedFiles((prev) => [...prev, ...next]);
    },
    [stagedFiles, t],
  );

  const submit = useCallback(async () => {
    if (!humanId || reason.trim().length < MIN_REASON) return;
    setFormError(null);
    setIsUploading(true);
    try {
      const documents: {
        storageKey: string;
        fileName: string;
        contentType: AllowedType;
        sizeBytes: number;
      }[] = [];
      for (const staged of stagedFiles) {
        const contentType = staged.file.type as AllowedType;
        const { key, uploadUrl } = await presign.mutateAsync({
          placeId,
          contentType,
          sizeBytes: staged.file.size,
          fileName: staged.file.name,
          context: "dispute",
          // This dialog files disputes as the individual human, so no org
          // storage quota is charged.
          orgId: null,
        });
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: staged.file,
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        documents.push({
          storageKey: key,
          fileName: staged.file.name,
          contentType,
          sizeBytes: staged.file.size,
        });
      }
      setIsUploading(false);
      fileDispute.mutate(
        {
          placeId,
          owner: { kind: "human", humanId },
          reason: reason.trim(),
          ...(documents.length > 0 ? { documents } : {}),
        },
        {
          onSuccess: () => setSubmitted(true),
          onError: (err) =>
            setFormError(
              normalizeError(err, tk).formError ??
                String(t("errors.generic")),
            ),
        },
      );
    } catch (err) {
      setIsUploading(false);
      setFormError(
        normalizeError(err, tk).formError ?? String(t("errors.generic")),
      );
    }
  }, [humanId, reason, stagedFiles, presign, fileDispute, placeId, t, tk]);

  const handleClose = () => {
    setReason("");
    setStagedFiles([]);
    setFormError(null);
    setSubmitted(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={String(t("places.claimDisputeTitle"))}
          subtitle={placeName}
          onClose={handleClose}
        />
        <Modal.Body gap="$3" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {submitted ? (
            <YStack gap="$3" alignItems="center" paddingVertical="$4">
              <CheckCircle2
                size={40}
                color="var(--success)"
                aria-hidden="true"
              />
              <Text variant="h4" weight="bold">
                {String(t("places.claimDisputeSuccessTitle"))}
              </Text>
              <Text variant="body" tone="muted" textAlign="center">
                {String(t("places.claimDisputeSuccessBody"))}
              </Text>
              <Button variant="primary" size="$3" onPress={handleClose}>
                {String(t("places.claimDone"))}
              </Button>
            </YStack>
          ) : (
            <>
              <Text variant="bodySmall" tone="muted">
                {String(t("places.claimDisputeHint"))}
              </Text>

              <LabeledTextInput
                id="dispute-reason"
                name="dispute-reason"
                label={String(t("places.claimDisputeReasonLabel"))}
                helperText={String(t("places.claimDisputeReasonHint"))}
                multiline
                numberOfLines={4}
                value={reason}
                onChangeText={setReason}
                placeholder={String(t("places.claimDisputeReasonPlaceholder"))}
                maxLength={2000}
                status={
                  reason.length > 0 && reason.trim().length < MIN_REASON
                    ? "error"
                    : undefined
                }
              />

              {/* Optional documents */}
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files) void addFiles(e.dataTransfer.files);
                }}
              >
                <DropZone
                  onPress={() => fileInputRef.current?.click()}
                  {...webA11y({
                    role: "button",
                    tabIndex: 0,
                    "aria-label": String(t("places.claimProofDocDrop")),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        fileInputRef.current?.click();
                      }
                    },
                  })}
                >
                  <Upload size={18} style={{ opacity: 0.6 }} aria-hidden="true" />
                  <Text variant="caption" tone="muted" textAlign="center">
                    {stagedFiles.length >= MAX_FILES
                      ? String(t("places.claimProofDocMax"))
                      : String(t("places.claimProofDocDrop"))}
                  </Text>
                </DropZone>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif"
                multiple
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
                style={{ display: "none" }}
              />
              {stagedFiles.length > 0 ? (
                <YStack gap="$2">
                  {stagedFiles.map((s) => {
                    const Icon = s.file.type.startsWith("image/")
                      ? ImageIcon
                      : FileText;
                    return (
                      <FileRow key={s.id}>
                        <Icon
                          size={16}
                          style={{ flexShrink: 0, opacity: 0.7 }}
                          aria-hidden="true"
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
                            {s.file.name}
                          </Text>
                          <Text variant="caption" tone="muted">
                            {formatBytes(s.file.size)}
                          </Text>
                        </YStack>
                        <Button
                          variant="ghost"
                          size="$1"
                          icon
                          onPress={() =>
                            setStagedFiles((prev) =>
                              prev.filter((f) => f.id !== s.id),
                            )
                          }
                          disabled={busy}
                          aria-label={String(
                            t("places.claimFileRemove", {
                              fileName: s.file.name,
                            }),
                          )}
                        >
                          <Trash2 size={14} color="var(--danger)" />
                        </Button>
                      </FileRow>
                    );
                  })}
                </YStack>
              ) : null}

              {formError ? (
                <Text variant="bodySmall" tone="error" role="alert">
                  {formError}
                </Text>
              ) : null}
            </>
          )}
        </Modal.Body>

        {!submitted ? (
          <Modal.Footer>
            <Button variant="ghost" size="$2" onPress={handleClose}>
              {String(t("places.claimCancel"))}
            </Button>
            <Button
              variant="primary"
              size="$2"
              onPress={() => void submit()}
              disabled={busy || reason.trim().length < MIN_REASON || !humanId}
            >
              {busy ? <Spinner size="sm" /> : null}
              {busy
                ? String(t("places.claimDisputeSubmitting"))
                : String(t("places.claimDisputeSubmit"))}
            </Button>
          </Modal.Footer>
        ) : null}
      </Modal.Panel>
    </Modal>
  );
}
