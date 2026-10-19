"use client";

/**
 * PackCatalogueView — the staff pack list (FR-014).
 *
 * The list answers two questions in one glance: what is live, and which packs
 * organizers actually adopt. The fork count is therefore a HEADLINE numeral,
 * not a footnote — it is the only signal we have that a pack earns its place in
 * the catalogue, and a pack with 0 adoptions after a season is a pack to
 * rewrite or retire.
 *
 * Creating a pack happens here rather than on a `/new` route: `new` is a
 * perfectly legal pack key (lowercase kebab), so a `[key]` segment that also
 * meant "create" would make one key permanently unreachable.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";
import { AlertTriangle, Layers, Plus, RefreshCw } from "lucide-react";
import {
  Button,
  Spinner,
  StyledSelect,
  Text,
  TextInput,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";
import { categoryDisplayName } from "@/lib/category-display-name";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  PlatformContainer,
  PlatformPageTitle,
  PlatformSectionTitle,
  PlatformSubtitle,
} from "../../_components/PlatformPageParts";
import { PackStatusPill, type VolunteerPackStatus } from "./PackStatusPill";
import styles from "./volunteer-packs.module.css";

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

/** Lowercase kebab — mirrors `volunteerPackKeySchema`, so the form fails fast. */
const PACK_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type StatusFilter = "ALL" | VolunteerPackStatus;

function slugifyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

