"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  CharCountTextarea,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Check, ExternalLink, UserCheck, X } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";

import { applicantHumansHref, applicantLabel } from "./applications-queue.helpers";

const PAGE_LIMIT = 20;

/**
 * /moderate/applications (spec FR-010 — ≈ Wikipedia RfA review): platform
 * ADMIN reviews CommunityModeratorApplications. Gated on
 * `platform.checkStaffAccess` with an ADMIN role check — this is STRICTER
 * than the layout's moderator gate, since `moderatorApplications.list` /
 * `.review` are platform-ADMIN procedures.
 *
 * Each list row carries the applicant's `applicantName` (one batched human
 * read per page, server-side), shown as the row label and linked from the
 * open row to the platform humans list filtered by that name. An applicant
 * with no name set shows the short id. A dangling applicant (deleted human)
 * arrives with `applicantMissing: true`, or is found when APPROVE fails with
 * HUMAN_NOT_FOUND (deleted after the page loaded); either way the row reads
 * "Deleted user" and APPROVE is disabled so the admin can REJECT it instead
 * (the server deliberately allows rejecting dangling applications).
 */
export function ApplicationsQueue() {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const router = useRouter();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [danglingApplicantIds, setDanglingApplicantIds] = useState<
    ReadonlySet<string>
  >(new Set());

  // ── ADMIN gate (platform staff check, NOT checkModeratorAccess) ───────
  const staffQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  });
  const isAdmin =
    staffQuery.data?.allowed === true &&
    staffQuery.data.roles.includes("ADMIN");

  useEffect(() => {
    if (!staffQuery.isLoading && (staffQuery.isError || !isAdmin)) {
      router.replace("/access-denied");
    }
  }, [staffQuery.isLoading, staffQuery.isError, isAdmin, router]);

  const listQuery = trpc.moderatorApplications.list.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      enabled: isAdmin,
      staleTime: 15_000,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const closePanel = () => {
    setSelectedId(null);
    setNote("");
  };

  const invalidate = () => void utils.moderatorApplications.list.invalidate();

  const reviewMut = trpc.moderatorApplications.review.useMutation({
    onSuccess: (_, vars) => {
      toast.success({
        title: String(
          t(
            vars.decision === "APPROVE"
              ? "moderation.applicationApprovedToast"
              : "moderation.applicationRejectedToast",
          ),
        ),
      });
      closePanel();
      invalidate();
    },
    onError: (err, vars) => {
      const code = getAppErrorCode(err);
      if (code === "MODERATOR_APPLICATION_ALREADY_REVIEWED") {
        toast.info({
          title: String(t("moderation.applicationAlreadyReviewedToast")),
        });
        closePanel();
        invalidate();
        return;
      }
      if (code === "HUMAN_NOT_FOUND") {
        // Dangling applicant — flag the row so the admin can REJECT instead.
        const application = items.find(
          (item) => item.id === vars.applicationId,
        );
        if (application) {
          setDanglingApplicantIds((prev) =>
            new Set(prev).add(application.applicantHumanId),
          );
        }
        toast.danger({
          title: String(t("moderation.applicantMissingToast")),
        });
        return;
      }
      toast.danger({
        title: String(t("moderation.decisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  const review = (decision: "APPROVE" | "REJECT") => {
    if (!selected) return;
    reviewMut.mutate({
      applicationId: selected.id,
      decision,
      reviewNote: note.trim() || undefined,
    });
  };

  // ── Gate loading / denied ─────────────────────────────────────────────
  if (staffQuery.isLoading || (!isAdmin && !staffQuery.isError)) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }
  if (staffQuery.isError || !isAdmin) {
    // Redirect effect is in flight.
    return null;
  }

  // ── List loading ──────────────────────────────────────────────────────
  if (listQuery.isLoading) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  // ── Error + retry ─────────────────────────────────────────────────────
  if (listQuery.isError) {
    return (
      <YStack
        gap="$3"
        padding="$4"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <Text variant="body" tone="error">
          {String(t("moderation.loadError"))}
        </Text>
        <XStack>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => void listQuery.refetch()}
          >
            {String(t("moderation.retry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$4">
      <YStack gap="$1">
        <Text
          variant="h4"
          tag="h2"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          {String(t("moderation.applicationsTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("moderation.applicationsSubtitle"))}
        </Text>
      </YStack>

      {items.length === 0 ? (
        <YStack
          alignItems="center"
          justifyContent="center"
          padding="$6"
          gap="$3"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surface"
        >
          <UserCheck size={28} style={{ opacity: 0.4 }} aria-hidden />
          <Text variant="h4">{String(t("moderation.applicationsEmpty"))}</Text>
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("moderation.applicationsEmptyHint"))}
          </Text>
        </YStack>
      ) : (
        <YStack gap="$2">
          {items.map((application) => {
            const isSelected = application.id === selectedId;
            const isDangling =
              application.applicantMissing ||
              danglingApplicantIds.has(application.applicantHumanId);
            const label = applicantLabel(
              application,
              isDangling,
              String(t("moderation.deletedUser")),
            );
            const applicantHref = isDangling
              ? null
              : applicantHumansHref(application);
            return (
              <YStack
                key={application.id}
                borderWidth={2}
                borderColor={isSelected ? "$accent" : "$borderColor"}
                backgroundColor="$surface"
              >
                {/* Native interactive wrapper: keyboard activation + focus
                    outline (Tamagui onPress only maps to click on web). */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isSelected}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    setSelectedId(isSelected ? null : application.id);
                    setNote("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(isSelected ? null : application.id);
                      setNote("");
                    }
                  }}
                >
                  <YStack
                    gap="$2"
                    padding="$3"
                    minHeight={44}
                    hoverStyle={{ backgroundColor: "$surfaceMuted" }}
                  >
                    <XStack
                      justifyContent="space-between"
                      alignItems="center"
                      gap="$2"
                      flexWrap="wrap"
                    >
                      <XStack
                        gap="$2"
                        alignItems="center"
                        flex={1}
                        minWidth={0}
                      >
                        <Badge tone="warning" size="sm">
                          {String(t("moderation.pendingBadge")).toUpperCase()}
                        </Badge>
                        <Text
                          variant="caption"
                          weight="bold"
                          textTransform="uppercase"
                          letterSpacing={0.5}
                        >
                          {String(t("moderation.applicant"))}
                        </Text>
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          tone={isDangling ? "error" : "default"}
                          style={{ overflowWrap: "anywhere" }}
                        >
                          {label}
                        </Text>
                      </XStack>
                      <Text variant="caption" tone="muted">
                        {fmt.dateTime(new Date(application.createdAt), {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </Text>
                    </XStack>

                    <YStack gap="$1">
                      <Text
                        variant="caption"
                        weight="bold"
                        textTransform="uppercase"
                        letterSpacing={0.5}
                        tone="muted"
                      >
                        {String(t("moderation.statementLabel"))}
                      </Text>
                      {application.statement ? (
                        <Text
                          variant="bodySmall"
                          style={
                            isSelected
                              ? undefined
                              : {
                                  display: "-webkit-box",
                                  WebkitLineClamp: 3,
                                  WebkitBoxOrient: "vertical",
                                  overflow: "hidden",
                                }
                          }
                        >
                          {application.statement}
                        </Text>
                      ) : (
                        <Text variant="bodySmall" tone="muted">
                          {String(t("moderation.noStatement"))}
                        </Text>
                      )}
                    </YStack>
                  </YStack>
                </div>

                {/* Inline review expansion */}
                {isSelected ? (
                  <YStack
                    gap="$3"
                    padding="$3"
                    borderTopWidth={2}
                    borderTopColor="$borderColor"
                  >
                    {applicantHref ? (
                      <NextLinkAnchor
                        href={applicantHref}
                        target="_blank"
                        textDecorationLine="none"
                      >
                        <XStack
                          gap="$2"
                          alignItems="center"
                          minHeight={24}
                          flexWrap="wrap"
                        >
                          <ExternalLink size={12} aria-hidden />
                          <Text
                            variant="bodySmall"
                            weight="bold"
                            color="$accentText"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {String(
                              t("moderation.applicantHumansLink", {
                                name: label,
                              }),
                            )}
                          </Text>
                        </XStack>
                      </NextLinkAnchor>
                    ) : null}
                    <YStack gap="$1">
                      <Text
                        variant="caption"
                        weight="bold"
                        textTransform="uppercase"
                        letterSpacing={0.5}
                      >
                        {String(t("moderation.reviewNoteLabel"))}
                      </Text>
                      <CharCountTextarea
                        value={note}
                        onChange={setNote}
                        maxLength={1000}
                        minHeight={72}
                        placeholder={String(
                          t("moderation.reviewNotePlaceholder"),
                        )}
                        disabled={reviewMut.isPending}
                        testIdBase="moderation-application-note"
                      />
                    </YStack>

                    <XStack gap="$2" flexWrap="wrap">
                      <Button
                        variant="primary"
                        size="$3"
                        onPress={() => review("APPROVE")}
                        disabled={reviewMut.isPending || isDangling}
                      >
                        <Check size={14} aria-hidden />
                        {String(t("moderation.approve"))}
                      </Button>
                      <Button
                        variant="destructive"
                        size="$3"
                        onPress={() => review("REJECT")}
                        disabled={reviewMut.isPending}
                      >
                        <X size={14} />
                        {String(t("moderation.reject"))}
                      </Button>
                    </XStack>
                  </YStack>
                ) : null}
              </YStack>
            );
          })}

          {listQuery.hasNextPage ? (
            <XStack justifyContent="center" paddingVertical="$2">
              <Button
                variant="secondary"
                size="$3"
                onPress={() => void listQuery.fetchNextPage()}
                disabled={listQuery.isFetchingNextPage}
              >
                {listQuery.isFetchingNextPage ? <Spinner size="small" /> : null}
                {String(t("moderation.loadMore"))}
              </Button>
            </XStack>
          ) : null}
        </YStack>
      )}
    </YStack>
  );
}
