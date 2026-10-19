"use client";

import { useCallback, useState } from "react";
import { nanoid } from "nanoid";
import { YStack } from "tamagui";
import {
  Button,
  FormErrorBanner,
  Modal,
  Text,
  TextInput,
  useNotify,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import { useTranslations } from "@th/ui";
import {
  createOrgSchema,
  validateForm,
  type FieldErrors,
} from "@/lib/validation";
import {
  extractQuotaExceededMeta,
  type QuotaExceededMeta,
} from "@/lib/quota-error";
import { QuotaExceededDialog } from "@/components/errors/QuotaExceededDialog";

export interface CreateOrganizationDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (orgId: string) => void;
}

export const CreateOrganizationDialog = ({
  open,
  onClose,
  onCreated,
}: CreateOrganizationDialogProps) => {
  const [name, setName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<"name">>({});
  const [quotaMeta, setQuotaMeta] = useState<QuotaExceededMeta | null>(null);
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();

  const createOrgMutation = trpc.orgs.createOrg.useMutation({
    onSuccess: (data) => {
      toast.success(t("admin.createOrgCreated") as string);
      setName("");
      onCreated(data.orgId);
    },
    onError: (err) => {
      const meta = extractQuotaExceededMeta(err);
      if (meta) {
        setQuotaMeta(meta);
        return;
      }
      setError(err);
    },
  });

  const handleSubmit = useCallback(() => {
    clearAll();
    const result = validateForm({
      schema: createOrgSchema,
      data: { name },
      t,
    });

    if (!result.success) {
      setFieldErrors(result.fieldErrors);
      return;
    }

    setFieldErrors({});
    createOrgMutation.mutate({ name: result.data.name, clientKey: nanoid(12) });
  }, [name, createOrgMutation, t, clearAll]);

  const handleClose = useCallback(() => {
    if (createOrgMutation.isPending) return;
    setName("");
    setFieldErrors({});
    onClose();
  }, [createOrgMutation.isPending, onClose]);

  const isValid = name.trim().length >= 2;

  return (
    <>
      <Modal open={open} onClose={handleClose}>
        <Modal.Panel width={440}>
          <Modal.Header
            title={t("admin.createOrgTitle") as string}
            onClose={handleClose}
          />
          <Modal.Body>
            <YStack gap="$3">
              <FormErrorBanner message={formError} onDismiss={clearAll} />
              <Text variant="body" tone="muted">
                {String(t("admin.createOrgDescription"))}
              </Text>
              <YStack gap="$1">
                <Text variant="label">
                  {String(t("admin.createOrgNameLabel"))}
                </Text>
                <TextInput
                  placeholder={t("admin.createOrgNamePlaceholder") as string}
                  value={name}
                  onChangeText={(v) => {
                    setName(v);
                    if (fieldErrors.name) setFieldErrors({});
                  }}
                  autoFocus
                  maxLength={140}
                  fullWidth
                  testId="create-org-name-input"
                  status={fieldErrors.name ? "error" : undefined}
                />
                {fieldErrors.name ? (
                  <Text variant="bodySmall" tone="error">
                    {fieldErrors.name}
                  </Text>
                ) : null}
              </YStack>
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              onPress={handleClose}
              disabled={createOrgMutation.isPending}
            >
              {String(t("admin.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={!isValid || createOrgMutation.isPending}
            >
              {createOrgMutation.isPending
                ? String(t("admin.createOrgCreating"))
                : String(t("admin.createOrgCreate"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      <QuotaExceededDialog
        open={quotaMeta !== null}
        onClose={() => setQuotaMeta(null)}
        meta={quotaMeta}
      />
    </>
  );
};

CreateOrganizationDialog.displayName = "CreateOrganizationDialog";
