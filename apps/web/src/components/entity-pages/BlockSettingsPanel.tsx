"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ChangeEvent,
} from "react";
import { YStack, XStack } from "tamagui";
import {
  Text,
  Button,
  TextInput,
  LabeledTextInput,
  Spinner,
  Switch,
  useTranslations,
  useNotify,
} from "@th/ui";
import { Save, Plus, Trash2, Upload } from "lucide-react";

import type { BlockFieldConfig } from "@th/core/use-cases/entity-pages";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  NativeFileInput,
  PAGE_IMAGE_UPLOAD_ACCEPT,
  usePageImageUpload,
} from "./use-page-image-upload";
import {
  buildBlockSettingsSavePayload,
  createBlockSettingsDraft,
  draftHasUnsupportedEmbedUrls,
  getBlockSettingsFields,
  getObjectListFieldModel,
  isEmbedUrlField,
  isUnsupportedEmbedUrl,
  type ObjectListItemFieldConfig,
} from "./block-settings-registry";

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";
type DraftRecord = Record<string, unknown>;
type TranslationFn = (key: string) => unknown;

interface BlockSettingsPanelProps {
  blockId: string;
  kind: string;
  data: unknown;
  ownerType: PageOwnerType;
  ownerId: string;
  onClose: () => void;
}

type LinkItem = {
  label: string;
  url: string;
  icon?: string;
};

type ImageItem = {
  url: string;
  alt?: string;
  caption?: string;
  downloadable?: boolean;
};

function translate(t: TranslationFn, key: string, fallback: string): string {
  const value = String(t(key));
  return value === key ? fallback : value;
}

function labelFor(t: TranslationFn, labelKey: string): string {
  return translate(t, labelKey, labelKey.replace(/^admin\.peBlockField/, ""));
}

function toTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(toRecord) : [];
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(toTextValue) : [];
}

function toLinkList(value: unknown): LinkItem[] {
  return toRecordList(value).map((item) => ({
    label: toTextValue(item.label),
    url: toTextValue(item.url),
    icon: toTextValue(item.icon) || undefined,
  }));
}

function toImageList(value: unknown): ImageItem[] {
  return toRecordList(value).map((item) => ({
    url: toTextValue(item.url),
    alt: toTextValue(item.alt) || undefined,
    caption: toTextValue(item.caption) || undefined,
    downloadable: item.downloadable === true ? true : undefined,
  }));
}

