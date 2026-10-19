"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  LabeledTextInput,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";
import { XStack, YStack, styled } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { useFormErrors } from "@/hooks/useFormErrors";
import { formatAuthErrorMessage } from "./auth-helpers";
import { AuthCardShell } from "./AuthCardShell";
import { lookupOwn } from "@/lib/lookup-own";
import {
  AUTH_FOOTER_LINK,
  AUTH_FOOTER_LINK_TEXT,
  AUTH_FOOTER_RULE,
  RECEDING_DISABLED,
} from "./auth-card-chrome";

/**
 * The footer rule. A hairline at 20% of the panel's foreground — see
 * `AUTH_FOOTER_RULE`.
 */
const Separator = styled(YStack, {
  name: "AuthFooterRule",
  ...AUTH_FOOTER_RULE,
});

/**
 * Mirrors the username plugin's DEFAULT rules (`minUsernameLength` 3,
 * `maxUsernameLength` 30, `defaultUsernameValidator` = `/^[a-zA-Z0-9_.]+$/`),
 * which is what `apps/api/src/auth/better-auth.ts` mounts — `username()` with
 * no options. A pre-check here is ergonomics, not policy: the server still
 * validates and is the only place uniqueness can be known.
 */
const USERNAME_SHAPE = /^[a-zA-Z0-9_.]{3,30}$/;

/** Error codes the username plugin raises from `/update-user`. */
const USERNAME_FIELD_ERROR_CODES: Record<string, string> = {
  USERNAME_IS_ALREADY_TAKEN: "That username is taken. Try another.",
  USERNAME_TOO_SHORT: "At least 3 characters.",
  USERNAME_TOO_LONG: "At most 30 characters.",
  INVALID_USERNAME: "Letters, numbers, dots and underscores only.",
};

/** The session user, with the field the username plugin adds. */
type SessionUserWithUsername = {
  name?: string | null;
  username?: string | null;
};

export type WelcomeProfileCardProps = {
  onDoneAction: () => void;
  /** "Skip for now". Falls back to `onDoneAction` when omitted. */
  onSkipAction?: () => void;
  /** Optional header rendered inside the card surface (e.g. step indicator). */
  cardHeader?: ReactNode;
};

/**
 * Step 4 of 4 — Profile.
 *
 * Display name and username, the two identity fields step 1 stopped asking
 * for. This card was built and mounted by nothing; it is now the last panel
 * of sign-up in both hosts, and the OAuth `?onboarding=oauth` entry lands
 * here too.
 *
 * ## Why the session, not a prop
 *
 * The display name is prefilled with the placeholder step 1 minted
 * (`placeholderNameFromEmail`), read back from the session rather than
 * threaded through the shell: a refresh on step 4 keeps the session and
 * loses the shell's state, and the card should still know what the account
 * is currently called.
 *
 * ## Saving
 *
 * `authClient.updateUser({ name, username })`. `username` is a schema field
 * the username plugin adds to `user` (input allowed), so the core
 * `/update-user` route writes it and the plugin's `before` hook on that path
 * validates the shape and rejects a taken name with
 * `USERNAME_IS_ALREADY_TAKEN`. That becomes an inline field error, never a
 * toast — the fix is in the field.
 */
