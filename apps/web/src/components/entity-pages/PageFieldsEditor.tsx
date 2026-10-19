"use client";

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { YStack, XStack } from "tamagui";
import {
  Text,
  CardSurface,
  Button,
  AmountInput,
  LabeledTextInput,
  StyledSelect,
  useNotify,
  useTranslations,
  Spinner,
} from "@th/ui";
import { Check, Upload, Trash2, Maximize2 } from "lucide-react";

import { trpc } from "@/trpc";
import { ImageLightbox } from "@/components/media/ImageLightbox";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  NativeFileInput,
  PAGE_IMAGE_UPLOAD_ACCEPT,
  usePageImageUpload,
} from "./use-page-image-upload";
import { ImageCropDialog } from "./ImageCropDialog";
import { shouldSkipCrop } from "./image-crop";
import { useRegisterPageSettingsSave } from "./page-settings-save";

/**
 * Server-side cap on `bio` — `plainTextMultilineOptional(2000)` in
 * `packages/core/src/use-cases/entity-pages/update-page.ts`. Mirrored here so
 * the counter reflects a REAL limit rather than an invented one; if the schema
 * moves, this must move with it.
 */
const BIO_MAX_LENGTH = 2000;
/** Point at which the counter stops being decorative and turns into a warning. */
const BIO_WARN_AT = 1800;

/** Crop aspect per image slot — matches each preview's own frame. */
const AVATAR_ASPECT = 1;
const BANNER_ASPECT = 3;

/**
 * Left inset (px) the slug input reserves for its "/p/" stem. `AmountInput`'s
 * default (32px) is sized for a single glyph like "$"; three characters of
 * Montserrat at the input's 14px need more, or the typed slug starts
 * underneath the prefix.
 */
const SLUG_PREFIX_CLEARANCE = 46;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";
type PageVisibility = "PUBLIC" | "PRIVATE" | "UNLISTED";

interface PageData {
  id: string;
  slug: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  visibility: PageVisibility;
}

export interface PageFieldsEditorProps {
  page: PageData;
  ownerType: PageOwnerType;
  ownerId: string;
  onSaved?: () => void;
  /**
   * Drop the `CardSurface` so the form sits inside a host section that
   * already draws the frame (strict Swiss: no card inside a card). The venue
   * settings page's "Public page" section is the one caller; the page
   * editor's own settings drawer keeps the default.
   */
  embedded?: boolean;
  /**
   * PLACE only: the sentence under "Place name", replacing the owner's
   * "Edit it under Identity, above." The moderator editor says where a
   * moderator changes the name instead. An empty string shows no sentence
   * (the moderator editor while its editability check is still loading).
   */
  placeNameHint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Image control
// ─────────────────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: string }) {
  return (
    <Text variant="overline" color="$colorMuted">
      {children}
    </Text>
  );
}

/**
 * Group heading for one block of related fields. Ink-coloured (field labels
 * are muted) with a rule running to the edge, so a subheading never reads as
 * just another field label. Mirrors `SettingsSectionLabel` in
 * `PageEditorView`, which already labels the Profile/Theme subsections that
 * wrap this card.
 */
function FieldGroup({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <YStack gap="$3">
      <XStack alignItems="center" gap="$3">
        <Text variant="overline">{title}</Text>
        <YStack
          flex={1}
          minWidth={12}
          height={2}
          backgroundColor="$borderColorSoft"
        />
        {badge}
      </XStack>
      <YStack gap="$4">{children}</YStack>
    </YStack>
  );
}

