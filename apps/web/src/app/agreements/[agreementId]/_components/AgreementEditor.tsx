"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import { XStack, YStack } from "tamagui";
import { ArrowLeft, FileLock2, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";

import type { AppRouter } from "@th/trpc";
import { trpc } from "@/trpc";
import {
  BillSection,
  DealEditor,
  ResaleClause,
  billSuggestionsOf,
  type DealTarget,
} from "@/components/deals";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import {
  adminBookingHref,
  agreementMayRedirect,
  performerBookingRequestsHref,
  resolveAgreementAdminRedirect,
} from "@/lib/agreement-routes";
import {
  AGREEMENT_STATUS_LABEL_KEYS,
  agreementActionErrorKey,
  agreementStatusTone,
  canViewerActOnAgreement,
  type ViewerIdentity,
} from "@/lib/booking-agreements";

import { AgreementHeaderCard } from "./AgreementHeaderCard";
import { NegotiationBar } from "./NegotiationBar";
import { PayoutLinesSection } from "./PayoutLinesSection";
import { FinalizeDialog } from "./FinalizeDialog";
import { agreementDealParties } from "./agreement-deal";

/** Where the header's guarantee points when The deal sets it. */
const DEAL_ANCHOR_ID = "the-deal";

export type AgreementGetOutput =
  inferRouterOutputs<AppRouter>["bookingAgreements"]["get"];

/**
 * Which frame the editor sits in.
 *
 *  - `standalone` — `/agreements/{id}`: the editor paints its own chrome
 *    (back-to-booking-requests link, eyebrow, status badge, title). The
 *    performer's page; "back" is Account settings → Booking requests.
 *  - `admin` — `/admin/{slug}/bookings/agreement/{id}`: the admin page
 *    already carries identity (title, status, stage rail, back-to-booking),
 *    so the editor paints NONE of it — a second title and a second status
 *    badge would be two elements with one accessible name apiece. Error
 *    states point back at the booking inbox, never at `/agreements`.
 */
export type AgreementEditorChrome = "standalone" | "admin";

/**
 * Standalone two-party negotiation editor (spec FR-004/FR-005). Party authz
 * is server-side — a non-party gets a clean "not yours" state from the
 * FORBIDDEN/NOT_FOUND error, never partial data.
 *
 * ON `standalone`, THE EDITOR PARTY IS MOVED. Once the read resolves with
 * `viewerSide === "editor"` and the viewer's owner entities carry the editor
 * party, the page replaces itself with the admin route — the venue finishes
 * the agreement inside its booking, never on a page with no shell. Until that
 * decision is made the editor shows a spinner, not the standalone chrome, so
 * a venue user never sees the list-page frame flash before the redirect. An
 * org acting as the performer moves too (it has an admin); a human performer,
 * and an editor with no matching entity, render in place. The rule lives in
 * `@/lib/agreement-routes`.
 */
export function AgreementEditor({
  agreementId,
  chrome = "standalone",
  adminSlug,
}: {
  agreementId: string;
  chrome?: AgreementEditorChrome;
  /** Required with `chrome="admin"`: where the error-state CTAs go back to. */
  adminSlug?: string;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const router = useRouter();

  const [finalizeOpen, setFinalizeOpen] = useState(false);

  const agreementQuery = trpc.bookingAgreements.get.useQuery(
    { agreementId },
    { staleTime: 10_000, retry: false, meta: { silent: true } },
  );

  const placeId = agreementQuery.data?.agreement.placeId ?? null;
  const placeQuery = trpc.places.getPlacePublic.useQuery(
    { placeId: placeId ?? "" },
    {
      enabled: Boolean(placeId),
      staleTime: 60_000,
      retry: false,
      meta: { silent: true },
    },
  );

  // Viewer identity for the per-line "Confirm your line" affordance and the
  // negotiation-action gate. `listEventOwnerEntities` always returns the
  // actor's own human entry; org payee confirmation requires OWNER/ADMIN
  // (mirrors confirmPayoutLine), negotiation actions require
  // OWNER/ADMIN/EDITOR (mirrors ORG_EDIT_ROLES on the agreement mutations).
  const ownersQuery = useEventOwnerEntities();
  const { viewer, editOrgIds, ownersLoaded } = useMemo(() => {
    let humanId: string | null = null;
    const adminOrgIds: string[] = [];
    const editOrgIds: string[] = [];
    for (const owner of ownersQuery.ownersWithSlugs ?? []) {
      if (owner.kind === "human") {
        humanId = owner.humanId;
        continue;
      }
      if (owner.role === "OWNER" || owner.role === "ADMIN") {
        adminOrgIds.push(owner.orgId);
      }
      if (
        owner.role === "OWNER" ||
        owner.role === "ADMIN" ||
        owner.role === "EDITOR"
      ) {
        editOrgIds.push(owner.orgId);
      }
    }
    const viewer: ViewerIdentity = { humanId, adminOrgIds };
    return {
      viewer,
      editOrgIds,
      ownersLoaded: ownersQuery.ownersWithSlugs !== undefined,
    };
  }, [ownersQuery.ownersWithSlugs]);

  // The redirect decision (standalone only). `ownersWithSlugs` is undefined
  // both while loading AND for an empty list, so "settled" is read off the
  // query itself: data present, or the read failed — a failed owners read
  // must not spin forever, it renders in place (the server still gates).
  const ownersSettled = ownersQuery.data !== undefined || ownersQuery.isError;
  const data = agreementQuery.data;
  const redirectHref =
    chrome === "standalone" && data
      ? resolveAgreementAdminRedirect({
          agreementId,
          viewerSide: data.viewerSide,
          actorSide: data.actorSide,
          agreement: data.agreement,
          owners: ownersQuery.ownersWithSlugs,
        })
      : null;
  const decidingRedirect =
    chrome === "standalone" &&
    data !== undefined &&
    agreementMayRedirect({
      viewerSide: data.viewerSide,
      actorSide: data.actorSide,
      agreement: data.agreement,
    }) &&
    (!ownersSettled || redirectHref !== null);

  useEffect(() => {
    if (redirectHref) router.replace(redirectHref);
  }, [redirectHref, router]);

  const dealTarget = useMemo<DealTarget>(
    () => ({ kind: "BOOKING_AGREEMENT", agreementId }),
    [agreementId],
  );

  // After the deal saves: the agreement's own read (its lines feed Finalize
  // and the blocked-lines hint). The deal already re-read itself.
  const refreshAgreement = useCallback(() => {
    void utils.bookingAgreements.get.invalidate({ agreementId });
  }, [agreementId, utils.bookingAgreements.get]);

  // After a negotiation action (send, pull back, reopen, a payee's answer):
  // the agreement AND the deal, whose editability and agreement tags follow
  // the agreement's status and lines.
  const refresh = useCallback(() => {
    refreshAgreement();
    void utils.deals.getTermsDeal.invalidate({ target: dealTarget });
    void utils.deals.projectTermsDeal.invalidate({ target: dealTarget });
  }, [refreshAgreement, dealTarget, utils.deals]);

  /**
   * Shared mutation error handling: CONFLICT → neutral refresh toast;
   * TERMS_EDITOR_ONLY → the rule, in the act's own words (the affordance is
   * hidden, so this only fires on a stale page or a direct call).
   */
  const handleActionError = useCallback(
    (err: unknown) => {
      const e = err as { data?: { code?: string } | null; message?: string };
      const actionKey = agreementActionErrorKey(e?.message);
      if (e?.data?.code === "CONFLICT") {
        toast.warning({
          id: "ba-conflict",
          title: String(t("admin.baConflict")),
        });
      } else if (actionKey) {
        toast.danger({
          id: "ba-action-failed",
          title: String(t("admin.baActionFailed")),
          message: String(t(actionKey)),
        });
      } else {
        toast.danger({
          id: "ba-action-failed",
          title: String(t("admin.baActionFailed")),
          message: formatErrorMessage(err, t),
        });
      }
      refresh();
    },
    [refresh, t, toast],
  );

  // ── Loading (and the standalone page's redirect decision) ─────────────────
  if (agreementQuery.isLoading || decidingRedirect) {
    return (
      <YStack alignItems="center" paddingVertical="$10">
        <Spinner size="sm" />
      </YStack>
    );
  }

  // ── Error states ──────────────────────────────────────────────────────────
  if (agreementQuery.error) {
    const code = agreementQuery.error.data?.code;
    if (code === "FORBIDDEN" || code === "NOT_FOUND") {
      return (
        <CenteredNotice
          icon={<FileLock2 size={36} style={{ opacity: 0.3 }} />}
          title={String(t("admin.baNotYoursTitle"))}
          body={String(t("admin.baNotYoursBody"))}
          cta={
            chrome === "admin" && adminSlug ? (
              <NextLinkAnchor href={adminBookingHref(adminSlug, null)}>
                <Button tag="span" variant="outlined" size="$2">
                  {String(t("admin.baAdminBackToBookings"))}
                </Button>
              </NextLinkAnchor>
            ) : (
              <NextLinkAnchor href={performerBookingRequestsHref()}>
                <Button tag="span" variant="outlined" size="$2">
                  {String(t("admin.baBackToList"))}
                </Button>
              </NextLinkAnchor>
            )
          }
        />
      );
    }
    if (code === "UNAUTHORIZED") {
      return (
        <CenteredNotice
          icon={<ShieldAlert size={36} style={{ opacity: 0.3 }} />}
          title={String(t("admin.baSignInTitle"))}
          body={String(t("admin.baSignInBody"))}
          cta={
            <NextLinkAnchor href="/sign-in">
              <Button tag="span" variant="primary" size="$2">
                {String(t("admin.baSignInCta"))}
              </Button>
            </NextLinkAnchor>
          }
        />
      );
    }
    return (
      <YStack gap="$3" paddingVertical="$6" alignItems="flex-start">
        <Text variant="body" tone="error">
          {String(t("admin.baLoadFailed"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {formatErrorMessage(agreementQuery.error, t)}
        </Text>
        <Button
          variant="outlined"
          size="$2"
          onPress={() => void agreementQuery.refetch()}
        >
          {String(t("admin.baRetry"))}
        </Button>
      </YStack>
    );
  }

  if (!data) return null;

  const {
    agreement,
    lines,
    bookingRequest,
    pitchProvenance,
    mayEdit,
    viewerSide,
    viewerCanEditTerms,
  } = data;
  const placeName = placeQuery.data?.place.name ?? null;
  const unnamed = String(t("deals.unnamed"));
  const dealParties = agreementDealParties(data, unnamed);
  const billSuggestions = billSuggestionsOf(data.bill, dealParties, unnamed);

  // Hide negotiation actions only when we positively know the viewer can't
  // act (org member without an edit role). While the owners query is still
  // loading — or failed — default open: the server enforces the real rule,
  // and a wrong FORBIDDEN toast beats wrongly locking a legit party out.
  const mayAct =
    !ownersLoaded ||
    canViewerActOnAgreement(agreement, {
      humanId: viewer.humanId,
      editOrgIds,
    });

  // Countered/declined lines block finalize; the NegotiationBar surfaces a
  // "reopen the draft to adjust" hint when any exist.
  const blockedLineCount = lines.filter(
    (line) =>
      line.requiresConfirmation &&
      (line.confirmationStatus === "COUNTERED" ||
        line.confirmationStatus === "DECLINED"),
  ).length;

  return (
    <YStack gap="$5">
      {/* ── Page chrome: back link + eyebrow + status ─────────────────────── */}
      {chrome === "standalone" ? (
        <YStack gap="$2">
          <NextLinkAnchor
            href={performerBookingRequestsHref()}
            style={{ textDecoration: "none" }}
          >
            <XStack gap="$2" alignItems="center">
              <ArrowLeft size={13} style={{ opacity: 0.6 }} />
              <Text variant="caption" tone="muted">
                {String(t("admin.baBackToList"))}
              </Text>
            </XStack>
          </NextLinkAnchor>
          <XStack
            justifyContent="space-between"
            alignItems="center"
            gap="$3"
            flexWrap="wrap"
          >
            <Text
              variant="caption"
              weight="bold"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {String(t("admin.baEditorEyebrow"))}
            </Text>
            <Badge tone={agreementStatusTone(agreement.status)} size="sm">
              {String(t(AGREEMENT_STATUS_LABEL_KEYS[agreement.status]))}
            </Badge>
          </XStack>
          <Text
            variant="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {agreement.title}
          </Text>
        </YStack>
      ) : null}

      <NegotiationBar
        agreementId={agreementId}
        agreement={agreement}
        event={data.event}
        mayEdit={mayEdit}
        mayAct={mayAct}
        canEditTerms={viewerCanEditTerms}
        viewerSide={viewerSide}
        blockedLineCount={blockedLineCount}
        onRefresh={refresh}
        onActionError={handleActionError}
        onRequestFinalize={() => setFinalizeOpen(true)}
      />

      <AgreementHeaderCard
        agreementId={agreementId}
        agreement={agreement}
        bookingRequest={bookingRequest}
        pitchProvenance={pitchProvenance}
        guaranteeFromDeal={data.guaranteeFromDeal}
        dealAnchorId={DEAL_ANCHOR_ID}
        mayEdit={mayEdit}
        placeName={placeName}
        onRefresh={refresh}
        onActionError={handleActionError}
      />

      {/* Board A1: the bill, read-only, right above the deal, so it is clear
          why an act is offered as a payee. */}
      <BillSection
        bill={data.bill}
        unavailable={data.billUnavailable}
        testIdBase="ba"
      />

      {/* "The deal" edits the money terms (deal-terms FR-003). It replaces
          the line-by-line editor; editability comes from its own read. */}
      {/* The header's "Go to The deal" lands here. */}
      <div id={DEAL_ANCHOR_ID} />
      <DealEditor
        target={dealTarget}
        parties={dealParties}
        suggestions={billSuggestions}
        onSaved={refreshAgreement}
        // The header's guarantee starts a guaranteed preset until a deal
        // sets it; after that the deal's own clause is the number.
        presetGuaranteeCents={
          data.guaranteeFromDeal ? null : agreement.guaranteeCents
        }
        resaleSlot={<ResaleClause target={dealTarget} testIdBase="ba-deal" />}
        testIdBase="ba-deal"
      />

      {/* What the deal has no control for: a payee who isn't a party answers
          their own line here, and an open counter-ask reads in full. */}
      <PayoutLinesSection
        agreementId={agreementId}
        status={agreement.status}
        lines={lines}
        mayEdit={mayEdit}
        viewer={viewer}
        onRefresh={refresh}
        onActionError={handleActionError}
        answersOnly
      />

      <FinalizeDialog
        open={finalizeOpen}
        onClose={() => setFinalizeOpen(false)}
        agreementId={agreementId}
        agreement={agreement}
        bookingRequest={bookingRequest}
        placeName={placeName}
        lines={lines}
        onRefresh={refresh}
      />
    </YStack>
  );
}

function CenteredNotice({
  icon,
  title,
  body,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: React.ReactNode;
}) {
  return (
    <YStack
      gap="$3"
      alignItems="center"
      justifyContent="center"
      paddingVertical="$10"
      borderWidth={2}
      borderColor="$borderColor"
    >
      {icon}
      <Text variant="h4" weight="bold" textAlign="center">
        {title}
      </Text>
      <Text variant="body" tone="muted" textAlign="center" maxWidth={400}>
        {body}
      </Text>
      {cta}
    </YStack>
  );
}