export const WelcomeProfileCard = ({
  onDoneAction,
  onSkipAction,
  cardHeader,
}: WelcomeProfileCardProps) => {
  const t = useTranslations();
  const { toast } = useNotify();
  const sessionQuery = authClient.useSession();
  const user = sessionQuery.data?.user as SessionUserWithUsername | undefined;

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const { fieldErrors, setFieldError, clearField, clearAll } = useFormErrors<
    "displayName" | "username"
  >();
  const formRef = useRef<HTMLFormElement>(null);

  // Seed ONCE from the session, when it first resolves. The session is
  // pending on the first render of a fresh mount, so an initial-state read
  // would seed empty and never catch up; seeding on every change would
  // clobber what the reader has already typed.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !user) return;
    seededRef.current = true;
    setDisplayName(user.name ?? "");
    setUsername(user.username ?? "");
  }, [user]);

  const currentName = (user?.name ?? "").trim();
  const currentUsername = (user?.username ?? "").trim().toLowerCase();

  const handleSkip = onSkipAction ?? onDoneAction;

  const handleFinish = useCallback(async () => {
    if (saving) return;
    const name = displayName.trim();
    const wantedUsername = username.trim();
    clearAll();

    if (wantedUsername && !USERNAME_SHAPE.test(wantedUsername)) {
      setFieldError(
        "username",
        "3–30 characters: letters, numbers, dots and underscores.",
      );
      return;
    }

    const payload: { name?: string; username?: string } = {};
    if (name && name !== currentName) payload.name = name;
    if (
      wantedUsername &&
      wantedUsername.toLowerCase() !== currentUsername
    ) {
      payload.username = wantedUsername;
    }

    // Nothing changed — the reader pressed Finish on the prefilled card.
    if (Object.keys(payload).length === 0) {
      onDoneAction();
      return;
    }

    setSaving(true);
    try {
      const result = await authClient.updateUser(payload);
      if (result.error) {
        const code = result.error.code ?? "";
        const fieldMessage = lookupOwn(USERNAME_FIELD_ERROR_CODES, code);
        if (fieldMessage) {
          setFieldError("username", fieldMessage);
          return;
        }
        toast.danger(formatAuthErrorMessage(result.error, t));
        return;
      }
      onDoneAction();
    } catch (error) {
      toast.danger(formatAuthErrorMessage(error, t));
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    displayName,
    username,
    clearAll,
    setFieldError,
    currentName,
    currentUsername,
    onDoneAction,
    toast,
    t,
  ]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleFinish();
  };

  return (
    <AuthCardShell
      testId="welcome-profile-card"
      step={{ kind: "counted", index: 4, total: 4, name: "Profile" }}
      header={cardHeader}
      compactVerticalPadding
    >
      <YStack gap="$2">
        <Text variant="h4" tag="h1">
          Who are you?
        </Text>
        <Text variant="bodySmall" color="$colorMuted">
          This is the name organisers see on your orders and RSVPs. Both can
          be changed later.
        </Text>
      </YStack>

      <div>
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          noValidate
          data-testid="auth-profile-form"
        >
          <YStack gap="$4">
            {/* `LabeledTextInput` with the mono `overline` label — the same
                field every other auth card renders. */}
            <LabeledTextInput
              label={String(t("auth.wpNameLabel"))}
              labelVariant="overline"
              testId="auth-profile-display-name"
              id="auth-profile-display-name"
              name="name"
              value={displayName}
              onChangeText={(v) => {
                setDisplayName(v);
                if (fieldErrors.displayName) clearField("displayName");
              }}
              placeholder={String(t("auth.scDisplayNamePlaceholder"))}
              autoCapitalize="words"
              autoComplete="name"
              autoCorrect={false}
              autoFocus
              disabled={saving}
              status={fieldErrors.displayName ? "error" : undefined}
              aria-invalid={fieldErrors.displayName ? true : undefined}
              helperText={fieldErrors.displayName}
              // Matches the field metrics every other auth card uses;
              // `fontSize: 16` is the iOS Safari focus-zoom threshold.
              height={52}
              fontSize={16}
            />

            <LabeledTextInput
              label={String(t("auth.scUsername"))}
              labelVariant="overline"
              testId="auth-profile-username"
              id="auth-profile-username"
              name="username"
              value={username}
              onChangeText={(v) => {
                setUsername(v);
                if (fieldErrors.username) clearField("username");
              }}
              placeholder={String(t("auth.scUsernamePlaceholder"))}
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect={false}
              disabled={saving}
              status={fieldErrors.username ? "error" : undefined}
              aria-invalid={fieldErrors.username ? true : undefined}
              helperText={fieldErrors.username}
              height={52}
              fontSize={16}
            />

            {/* THE accent fill on this card. Never `disabled` while saving —
                that would dim the spinner that is the feedback. */}
            <Button
              data-testid="auth-profile-submit"
              // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
              type="submit"
              size="$4"
              width="100%"
              aria-busy={saving ? true : undefined}
              aria-disabled={saving ? true : undefined}
              disabledStyle={RECEDING_DISABLED}
              onPress={() => {
                formRef.current?.requestSubmit();
              }}
            >
              {saving ? (
                <Spinner size="sm" indicatorColor="$onBrandSecondary" />
              ) : null}
              {saving ? String(t("auth.wpSaving")) : "Finish"}
            </Button>
          </YStack>
        </form>
      </div>

      <Separator />

      <XStack justifyContent="center" alignItems="center">
        <XStack
          {...AUTH_FOOTER_LINK}
          data-testid="auth-profile-skip"
          // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
          type="button"
          disabled={saving}
          onPress={handleSkip}
        >
          <Text {...AUTH_FOOTER_LINK_TEXT}>{String(t("auth.tfaSkip"))}</Text>
        </XStack>
      </XStack>
    </AuthCardShell>
  );
};

WelcomeProfileCard.displayName = "WelcomeProfileCard";