function useBlockSave(
  ownerType: PageOwnerType,
  ownerId: string,
  blockId: string,
) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const mutation = trpc.entityPages.managePageBlocks.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
      toast.success({
        id: "block-saved",
        title: String(t("admin.peBlockSettingsSaved")),
      });
    },
    onError: (err) => {
      toast.danger({
        id: "block-save-failed",
        title: String(t("admin.peBlockSettingsSaveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const save = useCallback(
    (payload: Record<string, unknown>) => {
      mutation.mutate({
        ownerType,
        ownerId,
        blockAction: { action: "edit", blockId, data: payload },
      });
    },
    [ownerType, ownerId, blockId, mutation],
  );

  return { save, isPending: mutation.isPending };
}

function FieldLabel({ children }: { children: string }) {
  return <Text variant="overline">{children}</Text>;
}

function ReadOnlyField({ label, message }: { label: string; message: string }) {
  return (
    <YStack
      gap="$1"
      padding="$2"
      borderWidth={1}
      borderColor="$borderColor"
      borderRadius={0}
    >
      <FieldLabel>{label}</FieldLabel>
      <Text variant="caption" color="$colorMuted">
        {message}
      </Text>
    </YStack>
  );
}

function MultilineField({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <YStack gap="$1">
      <FieldLabel>{label}</FieldLabel>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline
        numberOfLines={5}
        fullWidth
        style={{ minHeight: 96, fontSize: 16 }}
      />
    </YStack>
  );
}

function LinkListField({
  label,
  value,
  onChange,
  t,
}: {
  label: string;
  value: unknown;
  onChange: (value: LinkItem[]) => void;
  t: TranslationFn;
}) {
  const links = toLinkList(value);

  const updateLink = (
    index: number,
    field: keyof LinkItem,
    nextValue: string,
  ) => {
    onChange(
      links.map((link, itemIndex) =>
        itemIndex === index ? { ...link, [field]: nextValue } : link,
      ),
    );
  };

  return (
    <YStack gap="$2">
      <FieldLabel>{label}</FieldLabel>
      {links.map((link, index) => (
        <YStack
          key={index}
          gap="$2"
          padding="$2"
          borderWidth={1}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <XStack justifyContent="space-between" alignItems="center">
            <Text variant="caption" color="$colorMuted">
              {String(t("admin.peBlockSettingsItem"))} {index + 1}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() =>
                onChange(links.filter((_, itemIndex) => itemIndex !== index))
              }
              aria-label={String(t("admin.peBlockSettingsRemoveItem"))}
            >
              <Trash2 size={12} />
            </Button>
          </XStack>
          <XStack gap="$2" flexWrap="wrap">
            <YStack flex={1} minWidth={160}>
              <LabeledTextInput
                label={String(t("admin.peBlockFieldLabel"))}
                value={link.label}
                onChangeText={(nextValue) =>
                  updateLink(index, "label", nextValue)
                }
              />
            </YStack>
            <YStack flex={2} minWidth={180}>
              <LabeledTextInput
                label={String(t("admin.peBlockFieldUrl"))}
                value={link.url}
                onChangeText={(nextValue) =>
                  updateLink(index, "url", nextValue)
                }
              />
            </YStack>
            <YStack width={92}>
              <LabeledTextInput
                label={String(t("admin.peBlockFieldIcon"))}
                value={link.icon ?? ""}
                onChangeText={(nextValue) =>
                  updateLink(index, "icon", nextValue)
                }
              />
            </YStack>
          </XStack>
        </YStack>
      ))}
      <Button
        variant="outlined"
        size="$2"
        onPress={() => onChange([...links, { label: "", url: "" }])}
      >
        <Plus size={14} />
        {String(t("admin.peBlockSettingsAddItem"))}
      </Button>
    </YStack>
  );
}

function ImageListField({
  label,
  value,
  onChange,
  t,
  ownerType,
  ownerId,
}: {
  label: string;
  value: unknown;
  onChange: (value: ImageItem[]) => void;
  t: TranslationFn;
  ownerType: PageOwnerType;
  ownerId: string;
}) {
  const { toast } = useNotify();
  const images = toImageList(value);
  const { upload } = usePageImageUpload({ ownerType, ownerId });
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);

  const updateImage = useCallback(
    (index: number, field: keyof ImageItem, nextValue: string) => {
      onChange(
        images.map((image, itemIndex) =>
          itemIndex === index ? { ...image, [field]: nextValue } : image,
        ),
      );
    },
    [images, onChange],
  );

  const setDownloadable = useCallback(
    (index: number, next: boolean) => {
      onChange(
        images.map((image, itemIndex) =>
          itemIndex === index
            ? { ...image, downloadable: next ? true : undefined }
            : image,
        ),
      );
    },
    [images, onChange],
  );

  const handleUpload = useCallback(
    async (index: number, file: File) => {
      // Shared hook handles HEIC prep, type/size validation, presign PUT, and
      // finalize — surfacing its own danger toasts and resolving to the public
      // URL (or null on failure). We keep the per-index spinner and the
      // block-specific success toast local so this surface stays unchanged.
      setUploadingIndex(index);
      try {
        const publicUrl = await upload(file);
        if (!publicUrl) return;

        updateImage(index, "url", publicUrl);
        toast.success({
          id: `page-image-uploaded-${index}`,
          title: String(t("admin.peBlockImageUploaded")),
          message: String(t("admin.peBlockImageUploadedMessage")),
        });
      } finally {
        setUploadingIndex((current) => (current === index ? null : current));
      }
    },
    [upload, t, toast, updateImage],
  );

  const handleFileChange = useCallback(
    (index: number, event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file || uploadingIndex !== null) return;
      void handleUpload(index, file);
    },
    [handleUpload, uploadingIndex],
  );

  return (
    <YStack gap="$2">
      <FieldLabel>{label}</FieldLabel>
      {images.map((image, index) => (
        <YStack
          key={index}
          gap="$2"
          padding="$2"
          borderWidth={1}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <XStack justifyContent="space-between" alignItems="center">
            <Text variant="caption" color="$colorMuted">
              {String(t("admin.peBlockSettingsItem"))} {index + 1}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() =>
                onChange(images.filter((_, itemIndex) => itemIndex !== index))
              }
              aria-label={String(t("admin.peBlockSettingsRemoveItem"))}
            >
              <Trash2 size={12} />
            </Button>
          </XStack>
          <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
            <YStack flex={1} minWidth={180}>
              <LabeledTextInput
                id={`entity-page-photo-${index}-url`}
                name={`entity-page-photo-${index}-url`}
                label={String(t("admin.peBlockFieldUrl"))}
                value={image.url}
                onChangeText={(nextValue) =>
                  updateImage(index, "url", nextValue)
                }
                autoComplete="url"
                enterKeyHint="next"
                style={{ minHeight: 36, fontSize: 14 }}
              />
            </YStack>
            <YStack minWidth={132}>
              <NativeFileInput
                id={`entity-page-photo-upload-${index}`}
                type="file"
                accept={PAGE_IMAGE_UPLOAD_ACCEPT}
                disabled={uploadingIndex !== null}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  handleFileChange(index, event)
                }
              />
              <Button
                tag="label"
                variant="outlined"
                size="$2"
                disabled={uploadingIndex !== null}
                data-testid={`entity-page-image-upload-${index}`}
                {...({ htmlFor: `entity-page-photo-upload-${index}` } as any)}
              >
                {uploadingIndex === index ? (
                  <Spinner width={14} height={14} borderWidth={2} />
                ) : (
                  <Upload size={14} />
                )}
                {uploadingIndex === index
                  ? String(t("admin.peBlockImageUploading"))
                  : String(t("admin.peBlockImageUpload"))}
              </Button>
            </YStack>
          </XStack>
          <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
            <LabeledTextInput
              id={`entity-page-photo-${index}-alt`}
              name={`entity-page-photo-${index}-alt`}
              label={String(t("admin.peBlockFieldAltText"))}
              value={image.alt ?? ""}
              onChangeText={(nextValue) => updateImage(index, "alt", nextValue)}
              enterKeyHint="next"
              style={{ minHeight: 36, fontSize: 14 }}
              containerProps={{ flex: 1, minWidth: 180 }}
            />
            <LabeledTextInput
              id={`entity-page-photo-${index}-caption`}
              name={`entity-page-photo-${index}-caption`}
              label={String(t("admin.peBlockFieldCaption"))}
              value={image.caption ?? ""}
              onChangeText={(nextValue) =>
                updateImage(index, "caption", nextValue)
              }
              enterKeyHint="done"
              style={{ minHeight: 36, fontSize: 14 }}
              containerProps={{ width: 220, maxWidth: "100%", flexShrink: 0 }}
            />
          </XStack>
          <XStack gap="$2" alignItems="center" justifyContent="space-between">
            <YStack flex={1} minWidth={0}>
              <Text variant="caption" weight="bold">
                {String(t("admin.peBlockFieldDownloadable"))}
              </Text>
              <Text variant="caption" color="$colorMuted">
                {String(t("admin.peBlockFieldDownloadableHint"))}
              </Text>
            </YStack>
            <Switch
              checked={image.downloadable === true}
              onCheckedChange={(next) => setDownloadable(index, next)}
              size="small"
              aria-label={String(t("admin.peBlockFieldDownloadable"))}
              testId={`entity-page-photo-${index}-downloadable`}
            />
          </XStack>
        </YStack>
      ))}
      <Button
        variant="outlined"
        size="$2"
        onPress={() => onChange([...images, { url: "" }])}
      >
        <Plus size={14} />
        {String(t("admin.peBlockSettingsAddItem"))}
      </Button>
    </YStack>
  );
}

