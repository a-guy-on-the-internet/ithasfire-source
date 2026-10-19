"use client";

import { useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack, styled } from "tamagui";
import {
  Badge,
  Button,
  NextLinkAnchor,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { Check, Link2, Plus } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { AdminTableErrorState } from "@/components/AdminTableParts";

import { VolunteerAskForm, type AskSubject } from "./VolunteerAskForm";
import { formatAskWindow } from "./ask-window-label";
import {
  WRAPPING_BUTTON_ICON_STYLE,
  WRAPPING_BUTTON_LABEL_PROPS,
  WRAPPING_BUTTON_PROPS,
  WRAPPING_BUTTON_ROW_PROPS,
} from "./wrapping-button-props";
import {
  ASK_CADENCE_LABEL_KEY,
  ASK_STATUS_LABEL_KEY,
  ASK_STATUS_TONE,
  type AskCadence,
  type AskStatus,
} from "./volunteering-helpers";

const AskCardFrame = styled(YStack, {
  name: "VolunteerAskCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  padding: "$4",
  gap: "$2",
});

export type AsksListSubject =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string }
  | { kind: "place"; placeId: string };

export type AsksListProps = {
  /** Admin slug used to build the manage-page links. */
  slug: string;
  subject: AsksListSubject;
};

type AskListItem = {
  id: string;
  title: string;
  status: AskStatus;
  cadence: AskCadence;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  timezone: string | null;
  capacity: number | null;
};

function toCreateSubject(subject: AsksListSubject): AskSubject {
  switch (subject.kind) {
    case "org":
      return { subjectType: "ORG", subjectId: subject.orgId };
    case "human":
      return { subjectType: "HUMAN", subjectId: subject.humanId };
    case "place":
      return { subjectType: "PLACE", subjectId: subject.placeId };
  }
}

/**
 * Dashboard list of an owner's volunteer asks — shared by the org and
 * personal "Asks" tab and the place volunteers tab. Rows link into the ask
 * manage page under the current admin slug.
 */
