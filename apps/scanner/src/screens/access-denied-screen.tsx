import {
  Column,
  Panel,
  ScreenSurface,
  SquareSecondaryButton,
  Text,
  TopBar,
} from "@th/ui-native";

/**
 * FR-009: this was the ONLY scanner screen importing `@th/ui`'s `Button`. It
 * now uses `SquareSecondaryButton` like every other secondary action in the
 * app — same neutral-outlined treatment, same 52pt target, same AA rungs — so
 * the scanner draws its buttons from one system rather than two.
 */
export const AccessDeniedScreen = ({
  userEmail,
  onSignOut,
}: {
  userEmail: string | undefined;
  onSignOut: () => Promise<void>;
}) => (
  <ScreenSurface testID="access-denied-screen">
    <TopBar
      title="Access denied"
      subtitle="This account is not provisioned for the scanner app."
    />

    <Column flex justify="center" gap={16}>
      <Panel>
        <Text variant="body">
          Signed in as {userEmail ?? "unknown operator"}.
        </Text>
        <Text variant="bodySmall" tone="muted">
          Scanner access requires an org admin to grant you the SCANNER role on
          at least one organization. Ask the staffing lead or admin who invited
          you to add the SCANNER role to your account, then sign back in.
        </Text>
      </Panel>

      <Panel>
        <Text variant="bodySmall" tone="muted">
          If you believe this is a mistake, sign out and try again with the
          email tied to your scanner role.
        </Text>
        <SquareSecondaryButton
          label="Sign out"
          onPress={() => {
            void onSignOut();
          }}
          testID="access-denied-sign-out-button"
        />
      </Panel>
    </Column>
  </ScreenSurface>
);
