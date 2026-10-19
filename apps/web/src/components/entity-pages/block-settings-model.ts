import type {
  BlockFieldConfig,
  BlockFieldKind,
} from "@th/core/use-cases/entity-pages";
import { matchEmbedProviderByHost } from "@th/core/lib/embeds";

type ObjectListItemFieldKind = "text" | "textarea" | "image";

export type ObjectListItemFieldConfig = {
  name: string;
  labelKey: string;
  kind: ObjectListItemFieldKind;
};

export type ObjectListFieldModel =
  | {
      kind: "object";
      fields: readonly ObjectListItemFieldConfig[];
    }
  | {
      kind: "string";
    }
  | {
      kind: "readonly";
    };

export type BlockSettingsConfig = {
  fields: readonly BlockFieldConfig[];
};

export type BlockConfigResolver = (
  kind: string,
) => BlockSettingsConfig | undefined;

const editableScalarKinds = new Set<BlockFieldKind>([
  "text",
  "textarea",
  "richText",
  "number",
  "image",
  "imageList",
  "linkList",
]);

const stringListFieldNames = new Set([
  "requirements",
  "rules",
  "amenities",
  "tags",
]);

const objectListFieldModels: Record<
  string,
  readonly ObjectListItemFieldConfig[]
> = {
  items: [
    { name: "question", labelKey: "admin.peBlockFieldQuestion", kind: "text" },
    { name: "answer", labelKey: "admin.peBlockFieldAnswer", kind: "textarea" },
  ],
  videos: [
    { name: "url", labelKey: "admin.peBlockFieldUrl", kind: "text" },
    { name: "title", labelKey: "admin.peBlockFieldTitle", kind: "text" },
  ],
  mentions: [
    { name: "title", labelKey: "admin.peBlockFieldTitle", kind: "text" },
    { name: "source", labelKey: "admin.peBlockFieldSource", kind: "text" },
    { name: "url", labelKey: "admin.peBlockFieldUrl", kind: "text" },
    { name: "date", labelKey: "admin.peBlockFieldDate", kind: "text" },
    {
      name: "excerpt",
      labelKey: "admin.peBlockFieldExcerpt",
      kind: "textarea",
    },
  ],
  members: [
    { name: "name", labelKey: "admin.peBlockFieldName", kind: "text" },
    { name: "role", labelKey: "admin.peBlockFieldRole", kind: "text" },
    {
      name: "avatarUrl",
      labelKey: "admin.peBlockFieldAvatarUrl",
      kind: "image",
    },
  ],
  // Musician EPK "listen" widget (FR-005). The owner pastes a profile URL; the
  // `provider` field is derived from the URL host at save time (see
  // `normalizeObjectListItems`) so it always matches the domain allowlist and
  // the owner can never mismatch it.
  embeds: [{ name: "url", labelKey: "admin.peBlockFieldUrl", kind: "text" }],
  // Curated, labeled track list (FR-006): a specific embed URL + an optional
  // freeform "what it's for" label.
  tracks: [
    { name: "url", labelKey: "admin.peBlockFieldUrl", kind: "text" },
    { name: "label", labelKey: "admin.peBlockFieldLabel", kind: "text" },
  ],
  // Venue tech-spec sheet (`tech_specs` block): labeled spec rows
  // ("PA" → "d&b line array + subs"). Named `specs` — NOT `items` — because
  // this registry is keyed by field name and `items` is bound to the FAQ
  // question/answer form above.
  specs: [
    { name: "label", labelKey: "admin.peBlockFieldLabel", kind: "text" },
    // Multiline like the FAQ answer — the schema allows 1000 chars and the
    // renderer is pre-wrap.
    { name: "value", labelKey: "admin.peBlockFieldValue", kind: "textarea" },
  ],
};

/**
 * Object-list field names whose items carry a provider-embed `url` that must
 * be validated against the domain allowlist (music `embeds`, curated `tracks`).
 */
const embedUrlFieldNames = new Set(["embeds", "tracks"]);

export function isEmbedUrlField(fieldName: string): boolean {
  return embedUrlFieldNames.has(fieldName);
}

function urlOf(item: unknown): string {
  const record = isRecord(item) ? item : {};
  return typeof record.url === "string" ? record.url.trim() : "";
}

/**
 * True for a row where the owner typed a URL that is NOT an allowlisted
 * provider host. Empty/blank rows are NOT "invalid" — they're a normal editing
 * state (a stray "Add item" row) and are filtered on save rather than flagged.
 */
export function isUnsupportedEmbedUrl(value: unknown): boolean {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return false;
  return matchEmbedProviderByHost(trimmed) === null;
}