export function AsksList({ slug, subject }: AsksListProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [copiedAskId, setCopiedAskId] = useState<string | null>(null);

  const orgQuery = trpc.volunteer.asks.listByOrg.useQuery(
    { orgId: subject.kind === "org" ? subject.orgId : "" },
    { enabled: subject.kind === "org", staleTime: 15_000 },
  );
  const subjectQuery = trpc.volunteer.asks.listBySubject.useQuery(
    subject.kind === "human"
      ? { subjectType: "HUMAN", subjectId: subject.humanId }
      : {
          subjectType: "PLACE",
          subjectId: subject.kind === "place" ? subject.placeId : "",
        },
    { enabled: subject.kind !== "org", staleTime: 15_000 },
  );

  const activeQuery = subject.kind === "org" ? orgQuery : subjectQuery;

  // A place's ask defaults to the place's own zone. Same query and input the
  // place layout runs, so React Query serves it from cache.
  const placeQuery = trpc.places.getPlaceTitle.useQuery(
    { placeId: subject.kind === "place" ? subject.placeId : "" },
    {
      enabled: subject.kind === "place",
      staleTime: 60_000,
      retry: 2,
      meta: { silent: true },
    },
  );
  const placeTimezone =
    subject.kind === "place" ? placeQuery.data?.timezone : undefined;
  const asks = (activeQuery.data ?? []) as AskListItem[];

  const copyPublicLink = (askId: string) => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    void navigator.clipboard.writeText(`${base}/v/${askId}`).then(() => {
      setCopiedAskId(askId);
      setTimeout(() => setCopiedAskId((v) => (v === askId ? null : v)), 2000);
    });
  };

  // One label per card, computed once per render.
  const windowLabels = new Map(
    asks.map((ask) => [ask.id, formatAskWindow(fmt, t, ask)] as const),
  );

  return (
    <YStack gap="$4">
      <XStack justifyContent="flex-end">
        <Button
          variant="primary"
          {...WRAPPING_BUTTON_PROPS}
          onPress={() => setCreateOpen(true)}
          data-testid="volunteer-asks-new-cta"
        >
          <XStack gap="$2" alignItems="center" {...WRAPPING_BUTTON_ROW_PROPS}>
            <Plus size={16} style={WRAPPING_BUTTON_ICON_STYLE} />
            <Text tone="inherit" {...WRAPPING_BUTTON_LABEL_PROPS}>
              {String(t("volunteering.newAskCta"))}
            </Text>
          </XStack>
        </Button>
      </XStack>

      {activeQuery.isLoading ? (
        <YStack paddingVertical="$6" alignItems="center">
          <Text color="$colorMuted">{String(t("admin.loading"))}</Text>
        </YStack>
      ) : activeQuery.isError ? (
        <AdminTableErrorState
          message={formatErrorMessage(activeQuery.error, t)}
          onRetry={() => {
            void activeQuery.refetch();
          }}
          testId="volunteer-asks-error"
        />
      ) : asks.length === 0 ? (
        <YStack
          alignItems="center"
          gap="$3"
          paddingVertical="$8"
          borderWidth={1}
          borderColor="$borderColor"
          borderStyle="dashed"
          padding="$6"
        >
          <Text
            variant="h4"
            style={{ textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            {String(t("volunteering.asksEmptyTitle"))}
          </Text>
          <Text color="$colorMuted" style={{ textAlign: "center" }}>
            {String(t("volunteering.asksEmptyDescription"))}
          </Text>
        </YStack>
      ) : (
        <YStack gap="$3" data-testid="volunteer-asks-list">
          {asks.map((ask) => (
            <AskCardFrame key={ask.id}>
              <XStack
                gap="$3"
                alignItems="flex-start"
                justifyContent="space-between"
                flexWrap="wrap"
              >
                {/* Basis, not minWidth: a 220px floor overflowed the card at
                    320px once the window label carried a time and zone. */}
                <YStack
                  gap="$1"
                  flexGrow={1}
                  flexShrink={1}
                  flexBasis={220}
                  minWidth={0}
                >
                  <Text variant="h4" style={{ textTransform: "uppercase" }}>
                    {ask.title}
                  </Text>
                  <XStack gap="$2" alignItems="center" flexWrap="wrap">
                    <Badge tone={ASK_STATUS_TONE[ask.status]} size="sm">
                      {String(t(ASK_STATUS_LABEL_KEY[ask.status]))}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      {String(t(ASK_CADENCE_LABEL_KEY[ask.cadence]))}
                    </Badge>
                    {ask.capacity !== null ? (
                      <Badge tone="neutral" size="sm">
                        {String(
                          t("volunteering.askCapacityBadge", {
                            cap: ask.capacity,
                          }),
                        )}
                      </Badge>
                    ) : null}
                  </XStack>
                  {windowLabels.get(ask.id) ? (
                    <Text variant="caption" tone="muted">
                      {windowLabels.get(ask.id)}
                    </Text>
                  ) : null}
                </YStack>

                {/* flexShrink + minWidth 0 let the group shrink to its line
                    so the wrap fires; an XStack keeps max-content otherwise. */}
                <XStack
                  gap="$2"
                  flexWrap="wrap"
                  alignItems="center"
                  flexShrink={1}
                  minWidth={0}
                >
                  <Button
                    variant="ghost"
                    size="$2"
                    {...WRAPPING_BUTTON_PROPS}
                    onPress={() => copyPublicLink(ask.id)}
                    aria-label={String(t("volunteering.copyPublicLink"))}
                    data-testid={`volunteer-ask-copy-link-${ask.id}`}
                  >
                    <XStack
                      gap="$2"
                      alignItems="center"
                      {...WRAPPING_BUTTON_ROW_PROPS}
                    >
                      {copiedAskId === ask.id ? (
                        <Check size={14} style={WRAPPING_BUTTON_ICON_STYLE} />
                      ) : (
                        <Link2 size={14} style={WRAPPING_BUTTON_ICON_STYLE} />
                      )}
                      <Text variant="bodySmall" {...WRAPPING_BUTTON_LABEL_PROPS}>
                        {copiedAskId === ask.id
                          ? String(t("volunteering.publicLinkCopied"))
                          : String(t("volunteering.copyPublicLink"))}
                      </Text>
                    </XStack>
                  </Button>
                  <Button variant="outlined" size="$2" minHeight={44} asChild>
                    <NextLinkAnchor
                      href={`/admin/${slug}/volunteers/asks/${ask.id}`}
                      data-testid={`volunteer-ask-manage-${ask.id}`}
                    >
                      {String(t("volunteering.manageCta"))}
                    </NextLinkAnchor>
                  </Button>
                </XStack>
              </XStack>
            </AskCardFrame>
          ))}
        </YStack>
      )}

      {createOpen ? (
        <VolunteerAskForm
          mode="create"
          subject={toCreateSubject(subject)}
          defaultTimezone={placeTimezone}
          onClose={() => setCreateOpen(false)}
          onSuccess={(askId) => {
            setCreateOpen(false);
            void activeQuery.refetch();
            if (askId) {
              router.push(`/admin/${slug}/volunteers/asks/${askId}`);
            }
          }}
        />
      ) : null}
    </YStack>
  );
}
