"use client";

import { useState, useCallback, useRef } from "react";
import { YStack, XStack } from "tamagui";
import { User, Camera, ExternalLink } from "lucide-react";
import {
  Text,
  Button,
  LabeledTextInput,
  NextLinkAnchor,
  Spinner,
  Switch,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { authClient } from "@/lib/auth/auth-client";
import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";
import { useAvatarUpload } from "../_hooks/useAvatarUpload";
import { ImageCropDialog } from "@/components/entity-pages/ImageCropDialog";
import { SectionCard } from "./settings-primitives";

/**
 * Identity only: avatar, display name, public-page visibility. The "what I do"
 * fields (jobs, genres, role description) live in `RolesCraftSection`.
 */
export function ProfileSection({
  user,
}: {
  user: { name?: string | null; email?: string | null; image?: string | null };
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();
  const utils = trpc.useUtils();
  const sessionQuery = authClient.useSession();
  const isAuthenticated = Boolean(sessionQuery.data?.user);
  const [name, setName] = useState(user.name ?? "");
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pageProfileQuery = trpc.entityPages.getMyProfile.useQuery(
    {},
    { retry: false, staleTime: 60_000, enabled: isAuthenticated },
  );
  const avatarUrl = pageProfileQuery.data?.avatarUrl ?? user.image ?? null;
  const mySlug = pageProfileQuery.data?.slug ?? null;
  const myHumanId = pageProfileQuery.data?.humanId ?? null;
  const pageExists = Boolean(pageProfileQuery.data?.visibility);
  const isPagePublic = pageProfileQuery.data?.visibility === "PUBLIC";
  const showMyPageLink = Boolean(mySlug);

  const visibilityMutation = trpc.entityPages.updatePage.useMutation({
    onSuccess: () => {
      void utils.entityPages.getMyProfile.invalidate();
    },
    onError: (error) => setError(error),
  });

  const handleTogglePageVisibility = useCallback(
    (next: boolean) => {
      if (!myHumanId) return;
      visibilityMutation.mutate({
        ownerType: "HUMAN",
        ownerId: myHumanId,
        visibility: next ? "PUBLIC" : "PRIVATE",
      });
    },
    [myHumanId, visibilityMutation],
  );

  const { uploadAvatar, isUploading } = useAvatarUpload({
    onSuccess: () => {
      toast.success({
        id: "avatar-updated",
        title: String(t("account.sAvatarUploadSuccess")),
        message: String(t("account.sAvatarUploadSuccessMsg")),
      });
    },
    onError: (err) => {
      if (err.message === "TOO_LARGE") {
        toast.danger({
          id: "avatar-too-large",
          title: String(t("account.sAvatarUploadFailed")),
          message: String(t("account.sAvatarTooLarge")),
        });
      } else if (err.message === "INVALID_TYPE") {
        toast.danger({
          id: "avatar-invalid-type",
          title: String(t("account.sAvatarUploadFailed")),
          message: String(t("account.sAvatarInvalidType")),
        });
      } else {
        toast.danger({
          id: "avatar-upload-failed",
          title: String(t("account.sAvatarUploadFailed")),
          message: String(t("account.sAvatarUploadFailedMsg")),
        });
      }
    },
  });

  // Crop step (FR-002). This widget writes the same `EntityPage.avatarUrl`
  // the page editor does, so it gets the same square crop — and the CROPPED
  // file is what `uploadAvatar` receives, so the hook's HEIC prep, type
  // allow-list and 5MB cap still run on the bytes that are actually sent.
  //
  // Deliberately NOT calling `shouldSkipCrop` the way `PageFieldsEditor` does.
  // That escape hatch exists so an animated GIF survives as a GIF, and this
  // surface has never supported GIF avatars at all: neither the picker's
  // `accept` nor `useAvatarUpload`'s ALLOWED_TYPES (jpeg/png/webp) admits one.
  // Routing GIFs around the crop here would only turn today's "flattened to a
  // static JPEG and accepted" into an INVALID_TYPE rejection — a regression,
  // and reachable only by overriding the picker filter. If GIF is ever added
  // to `useAvatarUpload`, add the `shouldSkipCrop` branch with it.
  const [cropFile, setCropFile] = useState<File | null>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Reset input so re-selecting the same file triggers change
      e.target.value = "";
      setCropFile(file);
    },
    [],
  );

  const handleCropped = useCallback(
    (cropped: File) => {
      setCropFile(null);
      void uploadAvatar(cropped);
    },
    [uploadAvatar],
  );

  const handleCropError = useCallback(() => {
    toast.danger({
      id: "avatar-crop-failed",
      title: String(t("common.cropFailed")),
      message: String(t("account.sAvatarUploadFailedMsg")),
    });
  }, [t, toast]);

  const isDirty = name.trim() !== (user.name ?? "").trim();

  const handleSave = useCallback(async () => {
    if (!isDirty || !name.trim()) return;
    clearAll();
    setSaving(true);
    try {
      await authClient.updateUser({ name: name.trim() });
      toast.success({
        id: "name-updated",
        title: String(t("account.sNameUpdatedTitle")),
        message: String(t("account.sNameUpdatedMsg")),
      });
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }, [isDirty, name, t, toast, clearAll, setError]);

  const initials = (() => {
    const val = (user.name ?? user.email ?? "").trim();
    if (!val) return "U";
    const parts = val
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) return "U";
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
  })();

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <User size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sProfileTitle"))}
        </Text>
      </XStack>

      {/* Profile picture with upload overlay */}
      <YStack alignItems="center" gap="$2" paddingVertical="$2">
        <XStack
          position="relative"
          width={80}
          height={80}
          cursor={isUploading ? "wait" : "pointer"}
          hoverStyle={{ opacity: 0.85 }}
          pressStyle={{ opacity: 0.7 }}
          onPress={() => {
            if (!isUploading) fileInputRef.current?.click();
          }}
          role="button"
          aria-label={String(t("account.sAvatarUpload"))}
        >
          {/* Avatar */}
          <XStack
            width={80}
            height={80}
            borderRadius={0}
            backgroundColor="$accentSoft"
            borderWidth={2}
            borderColor="$borderColor"
            alignItems="center"
            justifyContent="center"
            overflow="hidden"
          >
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={String(t("account.sProfilePictureAlt"))}
                width={80}
                height={80}
                style={{ objectFit: "cover", width: 80, height: 80 }}
              />
            ) : (
              <Text variant="h3" weight="bold">
                {initials}
              </Text>
            )}
          </XStack>

          {/* Camera / spinner overlay — bottom-right badge */}
          <XStack
            position="absolute"
            bottom={-2}
            right={-2}
            width={28}
            height={28}
            borderRadius={14}
            backgroundColor="$accent"
            alignItems="center"
            justifyContent="center"
            borderWidth={2}
            borderColor="$surface"
          >
            {isUploading ? (
              <Spinner size="sm" />
            ) : (
              <Camera size={14} color="var(--onBrandSecondary, #FFFFFF)" />
            )}
          </XStack>
        </XStack>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          onChange={handleFileChange}
          style={{ display: "none" }}
        />

        <Text variant="caption" color="$colorMuted">
          {isUploading
            ? String(t("account.sAvatarUploading"))
            : String(t("account.sAvatarUpload"))}
        </Text>
      </YStack>

      {showMyPageLink && mySlug ? (
        <NextLinkAnchor href={`/humans/${mySlug}`}>
          <XStack
            tag="span"
            alignItems="center"
            justifyContent="space-between"
            gap="$2"
            paddingVertical="$2"
            paddingHorizontal="$3"
            borderWidth={1}
            borderColor="$borderColor"
            hoverStyle={{ backgroundColor: "$backgroundHover" }}
          >
            <XStack gap="$2" alignItems="center">
              <ExternalLink size={14} color="$colorMuted" />
              <Text variant="bodySmall" weight="bold">
                {String(t("account.sViewMyPage"))}
              </Text>
            </XStack>
            <Text variant="caption" color="$colorMuted">
              /humans/{mySlug}
            </Text>
          </XStack>
        </NextLinkAnchor>
      ) : null}

      {pageExists ? (
        <XStack
          alignItems="center"
          justifyContent="space-between"
          gap="$3"
          paddingVertical="$2"
          paddingHorizontal="$3"
          borderWidth={1}
          borderColor="$borderColor"
        >
          <YStack flex={1} gap="$1">
            <Text variant="bodySmall" weight="bold">
              {String(t("account.sPublicPageVisible"))}
            </Text>
            <Text variant="caption" color="$colorMuted">
              {isPagePublic
                ? String(t("account.sPublicPageVisibleHelp"))
                : String(t("account.sPublicPageHiddenHelp"))}
            </Text>
          </YStack>
          <Switch
            checked={isPagePublic}
            onCheckedChange={handleTogglePageVisibility}
            saving={visibilityMutation.isPending}
            aria-label={String(t("account.sPublicPageVisible"))}
          />
        </XStack>
      ) : null}

      <FormErrorBanner message={formError} onDismiss={clearAll} />

      <LabeledTextInput
        label={String(t("account.sNameLabel"))}
        name="displayName"
        value={name}
        onChangeText={setName}
        placeholder={String(t("account.sNamePlaceholder"))}
      />

      {isDirty && (
        <XStack justifyContent="flex-end">
          <Button
            variant="primary"
            size="$3"
            onPress={handleSave}
            disabled={saving || !name.trim()}
          >
            {saving ? <Spinner size="sm" /> : String(t("account.sSave"))}
          </Button>
        </XStack>
      )}

      <ImageCropDialog
        file={cropFile}
        aspect={1}
        title={String(t("account.sAvatarCropTitle"))}
        maxOutputWidth={1024}
        onCancel={() => setCropFile(null)}
        onCropped={handleCropped}
        onPrepareError={handleCropError}
      />
    </SectionCard>
  );
}
