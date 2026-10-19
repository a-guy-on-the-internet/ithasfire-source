"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { styled, XStack, YStack, useTheme } from "tamagui";
import {
  Plus,
  Trash2,
  GripVertical,
  ExternalLink,
  Users,
  Link,
  Copy,
  Check,
  UserPlus,
  ChevronUp,
  ChevronDown,
  Bell,
} from "lucide-react";

import {
  Text,
  TextInput,
  Button,
  StyledSelect,
  Badge,
  useNotify,
  useTranslations,
} from "@th/ui";
import { toSafeExternalUrl } from "@th/types";
import { HumanSearchCombobox } from "./HumanSearchCombobox";
import { FieldLabel } from "./_form-bits";
import {
  EditorCard,
  EditorCardActions,
  EditorCardMeta,
  EditorCardTitle,
} from "./_mobile-bits";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

/* ── Types ───────────────────────────────────────────────────────── */

const EVENT_HUMAN_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "VOLUNTEER",
  "OTHER",
] as const;

type EventHumanRole = (typeof EVENT_HUMAN_ROLES)[number];

const ROLE_I18N_MAP: Record<EventHumanRole, string> = {
  PERFORMER: "admin.ebLineupRolePerformer",
  HOST: "admin.ebLineupRoleHost",
  DJ: "admin.ebLineupRoleDj",
  INSTRUCTOR: "admin.ebLineupRoleInstructor",
  SPEAKER: "admin.ebLineupRoleSpeaker",
  VENDOR: "admin.ebLineupRoleVendor",
  VOLUNTEER: "admin.ebLineupRoleVolunteer",
  OTHER: "admin.ebLineupRoleOther",
};

/* ── Styled components ───────────────────────────────────────────── */

const PersonRow = styled(XStack, {
  padding: 12,
  paddingHorizontal: 16,
  borderWidth: 1,
  borderColor: "$borderColor",
  alignItems: "center",
  gap: 12,
  borderRadius: 0,
  backgroundColor: "$surface",
  variants: {
    dragging: {
      true: {
        opacity: 0.4,
        borderColor: "$accent",
        borderStyle: "dashed",
      },
    },
    dragOver: {
      true: {
        borderColor: "$accent",
        backgroundColor: "$surfaceMuted",
      },
    },
  } as const,
});

const DragHandle = styled(XStack, {
  cursor: "grab",
  padding: 4,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  pressStyle: { cursor: "grabbing" },
});

const AddRow = styled(XStack, {
  gap: 8,
  flexWrap: "wrap",
  alignItems: "flex-end",
});

/* ── Component ───────────────────────────────────────────────────── */

export type LineupEditorProps = {
  eventId: string;
  /**
   * The event is an ownerless COMMUNITY listing.
   *
   * `eventHumans.*` admits a community moderator, so the lineup itself works —
   * but the two payout-shaped affordances in here do NOT. Referral links
   * (`getPerformerShareLinks`) and "invite to set up payouts"
   * (`inviteLineupHumanToRegister`) are both owner-gated, and both are about
   * routing money a listing never takes. They are not rendered, and the read
   * behind them is not fired: MEASURED, it answered NOT_RESOURCE_OWNER on every
   * community builder load.
   */
  communityMode?: boolean;
};

