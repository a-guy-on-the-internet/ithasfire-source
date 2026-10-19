"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTheme, XStack, YStack, styled } from "tamagui";
import {
  AlertTriangle,
  Check,
  Plus,
  RefreshCw,
  Tag,
  X,
} from "lucide-react";

import {
  PlatformContainer,
  PlatformFilterBar,
  PlatformPageTitle,
  PlatformSectionTitle,
  PlatformSubtitle,
} from "../_components/PlatformPageParts";
import {
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CategoryTile,
  SELECT_FRAME_PROPS,
  SEO_TYPE_OPTIONS,
  categoryNameErrorKey,
  categoryTileIds,
  movedCategoryIds,
  type CategoryMoveDirection,
  type CategoryNameError,
  type CategoryTileMode,
} from "./_components/CategoryTile";
import {
  CategoryNameField,
  LANGUAGE_NAME_KEYS,
  isTranslatedNameAcceptable,
  translationErrorMessage,
  translationRefusal,
  useSuggestedName,
  type TranslationError,
} from "./_components/category-name-fields";
import {
  CategoryRequestApproval,
  approvalFieldIds,
  type CategoryRequestApprovalInput,
} from "./_components/CategoryRequestApproval";
import {
  LanguageSelect,
  SuggestionNotice,
  useLanguageSelection,
  type LanguageRevealRequest,
} from "./_components/language-select";
import {
  Badge,
  Button,
  Spinner,
  StyledSelect,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  isCategoryNameLocale,
  type CategoryNameLocale,
  type CategoryTranslationLocale,
  type EventSchemaType,
} from "@th/types";
import { trpc } from "@/trpc";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import { getAppErrorCode } from "@/lib/app-error";
import {
  categorySlugIssue,
  deriveCategorySlug,
  normalizeCategoryName,
} from "@th/types/category-name-rules";
import { formatDateShort } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";

type RequestStatus = "PENDING" | "APPROVED" | "REJECTED";
type CategoryRequestKind = "CATEGORY";
type ReviewDecision = "APPROVE" | "REJECT";
type TileModeState = { categoryId: string; kind: CategoryTileMode };

const PAGE_SIZE = 50;

const STATUS_OPTIONS: RequestStatus[] = ["PENDING", "APPROVED", "REJECTED"];
const REVIEW_ROLES = new Set(["ADMIN", "REVIEWER", "DEVELOPER"]);
// Deletion is destructive — REVIEWERs can approve/reject but not destroy.
const DELETE_ROLES = new Set(["ADMIN", "DEVELOPER"]);
// Editing a category's schema.org @type shapes crawler-visible structured
// data, so it sits at the same privilege level as deletion (ADMIN / DEVELOPER).
const SEO_TYPE_ROLES = DELETE_ROLES;
// Creating a category authors taxonomy, so it sits at that level too
// (`createCategory` refuses everyone else; REVIEWERs approve requests).
const CREATE_ROLES = DELETE_ROLES;
// Renaming, deactivating and reordering author taxonomy as well (`rename`,
// `setActive` and `reorder` refuse everyone else). A REVIEWER still sees
// every category, inactive ones included.
const MANAGE_ROLES = CREATE_ROLES;

const DEFAULT_SEO_TYPE: EventSchemaType = "Event";
const NEW_CATEGORY_NAME_ID = "platform-category-new-name";
const NEW_CATEGORY_NAME_ERROR_ID = "platform-category-new-name-error";
const NEW_CATEGORY_ES_ERROR_ID = "platform-category-new-name-es-error";
const NEW_CATEGORY_SEO_TYPE_ID = "platform-category-new-seo-type";
const NEW_CATEGORY_LANGUAGE_ID = "platform-category-new-language";
/** The Add form's name field per language (`…-new-name-es` for es). */
const newCategoryNameId = (locale: string) =>
  locale === "en" ? NEW_CATEGORY_NAME_ID : `${NEW_CATEGORY_NAME_ID}-${locale}`;
const STATUS_FILTER_ID = "platform-category-request-status";
// The request's language on its own in a cell, capitalised in both
// catalogs (the `pcLanguage*` names are lowercase in Spanish, for sentences).
const REQUEST_LANGUAGE_KEYS = {
  en: "admin.pcRequestLanguageEn",
  es: "admin.pcRequestLanguageEs",
} as const;
const approveButtonId = (requestId: string) =>
  `platform-category-approve-button-${requestId}`;

// The visually hidden live region that announces a finished reorder.
const LIVE_REGION_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

// `min(100%, …)` lets a column go narrower than its minimum when the page
// itself is narrower, so the tiles never push the document sideways.
const TILE_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
  gap: 12,
  alignItems: "stretch",
} as const;

const CREATE_FIELD_GROW = 1000;

// A tile's first control that takes focus: an inert button is skipped.
const TILE_FIRST_CONTROL_SELECTOR =
  'button:not([aria-disabled="true"]), select:not([disabled]), input';

/**
 * A request the tRPC input schema refused before the use case ran, over the
 * name and nothing else. The wire shape is a BAD_REQUEST with no app code
 * whose message is Zod's JSON issue list (the router's error formatter adds no
 * `zodError` field). The schema checks `seoType` too, so the issue paths
 * decide: every issue must point at `name`. A refusal over another field, or
 * a message that is not an issue list, is not the name's fault and goes to
 * the toast.
 */
function isNameSchemaRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { data, message } = error as {
    data?: { code?: unknown };
    message?: unknown;
  };
  if (data?.code !== "BAD_REQUEST" || typeof message !== "string") return false;
  let issues: unknown;
  try {
    issues = JSON.parse(message);
  } catch {
    return false;
  }
  if (!Array.isArray(issues) || issues.length === 0) return false;
  return issues.every((issue: unknown) => {
    const path =
      issue && typeof issue === "object"
        ? (issue as { path?: unknown }).path
        : null;
    return Array.isArray(path) && path[0] === "name";
  });
}

/**
 * Which inline name message a refused create or rename earns, or `null` when
 * the refusal is not about the name and belongs in a toast.
 */
function nameErrorFromRefusal(error: unknown): CategoryNameError | null {
  const code = getAppErrorCode(error);
  if (code === "CATEGORY_ALREADY_EXISTS") return "exists";
  if (
    code === "INVALID_CATEGORY_REQUEST_NAME" ||
    (code === null && isNameSchemaRefusal(error))
  ) {
    return "invalid";
  }
  return null;
}

const isCategoryNameLengthValid = (name: string) =>
  name.length >= CATEGORY_NAME_MIN && name.length <= CATEGORY_NAME_MAX;

const HeaderRule = styled(YStack, {
  height: 4,
  width: 48,
  backgroundColor: "$brandSecondary",
});

const CreateFormBox = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  borderRadius: 0,
  padding: 16,
  gap: 8,
});

// Top-aligned: the three labels share one line and the three inputs the next.
// The Spanish column can be taller (its Translate link wraps under the input
// in a narrow column); bottom alignment lifted its label and input out of line
// with the other two.
const CreateFormRow = styled(XStack, {
  gap: 12,
  flexWrap: "wrap",
  alignItems: "flex-start",
});

// Each field is a wrapping flex item: side by side when the row has room, one
// per line when it does not. `minWidth: 0` + `flexShrink: 1` let a field go
// narrower than its basis instead of pushing the row wider than the page.
const CreateField = styled(YStack, {
  gap: 4,
  flexGrow: CREATE_FIELD_GROW,
  flexShrink: 1,
  minWidth: 0,
});

// The button always takes its own full-width line under the fields: beside
// top-aligned fields it would sit level with their labels.
const CreateSubmitSlot = styled(YStack, {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: "100%",
  minWidth: 0,
});

// Both field labels render through this one style, so they are the same
// height and share a baseline. `flex` makes the label exactly as tall as its
// text; a block label would take the page's inherited line-height instead.
const CREATE_LABEL_STYLE = { display: "flex" } as const;

const QueueRow = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  borderRadius: 0,
  padding: 16,
  gap: 14,
});

const MetaCell = styled(YStack, {
  gap: 4,
  minWidth: 140,
  flexGrow: 1,
  flexBasis: 160,
});

