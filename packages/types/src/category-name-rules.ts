/**
 * THE category name rules: the one copy core enforces and the web checks
 * before a round trip (category-translations spec, follow-up F3).
 *
 * Pure functions returning an issue code or `null`. No `@th/errors`, no zod:
 * core wraps them in its boundary schema and `fail("INVALID_CATEGORY_REQUEST_NAME")`
 * (`packages/core/src/use-cases/categories/_shared/category-naming.ts`), and
 * the web shows the code as a field message. The server stays the authority;
 * the web only reads the same rules earlier.
 *
 * Every language follows the word rules ({@link categoryNameIssue}). The
 * English name also derives the slug, so it must slug to 2–40 characters
 * ({@link categorySlugNameIssue}); a translated name never makes a slug.
 */

export type CategoryNameIssue =
  | "too_short"
  | "too_long"
  | "unsupported_characters"
  | "link_or_handle"
  | "repeated_characters";

/** Lowercase latin words joined by single hyphens. */
export const CATEGORY_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CATEGORY_NAME_MIN_LENGTH = 2;
export const CATEGORY_NAME_MAX_LENGTH = 80;
export const CATEGORY_SLUG_MIN_LENGTH = 2;
export const CATEGORY_SLUG_MAX_LENGTH = 40;

const NAME_ALLOWED = /^[\p{L}\p{N}\s&'’+-]+$/u;
const NAME_LINK_OR_HANDLE = /(https?:\/\/|www\.|@|#)/i;
const NAME_REPEAT = /(.)\1{7,}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/** NFKC, inner runs of space collapsed, trimmed: what the server stores. */
export function normalizeCategoryName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * The slug a name derives: accents stripped (U+0300–U+036F after NFKD),
 * lowercased, every run of other characters turned into one hyphen, no
 * hyphen at either end. Never throws; a name with no latin letters or digits
 * derives `""`. Check the result with {@link categorySlugIssue}.
 */
export function deriveCategorySlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * The word rules every name follows, in any language, checked on the
 * normalised name: at least two letters or numbers (any script), at most 80
 * characters, only letters, numbers, spaces and & ' ’ + -, no link or
 * handle, no character repeated eight times. The first rule broken wins.
 */
export function categoryNameIssue(raw: string): CategoryNameIssue | null {
  const name = normalizeCategoryName(raw);
  const alnum = Array.from(name).filter((char) =>
    LETTER_OR_NUMBER.test(char),
  ).length;
  if (alnum < CATEGORY_NAME_MIN_LENGTH) return "too_short";
  if (name.length > CATEGORY_NAME_MAX_LENGTH) return "too_long";
  if (!NAME_ALLOWED.test(name)) return "unsupported_characters";
  // Unreachable today: every link or handle needs `.` `:` `/` `@` or `#`,
  // which the allowed-characters check refuses first. Kept so widening that
  // set (allowing `.`, say) cannot let "www.example" through unnoticed.
  if (NAME_LINK_OR_HANDLE.test(name)) return "link_or_handle";
  if (NAME_REPEAT.test(name)) return "repeated_characters";
  return null;
}

/**
 * A slug's bounds: 2 to 40 characters of {@link CATEGORY_SLUG_REGEX}. A slug
 * from {@link deriveCategorySlug} always fits the pattern when it is not
 * empty; the pattern check makes the function safe on any string.
 */
export function categorySlugIssue(slug: string): CategoryNameIssue | null {
  if (slug.length < CATEGORY_SLUG_MIN_LENGTH) return "too_short";
  if (slug.length > CATEGORY_SLUG_MAX_LENGTH) return "too_long";
  if (!CATEGORY_SLUG_REGEX.test(slug)) return "unsupported_characters";
  return null;
}

/** The word rules plus the derived slug's bounds: an English name. */
export function categorySlugNameIssue(raw: string): CategoryNameIssue | null {
  return (
    categoryNameIssue(raw) ??
    categorySlugIssue(deriveCategorySlug(normalizeCategoryName(raw)))
  );
}