function StringListField({
  label,
  value,
  onChange,
  t,
}: {
  label: string;
  value: unknown;
  onChange: (value: string[]) => void;
  t: TranslationFn;
}) {
  const items = toStringList(value);

  return (
    <YStack gap="$2">
      <FieldLabel>{label}</FieldLabel>
      {items.map((item, index) => (
        <XStack key={index} gap="$2" alignItems="center">
          <YStack flex={1}>
            <TextInput
              value={item}
              onChangeText={(nextValue) =>
                onChange(
                  items.map((current, itemIndex) =>
                    itemIndex === index ? nextValue : current,
                  ),
                )
              }
              fullWidth
              style={{ fontSize: 16 }}
            />
          </YStack>
          <Button
            variant="ghost"
            size="$2"
            onPress={() =>
              onChange(items.filter((_, itemIndex) => itemIndex !== index))
            }
            aria-label={String(t("admin.peBlockSettingsRemoveItem"))}
          >
            <Trash2 size={14} />
          </Button>
        </XStack>
      ))}
      <Button
        variant="outlined"
        size="$2"
        onPress={() => onChange([...items, ""])}
      >
        <Plus size={14} />
        {String(t("admin.peBlockSettingsAddItem"))}
      </Button>
    </YStack>
  );
}

function ObjectListField({
  field,
  label,
  value,
  onChange,
  t,
}: {
  field: BlockFieldConfig;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  t: TranslationFn;
}) {
  const model = getObjectListFieldModel(field);

  if (model.kind === "readonly") {
    return (
      <ReadOnlyField
        label={label}
        message={String(t("admin.peBlockSettingsManagedAutomatically"))}
      />
    );
  }

  if (model.kind === "string") {
    return (
      <StringListField label={label} value={value} onChange={onChange} t={t} />
    );
  }

  return (
    <StructuredObjectListField
      label={label}
      value={value}
      itemFields={model.fields}
      onChange={onChange}
      t={t}
      validateEmbedUrls={isEmbedUrlField(field.name)}
    />
  );
}

