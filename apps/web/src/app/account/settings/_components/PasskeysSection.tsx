"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import type { TamaguiElement } from "tamagui";
import { Check, Fingerprint, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Spinner, Text, TextInput, useNotify } from "@th/ui";
import {
  PASSKEY_NAME_MAX_LENGTH,
  derivePasskeyName,
  normalizePasskeyName,
} from "@th/types";
// Subpath, NOT the `@th/types` barrel: the AAGUID table is ~29 KB of source
// needed by this one component, and the barrel is on the dependency graph of
// most of the app. See the module's own header.
import { passkeyAaguidLabel } from "@th/types/passkey-aaguid";

import { authClient } from "@/lib/auth/auth-client";
import { detectDeviceLabel } from "@/lib/auth/device-label";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { trpc } from "@/trpc";
import { SectionCard } from "./settings-primitives";

interface PasskeyRecord {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  createdAt?: string | null;
  credentialID?: string | null;
  /**
   * Authenticator model identifier, written by Better Auth from SimpleWebAuthn's
   * `registrationInfo` at registration (`@better-auth/passkey/dist/index.mjs:331`
   * and `:363`) and stored on `Passkey.aaguid`. Optional in the plugin's own
   * `Passkey` type and frequently all-zero on the wire — see
   * `ABSENT_AAGUID` in `@th/types/passkey-aaguid`.
   */
  aaguid?: string | null;
}

/**
 * Find the row an enrollment just created.
 *
 * Identity is by ID and only by ID. Name is not a key (several rows can legally
 * share one — that is why the collision suffix exists) and neither is position
 * (`/passkey/list-user-passkeys` promises no ordering, and the list can change
 * underneath us from another tab).
 *
 * Two sources, in order:
 * 1. The `addPasskey` result. `/passkey/verify-registration` returns the created
 *    row verbatim — `ctx.json(newPasskeyRes)` — and the client passes it
 *    straight through as `data`, typed `Passkey` (`client.d.mts:115`). So the id
 *    AND the aaguid normally arrive without a second request.
 * 2. Failing that, an ID-set diff across the refetch. Only accepted when it
 *    yields EXACTLY one new row: two concurrent enrollments (a second tab) make
 *    the diff ambiguous, and renaming the wrong credential is worse than
 *    leaving both with their browser-derived names.
 */
function findEnrolledPasskey(
  created: PasskeyRecord | null,
  before: readonly PasskeyRecord[],
  after: readonly PasskeyRecord[],
): PasskeyRecord | null {
  if (created?.id) {
    // Prefer the refetched row when we have it: it is the authoritative stored
    // state. Fall back to the create response so a failed/racing refetch still
    // leaves us able to rename.
    return after.find((pk) => pk.id === created.id) ?? created;
  }

  const knownIds = new Set(before.map((pk) => pk.id));
  const added = after.filter((pk) => !knownIds.has(pk.id));
  return added.length === 1 ? (added[0] ?? null) : null;
}

/**
 * Minimum width the row's content column keeps before the action buttons wrap
 * onto their own line. Without a floor, `flex={1}` would happily squeeze the
 * name to a few characters on a narrow phone to keep Rename + Remove on the
 * same line; wrapping is the better failure mode.
 */
const ROW_CONTENT_MIN_WIDTH = 180;

/**
 * Smallest Button size that clears the 44px touch-target floor
 * (`BUTTON_SIZE_HEIGHTS.$4 === 44`; `$3` is 36 and `$2` is 34). Every control in
 * this section rides it so the row actions and the section CTA stay the same
 * height — a 44px row action next to a 36px primary CTA reads as an inverted
 * hierarchy.
 */
const TOUCH_SIZE = "$4" as const;

/** Focus a Tamagui element ref on web. Native has no `.focus()` on a frame. */
function focusRef(ref: React.RefObject<TamaguiElement | null>): void {
  (ref.current as unknown as { focus?: () => void } | null)?.focus?.();
}

/**
 * True when focus has been ORPHANED — i.e. the element that had it was
 * unmounted, so the browser fell back to `<body>`.
 *
 * Every focus restore in this section is gated on this. Restoring
 * unconditionally steals focus from a user who moved on (e.g. clicking row B's
 * Rename takes row A out of edit mode, and row A must not yank focus back).
 */
function focusWasOrphaned(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return !active || active === document.body;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/** Comparison key for "is this name already taken?" — normalized, then folded. */
/**
 * Rejections from listing passkeys that carry no signal: the session went away
 * (sign-out, expiry) or the request was cancelled by navigation. Both are
 * ordinary, both leave the UI in a correct degraded state, and neither is worth
 * a Sentry event.
 */
function isExpectedListFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    /failed to fetch|networkerror|load failed/i.test(message) ||
    (err instanceof Error && err.name === "AbortError") ||
    /\b401\b|\b403\b|unauthor/i.test(message)
  );
}

