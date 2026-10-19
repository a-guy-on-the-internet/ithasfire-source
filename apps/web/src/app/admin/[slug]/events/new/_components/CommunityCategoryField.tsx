"use client";

import { memo, useId, type CSSProperties } from "react";

import { Text, useLocale, useTranslations } from "@th/ui";
import { withCategoryDisplayNames } from "@/lib/category-display-name";

import { trpc } from "@/trpc";

import { Field, FieldLabel } from "./_form-bits";

/**
 * Category picker for the builder's COMMUNITY mode.
 *
 * ## Why this exists instead of `CategoryTagsSection`
 *
 * `CategoryTagsSection` saves through `categories.setEventCategory` and
 * `tags.setEventTags`, and BOTH of those refuse an ownerless row: their
 * `ensureEventAccessible` falls through the org branch, finds no `humanId`,
 * and throws `NOT_RESOURCE_OWNER` (see
 * `core/src/use-cases/categories/set-event-category.ts` and
 * `.../tags/set-event-tags.ts`). Rendering that section on a community listing
 * would give a moderator a control that 403s on use.
 *
 * `categoryId` IS in the FR-007 whitelist, so the category rides the builder's
 * normal save through `community.updateListing` — hence a controlled value +
 * `onChange` here rather than a self-saving section. **Tags have no community
 * write path at all** and are therefore not offered; adding one is a backend
 * change, not something to fake in the UI.
 *
 * A native `<select>` (the same idiom the retired standalone community form
 * used) rather than the typeahead combobox: the list is short, there is no
 * "request a new option" affordance to hang off it here, and a native control
 * is keyboard- and screen-reader-correct for free.
 */

/** Square, token-driven, 44px — strict Swiss, matching the builder's inputs. */
const SELECT_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "inherit",
  color: "var(--color, #211C16)",
  background: "var(--surface, #FDFAF3)",
  border: "1px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  cursor: "pointer",
};

export type CommunityCategoryFieldProps = {
  /** Selected category UUID, or `null` for "no category". */
  value: string | null;
  onChange: (categoryId: string | null) => void;
  /** Read-only listing (PUBLISHED community row) — rendered but not editable. */
  disabled?: boolean;
};

function CommunityCategoryFieldImpl({
  value,
  onChange,
  disabled = false,
}: CommunityCategoryFieldProps) {
  const t = useTranslations();
  const locale = useLocale();
  const selectId = useId();
  const labelId = useId();
  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  // Shown in the organiser's language; the category is sent by id.
  const categories = withCategoryDisplayNames(
    categoriesQuery.data?.categories ?? [],
    locale,
  );

  return (
    <Field>
      {/* `FieldLabel` renders a <span> (Tamagui Text), so the association is
          made with `aria-labelledby` rather than `htmlFor` — a `<label for>`
          that points at nothing is worse than none. */}
      <FieldLabel optional id={labelId}>
        {String(t("communityCreate.fieldCategory"))}
      </FieldLabel>
      <select
        id={selectId}
        aria-labelledby={labelId}
        value={value ?? ""}
        disabled={disabled || categoriesQuery.isLoading}
        onChange={(event) => onChange(event.target.value || null)}
        style={SELECT_STYLE}
        data-testid="community-category-select"
      >
        <option value="">{String(t("communityCreate.categoryNone"))}</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      {categoriesQuery.isError && (
        <Text variant="caption" tone="error" role="alert">
          {String(t("communityBuilder.categoryLoadFailed"))}
        </Text>
      )}
    </Field>
  );
}

export const CommunityCategoryField = memo(CommunityCategoryFieldImpl);

CommunityCategoryField.displayName = "CommunityCategoryField";