function PageImageControl({
  label,
  emptyLabel,
  url,
  width,
  height,
  aspectRatio,
  inputId,
  isUploading,
  isSaving,
  uploadLabel,
  uploadingLabel,
  removeLabel,
  viewFullLabel,
  savingLabel,
  savedLabel,
  onPick,
  onRemove,
}: {
  label: string;
  emptyLabel: string;
  url: string | null;
  width: number | string;
  height?: number;
  aspectRatio?: number;
  inputId: string;
  isUploading: boolean;
  /** A persist for THIS slot is in flight (upload or remove). */
  isSaving: boolean;
  uploadLabel: string;
  uploadingLabel: string;
  removeLabel: string;
  viewFullLabel: string;
  savingLabel: string;
  savedLabel: string;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
}) {
  const hasImage = Boolean(url);
  const [viewing, setViewing] = useState(false);
  return (
    <YStack gap="$2">
      <FieldLabel>{label}</FieldLabel>
      {/* The preview is `cover`-cropped for a tidy frame; click it (or "View
          full" below) to see the whole uploaded image uncropped, so owners
          aren't blindly cropping. */}
      <YStack
        {...(hasImage
          ? ({
              tag: "button",
              type: "button",
              onPress: () => setViewing(true),
              "aria-label": viewFullLabel,
              cursor: "pointer",
              hoverStyle: { borderColor: "$color" },
            } as Record<string, unknown>)
          : {})}
        width={width}
        height={height}
        aspectRatio={aspectRatio}
        borderWidth={1}
        borderColor="$borderColor"
        borderRadius={0}
        backgroundColor="$surfaceMuted"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
        style={
          url
            ? {
                backgroundImage: `url("${url}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      >
        {!hasImage && (
          <Text variant="overline" color="$colorMuted">
            {emptyLabel}
          </Text>
        )}
      </YStack>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <NativeFileInput
          id={inputId}
          type="file"
          accept={PAGE_IMAGE_UPLOAD_ACCEPT}
          disabled={isUploading}
          onChange={onPick}
        />
        <Button
          tag="label"
          variant="outlined"
          size="$2"
          disabled={isUploading}
          {...({ htmlFor: inputId } as Record<string, unknown>)}
        >
          {isUploading ? (
            <Spinner width={14} height={14} borderWidth={2} />
          ) : (
            <Upload size={14} />
          )}
          {isUploading ? uploadingLabel : uploadLabel}
        </Button>
        {hasImage && (
          <Button
            variant="ghost"
            size="$2"
            onPress={() => setViewing(true)}
            aria-label={viewFullLabel}
          >
            <Maximize2 size={14} />
            {viewFullLabel}
          </Button>
        )}
        {hasImage && (
          <Button
            variant="ghost"
            size="$2"
            disabled={isUploading}
            onPress={onRemove}
            aria-label={removeLabel}
          >
            <Trash2 size={14} />
            {removeLabel}
          </Button>
        )}
      </XStack>
      {/* Per-slot save state (FR-004). This card mixes two save models —
          images persist the moment they change, everything else waits for the
          Save button — and nothing used to say so. Fixed height so the row
          never reflows as the state cycles. */}
      {/* gap is a NUMBER, not "$1.5": Tamagui's fractional space tokens
          resolve to a 0 gap, which jams the tick against the label. */}
      <XStack alignItems="center" gap={6} minHeight={18}>
        {isSaving ? (
          <>
            <Spinner width={12} height={12} borderWidth={2} />
            <Text variant="caption" color="$colorMuted">
              {savingLabel}
            </Text>
          </>
        ) : hasImage ? (
          <>
            <Check size={12} color="var(--success, #166534)" aria-hidden />
            <Text variant="caption" color="$colorMuted">
              {savedLabel}
            </Text>
          </>
        ) : null}
      </XStack>
      {viewing && url && (
        <ImageLightbox
          images={[{ url, alt: label }]}
          onClose={() => setViewing(false)}
        />
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PageFieldsEditor({
  page,
  ownerType,
  ownerId,
  onSaved,
  embedded = false,
  placeNameHint,
}: PageFieldsEditorProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const visibilityOptions: { value: PageVisibility; label: string }[] = useMemo(
    () => [
      { value: "PUBLIC", label: String(t("admin.peVisibilityPublic")) },
      { value: "UNLISTED", label: String(t("admin.peVisibilityUnlisted")) },
      { value: "PRIVATE", label: String(t("admin.peVisibilityPrivate")) },
    ],
    [t],
  );

  // A venue has ONE name, and it is `Place.name` on the venue details form.
  // For a PLACE page `displayName` therefore stops being an editable field —
  // it is not rendered, not compared for dirtiness, and never enters the save
  // payload. The column stays in the database untouched, which is what keeps
  // this ruling reversible; a PLACE save that sent `displayName: ""` would
  // normalise to null and blank the very column we are preserving.
  // HUMAN and ORGANIZATION pages are unaffected.
  const editsDisplayName = ownerType !== "PLACE";

  // ── Form state ──────────────────────────────────────────────
  const [slug, setSlug] = useState(page.slug);
  const [displayName, setDisplayName] = useState(
    editsDisplayName ? (page.displayName ?? "") : "",
  );
  const [bio, setBio] = useState(page.bio ?? "");
  const [visibility, setVisibility] = useState<PageVisibility>(page.visibility);
  const [bannerUrl, setBannerUrl] = useState<string | null>(page.bannerUrl);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(page.avatarUrl);

  // Reseed the text fields when their server values change (e.g. after a text
  // save + refetch). Kept SEPARATE from the image effect below so an image
  // auto-save — which invalidates getMyPage and refetches `page` — does not
  // refire this and clobber unsaved slug/displayName/bio/visibility edits.
  useEffect(() => {
    setSlug(page.slug);
    // A PLACE never holds the stored value in state, so a reseed cannot
    // resurrect it into a comparison or a payload.
    setDisplayName(editsDisplayName ? (page.displayName ?? "") : "");
    setBio(page.bio ?? "");
    setVisibility(page.visibility);
  }, [
    page.slug,
    page.displayName,
    page.bio,
    page.visibility,
    editsDisplayName,
  ]);

  // Reseed the image fields independently. On an image auto-save this re-sets
  // the value we just persisted (a harmless no-op) and never touches text state.
  useEffect(() => {
    setBannerUrl(page.bannerUrl);
    setAvatarUrl(page.avatarUrl);
  }, [page.bannerUrl, page.avatarUrl]);

  // ── Image upload ────────────────────────────────────────────
  // Separate hook instances so each control has its own busy state — uploading
  // the banner must not spin/disable the avatar control (and vice-versa).
  const banner = usePageImageUpload({ ownerType, ownerId });
  const avatar = usePageImageUpload({ ownerType, ownerId });

  // Track each control's persist independently — a single slot would let a
  // later avatar save clear the banner's busy flag while its mutation is still
  // in flight, re-enabling the banner buttons and allowing a racing second
  // banner mutation (and prematurely clearing the other control's spinner).
  const [bannerSaving, setBannerSaving] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);

  // Images auto-save the moment they change (upload or remove), independently of
  // the "Save changes" button that persists the text fields. A dedicated
  // mutation keeps its own pending state and only ever sends the one image key.
  const persistImage = trpc.entityPages.updatePage.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
      toast.success({
        id: "page-image-saved",
        title: String(t("admin.peImageSaved")),
      });
    },
    onError: (err, variables) => {
      // Revert the optimistic local value back to server truth for whichever
      // image field this mutation carried.
      const vars = variables as { bannerUrl?: unknown; avatarUrl?: unknown };
      if ("bannerUrl" in vars) setBannerUrl(page.bannerUrl);
      if ("avatarUrl" in vars) setAvatarUrl(page.avatarUrl);
      toast.danger({
        id: "page-image-save-failed",
        title: String(t("admin.peUpdateFailed")),
        message: formatErrorMessage(err, t),
      });
    },
    onSettled: (_data, _error, variables) => {
      // Clear only the flag for the field THIS mutation carried, so one control
      // settling never clears the other's in-flight spinner.
      const vars = variables as { bannerUrl?: unknown; avatarUrl?: unknown };
      if ("bannerUrl" in vars) setBannerSaving(false);
      if ("avatarUrl" in vars) setAvatarSaving(false);
    },
  });

  const persistImageField = useCallback(
    (control: "banner" | "avatar", value: string | null) => {
      if (control === "banner") setBannerSaving(true);
      else setAvatarSaving(true);
      persistImage.mutate({
        ownerType,
        ownerId,
        ...(control === "banner" ? { bannerUrl: value } : { avatarUrl: value }),
      } as Parameters<typeof persistImage.mutate>[0]);
    },
    [ownerType, ownerId, persistImage],
  );

  const bannerBusy = banner.isUploading || bannerSaving;
  const avatarBusy = avatar.isUploading || avatarSaving;

  // ── Crop step ───────────────────────────────────────────────
  // A picked file goes to the crop dialog first; the CROPPED file is what
  // enters `usePageImageUpload`, so HEIC prep, the content-type allow-list and
  // the 25MB cap all still run against the bytes that actually get uploaded.
  const [cropRequest, setCropRequest] = useState<{
    control: "banner" | "avatar";
    file: File;
  } | null>(null);

  const uploadBanner = useCallback(
    async (file: File) => {
      const url = await banner.upload(file);
      if (!url) return;
      setBannerUrl(url); // optimistic preview
      persistImageField("banner", url);
    },
    [banner, persistImageField],
  );

  const uploadAvatar = useCallback(
    async (file: File) => {
      const url = await avatar.upload(file);
      if (!url) return;
      setAvatarUrl(url); // optimistic preview
      persistImageField("avatar", url);
    },
    [avatar, persistImageField],
  );

  const handleBannerFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file || bannerBusy) return;
      // Animated GIFs can't survive a canvas round-trip — upload as picked.
      if (shouldSkipCrop(file)) {
        void uploadBanner(file);
        return;
      }
      setCropRequest({ control: "banner", file });
    },
    [bannerBusy, uploadBanner],
  );

  const handleBannerRemove = useCallback(() => {
    if (bannerBusy) return;
    setBannerUrl(null); // optimistic
    persistImageField("banner", null);
  }, [bannerBusy, persistImageField]);

  const handleAvatarFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file || avatarBusy) return;
      if (shouldSkipCrop(file)) {
        void uploadAvatar(file);
        return;
      }
      setCropRequest({ control: "avatar", file });
    },
    [avatarBusy, uploadAvatar],
  );

  const handleAvatarRemove = useCallback(() => {
    if (avatarBusy) return;
    setAvatarUrl(null); // optimistic
    persistImageField("avatar", null);
  }, [avatarBusy, persistImageField]);

  const handleCropped = useCallback(
    (cropped: File) => {
      const control = cropRequest?.control;
      setCropRequest(null);
      if (control === "banner") void uploadBanner(cropped);
      else if (control === "avatar") void uploadAvatar(cropped);
    },
    [cropRequest, uploadBanner, uploadAvatar],
  );

  const handleCropError = useCallback(
    (err: unknown) => {
      toast.danger({
        id: "page-image-crop-failed",
        title: String(t("common.cropFailed")),
        message: formatErrorMessage(err, t),
      });
    },
    [t, toast],
  );

  // ── Dirty tracking ──────────────────────────────────────────
  // Images are NOT part of this — they auto-save on change. Only the text
  // fields ride the "Save changes" button.
  const isDirty = useMemo(() => {
    return (
      slug !== page.slug ||
      (editsDisplayName && displayName !== (page.displayName ?? "")) ||
      bio !== (page.bio ?? "") ||
      visibility !== page.visibility
    );
  }, [slug, displayName, bio, visibility, page, editsDisplayName]);

  // ── Slug availability check ─────────────────────────────────
  const slugChanged = slug !== page.slug && slug.trim().length > 0;
  const slugCheckQuery = trpc.entityPages.isSlugAvailable.useQuery(
    { slug: slug.trim(), excludePageId: page.id },
    { enabled: slugChanged, staleTime: 5_000 },
  );

  // ── Mutation ────────────────────────────────────────────────
  const updateMutation = trpc.entityPages.updatePage.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyPage.invalidate({ ownerType, ownerId });
      toast.success({
        id: "page-updated",
        title: String(t("admin.peUpdated")),
        message: String(t("admin.peUpdatedMessage")),
      });
      onSaved?.();
    },
    onError: (err) => {
      toast.danger({
        id: "page-update-failed",
        title: String(t("admin.peUpdateFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  // ASYNC so a host awaiting `saveAll` (the venue settings page's one Save,
  // under its in-flight latch) is held until the request SETTLES — with
  // `mutate` it resolved at once and re-opened the double-press window.
  // Error reporting is unchanged: `onError` above still toasts, and the
  // rejection is swallowed here so no caller sees a new throw.
  const handleSave = useCallback(async () => {
    const updates: Record<string, unknown> = { ownerType, ownerId };
    if (slug !== page.slug) updates.slug = slug.trim();
    // Deliberately absent for a PLACE: no `displayName` key at all, not even
    // an unchanged one. Sending "" here would null the stored column.
    if (editsDisplayName && displayName !== (page.displayName ?? "")) {
      updates.displayName = displayName.trim() || null;
    }
    if (bio !== (page.bio ?? "")) {
      updates.bio = bio.trim() || null;
    }
    if (visibility !== page.visibility) updates.visibility = visibility;

    try {
      await updateMutation.mutateAsync(
        updates as Parameters<typeof updateMutation.mutateAsync>[0],
      );
    } catch {
      // Reported by the mutation's own `onError` toast.
    }
  }, [
    ownerType,
    ownerId,
    slug,
    displayName,
    bio,
    visibility,
    page,
    updateMutation,
    editsDisplayName,
  ]);

  // ── Toolbar Save registration ───────────────────────────────
  // The Save for this form lives in the editor toolbar, not in here: the
  // settings panel is collapsed by default, and a save button you must first
  // go looking for is a save button people do not press. `slugStatus` is the
  // one thing that can make a dirty form unsavable, so it rides along as
  // `blocked` rather than being duplicated in the toolbar.
  // ── Slug status indicator ───────────────────────────────────
  const slugStatus = useMemo(() => {
    if (!slugChanged) return null;
    if (slugCheckQuery.isLoading) return "checking";
    if (slugCheckQuery.data?.available) return "available";
    return "taken";
  }, [slugChanged, slugCheckQuery.isLoading, slugCheckQuery.data]);

  useRegisterPageSettingsSave({
    id: "profile",
    isDirty,
    isPending: updateMutation.isPending,
    blocked: slugStatus === "taken",
    save: handleSave,
  });

  // One line of discoverability copy for whichever visibility is selected
  // (FR-006), following `peStandardTemplateHint`'s contextual-hint pattern.
  const visibilityHint = {
    PUBLIC: "admin.peVisibilityPublicHint",
    UNLISTED: "admin.peVisibilityUnlistedHint",
    PRIVATE: "admin.peVisibilityPrivateHint",
  }[visibility];

  const bioOverWarn = bio.length >= BIO_WARN_AT;

  // The frame is the host's when embedded; the content and its rhythm are not.
  const Frame = embedded ? YStack : CardSurface;

  return (
    <Frame>
      <YStack gap="$5" padding={embedded ? 0 : "$4"}>
        {/* Embedded, the host section's heading outranks this one, so it
            steps down to body weight rather than out-shouting it. */}
        <Text variant={embedded ? "body" : "h4"} weight="bold">
          {String(t("admin.peFieldsTitle"))}
        </Text>

        {/* ── Identity ───────────────────────────────────────── */}
        <FieldGroup title={String(t("admin.peGroupIdentity"))}>
          {editsDisplayName ? (
            <LabeledTextInput
              id="entity-page-display-name"
              name="entity-page-display-name"
              label={String(t("admin.peDisplayNameLabel"))}
              placeholder={String(t("admin.peDisplayNamePlaceholder"))}
              value={displayName}
              onChangeText={setDisplayName}
              maxLength={200}
            />
          ) : (
            /* The name field held the top of this group, so its absence is the
               first thing a place owner notices. A labelled read-only line
               keeps the slot and answers "where did the name field go?" in
               place, rather than leaving the group opening on the slug. */
            <YStack gap="$2">
              <FieldLabel>{String(t("admin.peVenueNameLabel"))}</FieldLabel>
              {placeNameHint === "" ? null : (
                <Text variant="caption" color="$colorMuted">
                  {placeNameHint ?? String(t("admin.peVenueNameFromDetails"))}
                </Text>
              )}
            </YStack>
          )}

          {/* Slug: the `/p/` stem is an INSET inside the input's own border
              and the availability check is the input's own status icon, so
              prefix + field + indicator read as one control instead of three
              things in a row. The error sits directly under it (FR-005). */}
          <YStack gap="$2">
            <label htmlFor="entity-page-slug" style={{ display: "contents" }}>
              <Text
                variant="caption"
                weight="bold"
                color="$colorMuted"
                letterSpacing={1.2}
                style={{ fontSize: 11 }}
              >
                {String(t("admin.peSlugLabel"))}
              </Text>
            </label>
            <AmountInput
              id="entity-page-slug"
              name="entity-page-slug"
              prefix="/p/"
              prefixClearance={SLUG_PREFIX_CLEARANCE}
              fullWidth
              autoComplete="off"
              placeholder={String(t("admin.peSlugPlaceholder"))}
              value={slug}
              onChangeText={setSlug}
              status={
                slugStatus === "taken"
                  ? "error"
                  : slugStatus === "available"
                    ? "success"
                    : undefined
              }
              aria-describedby="entity-page-slug-status"
              testId="entity-page-slug"
            />
            {/* Reserved height: the status line must not shove the rest of
                the form down as the availability check resolves. */}
            <XStack
              alignItems="center"
              gap={6}
              minHeight={18}
              {...({ id: "entity-page-slug-status", role: "status" } as Record<
                string,
                unknown
              >)}
            >
              {slugStatus === "checking" && (
                <>
                  <Spinner width={12} height={12} borderWidth={2} />
                  <Text variant="caption" color="$colorMuted">
                    {String(t("admin.peSlugChecking"))}
                  </Text>
                </>
              )}
              {slugStatus === "available" && (
                <Text variant="caption" color="$success">
                  {String(t("admin.peSlugAvailable"))}
                </Text>
              )}
              {slugStatus === "taken" && (
                <Text variant="caption" color="$danger">
                  {String(t("admin.peSlugTaken"))}
                </Text>
              )}
            </XStack>
          </YStack>
        </FieldGroup>

        {/* ── Images (auto-saving) ───────────────────────────── */}
        <FieldGroup
          title={String(t("admin.peGroupImages"))}
          badge={
            <Text variant="overline" color="$colorMuted">
              {String(t("admin.peImagesAutoSaveBadge"))}
            </Text>
          }
        >
          <PageImageControl
            label={String(t("admin.peAvatarLabel"))}
            emptyLabel={String(t("admin.peAvatarEmpty"))}
            url={avatarUrl}
            width={96}
            height={96}
            inputId="entity-page-avatar-upload"
            isUploading={avatarBusy}
            isSaving={avatarBusy}
            uploadLabel={String(t("admin.peImageUpload"))}
            uploadingLabel={String(t("admin.peImageUploading"))}
            removeLabel={String(t("admin.peImageRemove"))}
            viewFullLabel={String(t("common.viewFullImage"))}
            savingLabel={String(t("admin.peImageSavingStatus"))}
            savedLabel={String(t("admin.peImageSavedStatus"))}
            onPick={handleAvatarFile}
            onRemove={handleAvatarRemove}
          />

          <PageImageControl
            label={String(t("admin.peBannerLabel"))}
            emptyLabel={String(t("admin.peBannerEmpty"))}
            url={bannerUrl}
            width="100%"
            aspectRatio={BANNER_ASPECT}
            inputId="entity-page-banner-upload"
            isUploading={bannerBusy}
            isSaving={bannerBusy}
            uploadLabel={String(t("admin.peImageUpload"))}
            uploadingLabel={String(t("admin.peImageUploading"))}
            removeLabel={String(t("admin.peImageRemove"))}
            viewFullLabel={String(t("common.viewFullImage"))}
            savingLabel={String(t("admin.peImageSavingStatus"))}
            savedLabel={String(t("admin.peImageSavedStatus"))}
            onPick={handleBannerFile}
            onRemove={handleBannerRemove}
          />
        </FieldGroup>

        {/* ── Bio ────────────────────────────────────────────── */}
        <FieldGroup title={String(t("admin.peGroupBio"))}>
          <YStack gap="$1">
            <LabeledTextInput
              id="entity-page-bio"
              name="entity-page-bio"
              label={String(t("admin.peBioLabel"))}
              placeholder={String(t("admin.peBioPlaceholder"))}
              value={bio}
              onChangeText={setBio}
              multiline
              numberOfLines={4}
              maxLength={BIO_MAX_LENGTH}
              // `numberOfLines` alone leaves the 4th line clipped mid-glyph:
              // RNW sizes the textarea from `rows` but the global input reset
              // adds 10px of vertical padding it doesn't account for. Pin a
              // height that actually fits four lines plus that padding.
              minHeight={104}
            />
            <XStack justifyContent="flex-end">
              <Text
                variant="caption"
                color={bioOverWarn ? "$warning" : "$colorMuted"}
                data-testid="entity-page-bio-counter"
              >
                {`${bio.length} / ${BIO_MAX_LENGTH}`}
              </Text>
            </XStack>
          </YStack>
        </FieldGroup>

        {/* ── Visibility ─────────────────────────────────────── */}
        <FieldGroup title={String(t("admin.peGroupVisibility"))}>
          <YStack gap="$2">
            <label
              htmlFor="entity-page-visibility"
              style={{ display: "contents" }}
            >
              <Text
                variant="caption"
                weight="bold"
                color="$colorMuted"
                letterSpacing={1.2}
                style={{ fontSize: 11 }}
              >
                {String(t("admin.peVisibilityLabel"))}
              </Text>
            </label>
            <StyledSelect
              value={visibility}
              options={visibilityOptions}
              onChange={setVisibility}
              size="md"
              fullWidth
              selectId="entity-page-visibility"
              ariaDescribedBy="entity-page-visibility-hint"
              testId="entity-page-visibility"
            />
            <Text
              variant="caption"
              color="$colorMuted"
              {...({ id: "entity-page-visibility-hint" } as Record<
                string,
                unknown
              >)}
            >
              {String(t(visibilityHint))}
            </Text>
          </YStack>
        </FieldGroup>

        {/* Save hint — names exactly which fields the toolbar's Save covers,
            since the images above have already persisted themselves (FR-004).
            The button itself moved to the editor toolbar on 2026-08-30; this
            line stayed, because "which fields does Save cover" is a question
            about THIS card. */}
        <XStack
          alignItems="center"
          gap="$3"
          flexWrap="wrap"
          paddingTop="$2"
          borderTopWidth={2}
          borderTopColor="$borderColorSoft"
        >
          {/* minWidth 0 so the hint wraps instead of setting the card's
              min-content width — it pushed the 320px layout out by ~10px. */}
          <Text variant="caption" color="$colorMuted" flex={1} minWidth={0}>
            {String(
              t(
                editsDisplayName
                  ? "admin.peManualSaveHint"
                  : "admin.peManualSaveHintNoName",
              ),
            )}
          </Text>
        </XStack>
      </YStack>

      <ImageCropDialog
        file={cropRequest?.file ?? null}
        aspect={
          cropRequest?.control === "banner" ? BANNER_ASPECT : AVATAR_ASPECT
        }
        title={String(
          t(
            cropRequest?.control === "banner"
              ? "admin.peBannerLabel"
              : "admin.peAvatarLabel",
          ),
        )}
        maxOutputWidth={cropRequest?.control === "banner" ? 2400 : 1024}
        onCancel={() => setCropRequest(null)}
        onCropped={handleCropped}
        onPrepareError={handleCropError}
      />
    </Frame>
  );
}