function nameKey(value: string | null | undefined): string | null {
  return normalizePasskeyName(value)?.toLowerCase() ?? null;
}

interface PasskeyRowProps {
  passkey: PasskeyRecord;
  isLast: boolean;
  editing: boolean;
  saving: boolean;
  removing: boolean;
  /** True while ANOTHER row has a rename in flight. */
  locked: boolean;
  draftName: string;
  /**
   * `nameKey()` of every OTHER passkey on the account. Renaming onto one of
   * these is blocked — see the inline conflict message below.
   */
  siblingNameKeys: readonly string[];
  onDraftNameChangeAction: (value: string) => void;
  onStartRenameAction: (passkey: PasskeyRecord) => void;
  onCancelRenameAction: () => void;
  onSubmitRenameAction: (passkey: PasskeyRecord) => void;
  onRemoveAction: (passkeyId: string) => void;
}

/**
 * One row of the passkey list: name + provenance, with Rename / Remove actions
 * that swap to an inline name field + Save / Cancel while editing.
 *
 * Button hierarchy is deliberate and NOT uniform — Rename and Remove used to be
 * two identical orange outlines 8px apart, one of which irreversibly deletes a
 * credential with no confirmation step:
 * - Rename → `secondary` (steel outline: different in KIND, not just in label)
 * - Remove → `destructiveGhost` (the variant that exists for
 *   "remove / disconnect / revoke")
 * - Save   → `primary` (the filled default)
 * - Cancel → `ghost`
 * No `borderWidth` overrides: the base Button config already sets 2, and
 * `destructiveGhost` deliberately rides a 1px hairline.
 *
 * Every action label repeats the same `<Text tone="inherit" …>` block verbatim
 * rather than sharing a small `<ActionLabel>` helper. That is deliberate:
 * `packages/ui/src/ui/tamagui/__tests__/button-label-inheritance.test.ts` guards
 * the "label didn't follow the button's colour inversion" bug class by SOURCE-
 * SCANNING `<Button>` bodies for `<Text` tags, so hiding a label behind a
 * component would make that call site invisible to the guard.
 */
