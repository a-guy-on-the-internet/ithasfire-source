// Saved snippets (booking-the-night FR-013, decision N18): an owner's
// reusable reasons, seeded from platform starters on first use. Transport
// exposes `savedSnippets.*`.

export {
  DEFAULT_STARTER_LOCALE,
  STARTER_DECLINE_REASONS,
  STARTER_LOCALES,
  STARTER_REASON_KEYS,
  starterSnippetsFor,
  toStarterLocale,
  type StarterLocale,
  type StarterReason,
  type StarterReasonKey,
} from "./_shared/starter-reasons";

export {
  savedSnippetOwnerInputSchema,
  type SavedSnippetOwnerInput,
} from "./_shared/saved-snippet-owner";

export {
  savedSnippetOutputSchema,
  type SavedSnippetOutput,
} from "./_shared/saved-snippet-schemas";

export {
  listSavedSnippets,
  listSavedSnippetsInputSchema,
  listSavedSnippetsOutputSchema,
  type ListSavedSnippetsDeps,
  type ListSavedSnippetsInput,
  type ListSavedSnippetsOutput,
} from "./list-saved-snippets";

export {
  createSavedSnippet,
  createSavedSnippetInputSchema,
  createSavedSnippetOutputSchema,
  updateSavedSnippet,
  updateSavedSnippetInputSchema,
  updateSavedSnippetOutputSchema,
  deleteSavedSnippet,
  deleteSavedSnippetInputSchema,
  deleteSavedSnippetOutputSchema,
  reorderSavedSnippets,
  reorderSavedSnippetsInputSchema,
  reorderSavedSnippetsOutputSchema,
  type ManageSavedSnippetsDeps,
  type CreateSavedSnippetInput,
  type CreateSavedSnippetOutput,
  type UpdateSavedSnippetInput,
  type UpdateSavedSnippetOutput,
  type DeleteSavedSnippetInput,
  type DeleteSavedSnippetOutput,
  type ReorderSavedSnippetsInput,
  type ReorderSavedSnippetsOutput,
} from "./manage-saved-snippets";