export function PackCatalogueView() {
  const t = useTranslations();
  const locale = useLocale();
  const { toast } = useNotify();
  const router = useRouter();
  const utils = trpc.useUtils();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = trpc.volunteerPacks.admin.list.useQuery(
    statusFilter === "ALL" ? {} : { status: statusFilter },
    { staleTime: 15_000 },
  );

  const categoriesQuery = trpc.categories.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categoriesQuery.data?.categories ?? []) {
      map.set(category.id, categoryDisplayName(category, locale));
    }
    return map;
  }, [categoriesQuery.data?.categories, locale]);

  const createMutation = trpc.volunteerPacks.admin.upsert.useMutation({
    meta: { silent: true },
  });

  const handleCreate = useCallback(async () => {
    const key = newKey.trim();
    const name = newName.trim();
    if (!name) {
      setFormError(String(t("admin.volunteerPackNameRequired")));
      return;
    }
    if (!PACK_KEY_PATTERN.test(key)) {
      setFormError(String(t("admin.volunteerPackKeyInvalid")));
      return;
    }
    setFormError(null);
    try {
      // A create is an upsert on an unknown key, and it lands DRAFT — the use
      // case refuses to accept a status here, so "save" can never publish.
      await createMutation.mutateAsync({ key, name });
      // `refetchType: "all"`, NOT the default `"active"`. The editor we are
      // about to navigate to resolves `key → packId` through `list({})`, but
      // when a status filter is set the ACTIVE query here is `list({status})` —
      // so the default would mark the `{}` entry stale WITHOUT refetching it
      // and the editor would mount against a cache that predates this pack,
      // flashing "No pack with the key … exists" straight after "Pack created".
      await utils.volunteerPacks.admin.list.invalidate(undefined, {
        refetchType: "all",
      });
      setNewKey("");
      setNewName("");
      toast.success({
        id: "volunteer-pack-created",
        title: String(t("admin.volunteerPackCreated")),
      });
      router.push(`/platform/volunteer-packs/${encodeURIComponent(key)}`);
    } catch (err) {
      setFormError(formatErrorMessage(err, t));
    }
  }, [
    newKey,
    newName,
    createMutation,
    utils.volunteerPacks.admin.list,
    toast,
    t,
    router,
  ]);

  const statusOptions = useMemo(
    () => [
      {
        value: "ALL" as const,
        label: String(t("admin.volunteerPackFilterAll")),
      },
      {
        value: "DRAFT" as const,
        label: String(t("admin.volunteerPackStatusDraft")),
      },
      {
        value: "LIVE" as const,
        label: String(t("admin.volunteerPackStatusLive")),
      },
    ],
    [t],
  );

  const packs = listQuery.data?.packs ?? [];

  return (
    <PlatformContainer size="lg">
      <YStack gap={8}>
        <XStack gap={10} alignItems="center" flexWrap="wrap">
          <Layers size={22} color="var(--color, #211C16)" aria-hidden />
          <PlatformPageTitle>
            {String(t("admin.volunteerPacksTitle"))}
          </PlatformPageTitle>
        </XStack>
        <PlatformSubtitle>
          {String(t("admin.volunteerPacksSubtitle"))}
        </PlatformSubtitle>
        <HeaderRule />
      </YStack>

      {/* ── Create ───────────────────────────────────────────────────────── */}
      <Panel>
        <PlatformSectionTitle>
          {String(t("admin.volunteerPackCreateTitle"))}
        </PlatformSectionTitle>
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerPackCreateHelp"))}
        </Text>
        <XStack gap={12} flexWrap="wrap" alignItems="flex-end">
          {/* 220 floor, capped at the row: at 320 the row inside the panel
              is 202px (238 less 2px borders and 16px padding a side). */}
          <YStack gap={4} flex={1} minWidth="min(100%, 220px)">
            <Text variant="label">
              {String(t("admin.volunteerPackFieldName"))}
            </Text>
            <TextInput
              value={newName}
              onChangeText={(value) => {
                setNewName(value);
                // Keep the key in step until the curator edits it themselves.
                if (newKey === "" || newKey === slugifyKey(newName)) {
                  setNewKey(slugifyKey(value));
                }
              }}
              placeholder={String(t("admin.volunteerPackFieldNamePlaceholder"))}
              maxLength={120}
              fullWidth
              // `Text variant="label"` renders a <span>, not a <label htmlFor>,
              // so the visible label is invisible to a screen reader.
              aria-label={String(t("admin.volunteerPackFieldName"))}
              testId="volunteer-pack-new-name"
            />
          </YStack>
          <YStack gap={4} flex={1} minWidth="min(100%, 220px)">
            <Text variant="label">
              {String(t("admin.volunteerPackFieldKey"))}
            </Text>
            <TextInput
              value={newKey}
              onChangeText={setNewKey}
              placeholder={String(t("admin.volunteerPackFieldKeyPlaceholder"))}
              maxLength={80}
              fullWidth
              aria-label={String(t("admin.volunteerPackFieldKey"))}
              testId="volunteer-pack-new-key"
            />
            <Text variant="caption" tone="muted">
              {String(t("admin.volunteerPackFieldKeyHelp"))}
            </Text>
          </YStack>
          <Button
            variant="primary"
            size="$4"
            onPress={() => void handleCreate()}
            disabled={createMutation.isPending}
            data-testid="volunteer-pack-create-submit"
            // Longhand: the size variant sets paddingLeft/Right. The
            // default padding made the label wider than a 320 panel.
            $sm={{ paddingLeft: 12, paddingRight: 12 }}
          >
            <Plus size={16} aria-hidden />
            {String(t("admin.volunteerPackCreateCta"))}
          </Button>
        </XStack>
        {formError ? (
          <Text
            variant="caption"
            tone="error"
            data-testid="volunteer-pack-create-error"
          >
            {formError}
          </Text>
        ) : null}
      </Panel>

      {/* ── Filter ───────────────────────────────────────────────────────── */}
      <XStack gap={12} alignItems="flex-end" flexWrap="wrap">
        <YStack gap={4} minWidth={200}>
          <Text variant="overline" tone="muted">
            {String(t("admin.volunteerPackStatusFilter"))}
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
            testId="volunteer-pack-status-filter"
          />
        </YStack>
        <Button
          variant="ghost"
          size="$4"
          onPress={() => void listQuery.refetch()}
          aria-label={String(t("admin.volunteerPackRefresh"))}
        >
          <RefreshCw size={15} aria-hidden />
          {String(t("admin.volunteerPackRefresh"))}
        </Button>
      </XStack>

      {/* ── List ─────────────────────────────────────────────────────────── */}
      {listQuery.isLoading ? (
        <StateFrame>
          <Spinner size="large" />
          <Text variant="body" tone="muted">
            {String(t("admin.volunteerPacksLoading"))}
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
            {String(t("admin.volunteerPackRetry"))}
          </Button>
        </StateFrame>
      ) : packs.length === 0 ? (
        <StateFrame>
          <Text variant="h4" weight="bold" textAlign="center">
            {String(t("admin.volunteerPacksEmptyTitle"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
            {String(t("admin.volunteerPacksEmptyDescription"))}
          </Text>
        </StateFrame>
      ) : (
        <YStack gap={12} data-testid="volunteer-pack-list">
          {packs.map((pack) => {
            const targets = pack.targetCategoryIds
              .map((id) => categoryNameById.get(id))
              .filter((name): name is string => Boolean(name));
            return (
              <CatalogueRow
                key={pack.id}
                data-testid={`volunteer-pack-row-${pack.key}`}
              >
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
                      <PackStatusPill
                        status={pack.status}
                        testId={`volunteer-pack-status-${pack.key}`}
                      />
                      {pack.rankFirst ? (
                        <Text variant="overline" tone="muted">
                          {String(t("admin.volunteerPackPinned"))}
                        </Text>
                      ) : null}
                    </XStack>
                    <Text variant="code" tone="muted" truncate>
                      {pack.key}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {targets.length > 0
                        ? String(
                            t("admin.volunteerPackTargetsValue", {
                              categories: targets.join(", "),
                            }),
                          )
                        : String(t("admin.volunteerPackTargetsNone"))}
                    </Text>
                  </YStack>

                  {/* Roles — the smaller of the two metrics */}
                  <div className={styles.metric}>
                    <Text variant="overline" tone="muted">
                      {String(t("admin.volunteerPackRolesMetric"))}
                    </Text>
                    <Text
                      variant="h5"
                      weight="bold"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                      data-testid={`volunteer-pack-role-count-${pack.key}`}
                    >
                      {pack.roleCount}
                    </Text>
                  </div>

                  {/* Adoption — the number that says whether the pack earns
                      its keep, so it carries the display weight. */}
                  <div className={styles.metric}>
                    <Text variant="overline" tone="muted">
                      {String(t("admin.volunteerPackAdoptedMetric"))}
                    </Text>
                    <Text
                      variant="h3"
                      weight="bold"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                      data-testid={`volunteer-pack-fork-count-${pack.key}`}
                    >
                      {String(
                        t("admin.volunteerPackAdoptedValue", {
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
                          `/platform/volunteer-packs/${encodeURIComponent(pack.key)}`,
                        )
                      }
                      data-testid={`volunteer-pack-edit-${pack.key}`}
                    >
                      {String(t("admin.volunteerPackEditCta"))}
                    </Button>
                  </XStack>
                </div>
              </CatalogueRow>
            );
          })}
        </YStack>
      )}
    </PlatformContainer>
  );
}
