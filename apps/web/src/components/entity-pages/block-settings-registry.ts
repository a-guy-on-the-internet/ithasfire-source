import { getBlockConfig } from "@th/core/use-cases/entity-pages";

import {
  buildBlockSettingsSavePayload as buildBlockSettingsSavePayloadFromConfig,
  createBlockSettingsDraft as createBlockSettingsDraftFromConfig,
  draftHasUnsupportedEmbedUrls as draftHasUnsupportedEmbedUrlsFromConfig,
  getBlockSettingsFields as getBlockSettingsFieldsFromConfig,
  getEditableBlockFields as getEditableBlockFieldsFromConfig,
  hasEditableSettings as hasEditableSettingsFromConfig,
} from "./block-settings-model";

export {
  getObjectListFieldModel,
  isEmbedUrlField,
  isUnsupportedEmbedUrl,
  type ObjectListItemFieldConfig,
} from "./block-settings-model";

export function draftHasUnsupportedEmbedUrls(
  kind: string,
  draft: Record<string, unknown>,
) {
  return draftHasUnsupportedEmbedUrlsFromConfig(kind, draft, getBlockConfig);
}

export function getBlockSettingsFields(kind: string) {
  return getBlockSettingsFieldsFromConfig(kind, getBlockConfig);
}

export function getEditableBlockFields(kind: string) {
  return getEditableBlockFieldsFromConfig(kind, getBlockConfig);
}

export function hasEditableSettings(kind: string) {
  return hasEditableSettingsFromConfig(kind, getBlockConfig);
}

export function createBlockSettingsDraft(kind: string, data: unknown) {
  return createBlockSettingsDraftFromConfig(kind, data, getBlockConfig);
}

export function buildBlockSettingsSavePayload(
  kind: string,
  existingData: unknown,
  draftData: Record<string, unknown>,
) {
  return buildBlockSettingsSavePayloadFromConfig(
    kind,
    existingData,
    draftData,
    getBlockConfig,
  );
}
