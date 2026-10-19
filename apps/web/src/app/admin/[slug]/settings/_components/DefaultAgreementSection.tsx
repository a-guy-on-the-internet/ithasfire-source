"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { RESALE_CLAIM_WINDOW_DAYS } from "@th/types/repos/resale-listings";

import {
  DealEditor,
  ResaleClause,
  type DealPerson,
  type DealTarget,
} from "@/components/deals";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import { SectionHeading } from "./org-settings-primitives";

/** The most days a seller's resale money may wait (`setDefaultAgreement`). */
const MAX_RELEASE_DAYS = 365;

/**
 * "Default agreement" (organiser-resale-share FR-012, board DA1; renamed from
 * "Resale policy", owner R19). The group's default terms, which new events
 * start from: the ticket-sales deal (`DealEditor`, target ORG_DEFAULT), the
 * resale clause inside it (`ResaleClause`, empty until set: resale stays off
 * on new events until then), and when resale sellers are paid.
 *
 * Each part saves on its own: the deal and the clause are separate terms rows
 * with their own version checks, and the release days are a field on the
 * resale template (`orgs.setDefaultAgreement`).
 *
 * The page and its default deal are for every group. Only the resale parts
 * sit behind the `resale` gate: the clause (`ResaleClause` gates itself) and
 * the release days, here.
 */
export function DefaultAgreementSection({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}) {
  const t = useTranslations();
  const { gates } = useFeatureGates();
  const target = useMemo<DealTarget>(
    () => ({ kind: "ORG_DEFAULT", orgId }),
    [orgId],
  );
  const parties = useMemo<DealPerson[]>(
    () => [{ ref: { kind: "org", id: orgId }, name: orgName, source: "party" }],
    [orgId, orgName],
  );

  return (
    <YStack gap="$5">
      <SectionHeading
        title={String(t("admin.settingsDefaultAgreement"))}
        description={String(t("deals.defaultAgreement.lede"))}
      />
      <DealEditor
        target={target}
        parties={parties}
        // The page's lede above says what these terms are for.
        headerDetail={<></>}
        resaleSlot={<ResaleClause target={target} testIdBase="da-deal" />}
        testIdBase="da-deal"
      />
      {/* Fail closed while the gates load, like every resale surface. */}
      {gates?.resale === true ? <ReleaseDays orgId={orgId} /> : null}
    </YStack>
  );
}

/** "When resale sellers are paid": days after the event, never under the claim window. */
function ReleaseDays({ orgId }: { orgId: string }) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const inputId = useId();

  const policyQuery = trpc.orgs.getOrganizationResalePolicy.useQuery(
    { orgId },
    { staleTime: 30_000 },
  );
  const [text, setText] = useState("");
  useEffect(() => {
    if (policyQuery.data) setText(String(policyQuery.data.payoutReleaseDays));
  }, [policyQuery.data]);

  const saveMutation = trpc.orgs.setDefaultAgreement.useMutation({
    onSuccess: () => {
      toast.success({
        id: "default-agreement-release-saved",
        title: String(t("deals.defaultAgreement.savedToast")),
      });
      void utils.orgs.getOrganizationResalePolicy.invalidate({ orgId });
    },
    onError: (err) => {
      toast.danger({
        id: "default-agreement-release-failed",
        title: String(t("deals.defaultAgreement.saveFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const title = (
    <Text variant="h5" weight="bold" textTransform="uppercase">
      {String(t("deals.defaultAgreement.releaseTitle"))}
    </Text>
  );
  const frame = {
    gap: "$3",
    padding: "$4",
    borderWidth: 2,
    borderColor: "$borderColor",
  } as const;

  if (policyQuery.isLoading) {
    return (
      <YStack {...frame}>
        {title}
        <XStack padding="$3">
          <Spinner size="sm" />
        </XStack>
      </YStack>
    );
  }
  if (policyQuery.error || !policyQuery.data) {
    return (
      <YStack {...frame}>
        {title}
        <Text variant="body" tone="error">
          {String(t("deals.defaultAgreement.readFailed"))}
        </Text>
        <XStack>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void policyQuery.refetch()}
          >
            {String(t("deals.retry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  const data = policyQuery.data;
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  const valid =
    value !== null &&
    value >= RESALE_CLAIM_WINDOW_DAYS &&
    value <= MAX_RELEASE_DAYS;
  const dirty = trimmed !== String(data.payoutReleaseDays);

  return (
    <YStack
      {...frame}
      tag="section"
      aria-labelledby={`${inputId}-title`}
      testID="da-release"
    >
      <Text
        id={`${inputId}-title`}
        variant="h5"
        weight="bold"
        textTransform="uppercase"
      >
        {String(t("deals.defaultAgreement.releaseTitle"))}
      </Text>
      {data.isPlatformDefault ? (
        <Text variant="bodySmall" tone="muted">
          {String(
            t("deals.defaultAgreement.releasePlatformDefault", {
              days: data.payoutReleaseDays,
            }),
          )}
        </Text>
      ) : null}
      <YStack gap="$2">
        <Text
          tag="label"
          variant="overline"
          tone="muted"
          htmlFor={`${inputId}-days`}
        >
          {String(t("deals.defaultAgreement.releaseLabel"))}
        </Text>
        <TextInput
          id={`${inputId}-days`}
          value={text}
          onChangeText={setText}
          inputMode="numeric"
          fullWidth
          aria-invalid={dirty && !valid ? true : undefined}
          testId="da-release-days"
        />
        <Text variant="caption" tone="muted">
          {String(
            t("deals.defaultAgreement.releaseHint", {
              days: RESALE_CLAIM_WINDOW_DAYS,
            }),
          )}
        </Text>
        {dirty && !valid ? (
          <Text variant="caption" tone="error" role="alert">
            {String(
              t("deals.defaultAgreement.releaseInvalid", {
                min: RESALE_CLAIM_WINDOW_DAYS,
              }),
            )}
          </Text>
        ) : null}
      </YStack>
      <XStack gap="$2" flexWrap="wrap">
        <Button
          variant="primary"
          size="$3"
          onPress={() => {
            if (!valid || !dirty || value === null) return;
            saveMutation.mutate({ orgId, payoutReleaseDays: value });
          }}
          disabled={!dirty || !valid || saveMutation.isPending}
          testID="da-release-save"
        >
          {String(t("deals.defaultAgreement.save"))}
        </Button>
        {dirty ? (
          <Button
            variant="ghost"
            size="$3"
            onPress={() => setText(String(data.payoutReleaseDays))}
            disabled={saveMutation.isPending}
            testID="da-release-reset"
          >
            {String(t("deals.defaultAgreement.reset"))}
          </Button>
        ) : null}
      </XStack>
    </YStack>
  );
}