export function LineupEditor({
  eventId,
  communityMode = false,
}: LineupEditorProps) {
  const { toast } = useNotify();
  const t = useTranslations();
  const utils = trpc.useUtils();
  const theme = useTheme();
  const isMobile = useIsMobile();
  // The actor's own human id: `listEventOwnerEntities`' one `human` entry is
  // always the caller (already fetched by the admin shell). Adding yourself
  // notifies nobody, so the notify caption must not claim otherwise.
  const { ownersWithSlugs } = useEventOwnerEntities();
  const actorHumanId =
    ownersWithSlugs?.find((o) => o.kind === "human")?.humanId ?? null;

  /* ── Query ──────────────────────────────────────────────────────── */

  const lineupQuery = trpc.eventHumans.list.useQuery(
    { eventId },
    { enabled: !!eventId },
  );

  const lineup = useMemo(() => lineupQuery.data ?? [], [lineupQuery.data]);

  const shareLinksQuery = trpc.eventHumans.getPerformerShareLinks.useQuery(
    { eventId },
    { enabled: !!eventId && !communityMode },
  );
  const shareLinks = shareLinksQuery.data;

  /* ── Mutations ──────────────────────────────────────────────────── */

  const attachMutation = trpc.eventHumans.attach.useMutation();
  const detachMutation = trpc.eventHumans.detach.useMutation();
  const reorderMutation = trpc.eventHumans.reorder.useMutation();
  const inviteMutation = trpc.events.inviteLineupHumanToRegister.useMutation();

  /* ── Invite UI state ────────────────────────────────────────────── */
  // The "Invite to set up payouts" inline form is open per-row. Free-text
  // lineup entries (no humanId) get an UpgradeRow when they expand. After
  // success the lineup query refetches and the row renders as registered.
  const [inviteRowId, setInviteRowId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");

  const handleInvite = useCallback(
    async (eventHumanId: string) => {
      const email = inviteEmail.trim();
      if (!email) return;
      try {
        await inviteMutation.mutateAsync({ eventHumanId, email });
        setInviteRowId(null);
        setInviteEmail("");
        void utils.eventHumans.list.invalidate({ eventId });
        toast.success({
          id: "lineup-invite-sent",
          title: "Invite sent",
          message:
            "They'll appear in the payout-line picker once they finish Stripe Connect setup.",
        });
      } catch (err) {
        toast.danger({
          id: "lineup-invite-failed",
          title: "Could not send invite",
          message: formatErrorMessage(err, t),
        });
      }
    },
    [inviteEmail, inviteMutation, eventId, utils, toast],
  );

  /* ── Form state ─────────────────────────────────────────────────── */

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [role, setRole] = useState<EventHumanRole>("PERFORMER");
  const [customRoleLabel, setCustomRoleLabel] = useState("");
  const [selectedHumanId, setSelectedHumanId] = useState<string | null>(null);
  const [selectedHumanDisplayName, setSelectedHumanDisplayName] = useState<
    string | null
  >(null);

  const roleOptions = useMemo(
    () =>
      EVENT_HUMAN_ROLES.map((r) => ({
        label: String(t(ROLE_I18N_MAP[r] as Parameters<typeof t>[0])),
        value: r,
      })),
    [t],
  );

  // Resolve a lineup entry's role to its display label (custom label for OTHER,
  // otherwise the localized role name). Shared by desktop badge + mobile card meta.
  const roleLabelFor = useCallback(
    (person: { role: string; customRoleLabel?: string | null }) =>
      person.role === "OTHER" && person.customRoleLabel
        ? person.customRoleLabel
        : String(
            t(
              ROLE_I18N_MAP[person.role as EventHumanRole] as Parameters<
                typeof t
              >[0],
            ),
          ),
    [t],
  );

  /* ── Handlers ───────────────────────────────────────────────────── */

  const handleAdd = useCallback(async () => {
    const trimmedName = name.trim();
    if (!selectedHumanId && !trimmedName) return;

    try {
      if (selectedHumanId) {
        await attachMutation.mutateAsync({
          eventId,
          humanId: selectedHumanId,
          externalName: (selectedHumanDisplayName ?? trimmedName) || null,
          externalUrl: null,
          role,
          customRoleLabel:
            role === "OTHER" ? customRoleLabel.trim() || null : null,
          sortOrder: lineup.length,
        });
      } else {
        await attachMutation.mutateAsync({
          eventId,
          externalName: trimmedName,
          externalUrl: url.trim() || null,
          role,
          customRoleLabel:
            role === "OTHER" ? customRoleLabel.trim() || null : null,
          sortOrder: lineup.length,
        });
      }
      setName("");
      setUrl("");
      setRole("PERFORMER");
      setCustomRoleLabel("");
      setSelectedHumanId(null);
      setSelectedHumanDisplayName(null);
      void utils.eventHumans.list.invalidate({ eventId });
      toast.success({ title: String(t("admin.ebLineupAdded")) });
    } catch (err) {
      toast.danger({
        title: String(t("admin.ebLineupAddFailed")),
        message: formatErrorMessage(err, t),
      });
    }
  }, [
    name,
    url,
    role,
    customRoleLabel,
    selectedHumanId,
    selectedHumanDisplayName,
    eventId,
    lineup.length,
    attachMutation,
    utils,
    toast,
    t,
  ]);

  const handleRemove = useCallback(
    async (eventHumanId: string) => {
      try {
        await detachMutation.mutateAsync({ eventHumanId });
        void utils.eventHumans.list.invalidate({ eventId });
        toast.success({ title: String(t("admin.ebLineupRemoved")) });
      } catch (err) {
        toast.danger({
          title: String(t("admin.ebLineupRemoveFailed")),
          message: formatErrorMessage(err, t),
        });
      }
    },
    [detachMutation, eventId, utils, toast, t],
  );

  const handleMove = useCallback(
    async (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      if (toIndex < 0 || toIndex >= lineup.length) return;

      const reordered = [...lineup];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);

      const orderedIds = reordered.map((h) => h.id);

      try {
        await reorderMutation.mutateAsync({ eventId, orderedIds });
        void utils.eventHumans.list.invalidate({ eventId });
        toast.success({ title: String(t("admin.ebLineupReordered")) });
      } catch (err) {
        toast.danger({
          title: String(t("admin.ebLineupReorderFailed")),
          message: formatErrorMessage(err, t),
        });
      }
    },
    [lineup, eventId, reorderMutation, utils, toast, t],
  );

  /* ── Drag state ─────────────────────────────────────────────────── */

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragCounterRef = useRef(0);

  /* ── Copy state ─────────────────────────────────────────────── */

  const [copiedUrls, setCopiedUrls] = useState<Record<string, boolean>>({});

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragIndex(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragCounterRef.current = 0;
  }, []);

  const handleDragEnter = useCallback((idx: number) => {
    dragCounterRef.current += 1;
    setDragOverIndex(idx);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      setDragOverIndex(null);
      dragCounterRef.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, toIdx: number) => {
      e.preventDefault();
      const fromIdx = Number(e.dataTransfer.getData("text/plain"));
      setDragIndex(null);
      setDragOverIndex(null);
      dragCounterRef.current = 0;
      if (!isNaN(fromIdx) && fromIdx !== toIdx) {
        void handleMove(fromIdx, toIdx);
      }
    },
    [handleMove],
  );

  /* ── Copy handlers ────────────────────────────────────────── */

  const handleCopy = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setCopiedUrls((prev) => ({ ...prev, [url]: true }));
        toast.success({ title: "Copied!" });
        setTimeout(() => {
          setCopiedUrls((prev) => ({ ...prev, [url]: false }));
        }, 2000);
      } catch {
        toast.danger({ title: "Failed to copy. Please try again." });
      }
    },
    [toast],
  );

  const handleCopyAll = useCallback(async () => {
    if (!shareLinks?.performers?.length) return;
    // `shareUrl` is null until the event has a slug (assigned at publish) —
    // there is no link to copy yet, so those performers are skipped.
    const text = shareLinks.performers
      .filter((p) => p.shareUrl)
      .map((p) => `${p.name}: ${p.shareUrl}`)
      .join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success({ title: "All links copied!" });
    } catch {
      toast.danger({ title: "Failed to copy. Please try again." });
    }
  }, [shareLinks, toast]);

  /* ── Render ─────────────────────────────────────────────────────── */

  const isBusy =
    attachMutation.isPending ||
    detachMutation.isPending ||
    reorderMutation.isPending;

  return (
    <YStack
      paddingVertical={isMobile ? 20 : 32}
      paddingHorizontal={isMobile ? 16 : 32}
      gap={isMobile ? 20 : 24}
      maxWidth={960}
      width="100%"
      marginHorizontal="auto"
    >
      {/* Header */}
      <YStack gap={4}>
        <XStack alignItems="center" gap={8}>
          <Users size={16} color={theme.color?.val} />
          <FieldLabel>{String(t("admin.ebLineup"))}</FieldLabel>
        </XStack>
        <Text variant="caption" tone="muted">
          {String(t("admin.ebLineupHint"))}
        </Text>
      </YStack>

      {/* Current lineup */}
      {lineup.length > 0 ? (
        <YStack gap={8}>
          {lineup.map((person, idx) => {
            const displayName =
              person.humanDisplayName ?? person.externalName ?? "—";
            const { profileSlug } = person;
            const safeExternalUrl = toSafeExternalUrl(person.externalUrl);
            const roleLabel = roleLabelFor(person);

            // Shared name node — a profile/external link with an ExternalLink
            // glyph, or plain bold text. Identical between desktop row + mobile
            // card so the link affordance survives the responsive reshape.
            const linkHref =
              person.humanId && profileSlug
                ? `/p/${profileSlug}`
                : !person.humanId && safeExternalUrl
                  ? safeExternalUrl
                  : null;
            const nameNode = linkHref ? (
              <XStack
                tag="a"
                {...{
                  href: linkHref,
                  target: "_blank",
                  rel: "noopener noreferrer",
                }}
                alignItems="center"
                gap={4}
                cursor="pointer"
                hoverStyle={{ opacity: 0.7 }}
                flexShrink={1}
                minWidth={0}
              >
                <Text
                  variant="body"
                  weight="bold"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {displayName}
                </Text>
                <ExternalLink
                  size={12}
                  color={theme.colorMuted?.val}
                  style={{ flexShrink: 0 }}
                />
              </XStack>
            ) : (
              <Text variant="body" weight="bold">
                {displayName}
              </Text>
            );

            // ── Mobile: stacked EditorCard ──────────────────────────────
            // The card is STATIC (no onPress) because it carries inline
            // controls in the actions slot. Reorder uses explicit Move-up /
            // Move-down buttons wired to the same handleMove() the desktop
            // drag-and-drop calls — touch DnD is unreliable on phones.
            if (isMobile) {
              return (
                <YStack key={person.id} gap={4}>
                  <EditorCard
                    actions={
                      <EditorCardActions>
                        <Button
                          variant="ghost"
                          size="$4"
                          icon
                          minWidth={44}
                          onPress={() => void handleMove(idx, idx - 1)}
                          disabled={idx === 0 || isBusy}
                          aria-label={String(t("admin.toolbarMoveUp"))}
                          data-testid={`lineup-move-up-${person.id}`}
                        >
                          <ChevronUp size={18} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="$4"
                          icon
                          minWidth={44}
                          onPress={() => void handleMove(idx, idx + 1)}
                          disabled={idx === lineup.length - 1 || isBusy}
                          aria-label={String(t("admin.toolbarMoveDown"))}
                          data-testid={`lineup-move-down-${person.id}`}
                        >
                          <ChevronDown size={18} />
                        </Button>
                        {!person.humanId && !communityMode ? (
                          <Button
                            variant="ghost"
                            size="$4"
                            icon
                            minWidth={44}
                            onPress={() => {
                              setInviteRowId(
                                inviteRowId === person.id ? null : person.id,
                              );
                              setInviteEmail("");
                            }}
                            aria-label="Invite to set up payouts"
                            data-testid={`lineup-invite-${person.id}`}
                          >
                            <UserPlus size={18} />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="$4"
                          icon
                          minWidth={44}
                          onPress={() => void handleRemove(person.id)}
                          aria-label={String(t("admin.ebLineupRemoveConfirm"))}
                          data-testid={`lineup-remove-${person.id}`}
                        >
                          <Trash2 size={18} />
                        </Button>
                      </EditorCardActions>
                    }
                  >
                    {/* Title: keep the profile/external link affordance, but
                        render the anchor as the Text itself (tag="a") rather
                        than nesting an XStack inside Text. */}
                    {linkHref ? (
                      <EditorCardTitle
                        tag="a"
                        {...({
                          href: linkHref,
                          target: "_blank",
                          rel: "noopener noreferrer",
                        } as Record<string, unknown>)}
                        hoverStyle={{ opacity: 0.7 }}
                      >
                        {displayName}
                      </EditorCardTitle>
                    ) : (
                      <EditorCardTitle>{displayName}</EditorCardTitle>
                    )}
                    <EditorCardMeta>{roleLabel}</EditorCardMeta>
                  </EditorCard>

                  {/* Inline invite form (free-text rows only) */}
                  {inviteRowId === person.id && !person.humanId ? (
                    <YStack
                      gap={8}
                      padding={12}
                      borderWidth={1}
                      borderColor="$borderColor"
                      backgroundColor="$surfaceMuted"
                    >
                      <Text variant="caption" tone="muted">
                        Send a Stripe Connect onboarding invite. Once they
                        finish setup, they'll appear as a quick-pick in the
                        payout-line picker.
                      </Text>
                      <YStack gap={8}>
                        <YStack gap={4}>
                          <Text variant="caption" tone="muted">
                            Email
                          </Text>
                          <TextInput
                            value={inviteEmail}
                            onChangeText={setInviteEmail}
                            placeholder="performer@example.com"
                            inputMode="email"
                            fullWidth
                            minHeight={44}
                            fontSize={16}
                          />
                        </YStack>
                        <XStack gap={8}>
                          <Button
                            variant="primary"
                            size="$4"
                            flex={1}
                            onPress={() => void handleInvite(person.id)}
                            disabled={
                              inviteMutation.isPending ||
                              inviteEmail.trim().length === 0
                            }
                          >
                            Send invite
                          </Button>
                          <Button
                            variant="ghost"
                            size="$4"
                            flex={1}
                            onPress={() => {
                              setInviteRowId(null);
                              setInviteEmail("");
                            }}
                          >
                            Cancel
                          </Button>
                        </XStack>
                      </YStack>
                    </YStack>
                  ) : null}
                </YStack>
              );
            }

            // ── Desktop: drag-and-drop PersonRow (unchanged) ────────────
            return (
              <YStack key={person.id} gap={4}>
                <PersonRow
                  dragging={dragIndex === idx}
                  dragOver={dragOverIndex === idx && dragIndex !== idx}
                  {...({ draggable: true } as any)}
                  onDragStart={(e: React.DragEvent) => handleDragStart(e, idx)}
                  onDragEnd={handleDragEnd}
                  onDragEnter={() => handleDragEnter(idx)}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={(e: React.DragEvent) => handleDrop(e, idx)}
                >
                  {/* Drag handle */}
                  <DragHandle data-testid={`lineup-drag-handle-${person.id}`}>
                    <GripVertical size={16} color={theme.colorMuted?.val} />
                  </DragHandle>

                  {/* Name + URL */}
                  <YStack flex={1} gap={2}>
                    {nameNode}
                  </YStack>

                  {/* Role badge */}
                  <Badge variant="outline" size="sm">
                    {roleLabel}
                  </Badge>

                  {/* Invite-to-payout (free-text rows only, owned events only) */}
                  {!person.humanId && !communityMode ? (
                    <XStack
                      cursor="pointer"
                      onPress={() => {
                        setInviteRowId(
                          inviteRowId === person.id ? null : person.id,
                        );
                        setInviteEmail("");
                      }}
                      padding={4}
                      hoverStyle={{ opacity: 0.7 }}
                      data-testid={`lineup-invite-${person.id}`}
                      alignItems="center"
                      gap={4}
                    >
                      <UserPlus size={14} color={theme.colorMuted?.val} />
                      <Text variant="caption" tone="muted">
                        Invite
                      </Text>
                    </XStack>
                  ) : null}

                  {/* Remove */}
                  <XStack
                    cursor="pointer"
                    onPress={() => void handleRemove(person.id)}
                    padding={4}
                    hoverStyle={{ opacity: 0.7 }}
                    data-testid={`lineup-remove-${person.id}`}
                  >
                    <Trash2 size={16} color={theme.colorMuted?.val} />
                  </XStack>
                </PersonRow>

                {/* Inline invite form for free-text rows */}
              {inviteRowId === person.id && !person.humanId ? (
                <YStack
                  gap={8}
                  padding={12}
                  borderWidth={1}
                  borderColor="$borderColor"
                  backgroundColor="$surfaceMuted"
                >
                  <Text variant="caption" tone="muted">
                    Send a Stripe Connect onboarding invite. Once they finish
                    setup, they'll appear as a quick-pick in the payout-line
                    picker.
                  </Text>
                  <XStack gap={8} flexWrap="wrap" alignItems="flex-end">
                    <YStack flex={1} minWidth={200} gap={4}>
                      <Text variant="caption" tone="muted">
                        Email
                      </Text>
                      <TextInput
                        value={inviteEmail}
                        onChangeText={setInviteEmail}
                        placeholder="performer@example.com"
                        inputMode="email"
                        fullWidth
                      />
                    </YStack>
                    <Button
                      variant="primary"
                      size="$2"
                      onPress={() => void handleInvite(person.id)}
                      disabled={
                        inviteMutation.isPending ||
                        inviteEmail.trim().length === 0
                      }
                    >
                      Send invite
                    </Button>
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() => {
                        setInviteRowId(null);
                        setInviteEmail("");
                      }}
                    >
                      Cancel
                    </Button>
                  </XStack>
                </YStack>
              ) : null}
              </YStack>
            );
          })}
        </YStack>
      ) : (
        <Text variant="body" tone="muted">
          {String(t("admin.ebLineupEmpty"))}
        </Text>
      )}

      {/* Referral Links — owned events only (see `communityMode`). */}
      {!!eventId && !communityMode && (
        <>
          {/* Separator */}
          <XStack
            width="100%"
            height={0}
            borderBottomWidth={1}
            borderColor="$borderColor"
          />

          <YStack gap={12}>
            {/* Section header */}
            <XStack alignItems="center" justifyContent="space-between">
              <XStack alignItems="center" gap={8}>
                <Link size={16} color={theme.color?.val} />
                <FieldLabel>Referral Links</FieldLabel>
              </XStack>
              {shareLinks?.performers && shareLinks.performers.length > 0 && (
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() => void handleCopyAll()}
                  data-testid="share-links-copy-all"
                >
                  <Copy size={12} />
                  Copy all
                </Button>
              )}
            </XStack>

            {/* Performer link rows */}
            {shareLinksQuery.isError ? (
              <Text variant="body" tone="error">
                Failed to load referral links. Please refresh the page.
              </Text>
            ) : !shareLinks || shareLinks.performers.length === 0 ? (
              <Text variant="body" tone="muted">
                Add performers to the lineup to generate share links
              </Text>
            ) : (
              <YStack gap={8}>
                {shareLinks.performers.map((performer) => (
                  <PersonRow key={performer.eventHumanId}>
                    {/* Name + role */}
                    <YStack flex={1} gap={2}>
                      <XStack gap={8} alignItems="center">
                        <Text variant="body" weight="bold">
                          {performer.name}
                        </Text>
                        <Badge variant="outline" size="sm">
                          {performer.role}
                        </Badge>
                      </XStack>
                      <Text
                        variant="caption"
                        tone="muted"
                        truncate
                        style={{ maxWidth: 320 }}
                      >
                        {performer.shareUrl ??
                          "Link available once the event is published"}
                      </Text>
                    </YStack>

                    {/* Copy button — nothing to copy before publish. */}
                    {performer.shareUrl ? (
                      <XStack
                        cursor="pointer"
                        onPress={() => void handleCopy(performer.shareUrl!)}
                        padding={4}
                        hoverStyle={{ opacity: 0.7 }}
                        alignItems="center"
                        gap={4}
                        data-testid={`share-link-copy-${performer.eventHumanId}`}
                      >
                        {copiedUrls[performer.shareUrl] ? (
                          <Check size={16} color={theme.color?.val} />
                        ) : (
                          <Copy size={16} color={theme.colorMuted?.val} />
                        )}
                      </XStack>
                    ) : null}
                  </PersonRow>
                ))}
              </YStack>
            )}
          </YStack>
        </>
      )}

      {/* Add form — wraps on desktop, stacks full-width on mobile so the
          combobox, role select, and add button each get a ≥44px row. */}
      <YStack gap={8}>
        <AddRow
          flexDirection={isMobile ? "column" : "row"}
          alignItems={isMobile ? "stretch" : "flex-end"}
        >
          <YStack
            {...(isMobile ? { width: "100%" } : { flex: 1, minWidth: 200 })}
          >
            <HumanSearchCombobox
              selectedHumanId={selectedHumanId}
              selectedDisplayName={selectedHumanDisplayName}
              inputValue={name}
              onInputChange={setName}
              onSelect={(humanId, displayName) => {
                setSelectedHumanId(humanId);
                setSelectedHumanDisplayName(displayName);
                setName(displayName);
              }}
              onClear={() => {
                setSelectedHumanId(null);
                setSelectedHumanDisplayName(null);
                setName("");
              }}
              placeholder={String(t("admin.ebLineupNamePlaceholder"))}
              testId="lineup-name-input"
              fullWidth={isMobile}
            />
          </YStack>

          {!selectedHumanId && (
            <YStack
              gap={4}
              {...(isMobile ? { width: "100%" } : { flex: 1, minWidth: 160 })}
            >
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder={String(t("admin.ebLineupUrlPlaceholder"))}
                maxLength={500}
                testId="lineup-url-input"
                fullWidth={isMobile}
                {...(isMobile ? { minHeight: 44, fontSize: 16 } : {})}
              />
            </YStack>
          )}

          <YStack
            gap={4}
            {...(isMobile ? { width: "100%" } : { minWidth: 140 })}
          >
            <StyledSelect
              value={role}
              options={roleOptions}
              onChange={(val) => {
                setRole(val as EventHumanRole);
                if (val !== "OTHER") setCustomRoleLabel("");
              }}
              placeholder={String(t("admin.ebLineupRole"))}
              testId="lineup-role-select"
              {...(isMobile
                ? { fullWidth: true, minHeight: 44, height: 44 }
                : {})}
            />
          </YStack>

          {role === "OTHER" && (
            <YStack
              gap={4}
              {...(isMobile ? { width: "100%" } : { flex: 1, minWidth: 120 })}
            >
              <TextInput
                value={customRoleLabel}
                onChangeText={setCustomRoleLabel}
                placeholder={String(t("admin.ebLineupCustomRolePlaceholder"))}
                maxLength={60}
                testId="lineup-custom-role-input"
                fullWidth={isMobile}
                {...(isMobile ? { minHeight: 44, fontSize: 16 } : {})}
              />
            </YStack>
          )}

          <Button
            variant="secondary"
            size={isMobile ? "$4" : "$2"}
            onPress={() => void handleAdd()}
            disabled={(!name.trim() && !selectedHumanId) || isBusy}
            data-testid="lineup-add-button"
            {...(isMobile ? { width: "100%" } : {})}
          >
            <Plus size={14} />
            {String(t("admin.ebAddToLineup"))}
          </Button>
        </AddRow>

        {/* A picked profile is a real person, and attaching them notifies them
            (now if published, else at publish). A free-typed name tells nobody,
            so the caption only appears for a selected profile — and not when
            that profile is the editor themself (the server skips self). */}
        {selectedHumanId && selectedHumanId !== actorHumanId ? (
          <XStack gap={8} alignItems="center" data-testid="lineup-notify-hint">
            <Bell
              size={14}
              color="var(--colorMuted, #5C544A)"
              aria-hidden
              style={{ flexShrink: 0 }}
            />
            <Text variant="caption" tone="muted" flexShrink={1}>
              {String(
                t("admin.ebLineupNotifyHint", {
                  name: selectedHumanDisplayName?.trim() || name.trim(),
                }),
              )}
            </Text>
          </XStack>
        ) : null}
      </YStack>
    </YStack>
  );
}
