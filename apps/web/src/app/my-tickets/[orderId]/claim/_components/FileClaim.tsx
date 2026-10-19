"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Card, Spinner, XStack, YStack } from "tamagui";
import { ArrowLeft } from "lucide-react";

import {
  Button,
  CharCountTextarea,
  Radio,
  RadioGroupField,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { EmailVerificationRequiredPage } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import {
  CLAIM_KINDS,
  CLAIM_KIND_COPY,
  CLAIM_TEXT_MAX,
  CREATE_CLAIM_ERROR_KEYS,
  RESALE_CLAIM_WINDOW_DAYS,
  claimWindowState,
  isClaimableResaleTicket,
  isResaleOrder,
  type ClaimKind,
} from "@/lib/resale-claims";

// ─────────────────────────────────────────────────────────────────────────────
// Buyer: file a claim on a ticket bought from another fan.
//
// Owner rulings (2026-10-06): support reviews every claim (Q9), decides at
// any time (Q8), the seller can reply until then (Q9.3), and an approved
// claim is a FULL refund (no partial refunds). Evidence is text only (v1).
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_IDS = {
  ticketGroup: "claim-ticket-group",
  kindGroup: "claim-kind-group",
  description: "claim-description",
  descriptionHelp: "claim-description-help",
  descriptionError: "claim-description-error",
  sentHeading: "claim-sent-heading",
  ticketError: "claim-ticket-error",
  kindError: "claim-kind-error",
  submitError: "claim-submit-error",
} as const;

const ticketRadioId = (ticketId: string) => `claim-ticket-${ticketId}`;
const kindRadioId = (kind: string) => `claim-kind-${kind}`;

type FieldErrors = {
  ticket?: string;
  kind?: string;
  description?: string;
};

/** Decorative index numeral, as on the order page's sections. */
const StepNum = ({ children }: { children: ReactNode }) => (
  <Text
    variant="kicker"
    tone="accent"
    weight="bold"
    aria-hidden
    fontSize={14}
    minWidth={28}
  >
    {children}
  </Text>
);

function focusById(id: string) {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.focus();
}

interface FileClaimProps {
  orderId: string;
}

export function FileClaim({ orderId }: FileClaimProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  // Probe the catalog first so a key-shaped miss never renders as a raw key.
  const translate = useCallback(
    (key: string) => (fmt.getRawMessage(key) ? String(t(key)) : key),
    [fmt, t],
  );

  // ── Data ──────────────────────────────────────────────────────────────────

  const orderQuery = trpc.orders.getMyOrder.useQuery(
    { orderId },
    { staleTime: 30_000 },
  );
  const order = orderQuery.data;

  const ticketsQuery = trpc.orders.listMyOrderTickets.useQuery(
    { orderId },
    { staleTime: 30_000, enabled: !!order },
  );

  // `claims.list` filters by humanId; the auth session id is not the humanId
  // for OAuth/passkey users, so read it from the profile.
  const profileQuery = trpc.entityPages.getMyProfile.useQuery(
    {},
    {
      staleTime: 5 * 60_000,
    },
  );
  const humanId = profileQuery.data?.humanId;

  const claimsQuery = trpc.claims.list.useQuery(
    // Narrowed to this order server-side. Gated on the order so a malformed
    // URL id fails once (order not found), not again as invalid input here.
    { claimantId: humanId ?? "", orderId, limit: 100 },
    { enabled: !!humanId && !!order, staleTime: 30_000 },
  );

  const createMutation = trpc.claims.create.useMutation({
    onSuccess: () => {
      void utils.claims.list.invalidate();
    },
    onError: (err) => {
      if (getAppErrorCode(err) === "CLAIM_ALREADY_EXISTS") {
        void utils.claims.list.invalidate();
      }
    },
  });

  // ── Derived ───────────────────────────────────────────────────────────────

  // Already narrowed to this order by the server (`orderId` input).
  const orderClaims = useMemo(
    () => claimsQuery.data?.items ?? [],
    [claimsQuery.data],
  );

  const claimableTickets = useMemo(() => {
    if (!order || !ticketsQuery.data || !isResaleOrder(order)) return [];
    const itemsById = new Map(order.items.map((i) => [i.id, i]));
    const claimedItemIds = new Set(orderClaims.map((c) => c.orderItemId));
    return ticketsQuery.data.tickets
      .map((ticket) => ({
        ...ticket,
        item: ticket.orderItemId
          ? (itemsById.get(ticket.orderItemId) ?? null)
          : null,
        typeName: ticket.ticketTypeId
          ? (order.ticketTypeNames[ticket.ticketTypeId] ?? null)
          : null,
      }))
      .filter(
        (ticket) =>
          isClaimableResaleTicket(ticket) &&
          !claimedItemIds.has(ticket.orderItemId!),
      );
  }, [order, ticketsQuery.data, orderClaims]);

  // ── Form state ────────────────────────────────────────────────────────────

  const [orderItemId, setOrderItemId] = useState<string | null>(null);
  const [kind, setKind] = useState<ClaimKind | null>(null);
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  // One ticket: nothing to choose.
  useEffect(() => {
    if (claimableTickets.length === 1 && !orderItemId) {
      setOrderItemId(claimableTickets[0]!.orderItemId);
    }
  }, [claimableTickets, orderItemId]);

  const isSent = createMutation.isSuccess;

  // Move focus to the confirmation so a screen reader hears it.
  useEffect(() => {
    if (isSent) focusById(FIELD_IDS.sentHeading);
  }, [isSent]);

  const validate = useCallback((): FieldErrors => {
    const next: FieldErrors = {};
    if (!orderItemId) next.ticket = String(t("resaleClaim.ticketRequired"));
    if (!kind) next.kind = String(t("resaleClaim.kindRequired"));
    if (description.trim().length === 0) {
      next.description = String(t("resaleClaim.descriptionRequired"));
    }
    return next;
  }, [orderItemId, kind, description, t]);

  const handleSubmit = useCallback(() => {
    if (createMutation.isPending) return;
    const found = validate();
    setErrors(found);
    if (found.ticket) {
      const first = claimableTickets[0];
      if (first) focusById(ticketRadioId(first.id));
      return;
    }
    if (found.kind) {
      focusById(kindRadioId(CLAIM_KINDS[0]));
      return;
    }
    if (found.description) {
      focusById(FIELD_IDS.description);
      return;
    }
    createMutation.mutate({
      orderId,
      orderItemId: orderItemId!,
      kind: kind!,
      evidence: { description: description.trim() },
    });
  }, [
    createMutation,
    validate,
    claimableTickets,
    orderId,
    orderItemId,
    kind,
    description,
  ]);

  const submitError = useMemo(() => {
    const err = createMutation.error;
    if (!err) return null;
    const code = getAppErrorCode(err);
    const key = code ? CREATE_CLAIM_ERROR_KEYS[code] : undefined;
    // `{days}` feeds errorWindowExpired; the other sentences ignore it.
    return key
      ? String(t(key, { days: RESALE_CLAIM_WINDOW_DAYS }))
      : formatErrorMessage(err, translate);
  }, [createMutation.error, t, translate]);

  // A refused submit moves focus to the sentence that explains it (the card
  // is not a live region, so it is announced once, by the focus move).
  useEffect(() => {
    if (createMutation.error) focusById(FIELD_IDS.submitError);
  }, [createMutation.error]);

  // ── Shell pieces ──────────────────────────────────────────────────────────

  const backLink = (
    <Link href={`/my-tickets/${orderId}`}>
      <XStack gap="$2" alignItems="center" paddingVertical="$2" minHeight={44}>
        <ArrowLeft
          size={16}
          strokeWidth={2.5}
          color="var(--accentText, #A8300F)"
          aria-hidden
        />
        <Text
          variant="bodySmall"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={1.2}
          color="$accentText"
          hoverStyle={{ color: "$color" }}
        >
          {String(t("resaleClaim.backToOrder"))}
        </Text>
      </XStack>
    </Link>
  );

  const header = order ? (
    <YStack
      gap="$2"
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
      paddingBottom="$4"
    >
      <Text
        variant="h2"
        tag="h1"
        weight="bold"
        textTransform="uppercase"
        letterSpacing={-0.5}
      >
        {String(t("resaleClaim.pageTitle"))}
      </Text>
      <Text variant="body" tone="muted">
        <Text variant="body" weight="bold" tag="span">
          {order.eventName}
        </Text>
        {order.eventStartsAt
          ? ` · ${fmt.dateTime(new Date(order.eventStartsAt), {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}`
          : null}
      </Text>
    </YStack>
  ) : null;

  const shell = (children: ReactNode) => (
    <YStack
      gap="$6"
      paddingVertical="$4"
      maxWidth={640}
      marginHorizontal="auto"
      width="100%"
      data-testid="file-claim"
    >
      {backLink}
      {header}
      {children}
    </YStack>
  );

  const notice = (title: string, body: string, testId: string) =>
    shell(
      <Card
        padding="$4"
        gap="$3"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
        data-testid={testId}
      >
        <Text variant="h4" tag="h2" weight="bold">
          {title}
        </Text>
        <Text variant="body" tone="muted">
          {body}
        </Text>
        <XStack>
          <Link href={`/my-tickets/${orderId}`}>
            <Button tag="span" variant="secondary" size="$4">
              {String(t("resaleClaim.backToOrder"))}
            </Button>
          </Link>
        </XStack>
      </Card>,
    );

  // ── Loading / not found ───────────────────────────────────────────────────

  const claimsLoading =
    profileQuery.isLoading || (!!humanId && claimsQuery.isLoading);

  if (
    orderQuery.isLoading ||
    (order && ticketsQuery.isLoading) ||
    claimsLoading
  ) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$4"
        role="status"
      >
        <Spinner size="large" color="$color" />
        <Text variant="body" tone="muted">
          {String(t("resaleClaim.loading"))}
        </Text>
      </YStack>
    );
  }

  if (
    isEmailVerificationRequired(orderQuery.error) ||
    isEmailVerificationRequired(ticketsQuery.error)
  ) {
    return (
      <EmailVerificationRequiredPage
        context="order"
        backHref="/my-tickets"
        backLabel={String(t("resaleClaim.backToMyTickets"))}
        testId="file-claim-verify-email"
      />
    );
  }

  if (orderQuery.error || !order) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$4"
        data-testid="file-claim-not-found"
      >
        <Text variant="h4" tag="h1" weight="bold" textAlign="center">
          {String(t("resaleClaim.orderNotFound"))}
        </Text>
        <Link href="/my-tickets">
          <Button tag="span" variant="secondary" size="$4">
            {String(t("resaleClaim.backToMyTickets"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  if (ticketsQuery.error) {
    return notice(
      String(t("resaleClaim.loadFailedTitle")),
      formatErrorMessage(ticketsQuery.error, translate),
      "file-claim-load-failed",
    );
  }

  // ── Sent ──────────────────────────────────────────────────────────────────

  if (isSent) {
    return shell(
      <Card
        padding="$5"
        gap="$4"
        borderRadius={0}
        borderTopWidth={3}
        borderTopColor="$success"
        data-testid="file-claim-sent"
      >
        <Text
          variant="h3"
          tag="h2"
          weight="bold"
          textTransform="uppercase"
          id={FIELD_IDS.sentHeading}
          tabIndex={-1}
        >
          {String(t("resaleClaim.sentTitle"))}
        </Text>
        <YStack gap="$3" tag="ol" margin={0} paddingLeft={0}>
          {(
            [
              "resaleClaim.sentStepReview",
              "resaleClaim.sentStepSeller",
              "resaleClaim.sentStepRefund",
            ] as const
          ).map((key, index) => (
            <XStack key={key} gap="$3" tag="li" alignItems="flex-start">
              <StepNum>{`0${index + 1}.`}</StepNum>
              <Text variant="body" flex={1} minWidth={0}>
                {String(t(key))}
              </Text>
            </XStack>
          ))}
        </YStack>
        <XStack>
          <Link href={`/my-tickets/${orderId}`}>
            <Button tag="span" variant="secondary" size="$4">
              {String(t("resaleClaim.backToOrder"))}
            </Button>
          </Link>
        </XStack>
      </Card>,
    );
  }

  // ── Nothing to file ───────────────────────────────────────────────────────

  if (claimableTickets.length === 0) {
    return orderClaims.length > 0
      ? notice(
          String(t("resaleClaim.alreadyFiledTitle")),
          String(t("resaleClaim.alreadyFiledBody")),
          "file-claim-already-filed",
        )
      : notice(
          String(t("resaleClaim.nothingToClaimTitle")),
          String(t("resaleClaim.nothingToClaimBody")),
          "file-claim-nothing",
        );
  }

  const windowState = claimWindowState({
    eventStartsAt: order.eventStartsAt,
    resaleClaimWindowClosesAt: order.resaleClaimWindowClosesAt,
    now: Date.now(),
  });
  if (windowState === "not_open") {
    return notice(
      String(t("resaleClaim.notOpenTitle")),
      String(t("resaleClaim.notOpenBody", { days: RESALE_CLAIM_WINDOW_DAYS })),
      "file-claim-not-open",
    );
  }
  if (windowState === "closed") {
    return notice(
      String(t("resaleClaim.closedTitle")),
      String(
        t("resaleClaim.errorWindowExpired", {
          days: RESALE_CLAIM_WINDOW_DAYS,
        }),
      ),
      "file-claim-closed",
    );
  }

  // ── Form ──────────────────────────────────────────────────────────────────

  const busy = createMutation.isPending;
  const showTicketStep = claimableTickets.length > 1;
  let step = 0;
  const stepNumeral = () => `0${++step}.`;

  return shell(
    <>
      <Text variant="body">{String(t("resaleClaim.intro"))}</Text>

      {/* Ticket (only when there is a choice) */}
      {showTicketStep && (
        <Card
          padding="$4"
          gap="$3"
          borderRadius={0}
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <XStack gap="$2" alignItems="center">
            <StepNum>{stepNumeral()}</StepNum>
            <Text
              variant="h4"
              tag="h2"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
              id={`${FIELD_IDS.ticketGroup}-label`}
            >
              {String(t("resaleClaim.stepTicket"))}
            </Text>
          </XStack>
          <RadioGroupField
            id={FIELD_IDS.ticketGroup}
            value={orderItemId ?? ""}
            onValueChange={(next: string) => {
              setOrderItemId(next);
              setErrors((e) => ({ ...e, ticket: undefined }));
            }}
            aria-labelledby={`${FIELD_IDS.ticketGroup}-label`}
            aria-describedby={errors.ticket ? FIELD_IDS.ticketError : undefined}
            aria-invalid={errors.ticket ? true : undefined}
            disabled={busy}
          >
            {claimableTickets.map((ticket) => (
              <Radio
                key={ticket.id}
                id={ticketRadioId(ticket.id)}
                value={ticket.orderItemId!}
                disabled={busy}
                label={
                  ticket.typeName ?? String(t("resaleClaim.ticketFallback"))
                }
                description={String(
                  t("resaleClaim.ticketCode", { code: ticket.code }),
                )}
                testIdBase={`claim-ticket-${ticket.id}`}
              />
            ))}
          </RadioGroupField>
          {errors.ticket && (
            <Text
              id={FIELD_IDS.ticketError}
              variant="bodySmall"
              tone="error"
              role="alert"
            >
              {errors.ticket}
            </Text>
          )}
        </Card>
      )}

      {/* Kind */}
      <Card
        padding="$4"
        gap="$3"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <XStack gap="$2" alignItems="center">
          <StepNum>{stepNumeral()}</StepNum>
          <Text
            variant="h4"
            tag="h2"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
            id={`${FIELD_IDS.kindGroup}-label`}
          >
            {String(t("resaleClaim.stepKind"))}
          </Text>
        </XStack>
        <RadioGroupField
          id={FIELD_IDS.kindGroup}
          value={kind ?? ""}
          onValueChange={(next: string) => {
            setKind(next as ClaimKind);
            setErrors((e) => ({ ...e, kind: undefined }));
          }}
          aria-labelledby={`${FIELD_IDS.kindGroup}-label`}
          aria-describedby={errors.kind ? FIELD_IDS.kindError : undefined}
          aria-invalid={errors.kind ? true : undefined}
          disabled={busy}
        >
          {CLAIM_KINDS.map((k) => (
            <Radio
              key={k}
              id={kindRadioId(k)}
              value={k}
              disabled={busy}
              label={String(t(CLAIM_KIND_COPY[k].labelKey))}
              description={String(t(CLAIM_KIND_COPY[k].descriptionKey))}
              testIdBase={`claim-kind-${k}`}
            />
          ))}
        </RadioGroupField>
        {errors.kind && (
          <Text
            id={FIELD_IDS.kindError}
            variant="bodySmall"
            tone="error"
            role="alert"
          >
            {errors.kind}
          </Text>
        )}
      </Card>

      {/* Description */}
      <Card
        padding="$4"
        gap="$3"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <XStack gap="$2" alignItems="center">
          <StepNum>{stepNumeral()}</StepNum>
          <label htmlFor={FIELD_IDS.description} style={{ cursor: "default" }}>
            <Text
              variant="h4"
              tag="span"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {String(t("resaleClaim.stepDescription"))}
            </Text>
          </label>
        </XStack>
        <Text id={FIELD_IDS.descriptionHelp} variant="bodySmall" tone="muted">
          {String(t("resaleClaim.descriptionHelp"))}
        </Text>
        {/* Validate on blur, clear on input, re-validate on submit (§6a).
            React's onBlur is focusout, so it bubbles from the textarea. */}
        <div
          onBlur={() => {
            if (description.trim().length === 0) {
              setErrors((e) => ({
                ...e,
                description: String(t("resaleClaim.descriptionRequired")),
              }));
            }
          }}
        >
          <CharCountTextarea
            id={FIELD_IDS.description}
            value={description}
            onChange={(next) => {
              setDescription(next);
              if (errors.description) {
                setErrors((e) => ({ ...e, description: undefined }));
              }
            }}
            maxLength={CLAIM_TEXT_MAX}
            minHeight={120}
            maxLines={12}
            disabled={busy}
            error={!!errors.description}
            ariaDescribedBy={
              errors.description
                ? `${FIELD_IDS.descriptionHelp} ${FIELD_IDS.descriptionError}`
                : FIELD_IDS.descriptionHelp
            }
            testIdBase="claim-description"
          />
        </div>
        {errors.description && (
          <Text
            id={FIELD_IDS.descriptionError}
            variant="bodySmall"
            tone="error"
            role="alert"
          >
            {errors.description}
          </Text>
        )}
      </Card>

      {/* Who sees what: the seller reads the description, never the
          buyer's contact details (protect the weaker side). */}
      <Card
        padding="$4"
        gap="$2"
        borderRadius={0}
        backgroundColor="$backgroundHover"
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <Text variant="overline">
          {String(t("resaleClaim.whatHappensNext"))}
        </Text>
        <Text variant="bodySmall">{String(t("resaleClaim.privacyNote"))}</Text>
        <Text variant="bodySmall">{String(t("resaleClaim.reviewNote"))}</Text>
      </Card>

      {submitError && (
        <Card
          padding="$4"
          gap="$2"
          borderRadius={0}
          borderWidth={2}
          borderColor="$danger"
          id={FIELD_IDS.submitError}
          tabIndex={-1}
          data-testid="file-claim-error"
        >
          <Text variant="body">{submitError}</Text>
        </Card>
      )}

      <XStack gap="$3" justifyContent="flex-end" flexWrap="wrap">
        <Link href={`/my-tickets/${orderId}`}>
          <Button tag="span" variant="ghost" size="$4">
            {String(t("resaleClaim.cancel"))}
          </Button>
        </Link>
        <Button
          variant="primary"
          size="$4"
          onPress={handleSubmit}
          disabled={busy}
          aria-busy={busy || undefined}
          data-testid="file-claim-submit"
        >
          {busy && <Spinner size="small" color="$colorInverted" />}
          {busy
            ? String(t("resaleClaim.submitting"))
            : String(t("resaleClaim.submit"))}
        </Button>
      </XStack>
    </>,
  );
}

export default FileClaim;
