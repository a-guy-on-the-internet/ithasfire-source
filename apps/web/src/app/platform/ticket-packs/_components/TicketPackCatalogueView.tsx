"use client";

/**
 * TicketPackCatalogueView — the staff pack list (ticket-type-packs FR-012).
 * Mirrors the volunteer PackCatalogueView: what is live, and which packs
 * organizers actually adopt — the fork count is the HEADLINE numeral, the
 * only signal a pack earns its place in the catalogue.
 *
 * Creating a pack happens here rather than on a `/new` route: `new` is a
 * perfectly legal pack key (lowercase kebab), so a `[key]` segment that also
 * meant "create" would make one key permanently unreachable.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";
import { AlertTriangle, Plus, RefreshCw, Ticket } from "lucide-react";
import {
  Button,
  Spinner,
  StyledSelect,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  PlatformContainer,
  PlatformPageTitle,
  PlatformSectionTitle,
  PlatformSubtitle,
} from "../../_components/PlatformPageParts";
import {
  TicketPackStatusPill,
  type TicketPackStatus,
} from "./TicketPackStatusPill";
import styles from "./ticket-packs.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// Swiss content primitives — 2px ink borders, radius 0, no shadows
// ─────────────────────────────────────────────────────────────────────────────

const HeaderRule = styled(YStack, {
  height: 4,
  width: 48,
  backgroundColor: "$brandSecondary",
});

const Panel = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  padding: 16,
  gap: 12,
});

const CatalogueRow = styled(YStack, {
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  padding: 16,
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

/** Lowercase kebab — mirrors `ticketPackKeySchema`, so the form fails fast. */
const PACK_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type StatusFilter = "ALL" | TicketPackStatus;

function slugifyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