function PasskeyRow({
  passkey,
  isLast,
  editing,
  saving,
  removing,
  locked,
  draftName,
  siblingNameKeys,
  onDraftNameChangeAction,
  onStartRenameAction,
  onCancelRenameAction,
  onSubmitRenameAction,
  onRemoveAction,
}: PasskeyRowProps) {
  const displayName = passkey.name ?? "Untitled passkey";
  const conflictId = `passkey-name-conflict-${passkey.id}`;

  /**
   * Accessible-name qualifier for this row's controls.
   *
   * "Rename" / "Remove" alone repeat once per row, which is useless in a
   * screen-reader control list — and the NAME alone is not enough either: two
   * credentials can carry the same label (rows that predate the collision guard
   * below), which would give a user two identically-named controls, one of which
   * deletes without confirmation. The added date disambiguates. Appended only
   * when we actually have one; `formatDate` renders "—" for a missing value and
   * "Remove Android, added —" reads as broken copy.
   */
  const rowQualifier = passkey.createdAt
    ? `${displayName}, added ${formatDate(passkey.createdAt)}`
    : displayName;

  // Both sides normalized before comparing: a stored name may predate the
  // shared normalizer (stray double spaces, trailing whitespace), and we don't
  // want a whitespace-only edit to count as a change.
  const normalizedDraft = normalizePasskeyName(draftName);
  // Derived, not stateful, so the message tracks the field live and there is no
  // stale error to clear on cancel/retry.
  const nameTaken =
    normalizedDraft !== null &&
    siblingNameKeys.includes(normalizedDraft.toLowerCase());
  const canSave =
    normalizedDraft !== null &&
    normalizedDraft !== normalizePasskeyName(passkey.name) &&
    !nameTaken;

  // ── Focus management on leaving edit mode ────────────────────────────────
  // Entering edit mode moves focus (the field autoFocuses). All three EXITS —
  // Escape, Cancel, Save — unmount the element that holds focus, which drops it
  // to <body>: a keyboard user has to Tab from the top of the document, past the
  // navbar and settings sections 01–05, with no visible focus anywhere. Hand it
  // back to the control they came from.
  const renameRef = useRef<TamaguiElement | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing && focusWasOrphaned()) {
      focusRef(renameRef);
    }
    wasEditing.current = editing;
  }, [editing]);

  const handleKeyPress = useCallback(
    (event: {
      nativeEvent: { key: string; isComposing?: boolean; keyCode?: number };
      preventDefault?: () => void;
    }) => {
      const native = event.nativeEvent;
      // IME composition guard, mirroring react-native-web's own
      // `isEventComposing` (TextInput/index.js). Mid-composition Enter is the
      // COMMIT-CANDIDATE keypress, not a submit: a user typing しごと via an IME
      // would otherwise save whatever `draftName` holds at that moment (Chrome
      // fires onChange during composition, so a pre-commit reading), and
      // preventDefault() on it can interfere with the commit itself.
      if (native.isComposing || native.keyCode === 229) return;
      const key = native.key;
      if (key === "Enter") {
        // Own the Enter key so react-native-web's own submit branch (which
        // fires `onSubmitEditing` and blurs) doesn't also run. RNW gates that
        // branch on `!e.isDefaultPrevented()`.
        event.preventDefault?.();
        if (canSave && !saving) onSubmitRenameAction(passkey);
        return;
      }
      if (key === "Escape") {
        event.preventDefault?.();
        if (!saving) onCancelRenameAction();
      }
    },
    [canSave, saving, onSubmitRenameAction, onCancelRenameAction, passkey],
  );

  const metaLine = (
    <Text variant="caption" tone="muted">
      {passkey.deviceType === "singleDevice"
        ? "This device only"
        : "Synced across devices"}
      {" · "}
      Added {formatDate(passkey.createdAt)}
    </Text>
  );

  return (
    <XStack
      padding="$3"
      alignItems="center"
      justifyContent="space-between"
      borderBottomWidth={isLast ? 0 : 1}
      borderBottomColor="$borderColor"
      gap="$3"
      // The actions wrap below the content on narrow viewports instead of
      // being pushed off-screen by a long name.
      flexWrap="wrap"
    >
      <YStack gap="$1" flex={1} minWidth={ROW_CONTENT_MIN_WIDTH}>
        {editing ? (
          <>
            <TextInput
              fullWidth
              value={draftName}
              onChangeText={onDraftNameChangeAction}
              onKeyPress={handleKeyPress}
              // Better Auth validates `name` as a bare `z.string()` with NO max
              // on /passkey/update-passkey, and the column is unbounded text —
              // this cap is the only thing between a paste and a blown-out row.
              // The value is also run through `normalizePasskeyName` on submit.
              maxLength={PASSKEY_NAME_MAX_LENGTH}
              autoFocus
              disabled={saving}
              status={nameTaken ? "error" : undefined}
              placeholder="e.g. Work laptop"
              // Row-qualified like the buttons: an unqualified "Passkey name"
              // is ambiguous in a list of rows.
              aria-label={`New name for ${displayName}`}
              aria-invalid={nameTaken || undefined}
              aria-describedby={nameTaken ? conflictId : undefined}
            />
            {nameTaken ? (
              // `color="$dangerSoft"`, not `tone="error"`: that tone resolves to
              // `$danger`, which is the FILL value — #EF4444 lands at ~4.0:1 as
              // small text on Ember's navy canvas. `$dangerSoft` is the theme's
              // legible danger TEXT token (AA on every canvas), and it is the
              // same token the adjacent `destructiveGhost` Remove button rides.
              <Text
                id={conflictId}
                variant="caption"
                color="$dangerSoft"
                role="alert"
              >
                You already have a passkey with that name.
              </Text>
            ) : null}
          </>
        ) : (
          <Text variant="body" weight="bold">
            {displayName}
          </Text>
        )}
        {metaLine}
      </YStack>

      <XStack
        gap="$2"
        alignItems="center"
        flexShrink={0}
        // Second-order wrap. The row's own `flexWrap` drops this cluster onto
        // its own line once the content column hits its 180px floor, but at 44px
        // the two labelled buttons are ~260px wide together — wider than the
        // ~232px of row content a 320px viewport leaves (WCAG 1.4.10 reflow: a
        // 1280px page at 400% zoom is exactly that). `maxWidth` is what makes
        // `flexWrap` bite here: with `flexShrink={0}` alone the cluster keeps its
        // max-content width and overflows instead of stacking.
        maxWidth="100%"
        flexWrap="wrap"
        justifyContent="flex-end"
      >
        {editing ? (
          <>
            <Button
              size={TOUCH_SIZE}
              // `secondary`, not the default fill: "Add a passkey" below is this
              // section's standing primary, and design-system-v2 §4 allows one
              // primary per viewport. Saving a row is a local commit, so it
              // outranks Cancel (`ghost`) without competing with the section CTA.
              // Safe as a lone variant swap because the label, the Check icon and
              // the spinner all inherit (`tone="inherit"` / `currentColor`), so
              // the foreground migrates with the fill rather than drifting.
              variant="secondary"
              // `disabled` stays for the genuinely-unavailable case (blank /
              // unchanged / colliding name) — there is nothing to read there.
              // It is deliberately NOT used for the IN-FLIGHT case, for one
              // reason: `disabled` pulls in Button's `disabledStyle` (opacity
              // 0.45), which painted the only progress feedback there is — the
              // spinner plus "Saving…" — at roughly 2:1.
              //
              // NB @th/ui's Button never emits the native HTML `disabled`
              // attribute: it maps `disabled` to `aria-disabled` plus
              // `tabindex="-1"` (out of the Tab order, focus kept if held). The
              // in-flight path passes `aria-disabled` alone, so the button just
              // pressed stays a normal Tab stop while it saves. `aria-busy` is
              // the genuine addition — the "Save" → "Saving…" text swap is a
              // plain DOM change no screen reader announces on its own.
              //
              // The cost of dropping `disabled` is that Tamagui no longer
              // short-circuits onPress, so `handleRename` carries the in-flight
              // guard, and hover/press are now reachable mid-flight — which is
              // why the spinner below had to stop riding a fixed token.
              disabled={!canSave && !saving}
              aria-busy={saving || undefined}
              aria-disabled={saving || undefined}
              // Row-qualified like Rename/Remove. /account/settings renders
              // several "Save" buttons (Booking defaults has one), so a bare
              // label leaves a screen-reader user with identical controls and no
              // way to tell which section they are committing.
              aria-label={`Save new name for ${displayName}`}
              onPress={() => onSubmitRenameAction(passkey)}
            >
              <XStack gap="$2" alignItems="center">
                {saving ? (
                  // `currentColor` + a transparent track, NOT a token: the
                  // spinner has to track the button's label colour through
                  // rest/hover/press, exactly like the `<Text tone="inherit">`
                  // below. Tamagui carries the variant's `color` (and its
                  // hover/press overrides) on the button FRAME, so a descendant
                  // resolving `currentColor` inherits all three rungs. A fixed
                  // token cannot: it is why this used to be gated on `disabled`
                  // (no pointer events ⇒ hover unreachable ⇒ a resting-colour
                  // spinner was "safe"), and that gate is now gone.
                  <Spinner
                    size="sm"
                    indicatorColor="currentColor"
                    trackColor="transparent"
                  />
                ) : (
                  <Check size={14} />
                )}
                <Text
                  tone="inherit"
                  variant="bodySmall"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={1}
                >
                  {saving ? "Saving…" : "Save"}
                </Text>
              </XStack>
            </Button>
            <Button
              size={TOUCH_SIZE}
              variant="ghost"
              disabled={saving}
              aria-label={`Cancel renaming ${displayName}`}
              onPress={onCancelRenameAction}
            >
              <Text
                tone="inherit"
                variant="bodySmall"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={1}
              >
                Cancel
              </Text>
            </Button>
          </>
        ) : (
          <>
            <Button
              ref={renameRef}
              size={TOUCH_SIZE}
              variant="secondary"
              disabled={removing || locked}
              onPress={() => onStartRenameAction(passkey)}
              aria-label={`Rename ${rowQualifier}`}
            >
              <XStack gap="$2" alignItems="center">
                <Pencil size={14} />
                <Text
                  tone="inherit"
                  variant="bodySmall"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={1}
                >
                  Rename
                </Text>
              </XStack>
            </Button>
            <Button
              size={TOUCH_SIZE}
              variant="destructiveGhost"
              // Same split as Save above: `locked` (another row is saving) is a
              // real disable; this row's own in-flight delete is aria-only so
              // the spinner stays readable and the button stays focusable.
              disabled={locked}
              aria-busy={removing || undefined}
              aria-disabled={removing || undefined}
              onPress={() => onRemoveAction(passkey.id)}
              aria-label={`Remove ${rowQualifier}`}
            >
              <XStack gap="$2" alignItems="center">
                {removing ? (
                  // See the Save spinner above for why this is `currentColor`:
                  // `destructiveGhost` inverts its label from $dangerSoft to
                  // $colorInverted on hover, and $dangerSoft is also the hover
                  // FILL — a fixed-token spinner would go 1:1 invisible there.
                  <Spinner
                    size="sm"
                    indicatorColor="currentColor"
                    trackColor="transparent"
                  />
                ) : (
                  <Trash2 size={14} />
                )}
                <Text
                  tone="inherit"
                  variant="bodySmall"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={1}
                >
                  Remove
                </Text>
              </XStack>
            </Button>
          </>
        )}
      </XStack>
    </XStack>
  );
}

