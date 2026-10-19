"use client";

import { forwardRef, useMemo, type ComponentPropsWithoutRef } from "react";
import { XStack } from "tamagui";

import { Button, Text, useTranslations } from "@th/ui";
import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { initialsFrom } from "./avatar-initials";

export type ProfileMenuProps = {
  testIdBase?: string;
  onPressAction?: () => void;
} & Omit<ComponentPropsWithoutRef<typeof Button>, "children" | "onPress">;

export const ProfileMenu = forwardRef<any, ProfileMenuProps>(
  ({ testIdBase = "profile-menu", onPressAction, ...buttonProps }, ref) => {
    const t = useTranslations();
    // Check session state before querying profile
    const sessionQuery = authClient.useSession();
    const isAuthenticated = Boolean(sessionQuery.data?.user);

    const profileQuery = trpc.entityPages.getMyProfile.useQuery(
      {},
      {
        retry: false,
        staleTime: 60_000,
        // Only run this query when authenticated
        enabled: isAuthenticated,
      },
    );

    const profile = profileQuery.data ?? null;

    const primaryLabel = profile?.displayName ?? null;
    const secondaryLabel = profile?.humanId ?? null;
    const initials = useMemo(
      () => initialsFrom(primaryLabel ?? secondaryLabel),
      [primaryLabel, secondaryLabel],
    );

    // If not authenticated, don't render the profile trigger.
    if (!isAuthenticated) {
      return null;
    }

    return (
      <Button
        ref={ref}
        size="$3"
        variant="ghost"
        aria-label={t("auth.pmOpenMenu") as string}
        data-testid={`${testIdBase}-trigger`}
        onPress={onPressAction}
        {...buttonProps}
      >
        <XStack alignItems="center" justifyContent="center" gap="$2">
          <XStack
            width={28}
            height={28}
            borderRadius={999}
            backgroundColor="$accentSoft"
            borderWidth={1.5}
            borderColor="$borderColorSoft"
            alignItems="center"
            justifyContent="center"
            overflow="hidden"
          >
            {profileQuery.isLoading ? (
              <XStack
                width={28}
                height={28}
                borderRadius={999}
                backgroundColor="$surfaceMuted"
              />
            ) : profile?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.avatarUrl}
                alt={
                  primaryLabel
                    ? String(t("auth.pmAvatarAlt", { name: primaryLabel }))
                    : (t("auth.pmAvatarFallback") as string)
                }
                width={28}
                height={28}
                style={{
                  objectFit: "cover",
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                }}
              />
            ) : (
              <Text variant="bodySmall" weight="bold">
                {initials}
              </Text>
            )}
          </XStack>
        </XStack>
      </Button>
    );
  },
);

ProfileMenu.displayName = "ProfileMenu";

export const profileMenuActions = {
  initialsFrom,
};