function StructuredObjectListField({
  label,
  value,
  itemFields,
  onChange,
  t,
  validateEmbedUrls = false,
}: {
  label: string;
  value: unknown;
  itemFields: readonly ObjectListItemFieldConfig[];
  onChange: (value: Record<string, unknown>[]) => void;
  t: TranslationFn;
  validateEmbedUrls?: boolean;
}) {
  const items = toRecordList(value);

  const updateItem = (index: number, fieldName: string, nextValue: string) => {
    onChange(
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [fieldName]: nextValue } : item,
      ),
    );
  };

  return (
    <YStack gap="$2">
      <FieldLabel>{label}</FieldLabel>
      {items.map((item, index) => (
        <YStack
          key={index}
          gap="$2"
          padding="$2"
          borderWidth={1}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <XStack justifyContent="space-between" alignItems="center">
            <Text variant="caption" color="$colorMuted">
              {String(t("admin.peBlockSettingsItem"))} {index + 1}
            </Text>
            <Button
              variant="ghost"
              size="$1"
              onPress={() =>
                onChange(items.filter((_, itemIndex) => itemIndex !== index))
              }
              aria-label={String(t("admin.peBlockSettingsRemoveItem"))}
            >
              <Trash2 size={12} />
            </Button>
          </XStack>
          {itemFields.map((itemField) => {
            const itemLabel = labelFor(t, itemField.labelKey);
            const itemValue = toTextValue(item[itemField.name]);

            if (itemField.kind === "textarea") {
              return (
                <MultilineField
                  key={itemField.name}
                  label={itemLabel}
                  value={itemValue}
                  onChangeText={(nextValue) =>
                    updateItem(index, itemField.name, nextValue)
                  }
                />
              );
            }

            const showUrlError =
              validateEmbedUrls &&
              itemField.name === "url" &&
              isUnsupportedEmbedUrl(itemValue);

            return (
              <YStack key={itemField.name} gap="$1">
                <LabeledTextInput
                  label={itemLabel}
                  value={itemValue}
                  onChangeText={(nextValue) =>
                    updateItem(index, itemField.name, nextValue)
                  }
                />
                {showUrlError && (
                  <Text variant="caption" color="$red10" role="alert">
                    {String(t("admin.peBlockFieldEmbedUrlUnsupported"))}
                  </Text>
                )}
              </YStack>
            );
          })}
        </YStack>
      ))}
      <Button
        variant="outlined"
        size="$2"
        onPress={() => onChange([...items, {}])}
      >
        <Plus size={14} />
        {String(t("admin.peBlockSettingsAddItem"))}
      </Button>
    </YStack>
  );
}