PasskeyRow.displayName = "PasskeyRow";

export function PasskeysSection() {
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  // Better Auth's `useSession` reads the shared client-side session store the
  // settings page is already subscribed to — no extra request, just the display
  // name so derived passkey names read "Tom’s macOS" instead of bare "macOS".
  const sessionQuery = authClient.useSession();
  const userName = sessionQuery.data?.user?.name ?? null;
  const [passkeys, setPasskeys] = useState<PasskeyRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Only one row may be in edit mode at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const addButtonRef = useRef<TamaguiElement | null>(null);
  /** Flips true after the FIRST list fetch settles — see `refresh`. */
  const hasLoadedRef = useRef(false);
  /** Set by a successful delete; consumed by the focus-restore effect below. */
  const restoreFocusAfterDeleteRef = useRef(false);

  const passkeySupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return typeof window.PublicKeyCredential !== "undefined";
  }, []);

  // The /platform and /moderate shells cache checkStaffAccess /
  // checkModeratorAccess with a 5-minute staleTime; without invalidation a
  // freshly-enrolled staff user is served the cached
  // `secondFactorEnrolled: false` and bounced back to /enroll-2fa.
  // Fire-and-forget: enrollment UX must not depend on these refetches, and
  // for non-staff users the queries aren't in cache so this is a no-op.
  const invalidateSecondFactorGates = useCallback(() => {
    void utils.platform.checkStaffAccess.invalidate();
    void utils.community.checkModeratorAccess.invalidate();
  }, [utils]);

  /**
   * Refetch the list into state and hand the rows back to the caller.
   *
   * Returns `null` — never `[]` — when the fetch FAILED, so a caller can tell
   * "the account has no passkeys" from "we don't know". `handleAdd` needs that
   * distinction: it must not conclude from a failed refetch that it cannot find
   * the row it just enrolled. Every other caller ignores the return.
   */
  const refresh = useCallback(async (): Promise<PasskeyRecord[] | null> => {
    // Only BLANK the list on the very first load. Flipping `loading` back on
    // for a post-mutation refetch swaps the whole list for a spinner, which
    // unmounts every row — including one the user is mid-rename in. The draft
    // survived (it lives up here) but `autoFocus` re-fired on remount and threw
    // the caret to the end of the field mid-keystroke. Later fetches reconcile
    // in place instead.
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const result = await authClient.passkey.listUserPasskeys({});
      const list = (result?.data ?? []) as unknown as PasskeyRecord[];
      setPasskeys(list);
      return list;
    } catch (error) {
      // `traceIgnoredError`, not `console.error`. This branch degrades
      // gracefully by design (see below), so a hard console error was both the
      // wrong severity and actively misleading: signing out with this page open
      // makes the in-flight list request fail, which produced a red
      // "[passkeys] list failed TypeError: Failed to fetch" on a completely
      // ordinary user action. Session loss and a cancelled request are expected
      // here and carry no signal, so they skip telemetry; anything else still
      // reaches Sentry.
      traceIgnoredError("account.passkeys.list", isExpectedListFailure)(error);
      // Keep whatever we already have when a REFETCH fails — replacing a real
      // list with [] renders "No passkeys yet", which is a lie that could push
      // someone into enrolling a duplicate. Only the first load has nothing to
      // keep.
      setPasskeys((current) => current ?? []);
      return null;
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Focus restore after a delete.
   *
   * Keyed on `passkeys` rather than done inline in `handleDelete`: the row that
   * owned the focused Remove button is still mounted (and still holds focus) at
   * the moment `await refresh()` returns, because React has not committed the
   * new list yet. Reading `document.activeElement` there always says "not
   * orphaned" and the restore silently no-ops. Waiting for the commit is the
   * only place the question can be answered.
   */
  useEffect(() => {
    if (!restoreFocusAfterDeleteRef.current) return;
    restoreFocusAfterDeleteRef.current = false;
    // Hand focus to the section's own CTA rather than making a keyboard user
    // Tab from the top of the document. Guarded so it never steals from someone
    // who moved on while the request was in flight.
    if (focusWasOrphaned()) focusRef(addButtonRef);
  }, [passkeys]);

  /**
   * `nameKey()` of every stored passkey name, paired with its row id, so each
   * row can exclude itself when checking for a rename collision.
   */
  const nameKeysById = useMemo(
    () =>
      (passkeys ?? []).map((pk) => ({ id: pk.id, key: nameKey(pk.name) })),
    [passkeys],
  );

  /**
   * Upgrade a just-enrolled passkey's auto-generated name to one derived from
   * its AAGUID. Returns the name now stored — the original when nothing changed.
   *
   * WHY THIS IS A SECOND CALL. The AAGUID identifies the authenticator MODEL
   * (iCloud Keychain vs 1Password vs a YubiKey), which is what a person
   * actually recognises in this list — the browser sniffing in
   * `detectDeviceLabel` can only name the host OS, so three credentials from
   * three providers enrolled on one laptop all come out "macOS". But the
   * AAGUID does not exist until the ceremony completes, and
   * `addPasskey({ name })` has to send the name WITH the registration request.
   * So the name is set twice: once optimistically from the browser, then
   * corrected microseconds later. The alternative was a server-side rename in
   * `/passkey/verify-registration`, which means patching Better Auth.
   *
   * ENTIRELY BEST-EFFORT. By the time this runs the credential is enrolled and
   * usable, so nothing in here may surface an error, block, or retry — the
   * worst outcome is a passkey named "Tom's macOS" instead of
   * "Tom's 1Password", which the user can fix with the Rename button already
   * next to it. Every failure path returns the name that is already stored.
   *
   * It only ever overwrites a name THIS COMPONENT generated moments earlier,
   * never a user's typed rename: the id it targets comes from the enrollment
   * that just completed, and it bails when it can't identify that row.
   */
  const applyAaguidName = useCallback(
    async (
      created: PasskeyRecord | null,
      before: readonly PasskeyRecord[],
      after: readonly PasskeyRecord[] | null,
      currentName: string,
    ): Promise<string> => {
      // A failed refetch is not evidence about which row is new. Bail rather
      // than diff against a stale list.
      if (!after) return currentName;

      const enrolled = findEnrolledPasskey(created, before, after);
      if (!enrolled) {
        // Reachable two ways: Better Auth stopped returning the created row
        // (a contract change we want to hear about — it is typed `Passkey` and
        // should always be there), or a second tab enrolled at the same moment
        // and made the ID diff ambiguous. The first is a silent regression, so
        // it is traced rather than swallowed; the second is rare enough that
        // the noise is worth it.
        traceIgnoredError("account.passkeys.aaguidRename.unidentified")(
          new Error(
            `Could not identify the enrolled passkey (before=${before.length}, after=${after.length}, createdId=${created?.id ? "yes" : "no"})`,
          ),
        );
        return currentName;
      }

      const label = passkeyAaguidLabel(enrolled.aaguid);
      // The common, expected outcome: the authenticator reported the all-zero
      // AAGUID (privacy) or a model not in the table. Keep the browser guess —
      // the fallback ladder is label -> browser -> nothing, and inventing a
      // name here would be worse than either.
      if (!label) return currentName;

      const nextName = derivePasskeyName({
        deviceLabel: label,
        userName,
        // Exclude the row we are renaming so it cannot collide with itself and
        // pick up a spurious " (2)".
        existingNames: after
          .filter((pk) => pk.id !== enrolled.id)
          .map((pk) => pk.name),
      });
      if (normalizePasskeyName(nextName) === normalizePasskeyName(currentName)) {
        return currentName;
      }

      try {
        const result = await authClient.passkey.updatePasskey({
          id: enrolled.id,
          name: nextName,
        });
        // A returned error is NOT surfaced to the user: the enrollment
        // succeeded, and a toast here would read as though it hadn't. It is
        // still reported, because a rename the server systematically refuses is
        // a defect nobody would otherwise ever see.
        if (result?.error) {
          traceIgnoredError("account.passkeys.aaguidRename")(
            new Error(
              result.error.message ?? "updatePasskey returned an error",
            ),
          );
          return currentName;
        }
      } catch (err) {
        traceIgnoredError("account.passkeys.aaguidRename")(err);
        return currentName;
      }

      await refresh();
      return nextName;
    },
    [refresh, userName],
  );

  const handleAdd = useCallback(async () => {
    if (!passkeySupported) return;
    setEnrolling(true);
    try {
      const before = passkeys ?? [];
      // Shared derivation (`@th/types`) — deliberately date-free; the row below
      // already renders "Added <date>". Collisions are disambiguated against
      // the names already on the account.
      const defaultName = derivePasskeyName({
        deviceLabel: detectDeviceLabel(),
        userName,
        existingNames: before.map((pk) => pk.name),
      });
      const result = await authClient.passkey.addPasskey({ name: defaultName });
      if (result?.error) {
        toast.danger({
          id: "passkey-add-failed",
          title: "Couldn't add passkey",
          message:
            result.error.message ??
            "Try again from a device that supports passkeys.",
        });
        return;
      }
      invalidateSecondFactorGates();
      const after = await refresh();
      // Deliberately BEFORE the toast, so the message names what is actually
      // stored. Toasting `defaultName` first and letting the list settle on the
      // AAGUID name a moment later reads as a bug ('it said "Tom’s macOS"').
      // The added latency is one already-required refetch plus, at most, one
      // update call.
      const storedName = await applyAaguidName(
        // `as unknown as`, matching the list cast in `refresh`: Better Auth's
        // `Passkey` types `createdAt` as a `Date` while the wire (and this
        // component) sees the serialized string.
        (result?.data as unknown as PasskeyRecord | null | undefined) ?? null,
        before,
        after,
        defaultName,
      );
      toast.success({
        id: "passkey-added",
        title: "Passkey added",
        message: `Saved as "${storedName}".`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't add passkey.";
      const isUserCancel =
        msg.toLowerCase().includes("cancel") || msg.includes("NotAllowedError");
      if (!isUserCancel) {
        toast.danger({
          id: "passkey-add-failed",
          title: "Couldn't add passkey",
          message: msg,
        });
      }
    } finally {
      setEnrolling(false);
    }
  }, [
    applyAaguidName,
    passkeySupported,
    passkeys,
    userName,
    refresh,
    toast,
    invalidateSecondFactorGates,
  ]);

  const handleStartRename = useCallback(
    (passkey: PasskeyRecord) => {
      // Never interrupt an in-flight save; otherwise switching rows just moves
      // the edit target (a discarded nickname draft is cheap).
      if (savingId) return;
      setEditingId(passkey.id);
      // Prefill with the STORED name. "Untitled passkey" is a render-time
      // fallback, not data — pre-filling it would let the user accidentally
      // save the placeholder as a real name.
      setDraftName(passkey.name ?? "");
    },
    [savingId],
  );

  const handleCancelRename = useCallback(() => {
    setEditingId(null);
    setDraftName("");
  }, []);

  const handleRename = useCallback(
    async (passkey: PasskeyRecord) => {
      // The Save button is deliberately not natively `disabled` while a save is
      // in flight (see PasskeyRow), so a second press is reachable — this is the
      // guard that actually stops the duplicate request.
      if (savingId) return;
      const nextName = normalizePasskeyName(draftName);
      if (!nextName || nextName === normalizePasskeyName(passkey.name)) return;
      // Durable half of the collision guard. The row derives the same check to
      // render the inline message and block Save, but that is UI state; this is
      // what stops the request. Deliberately NOT a silent " (2)" suffix like the
      // enroll path uses — quietly storing a different name than the one the
      // user typed is worse than telling them.
      if (
        nameKeysById.some(
          (entry) =>
            entry.id !== passkey.id && entry.key === nextName.toLowerCase(),
        )
      ) {
        return;
      }
      setSavingId(passkey.id);
      try {
        const result = await authClient.passkey.updatePasskey({
          id: passkey.id,
          name: nextName,
        });
        if (result?.error) {
          // Stay in edit mode so the typed value isn't lost on a retry.
          toast.danger({
            id: "passkey-rename-failed",
            title: "Couldn't rename passkey",
            message: result.error.message ?? "Try again.",
          });
          // Reconcile: the most likely reason the server refused is that this
          // credential is gone (removed in another tab), and without a refetch
          // the user retries forever against a row that no longer exists. Safe
          // now that a refetch no longer blanks the list out from under the
          // open field.
          await refresh();
          return;
        }
        toast.success({
          id: "passkey-renamed",
          title: "Passkey renamed",
          message: `Saved as "${nextName}".`,
        });
        setEditingId(null);
        setDraftName("");
        // Deliberately NOT invalidateSecondFactorGates(): a rename can't change
        // second-factor enrollment status — only adding or removing a passkey
        // can (see the comment on that callback).
        await refresh();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Couldn't rename passkey.";
        toast.danger({
          id: "passkey-rename-failed",
          title: "Couldn't rename passkey",
          message: msg,
        });
        // No refresh() on a THROWN failure: that is usually the network, and
        // `refresh` would fail too — leaving the list as-is beats swapping it
        // for a stale/empty one while the user still has a draft open.
      } finally {
        setSavingId(null);
      }
    },
    [draftName, nameKeysById, refresh, savingId, toast],
  );

  const handleDelete = useCallback(
    async (passkeyId: string) => {
      // Mirrors handleStartRename's guard, plus a re-entrancy guard of its own:
      // the Remove button is no longer natively `disabled` while its own delete
      // is in flight (aria-busy instead), so a second press is reachable.
      if (savingId || removingId) return;
      setRemovingId(passkeyId);
      try {
        const result = await authClient.passkey.deletePasskey({
          id: passkeyId,
        });
        if (result?.error) {
          toast.danger({
            id: "passkey-delete-failed",
            title: "Couldn't remove passkey",
            message: result.error.message ?? "Try again.",
          });
          return;
        }
        toast.success({
          id: "passkey-removed",
          title: "Passkey removed",
        });
        // Removing the last passkey can revoke staff second-factor status,
        // so the gate probes must be refreshed on delete too.
        invalidateSecondFactorGates();
        // Armed BEFORE the refetch; consumed by the effect that runs once the
        // new list has actually been committed (see its comment).
        restoreFocusAfterDeleteRef.current = true;
        await refresh();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Couldn't remove passkey.";
        toast.danger({
          id: "passkey-delete-failed",
          title: "Couldn't remove passkey",
          message: msg,
        });
      } finally {
        setRemovingId(null);
      }
    },
    [refresh, removingId, savingId, toast, invalidateSecondFactorGates],
  );

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Fingerprint size={18} color="var(--colorMuted)" />
        <Text variant="h4" weight="bold">
          Passkeys
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        Passkeys let you sign in with Touch ID, Face ID, or a security key — no
        password to remember.
      </Text>

      {!passkeySupported ? (
        <Text variant="bodySmall" tone="muted">
          Your browser doesn't support passkeys yet. Try a recent Chrome,
          Safari, Edge, or Firefox.
        </Text>
      ) : (
        <>
          {loading ? (
            <XStack alignItems="center" gap="$2" paddingVertical="$3">
              <Spinner size="sm" />
              <Text variant="bodySmall" tone="muted">
                Loading your passkeys…
              </Text>
            </XStack>
          ) : passkeys && passkeys.length > 0 ? (
            <YStack
              gap="$2"
              borderWidth={2}
              borderColor="$borderColor"
              borderRadius={0}
            >
              {passkeys.map((pk, index) => (
                <PasskeyRow
                  key={pk.id}
                  passkey={pk}
                  isLast={index === passkeys.length - 1}
                  editing={editingId === pk.id}
                  saving={savingId === pk.id}
                  removing={removingId === pk.id}
                  // A rename in flight elsewhere blocks this row's actions, so
                  // the buttons' appearance matches the guard in
                  // `handleStartRename` instead of clicking through to a no-op.
                  locked={savingId !== null && savingId !== pk.id}
                  draftName={editingId === pk.id ? draftName : ""}
                  siblingNameKeys={nameKeysById
                    .filter(
                      (entry): entry is { id: string; key: string } =>
                        entry.id !== pk.id && entry.key !== null,
                    )
                    .map((entry) => entry.key)}
                  onDraftNameChangeAction={setDraftName}
                  onStartRenameAction={handleStartRename}
                  onCancelRenameAction={handleCancelRename}
                  onSubmitRenameAction={(passkey) => void handleRename(passkey)}
                  onRemoveAction={(passkeyId) => void handleDelete(passkeyId)}
                />
              ))}
            </YStack>
          ) : (
            <Text variant="bodySmall" tone="muted">
              No passkeys yet. Add one to skip the password next time.
            </Text>
          )}

          <YStack gap="$2">
            <XStack>
              <Button
                ref={addButtonRef}
                size={TOUCH_SIZE}
                disabled={enrolling}
                onPress={() => void handleAdd()}
                testID="passkey-add"
              >
                <XStack gap="$2" alignItems="center">
                  {enrolling ? (
                    <Spinner size="sm" indicatorColor="$onBrandSecondary" />
                  ) : (
                    <Plus size={14} color="var(--onBrandSecondary, #FFFFFF)" />
                  )}
                  <Text
                    weight="bold"
                    color="$onBrandSecondary"
                    textTransform="uppercase"
                    letterSpacing={1}
                  >
                    {enrolling ? "Adding…" : "Add a passkey"}
                  </Text>
                </XStack>
              </Button>
            </XStack>
            <Text variant="caption" tone="muted">
              If you lose this device, you can still sign in with your password
              or social provider and enroll a new passkey here.
            </Text>
          </YStack>
        </>
      )}
    </SectionCard>
  );
}

PasskeysSection.displayName = "PasskeysSection";