/**
 * True when any row across the draft's embed/track fields has a non-empty but
 * unsupported URL. Callers block submit on this so a bad row is neither silently
 * dropped nor allowed to reject the whole block server-side.
 */
export function draftHasUnsupportedEmbedUrls(
  kind: string,
  draft: Record<string, unknown>,
  getBlockConfig: BlockConfigResolver,
): boolean {
  return getBlockSettingsFields(kind, getBlockConfig).some((field) => {
    if (field.kind !== "objectList" || !isEmbedUrlField(field.name)) {
      return false;
    }
    const rows = draft[field.name];
    return (
      Array.isArray(rows) && rows.some((row) => isUnsupportedEmbedUrl(urlOf(row)))
    );
  });
}

/**
 * Save-time normalization for object-list fields.
 *
 * - `embeds`: drop blank rows, stamp `provider` from the URL host so the stored
 *   `{ provider, url }` shape is always valid without a provider picker.
 * - `tracks`: drop blank rows, keep `{ url, label? }`.
 *
 * Both drop ONLY empty rows here — non-empty invalid rows are caught earlier by
 * `draftHasUnsupportedEmbedUrls` (submit is blocked), so they never reach this
 * path to be silently discarded under a success toast.
 */
function normalizeObjectListItems(fieldName: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  if (fieldName === "embeds") {
    return value
      .map((item) => {
        const url = urlOf(item);
        const provider = matchEmbedProviderByHost(url);
        return provider ? { provider, url } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  if (fieldName === "tracks") {
    return value
      .filter((item) => urlOf(item).length > 0)
      .map((item) => {
        const record = isRecord(item) ? item : {};
        const label =
          typeof record.label === "string" ? record.label.trim() : "";
        return label ? { url: urlOf(item), label } : { url: urlOf(item) };
      });
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function isEditableField(field: BlockFieldConfig): boolean {
  if (field.kind === "objectList") {
    return getObjectListFieldModel(field).kind !== "readonly";
  }

  return editableScalarKinds.has(field.kind);
}

export function getBlockSettingsFields(
  kind: string,
  getBlockConfig: BlockConfigResolver,
): readonly BlockFieldConfig[] {
  return (
    getBlockConfig(kind)?.fields.filter((field) => field.kind !== "html") ?? []
  );
}

export function getEditableBlockFields(
  kind: string,
  getBlockConfig: BlockConfigResolver,
): readonly BlockFieldConfig[] {
  return getBlockSettingsFields(kind, getBlockConfig).filter(isEditableField);
}

export function hasEditableSettings(
  kind: string,
  getBlockConfig: BlockConfigResolver,
): boolean {
  return getEditableBlockFields(kind, getBlockConfig).length > 0;
}

export function getObjectListFieldModel(
  field: Pick<BlockFieldConfig, "name">,
): ObjectListFieldModel {
  if (stringListFieldNames.has(field.name)) {
    return { kind: "string" };
  }

  const fields = objectListFieldModels[field.name];
  if (fields) {
    return { kind: "object", fields };
  }

  return { kind: "readonly" };
}

export function createBlockSettingsDraft(
  kind: string,
  data: unknown,
  getBlockConfig: BlockConfigResolver,
): Record<string, unknown> {
  const source = cloneRecord(data);
  const draft: Record<string, unknown> = {};

  for (const field of getBlockSettingsFields(kind, getBlockConfig)) {
    if (!isEditableField(field)) continue;
    draft[field.name] = source[field.name];
  }

  return draft;
}

export function buildBlockSettingsSavePayload(
  kind: string,
  existingData: unknown,
  draftData: Record<string, unknown>,
  getBlockConfig: BlockConfigResolver,
): Record<string, unknown> {
  const payload = cloneRecord(existingData);

  for (const field of getEditableBlockFields(kind, getBlockConfig)) {
    if (!Object.prototype.hasOwnProperty.call(draftData, field.name)) continue;

    const value = draftData[field.name];

    if (field.kind === "number") {
      const normalizedValue = typeof value === "string" ? value.trim() : value;

      if (
        normalizedValue === "" ||
        normalizedValue === null ||
        normalizedValue === undefined
      ) {
        delete payload[field.name];
        continue;
      }

      const parsed =
        typeof normalizedValue === "number"
          ? normalizedValue
          : Number(String(normalizedValue));
      if (Number.isFinite(parsed)) {
        payload[field.name] = parsed;
      }
      continue;
    }

    if (field.kind === "objectList") {
      payload[field.name] = normalizeObjectListItems(field.name, value);
      continue;
    }

    payload[field.name] = value;
  }

  return payload;
}