const StateFrame = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  padding: 28,
  gap: 12,
  alignItems: "center",
  justifyContent: "center",
  minHeight: 180,
  backgroundColor: "$surface",
});

/**
 * The slug a request row shows: the one approval used or will use.
 * - Approved: the slug of the category it became. If that category was since
 *   deleted, an English request shows its stored slug and others show none.
 * - Pending with the form open, when the English name makes a slug the
 *   server refuses: none (an empty field on a non-English request counts as
 *   not typed yet). The server refuses the name before it matches any
 *   category, so a Spanish-name match below never applies.
 * - Pending with the form open, when a category already has the slug the
 *   English name makes: that slug (approval lands there).
 * - Pending, in another language, whose name a category already carries in
 *   that language: that category's slug (approval lands there, as the server's
 *   findCategoryByTranslatedName does).
 * - Pending with the approval form open: the slug the English name makes.
 * - Otherwise an English request shows its stored slug and others show none
 *   (their stored slug is made from the non-English name and never used).
 * An empty string means the muted "From the English name" line.
 */
function requestRowSlug(opts: {
  request: {
    status: RequestStatus;
    name: string;
    slug: string;
    resolvedCategoryId: string | null;
  };
  requestLocale: string;
  categories: ReadonlyArray<{
    id: string;
    slug: string;
    names?: Partial<Record<string, string>>;
  }>;
  approvingEnglishName: string | null;
}): string {
  const { request, requestLocale, categories, approvingEnglishName } = opts;
  const askedInEnglish = requestLocale === "en";
  const storedOrNone = askedInEnglish ? request.slug : "";
  if (request.status === "APPROVED") {
    const resolved = request.resolvedCategoryId
      ? categories.find((c) => c.id === request.resolvedCategoryId)
      : undefined;
    return resolved ? resolved.slug : storedOrNone;
  }
  if (request.status !== "PENDING") return storedOrNone;
  // Same order as the server's approve: a category at the English name's
  // slug first, then one already carrying the requested name.
  // On a non-English request an empty English field (the form just opened)
  // counts as not typed yet, so the Spanish-name match still shows.
  const derived =
    approvingEnglishName === null ||
    (!askedInEnglish && approvingEnglishName.trim() === "")
      ? null
      : deriveCategorySlug(normalizeCategoryName(approvingEnglishName));
  const derivedOk = derived !== null && categorySlugIssue(derived) === null;
  // Refused before any matching, so no category's slug applies either.
  if (derived !== null && !derivedOk) return "";
  if (derived !== null && categories.some((c) => c.slug === derived)) {
    return derived;
  }
  if (!askedInEnglish) {
    const key = request.name.normalize("NFKC").toLowerCase();
    const existing = categories.find((c) => {
      const theirs = c.names?.[requestLocale];
      return theirs ? theirs.normalize("NFKC").toLowerCase() === key : false;
    });
    if (existing) return existing.slug;
  }
  if (derived !== null) return derived;
  return storedOrNone;
}

function statusTone(status: RequestStatus): "warning" | "success" | "danger" {
  if (status === "PENDING") return "warning";
  if (status === "APPROVED") return "success";
  return "danger";
}

function statusKey(
  status: RequestStatus,
):
  | "admin.pcStatusPending"
  | "admin.pcStatusApproved"
  | "admin.pcStatusRejected" {
  if (status === "PENDING") return "admin.pcStatusPending";
  if (status === "APPROVED") return "admin.pcStatusApproved";
  return "admin.pcStatusRejected";
}

function kindLabelKey(_kind: CategoryRequestKind): "admin.pcKindCategory" {
  return "admin.pcKindCategory";
}