export function BlockSettingsPanel({
  blockId,
  kind,
  data,
  ownerType,
  ownerId,
  onClose,
}: BlockSettingsPanelProps) {
  const t = useTranslations();
  const { save, isPending } = useBlockSave(ownerType, ownerId, blockId);
  const fields = getBlockSettingsFields(kind);
  const [draft, setDraft] = useState<DraftRecord>(() =>
    createBlockSettingsDraft(kind, data),
  );

  useEffect(() => {
    setDraft(createBlockSettingsDraft(kind, data));
  }, [kind, data]);

  const updateField = useCallback((name: string, value: unknown) => {
    setDraft((current) => ({ ...current, [name]: value }));
  }, []);

  // Block submit while any embed/track row holds a non-empty but unsupported
  // URL: those rows are flagged inline, so a bad row is neither silently dropped
  // under a success toast nor allowed to reject the whole block server-side.
  // Blank rows do NOT count — they're filtered on save.
  const hasUnsupportedEmbedUrls = useMemo(
    () => draftHasUnsupportedEmbedUrls(kind, draft),
    [kind, draft],
  );

  const handleSave = useCallback(() => {
    if (hasUnsupportedEmbedUrls) return;
    save(buildBlockSettingsSavePayload(kind, data, draft));
  }, [hasUnsupportedEmbedUrls, kind, data, draft, save]);

  const renderField = (field: BlockFieldConfig) => {
    const content = renderFieldControl(field);
    const help = field.helpTextKey ? String(t(field.helpTextKey)) : null;
    if (!help) return content;
    return (
      <YStack key={field.name} gap="$1">
        {content}
        <Text variant="caption" color="$colorMuted">
          {help}
        </Text>
      </YStack>
    );
  };

  const renderFieldControl = (field: BlockFieldConfig) => {
    const label = labelFor(t, field.labelKey);
    const value = draft[field.name];

    switch (field.kind) {
      case "text":
      case "image":
        return (
          <LabeledTextInput
            key={field.name}
            label={label}
            value={toTextValue(value)}
            onChangeText={(nextValue) => updateField(field.name, nextValue)}
          />
        );
      case "textarea":
      case "richText":
        return (
          <MultilineField
            key={field.name}
            label={label}
            value={toTextValue(value)}
            onChangeText={(nextValue) => updateField(field.name, nextValue)}
          />
        );
      case "number":
        return (
          <LabeledTextInput
            key={field.name}
            label={label}
            value={toTextValue(value)}
            onChangeText={(nextValue) => updateField(field.name, nextValue)}
            keyboardType="numeric"
          />
        );
      case "linkList":
        return (
          <LinkListField
            key={field.name}
            label={label}
            value={value}
            onChange={(nextValue) => updateField(field.name, nextValue)}
            t={t}
          />
        );
      case "imageList":
        return (
          <ImageListField
            key={field.name}
            label={label}
            value={value}
            onChange={(nextValue) => updateField(field.name, nextValue)}
            t={t}
            ownerType={ownerType}
            ownerId={ownerId}
          />
        );
      case "objectList":
        return (
          <ObjectListField
            key={field.name}
            field={field}
            label={label}
            value={value}
            onChange={(nextValue) => updateField(field.name, nextValue)}
            t={t}
          />
        );
      case "readonly":
        return (
          <ReadOnlyField
            key={field.name}
            label={label}
            message={String(t("admin.peBlockSettingsManagedAutomatically"))}
          />
        );
      default:
        return (
          <ReadOnlyField
            key={field.name}
            label={label}
            message={String(t("admin.peBlockSettingsUnsupportedField"))}
          />
        );
    }
  };

  return (
    <YStack
      padding="$3"
      gap="$3"
      backgroundColor="$surfaceMuted"
      borderTopWidth={1}
      borderTopColor="$borderColor"
      data-testid={`entity-page-block-settings-${blockId}`}
    >
      <XStack justifyContent="space-between" alignItems="center">
        <Text variant="overline">
          {String(t("admin.peBlockSettingsTitle"))}
        </Text>
        <Button variant="ghost" size="$1" onPress={onClose}>
          <Text variant="caption" color="$colorMuted">
            {String(t("admin.peBlockSettingsClose"))}
          </Text>
        </Button>
      </XStack>

      {fields.length > 0 ? (
        <YStack gap="$3">
          {fields.map(renderField)}
          {hasUnsupportedEmbedUrls && (
            <Text variant="caption" color="$red10" role="alert">
              {String(t("admin.peBlockFieldEmbedUrlUnsupportedSave"))}
            </Text>
          )}
          <Button
            variant="primary"
            size="$2"
            onPress={handleSave}
            disabled={isPending || hasUnsupportedEmbedUrls}
            data-entity-page-save="true"
          >
            <Save size={14} />
            {String(t("admin.peBlockSettingsSave"))}
          </Button>
        </YStack>
      ) : (
        <Text variant="caption" color="$colorMuted">
          {String(t("admin.peBlockSettingsUnavailable"))}
        </Text>
      )}
    </YStack>
  );
}

BlockSettingsPanel.displayName = "BlockSettingsPanel";
