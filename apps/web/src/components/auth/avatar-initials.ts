/**
 * One or two uppercase letters for an avatar fallback. Accepts a display
 * name or an email (the local part is used). Returns "U" for empty input.
 *
 * Shared by the navbar avatar trigger (`ProfileMenu`) and the account menu
 * (`AccountManagementPopover`), so both show the same letters for a person.
 */
export const initialsFrom = (nameOrEmail: string | null | undefined): string => {
  const value = (nameOrEmail ?? "").trim();
  if (!value) return "U";

  const emailPrefix = value.includes("@")
    ? (value.split("@")[0] ?? value)
    : value;
  const parts = emailPrefix
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
};