export default function PlatformCategoriesPage() {
  const theme = useTheme();
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();

  const [statusFilter, setStatusFilter] = useState<RequestStatus>("PENDING");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  // The one request whose approval form is open, and the server's refusals
  // of its names (already translated).
  const [approvingRequestId, setApprovingRequestIdState] = useState<
    string | null
  >(null);
  const approvingRequestIdRef = useRef<string | null>(null);
  const setApprovingRequestId = useCallback((next: string | null) => {
    approvingRequestIdRef.current = next;
    setApprovingRequestIdState(next);
  }, []);
  // The open form's English name: a request made in another language takes
  // its slug from it, so the row shows that slug, not the stored one.
  const [approvalEnglishName, setApprovalEnglishName] = useState("");
  const [approveErrors, setApproveErrors] = useState<{
    en: string | null;
    es: string | null;
  }>({ en: null, es: null });
  // At most one tile is asking something at a time: its rename editor or one
  // of its confirms. Opening another closes this one.
  const [tileMode, setTileModeState] = useState<TileModeState | null>(null);
  // The same value, readable when a reply lands: a mutation callback must
  // compare against what is open now, not what was open when it was sent.
  const tileModeRef = useRef<TileModeState | null>(null);
  const setTileMode = useCallback((next: TileModeState | null) => {
    tileModeRef.current = next;
    setTileModeState(next);
  }, []);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<CategoryNameError | null>(
    null,
  );
  const renameInFlightRef = useRef(false);
  // The rename editor's Spanish name. A suggestion is asked for only when the
  // category had no Spanish name when the editor opened.
  const [renameSuggestEnabled, setRenameSuggestEnabled] = useState(false);
  const renameTranslation = useSuggestedName({
    sourceText: renameValue,
    sourceLocale: "en",
    targetLocale: "es",
    enabled: renameSuggestEnabled && tileMode?.kind === "rename",
  });
  const [renameTranslationError, setRenameTranslationError] =
    useState<TranslationError | null>(null);
  // A rename that changes the Spanish name too saves it once the rename has
  // landed: this holds what to send.
  const pendingTranslationRef = useRef<{
    categoryId: string;
    es: string | null;
  } | null>(null);
  const translationsInFlightRef = useRef(false);
  // The category whose Spanish save follows a rename that already landed:
  // if that save fails, the English name is saved and the toast says so.
  const translationsAfterRenameRef = useRef<string | null>(null);
  // The move button that was pressed, kept until the list has re-rendered in
  // its new order so focus can be put back on it.
  const pendingMoveRef = useRef<{
    categoryId: string;
    direction: CategoryMoveDirection;
  } | null>(null);
  // The category a delete just removed and where it sat, kept until the list
  // has re-rendered without it so focus can go to the tile that took its place.
  const pendingDeleteFocusRef = useRef<{
    categoryId: string;
    index: number;
  } | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [newName, setNewName] = useState("");
  const [newSeoType, setNewSeoType] =
    useState<EventSchemaType>(DEFAULT_SEO_TYPE);
  const [createNameError, setCreateNameError] =
    useState<CategoryNameError | null>(null);
  // `isPending` only flips on the next render, and one Enter can reach the
  // submit handler twice (the form's submit and the button's press), so the
  // in-flight guard is a ref.
  const createInFlightRef = useRef(false);

  // `listAll`, not `list`: staff see inactive categories too.
  // Never served stale, and re-read when the window regains focus: a move
  // sends the whole order as this page has it, and the server refuses a stale
  // set of ids but not a stale order, so an old list would overwrite another
  // admin's reorder without a word.
  const categoriesQuery = trpc.categories.listAll.useQuery(undefined, {
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 60_000,
  });

  const requestInput = useMemo<{
    status: RequestStatus;
    limit: number;
    offset: number;
  }>(
    () => ({
      status: statusFilter,
      limit: PAGE_SIZE,
      offset: 0,
    }),
    [statusFilter],
  );

  const requestsQuery = trpc.categories.listRequests.useQuery(requestInput, {
    staleTime: 15_000,
  });

  // The rest of the app reads the public `list`; this page reads `listAll`.
  // Every category mutation refreshes both.
  const invalidateCategoryLists = useCallback(() => {
    void utils.categories.list.invalidate();
    void utils.categories.listAll.invalidate();
  }, [utils]);

  const reviewMutation = trpc.categories.reviewRequest.useMutation({
    // Its `onError` answers every failure, so the global toast would repeat it.
    meta: { silent: true },
    onSuccess: (_data, variables) => {
      toast.success({
        title: String(
          t(
            variables.decision === "APPROVE"
              ? "admin.pcApprovedToast"
              : "admin.pcRejectedToast",
          ),
        ),
      });
      setActiveReviewId(null);
      if (approvingRequestIdRef.current === variables.requestId) {
        setApprovingRequestId(null);
      }
      setReviewNotes((current) => {
        const next = { ...current };
        delete next[variables.requestId];
        return next;
      });
      void utils.categories.listRequests.invalidate();
      invalidateCategoryLists();
    },
    onError: (error, variables) => {
      setActiveReviewId(null);
      if (handleSecondFactorRequired(error)) return;
      // A refused name goes under its field while that approval is open.
      if (
        variables.decision === "APPROVE" &&
        approvingRequestIdRef.current === variables.requestId
      ) {
        const ids = approvalFieldIds(variables.requestId);
        if (getAppErrorCode(error) === "CATEGORY_ENGLISH_NAME_REQUIRED") {
          setApproveErrors({
            en: String(t("admin.pcEnglishNameRequired")),
            es: null,
          });
          document.getElementById(ids.en)?.focus();
          return;
        }
        const translationError = translationRefusal(error);
        if (translationError) {
          setApproveErrors({
            en: null,
            es: translationErrorMessage(t, translationError.error),
          });
          document.getElementById(ids.es)?.focus();
          return;
        }
        const nameError = nameErrorFromRefusal(error);
        if (nameError) {
          setApproveErrors({
            en: String(t(categoryNameErrorKey(nameError))),
            es: null,
          });
          document.getElementById(ids.en)?.focus();
          return;
        }
      }
      toast.danger({
        title: String(t("admin.pcReviewFailed")),
        message: formatErrorMessage(error, t),
      });
    },
  });

  const categories = useMemo(
    () => categoriesQuery.data?.categories ?? [],
    [categoriesQuery.data?.categories],
  );
  // A failed background refetch keeps the grid: the error frame is for a
  // load with nothing to show.
  const taxonomyError = categoriesQuery.data ? null : categoriesQuery.error;
  const taxonomyLoading = categoriesQuery.isLoading;
  const canReviewRequests = (staffAccessQuery.data?.roles ?? []).some((role) =>
    REVIEW_ROLES.has(role),
  );
  const canDeleteCategories = (staffAccessQuery.data?.roles ?? []).some(
    (role) => DELETE_ROLES.has(role),
  );
  const canEditSeoType = (staffAccessQuery.data?.roles ?? []).some((role) =>
    SEO_TYPE_ROLES.has(role),
  );

  const canCreateCategories = (staffAccessQuery.data?.roles ?? []).some(
    (role) => CREATE_ROLES.has(role),
  );
  const canManageCategories = (staffAccessQuery.data?.roles ?? []).some(
    (role) => MANAGE_ROLES.has(role),
  );

  // The Add form's Spanish name, prefilled from the English one.
  const newTranslation = useSuggestedName({
    sourceText: newName,
    sourceLocale: "en",
    targetLocale: "es",
    enabled: canCreateCategories,
  });
  const [createTranslationError, setCreateTranslationError] =
    useState<TranslationError | null>(null);
  // The Add form shows one language's name at a time (R24); a refused name
  // in a hidden language is brought forward.
  const createLanguage = useLanguageSelection({
    fieldId: newCategoryNameId,
    errors: {
      en: createNameError !== null,
      es: createTranslationError !== null,
    },
  });
  // Every refusal shows its language and focuses its field itself: one that
  // repeats an error already set changes no state the selector can see.
  const revealCreateLanguage = createLanguage.reveal;
  const focusNewNameInput = useCallback(
    () => revealCreateLanguage("en"),
    [revealCreateLanguage],
  );
  const focusNewSpanishInput = useCallback(
    () => revealCreateLanguage("es"),
    [revealCreateLanguage],
  );
  const resetNewTranslation = newTranslation.reset;

  const createMutation = trpc.categories.create.useMutation({
    // Every failure is answered here (the enrolment prompt for a missing
    // second factor, inline for the name, one toast for the rest), so the
    // global "Action failed" toast would say it a second time.
    meta: { silent: true },
    onSuccess: (data) => {
      const { name, slug } = data.category;
      toast.success({
        title: String(t("admin.pcAddedToast")),
        message: String(
          data.resolvedRequestCount > 0
            ? t("admin.pcAddedToastMessageWithRequests", {
                name,
                slug,
                count: data.resolvedRequestCount,
              })
            : t("admin.pcAddedToastMessage", { name, slug }),
        ),
      });
      setNewName("");
      setNewSeoType(DEFAULT_SEO_TYPE);
      setCreateNameError(null);
      resetNewTranslation("");
      setCreateTranslationError(null);
      // Back to the English name field so several can be added in a row.
      revealCreateLanguage("en");
      invalidateCategoryLists();
      // Creating a category approves the pending requests for its name.
      void utils.categories.listRequests.invalidate();
    },
    onError: (error) => {
      // A staff member with no second factor gets the enrolment prompt, not
      // a generic failure toast.
      if (handleSecondFactorRequired(error)) return;
      // The Spanish name first: a duplicate in Spanish is also
      // CATEGORY_ALREADY_EXISTS, told apart by its meta.
      const translationError = translationRefusal(error);
      if (translationError) {
        setCreateTranslationError(translationError.error);
        focusNewSpanishInput();
        return;
      }
      const nameError = nameErrorFromRefusal(error);
      if (nameError) {
        setCreateNameError(nameError);
        focusNewNameInput();
        return;
      }
      toast.danger({
        title: String(t("admin.pcAddFailed")),
        message: formatErrorMessage(error, t),
      });
    },
    onSettled: () => {
      createInFlightRef.current = false;
    },
  });

  const trimmedNewName = normalizeCategoryName(newName);
  const canSubmitCreate =
    trimmedNewName.length > 0 && !createMutation.isPending;

  // A suggestion whose field has not been on screen is not sent: nobody has
  // read it (the notice under the selector points at it). Nor is one for an
  // English name that has changed since: it would pair a stale translation
  // with the new name and make a Spanish URL from it.
  const newSpanishName = newTranslation.leaveOutOnSubmit
    ? ""
    : normalizeCategoryName(newTranslation.value);
  const submitCreate = useCallback(() => {
    if (createInFlightRef.current || trimmedNewName.length === 0) return;
    if (!isCategoryNameLengthValid(trimmedNewName)) {
      setCreateNameError("invalid");
      focusNewNameInput();
      return;
    }
    if (newSpanishName.length > 0 && !isTranslatedNameAcceptable(newSpanishName)) {
      setCreateTranslationError("invalid");
      focusNewSpanishInput();
      return;
    }
    createInFlightRef.current = true;
    setCreateNameError(null);
    setCreateTranslationError(null);
    createMutation.mutate({
      name: trimmedNewName,
      seoType: newSeoType,
      ...(newSpanishName.length > 0
        ? { translations: { es: newSpanishName } }
        : {}),
    });
  }, [
    createMutation,
    focusNewNameInput,
    focusNewSpanishInput,
    newSeoType,
    newSpanishName,
    trimmedNewName,
  ]);

  const handleCreateSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submitCreate();
    },
    [submitCreate],
  );

  const handleNewNameChange = useCallback((value: string) => {
    setNewName(value);
    // Clear on input (design system §6a): editing the field drops its error.
    setCreateNameError(null);
  }, []);

  const setNewTranslationValue = newTranslation.setValue;
  const handleNewSpanishChange = useCallback(
    (value: string) => {
      setNewTranslationValue(value);
      setCreateTranslationError(null);
    },
    [setNewTranslationValue],
  );
  // The Add form's other-language fields. Keyed by every translation locale,
  // so a language added to the app fails to compile here until it has one.
  const createTranslationDrafts = {
    es: {
      value: newTranslation.value,
      suggested: newTranslation.isSuggested,
      unreviewed: newTranslation.unreviewed,
      onSeen: newTranslation.markSeen,
      onChange: handleNewSpanishChange,
      error: createTranslationError,
      errorId: NEW_CATEGORY_ES_ERROR_ID,
    },
  } satisfies Record<
    CategoryTranslationLocale,
    {
      value: string;
      suggested: boolean;
      unreviewed: boolean;
      onSeen: () => void;
      onChange: (value: string) => void;
      error: TranslationError | null;
      errorId: string;
    }
  >;
  const createUnreviewed = {
    es: createTranslationDrafts.es.unreviewed,
  } satisfies Record<CategoryTranslationLocale, boolean>;
  const shownCreateDraft =
    createLanguage.language === "en"
      ? null
      : createTranslationDrafts[createLanguage.language];

  const refetchCategories = categoriesQuery.refetch;

  /**
   * Someone else changed the list under this page: a category was added or
   * removed (the reorder's id list is stale), or the one acted on is gone.
   * Reload it and say so once.
   */
  const handleListChanged = useCallback(
    (error: unknown, codes: readonly string[]): boolean => {
      const code = getAppErrorCode(error);
      if (code === null || !codes.includes(code)) return false;
      void refetchCategories();
      void utils.categories.list.invalidate();
      toast.warning({
        title: String(t("admin.pcListChangedToast")),
        message: String(t("admin.pcListChangedToastMessage")),
      });
      return true;
    },
    [refetchCategories, t, toast, utils],
  );

  const seoTypeMutation = trpc.categories.setSeoType.useMutation({
    // Its `onError` answers every failure, so the global toast would repeat it.
    meta: { silent: true },
    onSuccess: (data) => {
      toast.success({
        title: "SEO type updated",
        message: `${data.category.slug} → ${data.category.seoType}`,
      });
      invalidateCategoryLists();
    },
    onError: (error) => {
      if (handleSecondFactorRequired(error)) return;
      if (handleListChanged(error, ["CATEGORY_NOT_FOUND"])) return;
      toast.danger({
        title: "Failed to update SEO type",
        message: formatErrorMessage(error, t),
      });
    },
  });

  const handleSeoTypeChange = useCallback(
    (categoryId: string, seoType: EventSchemaType) => {
      seoTypeMutation.mutate({ categoryId, seoType });
    },
    [seoTypeMutation],
  );

  const isTileModeOpen = useCallback(
    (kind: CategoryTileMode, categoryId: string) => {
      const open = tileModeRef.current;
      return open?.kind === kind && open.categoryId === categoryId;
    },
    [],
  );

  // A reply closes the editor or confirm it answers: that tile's, of that
  // kind. Anything else that is open (another tile's editor with a draft in
  // it, another tile's confirm) stays as it is.
  const closeTileMode = useCallback(
    (kind: CategoryTileMode, categoryId: string) => {
      if (isTileModeOpen(kind, categoryId)) setTileMode(null);
    },
    [isTileModeOpen, setTileMode],
  );

  const deleteMutation = trpc.categories.delete.useMutation({
    // Its `onError` answers every failure, so the global toast would repeat it.
    meta: { silent: true },
    onSuccess: (_data, variables) => {
      toast.success({ title: String(t("admin.pcDeletedToast")) });
      closeTileMode("delete", variables.categoryId);
      pendingDeleteFocusRef.current = {
        categoryId: variables.categoryId,
        index: categories.findIndex(
          (category) => category.id === variables.categoryId,
        ),
      };
      invalidateCategoryLists();
    },
    onError: (error, variables) => {
      closeTileMode("delete", variables.categoryId);
      if (handleSecondFactorRequired(error)) return;
      if (handleListChanged(error, ["CATEGORY_NOT_FOUND"])) return;
      toast.danger({
        title: String(t("admin.pcDeleteFailed")),
        message: formatErrorMessage(error, t),
      });
    },
  });

  const handleDeleteCategory = useCallback(
    (categoryId: string) => {
      deleteMutation.mutate({ categoryId });
    },
    [deleteMutation],
  );

  // A refused name is shown and focused by its tile, which owns the
  // language selector: each refusal is a new request, so one that repeats
  // an error already set still brings its language forward.
  const [renameReveal, setRenameReveal] = useState<
    (LanguageRevealRequest & { categoryId: string }) | null
  >(null);
  // Never reused, so a request after a clear is still a new one.
  const renameRevealSeqRef = useRef(0);
  const revealRenameLanguage = useCallback(
    (categoryId: string, locale: CategoryNameLocale) => {
      renameRevealSeqRef.current += 1;
      setRenameReveal({ categoryId, locale, seq: renameRevealSeqRef.current });
    },
    [],
  );
  const focusRenameInput = useCallback(
    (categoryId: string) => revealRenameLanguage(categoryId, "en"),
    [revealRenameLanguage],
  );
  const focusRenameSpanishInput = useCallback(
    (categoryId: string) => revealRenameLanguage(categoryId, "es"),
    [revealRenameLanguage],
  );

  const closeRenameEditor = useCallback(
    (categoryId: string) => {
      if (!isTileModeOpen("rename", categoryId)) return;
      setTileMode(null);
      setRenameError(null);
      setRenameTranslationError(null);
      setRenameReveal(null);
    },
    [isTileModeOpen, setTileMode],
  );

  // The rename editor's Spanish name: set, changed or cleared.
  const translationsMutation = trpc.categories.setTranslations.useMutation({
    // Every failure is answered here: the enrolment prompt, inline under the
    // Spanish name, or one toast.
    meta: { silent: true },
    onSuccess: (data, variables) => {
      translationsAfterRenameRef.current = null;
      toast.success({
        title: String(t("admin.pcNamesSavedToast")),
        message: data.category.name,
      });
      closeRenameEditor(variables.categoryId);
      invalidateCategoryLists();
    },
    onError: (error, variables) => {
      const afterRename =
        translationsAfterRenameRef.current === variables.categoryId;
      translationsAfterRenameRef.current = null;
      // After a rename the failure is half a save: the English name is in.
      const failedTitle = String(
        afterRename
          ? t("admin.pcEnglishSavedOtherNotToast", {
              language: String(t(LANGUAGE_NAME_KEYS.es)),
            })
          : t("admin.pcNamesSaveFailed"),
      );
      if (handleSecondFactorRequired(error)) return;
      const refusal: { error: TranslationError } | null =
        translationRefusal(error) ??
        (getAppErrorCode(error) === "INVALID_CATEGORY_REQUEST_NAME"
          ? { error: "invalid" }
          : null);
      if (refusal) {
        if (isTileModeOpen("rename", variables.categoryId)) {
          setRenameTranslationError(refusal.error);
          focusRenameSpanishInput(variables.categoryId);
          return;
        }
        toast.danger({
          title: failedTitle,
          message: translationErrorMessage(t, refusal.error),
        });
        return;
      }
      if (handleListChanged(error, ["CATEGORY_NOT_FOUND"])) {
        closeTileMode("rename", variables.categoryId);
        return;
      }
      toast.danger({
        title: failedTitle,
        message: formatErrorMessage(error, t),
      });
    },
    onSettled: () => {
      translationsInFlightRef.current = false;
    },
  });

  const renameMutation = trpc.categories.rename.useMutation({
    // Every failure is answered here: the enrolment prompt, inline under the
    // name, or one toast.
    meta: { silent: true },
    onSuccess: (data, variables) => {
      // The Spanish name changed too: save it now, while the editor stays
      // open for its answer. Its toast says both were saved.
      const follow = pendingTranslationRef.current;
      pendingTranslationRef.current = null;
      if (
        follow?.categoryId === variables.categoryId &&
        isTileModeOpen("rename", variables.categoryId)
      ) {
        translationsInFlightRef.current = true;
        translationsAfterRenameRef.current = follow.categoryId;
        translationsMutation.mutate({
          categoryId: follow.categoryId,
          translations: { es: follow.es },
        });
        invalidateCategoryLists();
        return;
      }
      toast.success({
        title: String(t("admin.pcRenamedToast")),
        message: data.category.name,
      });
      // `renameValue` and `renameError` belong to whichever editor is open,
      // so they are only touched when that editor is this reply's.
      if (isTileModeOpen("rename", variables.categoryId)) {
        setTileMode(null);
        setRenameError(null);
      }
      invalidateCategoryLists();
    },
    onError: (error, variables) => {
      pendingTranslationRef.current = null;
      if (handleSecondFactorRequired(error)) return;
      const nameError = nameErrorFromRefusal(error);
      if (nameError) {
        // Inline only while the editor that sent it is still open. If it has
        // closed, or another tile's editor is open in its place, the refusal
        // goes to a toast: under another tile's field it would be a lie, and
        // with no field at all it would be silence.
        if (isTileModeOpen("rename", variables.categoryId)) {
          setRenameError(nameError);
          focusRenameInput(variables.categoryId);
          return;
        }
        toast.danger({
          title: String(t("admin.pcRenameFailed")),
          message: String(t(categoryNameErrorKey(nameError))),
        });
        return;
      }
      if (handleListChanged(error, ["CATEGORY_NOT_FOUND"])) {
        closeTileMode("rename", variables.categoryId);
        return;
      }
      toast.danger({
        title: String(t("admin.pcRenameFailed")),
        message: formatErrorMessage(error, t),
      });
    },
    onSettled: () => {
      renameInFlightRef.current = false;
    },
  });

  const resetRenameTranslation = renameTranslation.reset;
  const openRename = useCallback(
    (categoryId: string, name: string, spanishName: string | undefined) => {
      setTileMode({ categoryId, kind: "rename" });
      setRenameValue(name);
      setRenameError(null);
      // A stored Spanish name is shown as it is; a missing one is suggested.
      resetRenameTranslation(spanishName ?? "");
      setRenameSuggestEnabled(!spanishName);
      setRenameTranslationError(null);
      setRenameReveal(null);
    },
    [resetRenameTranslation, setTileMode],
  );

  const handleRenameChange = useCallback((value: string) => {
    setRenameValue(value);
    // Clear on input (design system §6a): editing the field drops its error.
    setRenameError(null);
  }, []);

  const setRenameTranslationValue = renameTranslation.setValue;
  const handleRenameTranslationChange = useCallback(
    (value: string) => {
      setRenameTranslationValue(value);
      setRenameTranslationError(null);
    },
    [setRenameTranslationValue],
  );

  const renameSpanishValue = renameTranslation.value;
  const renameSpanishLeftOut = renameTranslation.leaveOutOnSubmit;
  const submitRename = useCallback(
    (
      categoryId: string,
      currentName: string,
      currentSpanishName: string | undefined,
    ) => {
      if (renameInFlightRef.current || translationsInFlightRef.current) return;
      const name = normalizeCategoryName(renameValue);
      if (name.length === 0) return;
      if (!isCategoryNameLengthValid(name)) {
        setRenameError("invalid");
        focusRenameInput(categoryId);
        return;
      }
      // A suggestion that is unseen, or answers an English name since
      // changed, is not sent.
      const spanish = renameSpanishLeftOut
        ? ""
        : normalizeCategoryName(renameSpanishValue);
      if (spanish.length > 0 && !isTranslatedNameAcceptable(spanish)) {
        setRenameTranslationError("invalid");
        focusRenameSpanishInput(categoryId);
        return;
      }
      const nextSpanish = spanish.length > 0 ? spanish : null;
      const spanishChanged = nextSpanish !== (currentSpanishName ?? null);
      // Nothing to write: close the editor without a round trip.
      if (name === currentName && !spanishChanged) {
        setTileMode(null);
        setRenameError(null);
        setRenameTranslationError(null);
        return;
      }
      setRenameError(null);
      setRenameTranslationError(null);
      if (name === currentName) {
        translationsInFlightRef.current = true;
        translationsMutation.mutate({
          categoryId,
          translations: { es: nextSpanish },
        });
        return;
      }
      pendingTranslationRef.current = spanishChanged
        ? { categoryId, es: nextSpanish }
        : null;
      renameInFlightRef.current = true;
      renameMutation.mutate({ categoryId, name });
    },
    [
      focusRenameInput,
      focusRenameSpanishInput,
      renameMutation,
      renameSpanishLeftOut,
      renameSpanishValue,
      renameValue,
      setTileMode,
      translationsMutation,
    ],
  );

  const setActiveMutation = trpc.categories.setActive.useMutation({
    meta: { silent: true },
    onSuccess: (data, variables) => {
      toast.success({
        title: String(
          t(
            data.category.active
              ? "admin.pcReactivatedToast"
              : "admin.pcDeactivatedToast",
          ),
        ),
        message: data.category.name,
      });
      closeTileMode("deactivate", variables.categoryId);
      invalidateCategoryLists();
    },
    onError: (error, variables) => {
      closeTileMode("deactivate", variables.categoryId);
      if (handleSecondFactorRequired(error)) return;
      if (handleListChanged(error, ["CATEGORY_NOT_FOUND"])) return;
      toast.danger({
        title: String(t("admin.pcSetActiveFailed")),
        message: formatErrorMessage(error, t),
      });
    },
  });

  const handleSetActive = useCallback(
    (categoryId: string, active: boolean) => {
      setActiveMutation.mutate({ categoryId, active });
    },
    [setActiveMutation],
  );

  const reorderMutation = trpc.categories.reorder.useMutation({
    meta: { silent: true },
    onSuccess: (data) => {
      // Show the new order now, from the reply; the refetch confirms it.
      // The reply has no slug rows (a reorder never changes them): keep the
      // ones already cached for each category.
      utils.categories.listAll.setData(undefined, (previous) => ({
        categories: data.categories.map((category) => ({
          ...category,
          urls: previous?.categories.find((c) => c.id === category.id)?.urls ?? [],
        })),
      }));
      const moved = pendingMoveRef.current;
      const position = moved
        ? data.categories.findIndex(
            (category) => category.id === moved.categoryId,
          )
        : -1;
      const movedCategory = data.categories[position];
      if (movedCategory) {
        setMoveAnnouncement(
          String(
            t("admin.pcMovedAnnouncement", {
              name: movedCategory.name,
              position: position + 1,
              total: data.categories.length,
            }),
          ),
        );
      }
      invalidateCategoryLists();
    },
    onError: (error) => {
      pendingMoveRef.current = null;
      if (handleSecondFactorRequired(error)) return;
      if (handleListChanged(error, ["INVALID_INPUT", "CATEGORY_NOT_FOUND"])) {
        return;
      }
      toast.danger({
        title: String(t("admin.pcMoveFailed")),
        message: formatErrorMessage(error, t),
      });
    },
  });

  const handleMove = useCallback(
    (categoryId: string, direction: CategoryMoveDirection) => {
      if (reorderMutation.isPending) return;
      // `reorder` takes every category id, inactive ones included, each once.
      const orderedCategoryIds = movedCategoryIds(
        categories.map((category) => category.id),
        categoryId,
        direction,
      );
      if (!orderedCategoryIds) return;
      pendingMoveRef.current = { categoryId, direction };
      setMoveAnnouncement("");
      reorderMutation.mutate({ orderedCategoryIds });
    },
    [categories, reorderMutation],
  );

  // After a move the tile's DOM node may have been re-inserted, which drops
  // focus. Put it back on the button that was pressed, unless the reader has
  // already moved on to another control. A tile that has reached the edge has
  // that button inert and out of the Tab order, so focus goes to the tile's
  // other move button instead.
  const categoryOrderKey = categories.map((category) => category.id).join(",");
  const reorderPending = reorderMutation.isPending;
  useEffect(() => {
    const moved = pendingMoveRef.current;
    if (!moved || reorderPending) return;
    pendingMoveRef.current = null;
    const ids = categoryTileIds(moved.categoryId);
    const pressed = document.getElementById(
      moved.direction === "up" ? ids.moveUp : ids.moveDown,
    );
    const sibling = document.getElementById(
      moved.direction === "up" ? ids.moveDown : ids.moveUp,
    );
    const atEdge = pressed?.getAttribute("aria-disabled") === "true";
    const target = atEdge ? sibling : pressed;
    const active = document.activeElement;
    if (!active || active === document.body || active === pressed) {
      target?.focus();
    }
  }, [categoryOrderKey, reorderPending]);

  // A deleted tile takes focus with it. Once the list has re-rendered without
  // it, focus goes to the first control of the tile now in its place (the
  // last tile when it was the last), or to the Add form when none is left.
  useEffect(() => {
    const removed = pendingDeleteFocusRef.current;
    if (!removed) return;
    const orderedIds = categoryOrderKey ? categoryOrderKey.split(",") : [];
    if (orderedIds.includes(removed.categoryId)) return;
    pendingDeleteFocusRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const nextId =
      orderedIds[Math.min(Math.max(removed.index, 0), orderedIds.length - 1)];
    const nextControl = nextId
      ? document
          .getElementById(categoryTileIds(nextId).tile)
          ?.querySelector<HTMLElement>(TILE_FIRST_CONTROL_SELECTOR)
      : null;
    (nextControl ?? document.getElementById(NEW_CATEGORY_NAME_ID))?.focus();
  }, [categoryOrderKey]);

  // While a rename, a deactivate / reactivate or a delete is out, no tile
  // opens another editor or confirm: the reply then always has its own tile
  // to land on.
  const tileMutationPending =
    renameMutation.isPending ||
    translationsMutation.isPending ||
    setActiveMutation.isPending ||
    deleteMutation.isPending;

  const statusOptions = useMemo(
    () =>
      STATUS_OPTIONS.map((status) => ({
        value: status,
        label: String(t(statusKey(status))),
      })),
    [t],
  );

  const handleReview = useCallback(
    (
      requestId: string,
      decision: ReviewDecision,
      approval?: CategoryRequestApprovalInput,
    ) => {
      setActiveReviewId(requestId);
      setApproveErrors({ en: null, es: null });
      reviewMutation.mutate({
        requestId,
        decision,
        reviewNote: reviewNotes[requestId]?.trim() || undefined,
        ...(approval
          ? { name: approval.name, translations: approval.translations }
          : {}),
      });
    },
    [reviewMutation, reviewNotes],
  );

  const openApproval = useCallback(
    // `englishName` is what the form opens with, so the row's slug is right
    // from the first frame.
    (requestId: string, englishName: string) => {
      setApprovingRequestId(requestId);
      setApprovalEnglishName(englishName);
      setApproveErrors({ en: null, es: null });
    },
    [setApprovingRequestId],
  );

  // Cancel unmounts the form that had focus: put it back on the row's
  // Approve, unless the reader has already moved on.
  const approveReturnFocusRef = useRef<string | null>(null);
  const cancelApproval = useCallback(
    (requestId: string) => {
      approveReturnFocusRef.current = requestId;
      setApprovingRequestId(null);
    },
    [setApprovingRequestId],
  );
  useEffect(() => {
    if (approvingRequestId !== null) return;
    const requestId = approveReturnFocusRef.current;
    approveReturnFocusRef.current = null;
    if (!requestId) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.getElementById(approveButtonId(requestId))?.focus();
  }, [approvingRequestId]);

  const clearApproveErrors = useCallback(() => {
    setApproveErrors((current) =>
      current.en === null && current.es === null
        ? current
        : { en: null, es: null },
    );
  }, []);

  return (
    <PlatformContainer size="lg">
      <YStack gap={8}>
        <XStack gap={10} alignItems="center" flexWrap="wrap">
          <Tag size={22} color={theme.color?.val} />
          <PlatformPageTitle>{String(t("admin.pcTitle"))}</PlatformPageTitle>
        </XStack>
        <PlatformSubtitle>{String(t("admin.pcSubtitle"))}</PlatformSubtitle>
        <HeaderRule />
      </YStack>

      <YStack gap={12}>
        <XStack
          justifyContent="space-between"
          gap={12}
          alignItems="flex-end"
          flexWrap="wrap"
        >
          <YStack gap={4} flex={1} minWidth={240}>
            <PlatformSectionTitle>
              {String(t("admin.pcOverviewTitle"))}
            </PlatformSectionTitle>
            <Text variant="body" tone="muted">
              {String(t("admin.pcOverviewSubtitleAll"))}
            </Text>
          </YStack>
          <Button
            variant="ghost"
            size="$4"
            onPress={() => {
              void categoriesQuery.refetch();
            }}
            aria-label={t("admin.pcRefresh") as string}
          >
            <RefreshCw size={15} />
            {String(t("admin.pcRefresh"))}
          </Button>
        </XStack>

        {canCreateCategories ? (
          <form
            onSubmit={handleCreateSubmit}
            noValidate
            aria-label={String(t("admin.pcAddFormLabel"))}
            data-testid="category-create-form"
          >
            <CreateFormBox>
              <CreateFormRow>
                <CreateField flexBasis={140}>
                  <label
                    htmlFor={NEW_CATEGORY_LANGUAGE_ID}
                    style={CREATE_LABEL_STYLE}
                  >
                    <Text variant="overline" tone="muted" tag="span">
                      {String(t("admin.pcLanguageLabel"))}
                    </Text>
                  </label>
                  <LanguageSelect
                    value={createLanguage.language}
                    onChange={createLanguage.setLanguage}
                    selectId={NEW_CATEGORY_LANGUAGE_ID}
                    testId="category-create-language"
                  />
                  <SuggestionNotice
                    unreviewed={createUnreviewed}
                    onReview={createLanguage.reveal}
                    testId="category-create-suggestion-notice"
                  />
                </CreateField>
                {shownCreateDraft === null ? (
                  <CreateField flexBasis={240}>
                    <label
                      htmlFor={NEW_CATEGORY_NAME_ID}
                      style={CREATE_LABEL_STYLE}
                    >
                      <Text variant="overline" tone="muted" tag="span">
                        {String(t("admin.pcNameEnLabel"))}
                      </Text>
                    </label>
                    <TextInput
                      id={NEW_CATEGORY_NAME_ID}
                      name="categoryName"
                      value={newName}
                      onChangeText={handleNewNameChange}
                      // Leaving the English name asks for the Spanish one now,
                      // not after the idle pause.
                      onBlur={newTranslation.flush}
                      // Enter adds the category: with the Spanish field the
                      // form has two inputs, so the browser no longer submits
                      // it on Enter by itself.
                      onSubmitEditing={submitCreate}
                      fullWidth
                      height={44}
                      minHeight={44}
                      maxLength={CATEGORY_NAME_MAX}
                      autoComplete="off"
                      required
                      // Read-only, not disabled, while the request is out: the
                      // reply is about the name that was sent, and the field
                      // keeps focus for the next one.
                      readOnly={createMutation.isPending}
                      // Enter submits the form; focus stays here for the next one.
                      blurOnSubmit={false}
                      status={createNameError ? "error" : undefined}
                      aria-invalid={createNameError ? true : undefined}
                      aria-describedby={
                        createNameError ? NEW_CATEGORY_NAME_ERROR_ID : undefined
                      }
                      testId="category-create-name"
                    />
                  </CreateField>
                ) : (
                  <CreateField flexBasis={240}>
                    <CategoryNameField
                      id={newCategoryNameId(createLanguage.language)}
                      locale={createLanguage.language}
                      value={shownCreateDraft.value}
                      onChange={shownCreateDraft.onChange}
                      onSubmitEditing={submitCreate}
                      isSuggested={shownCreateDraft.suggested}
                      onSuggestionSeen={shownCreateDraft.onSeen}
                      translateFrom={{ locale: "en", text: newName }}
                      // The message sits under the row (see the English one).
                      error={null}
                      invalid={shownCreateDraft.error !== null}
                      describedBy={
                        shownCreateDraft.error
                          ? shownCreateDraft.errorId
                          : undefined
                      }
                      readOnly={createMutation.isPending}
                      testId={`category-create-name-${createLanguage.language}`}
                    />
                  </CreateField>
                )}
                <CreateField flexBasis={200}>
                  <label
                    htmlFor={NEW_CATEGORY_SEO_TYPE_ID}
                    style={CREATE_LABEL_STYLE}
                  >
                    <Text variant="overline" tone="muted" tag="span">
                      {String(t("admin.pcAddSeoTypeLabel"))}
                    </Text>
                  </label>
                  <StyledSelect<EventSchemaType>
                    value={newSeoType}
                    options={SEO_TYPE_OPTIONS}
                    onChange={setNewSeoType}
                    selectId={NEW_CATEGORY_SEO_TYPE_ID}
                    {...SELECT_FRAME_PROPS}
                    testId="category-create-seo-type"
                  />
                </CreateField>
                <CreateSubmitSlot>
                  <Button
                    variant="secondary"
                    size="$4"
                    width="100%"
                    // One line is 44px, the inputs' height. On a
                    // phone the label wraps instead of being cut off, and
                    // the button grows to hold it.
                    height="auto"
                    minHeight={44}
                    paddingVertical={4}
                    // Longhand on purpose: the size variant sets
                    // paddingLeft/Right, which beat `paddingHorizontal` here.
                    $sm={{ paddingLeft: 8, paddingRight: 8 }}
                    // No `textAlign` here: in textProps it reaches the DOM
                    // unconverted and logs a React unknown-prop error.
                    textProps={{ whiteSpace: "normal", lineHeight: 16 }}
                    disabled={!canSubmitCreate}
                    onPress={submitCreate}
                    // Web-only: the press handler submits, so the rendered
                    // <button> must not also be the form's submit button.
                    {...({ type: "button" } as object)}
                    data-testid="category-create-submit"
                  >
                    {createMutation.isPending ? (
                      <Spinner size="small" />
                    ) : (
                      // The label wraps on a phone; the icon keeps its size.
                      <Plus size={15} style={{ flexShrink: 0 }} />
                    )}
                    {String(
                      t(
                        createMutation.isPending
                          ? "admin.pcAdding"
                          : "admin.pcAddSubmit",
                      ),
                    )}
                  </Button>
                </CreateSubmitSlot>
              </CreateFormRow>
              {/* Under the row, not inside the name column: the button sits
                  under the fields, and an error between them would push it
                  away from the field it belongs to. */}
              {/* Only the shown language's refusal: a refusal in a hidden
                  language brings that language forward first. */}
              {createNameError && createLanguage.language === "en" ? (
                <Text
                  id={NEW_CATEGORY_NAME_ERROR_ID}
                  role="alert"
                  variant="caption"
                  tone="error"
                >
                  {String(t(categoryNameErrorKey(createNameError)))}
                </Text>
              ) : null}
              {shownCreateDraft?.error ? (
                <Text
                  id={shownCreateDraft.errorId}
                  role="alert"
                  variant="caption"
                  tone="error"
                >
                  {translationErrorMessage(t, shownCreateDraft.error)}
                </Text>
              ) : null}
            </CreateFormBox>
          </form>
        ) : null}

        {taxonomyLoading ? (
          <StateFrame>
            <Spinner size="large" />
            <Text variant="body" tone="muted">
              {String(t("admin.pcLoadingTaxonomy"))}
            </Text>
          </StateFrame>
        ) : taxonomyError ? (
          <StateFrame>
            <AlertTriangle size={26} color={theme.danger?.val} />
            <Text variant="body" tone="error" textAlign="center">
              {String(
                t("admin.pcTaxonomyFailed", {
                  error: formatErrorMessage(taxonomyError, t),
                }),
              )}
            </Text>
            <Button
              variant="secondary"
              size="$4"
              onPress={() => {
                void categoriesQuery.refetch();
              }}
            >
              {String(t("admin.pcRetry"))}
            </Button>
          </StateFrame>
        ) : categories.length === 0 ? (
          <StateFrame>
            <Text variant="h4" weight="bold" textAlign="center">
              {String(t("admin.pcNoCategoriesYet"))}
            </Text>
          </StateFrame>
        ) : (
          // `listAll` returns them in display order (sortOrder, then name);
          // the order on screen is the order a move is computed from.
          <div style={TILE_GRID_STYLE} data-testid="category-tile-grid">
            {categories.map((category, index) => {
              const mode =
                tileMode?.categoryId === category.id ? tileMode.kind : null;
              const isDeleting =
                deleteMutation.isPending &&
                deleteMutation.variables?.categoryId === category.id;
              return (
                <CategoryTile
                  key={category.id}
                  category={category}
                  isFirst={index === 0}
                  isLast={index === categories.length - 1}
                  canManage={canManageCategories}
                  canDelete={canDeleteCategories}
                  canEditSeoType={canEditSeoType}
                  // The confirm steps aside while its delete is out.
                  mode={mode === "delete" && isDeleting ? null : mode}
                  modeElsewhere={
                    tileMode !== null && tileMode.categoryId !== category.id
                  }
                  openersBlocked={tileMutationPending}
                  renameValue={renameValue}
                  renameError={mode === "rename" ? renameError : null}
                  renamePending={
                    (renameMutation.isPending &&
                      renameMutation.variables?.categoryId === category.id) ||
                    (translationsMutation.isPending &&
                      translationsMutation.variables?.categoryId ===
                        category.id)
                  }
                  onRenameOpen={() =>
                    openRename(category.id, category.name, category.names?.es)
                  }
                  onRenameChange={handleRenameChange}
                  onRenameBlur={renameTranslation.flush}
                  onRenameSave={() =>
                    submitRename(
                      category.id,
                      category.name,
                      category.names?.es,
                    )
                  }
                  translationValue={
                    mode === "rename" ? renameTranslation.value : ""
                  }
                  translationSuggested={
                    mode === "rename" && renameTranslation.isSuggested
                  }
                  translationUnreviewed={
                    mode === "rename" && renameTranslation.unreviewed
                  }
                  onTranslationSeen={renameTranslation.markSeen}
                  translationError={
                    mode === "rename" ? renameTranslationError : null
                  }
                  onTranslationChange={handleRenameTranslationChange}
                  revealRequest={
                    renameReveal?.categoryId === category.id
                      ? renameReveal
                      : null
                  }
                  activePending={
                    setActiveMutation.isPending &&
                    setActiveMutation.variables?.categoryId === category.id
                  }
                  onDeactivateAsk={() =>
                    setTileMode({ categoryId: category.id, kind: "deactivate" })
                  }
                  onSetActive={(active) => handleSetActive(category.id, active)}
                  movePending={reorderMutation.isPending}
                  onMove={(direction) => handleMove(category.id, direction)}
                  deleting={isDeleting}
                  onDeleteAsk={() =>
                    setTileMode({ categoryId: category.id, kind: "delete" })
                  }
                  onDeleteConfirm={() => handleDeleteCategory(category.id)}
                  onModeCancel={() => setTileMode(null)}
                  seoTypePending={
                    seoTypeMutation.isPending &&
                    seoTypeMutation.variables?.categoryId === category.id
                  }
                  onSeoTypeChange={(seoType) =>
                    handleSeoTypeChange(category.id, seoType)
                  }
                />
              );
            })}
          </div>
        )}
        <div role="status" aria-live="polite" style={LIVE_REGION_STYLE}>
          {moveAnnouncement}
        </div>
      </YStack>

      <YStack gap={12}>
        <XStack
          justifyContent="space-between"
          gap={12}
          alignItems="flex-end"
          flexWrap="wrap"
        >
          <YStack gap={4} flex={1} minWidth={240}>
            <PlatformSectionTitle>
              {String(t("admin.pcQueueTitle"))}
            </PlatformSectionTitle>
            <Text variant="body" tone="muted">
              {String(t("admin.pcQueueSubtitle"))}
            </Text>
          </YStack>
          {requestsQuery.data ? (
            <Text variant="caption" tone="muted">
              {String(
                t("admin.pcRequestCount", { count: requestsQuery.data.total }),
              )}
            </Text>
          ) : null}
        </XStack>

        <PlatformFilterBar>
          <YStack gap={4} minWidth={180}>
            {/* A real <label for>: the filter was announced with no name. */}
            <label htmlFor={STATUS_FILTER_ID} style={CREATE_LABEL_STYLE}>
              <Text variant="overline" tone="muted" tag="span">
                {String(t("admin.pcStatusFilter"))}
              </Text>
            </label>
            <StyledSelect<RequestStatus>
              value={statusFilter}
              options={statusOptions}
              onChange={setStatusFilter}
              selectId={STATUS_FILTER_ID}
              {...SELECT_FRAME_PROPS}
            />
          </YStack>
          <Button
            variant="ghost"
            size="$4"
            onPress={() => {
              void requestsQuery.refetch();
            }}
            aria-label={t("admin.pcRefresh") as string}
          >
            <RefreshCw size={15} />
            {String(t("admin.pcRefresh"))}
          </Button>
        </PlatformFilterBar>

        {requestsQuery.isLoading ? (
          <StateFrame>
            <Spinner size="large" />
            <Text variant="body" tone="muted">
              {String(t("admin.pcLoadingRequests"))}
            </Text>
          </StateFrame>
        ) : requestsQuery.error ? (
          <StateFrame>
            <AlertTriangle size={26} color={theme.danger?.val} />
            <Text variant="body" tone="error" textAlign="center">
              {String(
                t("admin.pcFailedToLoad", {
                  error: formatErrorMessage(requestsQuery.error, t),
                }),
              )}
            </Text>
            <Button
              variant="secondary"
              size="$4"
              onPress={() => {
                void requestsQuery.refetch();
              }}
            >
              {String(t("admin.pcRetry"))}
            </Button>
          </StateFrame>
        ) : (requestsQuery.data?.requests ?? []).length === 0 ? (
          <StateFrame>
            <Text variant="h4" weight="bold" textAlign="center">
              {String(t("admin.pcNoRequestsTitle"))}
            </Text>
            <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
              {String(t("admin.pcNoRequestsDesc"))}
            </Text>
          </StateFrame>
        ) : (
          <YStack gap={10}>
            {(requestsQuery.data?.requests ?? []).map((request) => {
              const note = reviewNotes[request.id] ?? "";
              const isReviewing =
                reviewMutation.isPending && activeReviewId === request.id;
              const isApproving =
                approvingRequestId === request.id &&
                request.status === "PENDING" &&
                canReviewRequests;
              const requestLocale =
                request.locale && isCategoryNameLocale(request.locale)
                  ? request.locale
                  : "en";
              const askedInEnglish = requestLocale === "en";
              const shownSlug = requestRowSlug({
                request,
                requestLocale,
                categories,
                approvingEnglishName: isApproving ? approvalEnglishName : null,
              });
              return (
                <QueueRow key={request.id}>
                  <XStack
                    justifyContent="space-between"
                    alignItems="flex-start"
                    gap={12}
                    flexWrap="wrap"
                  >
                    {/* A 220 basis, not a 220 floor: alone on its line at
                        320 it shrinks to the card instead of spilling past
                        the border. */}
                    <YStack
                      gap={6}
                      flexGrow={1}
                      flexShrink={1}
                      flexBasis={220}
                      minWidth={0}
                    >
                      <XStack gap={8} alignItems="center" flexWrap="wrap">
                        <Badge tone={statusTone(request.status)} size="sm">
                          {String(t(statusKey(request.status)))}
                        </Badge>
                        <Badge
                          tone={
                            request.kind === "CATEGORY" ? "info" : "neutral"
                          }
                          size="sm"
                        >
                          {String(t(kindLabelKey(request.kind)))}
                        </Badge>
                      </XStack>
                      <Text variant="h5" weight="bold">
                        {request.name}
                      </Text>
                    </YStack>
                    {isApproving ? null : request.status === "PENDING" &&
                      canReviewRequests ? (
                      // Shrinkable, so at 320 the two buttons wrap instead of
                      // pushing Reject past the screen edge. Each button
                      // grows: beside the name the row is exactly as wide as
                      // the pair, so nothing changes; stacked, both fill the
                      // row and their edges line up.
                      <XStack
                        gap={8}
                        flexWrap="wrap"
                        justifyContent="flex-end"
                        flexShrink={1}
                        maxWidth="100%"
                      >
                        <Button
                          variant="primary"
                          size="$4"
                          flexGrow={1}
                          // Opens the names form; its own Approve sends.
                          onPress={() =>
                            openApproval(
                              request.id,
                              askedInEnglish ? request.name : "",
                            )
                          }
                          disabled={reviewMutation.isPending}
                          id={approveButtonId(request.id)}
                          data-testid={`category-approve-${request.id}`}
                        >
                          <Check size={16} />
                          {String(t("admin.pcApprove"))}
                        </Button>
                        <Button
                          variant="destructive"
                          size="$4"
                          flexGrow={1}
                          onPress={() => handleReview(request.id, "REJECT")}
                          disabled={reviewMutation.isPending}
                        >
                          <X size={16} />
                          {String(t("admin.pcReject"))}
                        </Button>
                      </XStack>
                    ) : request.status === "PENDING" ? (
                      <Text variant="caption" tone="muted" textAlign="right">
                        {String(t("admin.pcReadOnlyPending"))}
                      </Text>
                    ) : null}
                  </XStack>

                  <XStack gap={10} flexWrap="wrap">
                    <MetaCell>
                      <Text variant="overline" tone="muted">
                        {String(t("admin.pcSlug"))}
                      </Text>
                      {shownSlug ? (
                        <Text
                          variant="code"
                          truncate
                          data-testid={`category-request-slug-${request.id}`}
                        >
                          {shownSlug}
                        </Text>
                      ) : (
                        <Text
                          variant="bodySmall"
                          tone="muted"
                          data-testid={`category-request-slug-${request.id}`}
                        >
                          {String(t("admin.pcSlugFromEnglishName"))}
                        </Text>
                      )}
                    </MetaCell>
                    <MetaCell>
                      <Text variant="overline" tone="muted">
                        {String(t("admin.pcScopedCategory"))}
                      </Text>
                      <Text
                        variant="bodySmall"
                        tone={request.categoryName ? "default" : "muted"}
                      >
                        {request.categoryName ?? String(t("admin.pcUnscoped"))}
                      </Text>
                    </MetaCell>
                    <MetaCell>
                      <Text variant="overline" tone="muted">
                        {String(t("admin.pcRequestLanguage"))}
                      </Text>
                      <Text
                        variant="bodySmall"
                        data-testid={`category-request-language-${request.id}`}
                      >
                        {String(t(REQUEST_LANGUAGE_KEYS[requestLocale]))}
                      </Text>
                    </MetaCell>
                    <MetaCell>
                      <Text variant="overline" tone="muted">
                        {String(t("admin.pcCreated"))}
                      </Text>
                      <Text variant="bodySmall">
                        {formatDateShort(request.createdAt)}
                      </Text>
                    </MetaCell>
                    <MetaCell>
                      <Text variant="overline" tone="muted">
                        {String(t("admin.pcReviewNote"))}
                      </Text>
                      <Text
                        variant="bodySmall"
                        tone={request.reviewNote ? "default" : "muted"}
                      >
                        {request.reviewNote ??
                          String(t("admin.pcNoReviewNote"))}
                      </Text>
                    </MetaCell>
                  </XStack>

                  {request.status === "PENDING" && canReviewRequests ? (
                    <TextInput
                      value={note}
                      onChangeText={(value) =>
                        setReviewNotes((current) => ({
                          ...current,
                          [request.id]: value,
                        }))
                      }
                      placeholder={t("admin.pcNotePlaceholder") as string}
                      fullWidth
                      minHeight={44}
                      disabled={isReviewing}
                      maxLength={1000}
                      testId={`category-request-note-${request.id}`}
                    />
                  ) : null}

                  {isApproving ? (
                    <CategoryRequestApproval
                      request={{
                        id: request.id,
                        name: request.name,
                        locale: request.locale ?? null,
                      }}
                      pending={isReviewing}
                      englishError={approveErrors.en}
                      spanishError={approveErrors.es}
                      onEdit={clearApproveErrors}
                      onSubmit={(approval) =>
                        handleReview(request.id, "APPROVE", approval)
                      }
                      onCancel={() => cancelApproval(request.id)}
                      onEnglishNameChange={setApprovalEnglishName}
                    />
                  ) : null}
                </QueueRow>
              );
            })}
          </YStack>
        )}
      </YStack>
    </PlatformContainer>
  );
}