export function TicketPackCatalogueView() {
  const t = useTranslations();
  const { toast } = useNotify();
  const router = useRouter();
  const utils = trpc.useUtils();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = trpc.platform.ticketPacks.list.useQuery(
    statusFilter === "ALL" ? {} : { status: statusFilter },
    { staleTime: 15_000 },
  );

  const createMutation = trpc.platform.ticketPacks.upsert.useMutation({
    meta: { silent: true },
  });

  const handleCreate = useCallback(async () => {
    const key = newKey.trim();
    const name = newName.trim();
    if (!name) {
      setFormError(String(t("admin.ticketPackNameRequired")));
      return;
    }
    if (!PACK_KEY_PATTERN.test(key)) {
      setFormError(String(t("admin.ticketPackKeyInvalid")));
      return;
    }
    setFormError(null);
    try {
      // A create is an upsert on an unknown key, and it lands DRAFT — the
      // use case refuses to accept a status here, so "save" can never
      // publish.
      await createMutation.mutateAsync({ key, name });
      // `refetchType: "all"` — the editor resolves key → packId through
      // `list({})`, which may be inactive while a status filter is set; the
      // default would leave it stale and flash "pack not found" right after
      // "Pack created" (the volunteer catalogue's lesson).
      await utils.platform.ticketPacks.list.invalidate(undefined, {
        refetchType: "all",
      });
      setNewKey("");
      setNewName("");
      toast.success({
        id: "ticket-pack-created",
        title: String(t("admin.ticketPackCreated")),
      });
      router.push(`/platform/ticket-packs/${encodeURIComponent(key)}`);
    } catch (err) {
      setFormError(formatErrorMessage(err, t));
    }
  }, [
    newKey,
    newName,
    createMutation,
    utils.platform.ticketPacks.list,
    toast,
    t,
    router,
  ]);

  const statusOptions = useMemo(
    () => [
      { value: "ALL" as const, label: String(t("admin.ticketPackFilterAll")) },
      {
        value: "DRAFT" as const,
        label: String(t("admin.ticketPackStatusDraft")),
      },
      {
        value: "LIVE" as const,
        label: String(t("admin.ticketPackStatusLive")),
      },
    ],
    [t],
  );

  const packs = listQuery.data?.packs ?? [];

  return (
    <PlatformContainer size="lg">
      <YStack gap={8}>
        <XStack gap={10} alignItems="center" flexWrap="wrap">
          <Ticket size={22} color="var(--color, #211C16)" aria-hidden />
          <PlatformPageTitle>
            {String(t("admin.ticketPacksTitle"))}
          </PlatformPageTitle>
        </XStack>
        <PlatformSubtitle>
          {String(t("admin.ticketPacksSubtitle"))}
        </PlatformSubtitle>
        <HeaderRule />
      </YStack>

      {/* ── Create ───────────────────────────────────────────────────────── */}
      <Panel>
        <PlatformSectionTitle>
          {String(t("admin.ticketPackCreateTitle"))}
        </PlatformSectionTitle>
        <Text variant="caption" tone="muted">
          {String(t("admin.ticketPackCreateHelp"))}
        </Text>
        <XStack gap={12} flexWrap="wrap" alignItems="flex-end">
          {/* 220 floor, capped at the row: at 320 the row inside the panel
              is 202px (238 less 2px borders and 16px padding a side). */}
          <YStack gap={4} flex={1} minWidth="min(100%, 220px)">
            <Text variant="label">{String(t("admin.ticketPackFieldName"))}</Text>
            <TextInput
              value={newName}
              onChangeText={(value) => {
                setNewName(value);
                // Keep the key in step until the curator edits it themselves.
                if (newKey === "" || newKey === slugifyKey(newName)) {
                  setNewKey(slugifyKey(value));
                }
              }}
              placeholder={String(t("admin.ticketPackFieldNamePlaceholder"))}
              maxLength={120}
              fullWidth
              // `Text variant="label"` renders a <span>, not a <label
              // htmlFor>, so the visible label is invisible to a screen
              // reader.
              aria-label={String(t("admin.ticketPackFieldName"))}
              testId="ticket-pack-new-name"
            />
          </YStack>
          <YStack gap={4} flex={1} minWidth="min(100%, 220px)">
            <Text variant="label">{String(t("admin.ticketPackFieldKey"))}</Text>
            <TextInput
              value={newKey}
              onChangeText={setNewKey}
              placeholder={String(t("admin.ticketPackFieldKeyPlaceholder"))}
              maxLength={80}
              fullWidth
              aria-label={String(t("admin.ticketPackFieldKey"))}
              testId="ticket-pack-new-key"
            />
            <Text variant="caption" tone="muted">
              {String(t("admin.ticketPackFieldKeyHelp"))}
            </Text>
          </YStack>
          <Button
            variant="primary"
            size="$4"
            onPress={() => void handleCreate()}
            disabled={createMutation.isPending}
            data-testid="ticket-pack-create-submit"
            // Longhand: the size variant sets paddingLeft/Right. The
            // default padding made the label wider than a 320 panel.
            $sm={{ paddingLeft: 12, paddingRight: 12 }}
          >
            <Plus size={16} aria-hidden />
            {String(t("admin.ticketPackCreateCta"))}
          </Button>
        </XStack>
        {formError ? (
          <Text
            variant="caption"
            tone="error"
            data-testid="ticket-pack-create-error"
          >
            {formError}
          </Text>
        ) : null}
      </Panel>

      {/* ── Filter ───────────────────────────────────────────────────────── */}
      <XStack gap={12} alignItems="flex-end" flexWrap="wrap">
        <YStack gap={4} minWidth={200}>
          <Text variant="overline" tone="muted">
            {String(t("admin.ticketPackStatusFilter"))}
          </Text>
          <StyledSelect<StatusFilter>
            value={statusFilter}
            options={statusOptions}
            onChange={setStatusFilter}
            fullWidth
            size="lg"
            borderRadius={0}
            height={44}
            minHeight={44}
            testId="ticket-pack-status-filter"
          />
        </YStack>
        <Button
          variant="ghost"
          size="$4"
          onPress={() => void listQuery.refetch()}
          aria-label={String(t("admin.ticketPackRefresh"))}
        >
          <RefreshCw size={15} aria-hidden />
          {String(t("admin.ticketPackRefresh"))}
        </Button>
      </XStack>

      {/* ── List ─────────────────────────────────────────────────────────── */}
      {listQuery.isLoading ? (
        <StateFrame>
          <Spinner size="large" />
          <Text variant="body" tone="muted">
            {String(t("admin.ticketPacksLoading"))}
          </Text>
        </StateFrame>
      ) : listQuery.error ? (
        <StateFrame>
          <AlertTriangle size={26} color="var(--danger, #B91C1C)" aria-hidden />
          <Text variant="body" tone="error" textAlign="center">
            {formatErrorMessage(listQuery.error)}
          </Text>
          <Button
            variant="secondary"
            size="$4"
            onPress={() => void listQuery.refetch()}
          >
            {String(t("admin.ticketPackRetry"))}
          </Button>
        </StateFrame>
      ) : packs.length === 0 ? (
        <StateFrame>
          <Text variant="h4" weight="bold" textAlign="center">
            {String(t("admin.ticketPacksEmptyTitle"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
            {String(t("admin.ticketPacksEmptyDescription"))}
          </Text>
        </StateFrame>
      ) : (
        <YStack gap={12} data-testid="ticket-pack-list">
          {packs.map((pack) => (
            <CatalogueRow key={pack.id} data-testid={`ticket-pack-row-${pack.key}`}>
              <div className={styles.catalogueRow}>
                {/* Identity */}
                <YStack gap={6} minWidth={0}>
                  <XStack gap={8} alignItems="center" flexWrap="wrap">
                    <Text
                      variant="h5"
                      weight="bold"
                      style={{ textTransform: "uppercase" }}
                    >
                      {pack.name}
                    </Text>
                    <TicketPackStatusPill
                      status={pack.status}
                      testId={`ticket-pack-status-${pack.key}`}
                    />
                  </XStack>
                  <Text variant="code" tone="muted" truncate>
                    {pack.key}
                  </Text>
                  {pack.blurb ? (
                    <Text
                      variant="caption"
                      tone="muted"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {pack.blurb}
                    </Text>
                  ) : null}
                </YStack>

                {/* Templates */}
                <div className={styles.metric}>
                  <Text variant="overline" tone="muted">
                    {String(t("admin.ticketPackTemplatesMetric"))}
                  </Text>
                  <Text
                    variant="h5"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                    data-testid={`ticket-pack-template-count-${pack.key}`}
                  >
                    {pack.templateCount}
                  </Text>
                </div>

                {/* Entries */}
                <div className={styles.metric}>
                  <Text variant="overline" tone="muted">
                    {String(t("admin.ticketPackEntriesMetric"))}
                  </Text>
                  <Text
                    variant="h5"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {pack.entryCount}
                  </Text>
                </div>

                {/* Adoption — the number that says whether the pack earns
                    its keep, so it carries the display weight. */}
                <div className={styles.metric}>
                  <Text variant="overline" tone="muted">
                    {String(t("admin.ticketPackAdoptedMetric"))}
                  </Text>
                  <Text
                    variant="h3"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                    data-testid={`ticket-pack-fork-count-${pack.key}`}
                  >
                    {String(
                      t("admin.ticketPackAdoptedValue", {
                        count: pack.forkCount,
                      }),
                    )}
                  </Text>
                </div>

                <XStack gap={8} justifyContent="flex-end" flexWrap="wrap">
                  <Button
                    variant="secondary"
                    size="$3"
                    onPress={() =>
                      router.push(
                        `/platform/ticket-packs/${encodeURIComponent(pack.key)}`,
                      )
                    }
                    data-testid={`ticket-pack-edit-${pack.key}`}
                  >
                    {String(t("admin.ticketPackEditCta"))}
                  </Button>
                </XStack>
              </div>
            </CatalogueRow>
          ))}
        </YStack>
      )}
    </PlatformContainer>
  );
}
