"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { YStack, XStack, Card, Spinner, styled } from "tamagui";
import {
  Search,
  Send,
  User,
  CheckCircle,
  Mail,
  AlertCircle,
  Calendar,
} from "lucide-react";

// Swiss 2px structural divider
const Separator = styled(YStack, {
  name: "StructuralLine",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
});

import { Text, Button, Input, useTranslations, useFormatters } from "@th/ui";

import { formatErrorMessage } from "@/lib/format-error-message";
import { EmailVerificationRequiredPage } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { trpc } from "@/trpc";

// ── Hooks ──────────────────────────────────────────────────────────────────

/** Debounce a string value so downstream queries only fire after the user pauses. */
function useDebouncedValue(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ticketStatusLabels: Record<string, { labelKey: string; color: string }> =
  {
    VALID: { labelKey: "transfer.statusValid", color: "$green10" },
    SCANNED: { labelKey: "transfer.statusUsed", color: "$gray10" },
    INVALID: { labelKey: "transfer.statusInvalid", color: "$red10" },
    REFUNDED: { labelKey: "transfer.statusRefunded", color: "$orange10" },
    LISTED: { labelKey: "transfer.statusListed", color: "$accent" },
  };

const isValidEmail = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

// ── Types ──────────────────────────────────────────────────────────────────

type Recipient = {
  humanId: string;
  displayName: string | null;
  username: string | null;
  email: string;
  image: string | null;
};

type RecipientSelection =
  | { kind: "user"; recipient: Recipient }
  | { kind: "email"; email: string };

// ── Component ──────────────────────────────────────────────────────────────

type TransferProps = {
  orderId: string;
};

export const Transfer = ({ orderId }: TransferProps) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebouncedValue(searchQuery, 300);
  const [selection, setSelection] = useState<RecipientSelection | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const utils = trpc.useUtils();

  // ── Data queries ───────────────────────────────────────────────────────

  const orderQuery = trpc.orders.getMyOrder.useQuery(
    { orderId },
    { staleTime: 30_000 },
  );

  const ticketsQuery = trpc.orders.listMyOrderTickets.useQuery(
    { orderId },
    { staleTime: 30_000, enabled: !!orderQuery.data },
  );

  const recipientSearch = trpc.humans.searchTransferRecipients.useQuery(
    { query: debouncedQuery, limit: 8 },
    {
      enabled: debouncedQuery.trim().length >= 2,
      staleTime: 10_000,
      retry: false,
    },
  );

  const transferMutation = trpc.tickets.transferTicket.useMutation({
    onSuccess: () => {
      void utils.orders.getMyOrder.invalidate({ orderId });
      void utils.orders.listMyOrderTickets.invalidate({ orderId });
      void utils.orders.listMyOrders.invalidate();
    },
  });

  const emailTransferMutation = trpc.tickets.initiateEmailTransfer.useMutation({
    onSuccess: () => {
      void utils.orders.getMyOrder.invalidate({ orderId });
      void utils.orders.listMyOrderTickets.invalidate({ orderId });
      void utils.orders.listMyOrders.invalidate();
    },
  });

  const order = orderQuery.data;
  const tickets = ticketsQuery.data?.tickets;

  // Only VALID tickets can be transferred
  const transferableTickets = useMemo(
    () => tickets?.filter((tk) => tk.status === "VALID") ?? [],
    [tickets],
  );

  // Auto-select if there's only one transferable ticket
  useEffect(() => {
    if (transferableTickets.length === 1 && !selectedTicketId) {
      setSelectedTicketId(transferableTickets[0]!.id);
    }
  }, [transferableTickets, selectedTicketId]);

  // Show the "send invite by email" option when:
  // 1. No user results AND input looks like a valid email, OR
  // 2. Search errored AND input looks like a valid email (graceful fallback).
  const showEmailInviteOption = useMemo(() => {
    const looksLikeEmail = isValidEmail(searchQuery);
    if (recipientSearch.isError && looksLikeEmail) return true;
    if (!recipientSearch.data) return false;
    if (recipientSearch.data.results.length > 0) return false;
    return looksLikeEmail;
  }, [recipientSearch.data, recipientSearch.isError, searchQuery]);

  const isTransferring =
    transferMutation.isPending || emailTransferMutation.isPending;
  const isSuccess =
    transferMutation.isSuccess || emailTransferMutation.isSuccess;
  const transferError = transferMutation.error || emailTransferMutation.error;

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleSelectRecipient = useCallback((recipient: Recipient) => {
    setSelection({ kind: "user", recipient });
    setSearchQuery("");
  }, []);

  const handleSelectEmail = useCallback((email: string) => {
    setSelection({ kind: "email", email: email.trim().toLowerCase() });
    setSearchQuery("");
  }, []);

  const handleClearRecipient = useCallback(() => {
    setSelection(null);
    setShowConfirm(false);
  }, []);

  const handleSelectTicket = useCallback((ticketId: string) => {
    setSelectedTicketId((prev) => (prev === ticketId ? null : ticketId));
    setShowConfirm(false);
  }, []);

  const handleTransfer = useCallback(() => {
    if (!selection || !selectedTicketId) return;

    if (selection.kind === "user") {
      const clientKey = `web-transfer-${selectedTicketId}-${Date.now()}`;
      transferMutation.mutate({
        ticketId: selectedTicketId,
        targetHumanId: selection.recipient.humanId,
        reason: "gift",
        clientKey,
      });
    } else {
      const clientKey = `web-email-transfer-${selectedTicketId}-${Date.now()}`;
      emailTransferMutation.mutate({
        ticketId: selectedTicketId,
        recipientEmail: selection.email,
        reason: "gift",
        clientKey,
      });
    }
  }, [selection, selectedTicketId, transferMutation, emailTransferMutation]);

  // ── Loading ────────────────────────────────────────────────────────────

  if (orderQuery.isLoading) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8">
        <Spinner size="large" color="$color" />
        <Text variant="body" tone="muted">
          {String(t("transfer.loadingOrder"))}
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
        backLabel={String(t("transfer.backToMyTickets"))}
        testId="transfer-verify-email"
      />
    );
  }

  if (orderQuery.error || !order) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <Text variant="h4" color="$red10">
          {String(t("transfer.orderNotFound"))}
        </Text>
        <Link href="/my-tickets">
          <Button tag="span" variant="secondary">
            {String(t("transfer.backToMyTickets"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────

  if (isSuccess) {
    const isEmailTransfer = selection?.kind === "email";
    const recipientLabel =
      selection?.kind === "user"
        ? (selection.recipient.displayName ?? selection.recipient.email)
        : (selection?.email ?? String(t("transfer.theRecipient")));

    return (
      <YStack
        gap="$6"
        paddingVertical="$4"
        maxWidth={640}
        marginHorizontal="auto"
        width="100%"
      >
        <Link href={`/my-tickets/${orderId}`}>
          <Text
            variant="body"
            color="$accent"
            textTransform="uppercase"
            letterSpacing={1}
            weight="bold"
          >
            ← {String(t("transfer.backToOrder"))}
          </Text>
        </Link>

        <Card padding="$8" gap="$5" borderRadius={0} alignItems="center">
          <XStack
            width={64}
            height={64}
            borderRadius={0}
            backgroundColor={isEmailTransfer ? "$blue4" : "$green4"}
            alignItems="center"
            justifyContent="center"
          >
            {isEmailTransfer ? (
              <Mail size={32} color="var(--accent)" aria-hidden />
            ) : (
              <CheckCircle size={32} color="var(--success)" aria-hidden />
            )}
          </XStack>

          <YStack gap="$2" alignItems="center">
            <Text
              variant="h2"
              tag="h1"
              weight="bold"
              textAlign="center"
              textTransform="uppercase"
              letterSpacing={-0.5}
            >
              {isEmailTransfer
                ? String(t("transfer.invitationSent"))
                : String(t("transfer.ticketTransferred"))}
            </Text>
            <Text variant="body" tone="muted" textAlign="center">
              {isEmailTransfer
                ? String(
                    t("transfer.invitationSentDesc", {
                      recipient: recipientLabel,
                    }),
                  )
                : String(
                    t("transfer.transferredDesc", {
                      recipient: recipientLabel,
                    }),
                  )}
            </Text>
          </YStack>

          <Link href={`/my-tickets/${orderId}`}>
            <Button tag="span" variant="secondary" size="$3">
              {String(t("transfer.backToMyOrder"))}
            </Button>
          </Link>
        </Card>
      </YStack>
    );
  }

  // ── Event over ─────────────────────────────────────────────────────────
  // Core refuses every transfer of a past event's ticket; say so up front
  // instead of letting the buyer fill the form in to hit that refusal.

  if (order.eventEnded) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$4"
        data-testid="transfer-event-ended"
      >
        <Text variant="h4" tag="h1" weight="bold" textAlign="center">
          {String(t("transfer.eventEndedTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("transfer.eventEndedDesc"))}
        </Text>
        <Link href={`/my-tickets/${orderId}`}>
          <Button tag="span" variant="secondary">
            {String(t("transfer.backToMyOrder"))}
          </Button>
        </Link>
      </YStack>
    );
  }

  // ── Main form ──────────────────────────────────────────────────────────

  return (
    <YStack
      gap="$6"
      paddingVertical="$4"
      maxWidth={640}
      marginHorizontal="auto"
      width="100%"
    >
      {/* Back link */}
      <Link href={`/my-tickets/${orderId}`}>
        <Text
          variant="body"
          color="$accent"
          textTransform="uppercase"
          letterSpacing={1}
          weight="bold"
        >
          ← {String(t("transfer.backToOrder"))}
        </Text>
      </Link>

      {/* Header */}
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
          {String(t("transfer.transferATicket"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("transfer.sendTicketFrom"))}{" "}
          <Text variant="body" weight="bold" tag="span">
            {order.eventName}
          </Text>{" "}
          {String(t("transfer.orderToAnotherUser"))}
        </Text>
        {order.eventStartsAt && (
          <XStack gap="$2" alignItems="center" paddingTop="$1">
            <Calendar size={14} color="var(--colorMuted)" aria-hidden />
            <Text variant="bodySmall" tone="muted">
              {fmt.dateTime(
                new Date(
                  typeof order.eventStartsAt === "string"
                    ? order.eventStartsAt
                    : order.eventStartsAt,
                ),
                {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                },
              )}
            </Text>
          </XStack>
        )}
      </YStack>

      {/* Step 1: Select ticket */}
      <Card
        padding="$4"
        gap="$4"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <XStack gap="$3" alignItems="center">
          <XStack
            width={28}
            height={28}
            borderRadius={0}
            backgroundColor={selectedTicketId ? "$green4" : "$blue4"}
            alignItems="center"
            justifyContent="center"
          >
            {selectedTicketId ? (
              <CheckCircle size={16} color="var(--success)" aria-hidden />
            ) : (
              <Text
                variant="bodySmall"
                weight="bold"
                color={selectedTicketId ? "$green10" : "$accent"}
                tag="span"
              >
                1
              </Text>
            )}
          </XStack>
          <YStack flex={1}>
            <Text
              variant="h4"
              tag="h2"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {String(t("transfer.step1SelectTicket"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("transfer.chooseWhichTicket"))}
            </Text>
          </YStack>
        </XStack>
        <Separator />

        {ticketsQuery.isLoading ? (
          <XStack gap="$2" alignItems="center" padding="$3">
            <Spinner size="small" />
            <Text variant="bodySmall" tone="muted">
              {String(t("transfer.loadingTickets"))}
            </Text>
          </XStack>
        ) : transferableTickets.length === 0 ? (
          <YStack gap="$2" alignItems="center" padding="$4">
            <AlertCircle size={20} color="var(--warning)" aria-hidden />
            <Text variant="body" tone="muted" textAlign="center">
              {String(t("transfer.noTransferableTickets"))}
            </Text>
            <Text variant="bodySmall" tone="muted" textAlign="center">
              {String(t("transfer.noTransferableTicketsHint"))}
            </Text>
          </YStack>
        ) : (
          <YStack gap="$2">
            {transferableTickets.map((ticket) => {
              const isSelected = selectedTicketId === ticket.id;
              const statusInfo = ticketStatusLabels[ticket.status] ?? {
                labelKey: ticket.status,
                color: "$gray10",
              };
              const typeName = ticket.ticketTypeId
                ? order.ticketTypeNames[ticket.ticketTypeId]
                : null;
              return (
                <Card
                  key={ticket.id}
                  padding="$3"
                  borderRadius={0}
                  borderColor={isSelected ? "$blue8" : "$borderColor"}
                  borderWidth={isSelected ? 3 : 2}
                  backgroundColor={isSelected ? "$blue2" : undefined}
                  pressStyle={{ backgroundColor: "$backgroundHover" }}
                  onPress={() => handleSelectTicket(ticket.id)}
                  cursor="pointer"
                  data-testid={`select-ticket-${ticket.id}`}
                >
                  <XStack justifyContent="space-between" alignItems="center">
                    <YStack gap="$1">
                      {typeName && (
                        <Text variant="body" weight="bold">
                          {typeName}
                        </Text>
                      )}
                      <Text
                        variant={typeName ? "bodySmall" : "body"}
                        tone={typeName ? "muted" : undefined}
                        weight={typeName ? undefined : "bold"}
                      >
                        {ticket.code}
                      </Text>
                    </YStack>
                    <XStack gap="$2" alignItems="center">
                      <Text variant="bodySmall" color={statusInfo.color}>
                        {String(t(statusInfo.labelKey))}
                      </Text>
                      {isSelected && (
                        <CheckCircle size={20} color="var(--accent)" aria-hidden />
                      )}
                    </XStack>
                  </XStack>
                </Card>
              );
            })}
          </YStack>
        )}
      </Card>

      {/* Step 2: Find recipient */}
      <Card
        padding="$4"
        gap="$4"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$borderColor"
      >
        <XStack gap="$3" alignItems="center">
          <XStack
            width={28}
            height={28}
            borderRadius={0}
            backgroundColor={selection ? "$green4" : "$blue4"}
            alignItems="center"
            justifyContent="center"
          >
            {selection ? (
              <CheckCircle size={16} color="var(--success)" aria-hidden />
            ) : (
              <Text
                variant="bodySmall"
                weight="bold"
                color="$accent"
                tag="span"
              >
                2
              </Text>
            )}
          </XStack>
          <YStack flex={1}>
            <Text
              variant="h4"
              tag="h2"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={1}
            >
              {String(t("transfer.step2FindRecipient"))}
            </Text>
            <Text variant="bodySmall" tone="muted">
              {String(t("transfer.searchByEmailHint"))}
            </Text>
          </YStack>
        </XStack>
        <Separator />

        {selection ? (
          <Card
            padding="$3"
            borderRadius={0}
            borderColor={selection.kind === "email" ? "$blue8" : "$green8"}
            borderWidth={2}
            backgroundColor={selection.kind === "email" ? "$blue2" : "$green2"}
          >
            <XStack justifyContent="space-between" alignItems="center">
              <XStack gap="$3" alignItems="center">
                <XStack
                  width={40}
                  height={40}
                  borderRadius={0}
                  backgroundColor="$backgroundHover"
                  alignItems="center"
                  justifyContent="center"
                  overflow="hidden"
                >
                  {selection.kind === "user" && selection.recipient.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={selection.recipient.image}
                      alt=""
                      style={{ width: 40, height: 40, objectFit: "cover" }}
                    />
                  ) : selection.kind === "email" ? (
                    <Mail size={20} />
                  ) : (
                    <User size={20} />
                  )}
                </XStack>
                <YStack>
                  {selection.kind === "user" ? (
                    <>
                      <Text variant="body" weight="bold">
                        {selection.recipient.displayName ??
                          selection.recipient.email}
                      </Text>
                      {selection.recipient.username && (
                        <Text variant="bodySmall" tone="muted">
                          @{selection.recipient.username}
                        </Text>
                      )}
                    </>
                  ) : (
                    <>
                      <Text variant="body" weight="bold">
                        {selection.email}
                      </Text>
                      <Text variant="bodySmall" tone="muted">
                        {String(t("transfer.willBeInvited"))}
                      </Text>
                    </>
                  )}
                </YStack>
              </XStack>
              <Button size="$2" variant="ghost" onPress={handleClearRecipient}>
                {String(t("transfer.change"))}
              </Button>
            </XStack>
          </Card>
        ) : (
          <YStack gap="$3">
            <XStack position="relative" alignItems="center">
              <XStack
                position="absolute"
                left={12}
                top={0}
                bottom={0}
                alignItems="center"
                justifyContent="center"
                pointerEvents="none"
                zIndex={1}
              >
                <Search size={16} color="var(--colorMuted)" />
              </XStack>
              <Input
                flex={1}
                height={48}
                paddingLeft={42}
                placeholder={t("transfer.searchPlaceholder") as string}
                value={searchQuery}
                onChangeText={setSearchQuery}
                data-testid="recipient-search-input"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </XStack>

            {(recipientSearch.isLoading || recipientSearch.isFetching) &&
              debouncedQuery.trim().length >= 2 && (
                <XStack gap="$2" alignItems="center" padding="$2">
                  <Spinner size="small" />
                  <Text variant="bodySmall" tone="muted">
                    {String(t("transfer.searching"))}
                  </Text>
                </XStack>
              )}

            {recipientSearch.isError && debouncedQuery.trim().length >= 2 && (
              <XStack gap="$2" alignItems="center" padding="$2">
                <AlertCircle size={14} color="var(--warning)" aria-hidden />
                <Text variant="bodySmall" tone="muted">
                  {String(t("transfer.searchError"))}
                </Text>
              </XStack>
            )}

            {/* Inline email-validation hint when the query contains @ but isn't a complete email */}
            {searchQuery.includes("@") &&
              !isValidEmail(searchQuery) &&
              searchQuery.trim().length >= 2 && (
                <Text variant="bodySmall" color="$orange10" padding="$2">
                  {String(t("transfer.enterFullEmail"))}
                </Text>
              )}

            {recipientSearch.data?.results.length === 0 &&
              !showEmailInviteOption &&
              !recipientSearch.isError && (
                <YStack gap="$2" padding="$2">
                  <Text variant="bodySmall" tone="muted">
                    {String(
                      t("transfer.noUsersFound", { query: debouncedQuery }),
                    )}
                  </Text>
                  {isValidEmail(searchQuery) && (
                    <Text variant="bodySmall" color="$accent">
                      {String(t("transfer.tryFullEmail"))}
                    </Text>
                  )}
                </YStack>
              )}

            {showEmailInviteOption && (
              <Card
                padding="$3"
                borderRadius={0}
                borderColor="$blue6"
                borderWidth={2}
                backgroundColor="$blue2"
                pressStyle={{ backgroundColor: "$blue3" }}
                onPress={() => handleSelectEmail(searchQuery)}
                cursor="pointer"
                data-testid="invite-by-email"
              >
                <XStack gap="$3" alignItems="center">
                  <XStack
                    width={36}
                    height={36}
                    borderRadius={0}
                    backgroundColor="$blue4"
                    alignItems="center"
                    justifyContent="center"
                  >
                    <Mail size={18} />
                  </XStack>
                  <YStack flex={1}>
                    <Text variant="body" weight="bold">
                      {String(
                        t("transfer.sendTo", { email: searchQuery.trim() }),
                      )}
                    </Text>
                    <Text variant="bodySmall" tone="muted">
                      {String(t("transfer.inviteToClaimTicket"))}
                    </Text>
                  </YStack>
                </XStack>
              </Card>
            )}

            {recipientSearch.data &&
              recipientSearch.data.results.length > 0 && (
                <YStack gap="$1">
                  {recipientSearch.data.results.map((r) => (
                    <Card
                      key={r.humanId}
                      padding="$3"
                      borderRadius={0}
                      pressStyle={{ backgroundColor: "$backgroundHover" }}
                      onPress={() => handleSelectRecipient(r)}
                      cursor="pointer"
                      data-testid={`recipient-${r.humanId}`}
                    >
                      <XStack gap="$3" alignItems="center">
                        <XStack
                          width={36}
                          height={36}
                          borderRadius={0}
                          backgroundColor="$backgroundHover"
                          alignItems="center"
                          justifyContent="center"
                          overflow="hidden"
                        >
                          {r.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={r.image}
                              alt=""
                              style={{
                                width: 36,
                                height: 36,
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <User size={18} />
                          )}
                        </XStack>
                        <YStack flex={1}>
                          <Text variant="body" weight="bold">
                            {r.displayName ?? r.email}
                          </Text>
                          {r.username && (
                            <Text variant="bodySmall" tone="muted">
                              @{r.username}
                            </Text>
                          )}
                          {r.displayName && (
                            <Text variant="bodySmall" tone="muted">
                              {r.email}
                            </Text>
                          )}
                        </YStack>
                      </XStack>
                    </Card>
                  ))}
                </YStack>
              )}
          </YStack>
        )}
      </Card>

      {/* Step 3: Confirm */}
      {selectedTicketId && selection && (
        <Card
          padding="$4"
          gap="$4"
          borderRadius={0}
          borderTopWidth={2}
          borderTopColor="$borderColor"
        >
          <XStack gap="$3" alignItems="center">
            <XStack
              width={28}
              height={28}
              borderRadius={0}
              backgroundColor="$blue4"
              alignItems="center"
              justifyContent="center"
            >
              <Text
                variant="bodySmall"
                weight="bold"
                color="$accent"
                tag="span"
              >
                3
              </Text>
            </XStack>
            <YStack flex={1}>
              <Text
                variant="h4"
                tag="h2"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={1}
              >
                {String(t("transfer.step3Confirm"))}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {selection.kind === "email"
                  ? String(t("transfer.confirmEmailHint"))
                  : String(t("transfer.confirmDirectHint"))}
              </Text>
            </YStack>
          </XStack>
          <Separator />

          <YStack gap="$2">
            {(() => {
              const selectedTicket = transferableTickets.find(
                (tk) => tk.id === selectedTicketId,
              );
              const confirmTypeName = selectedTicket?.ticketTypeId
                ? order.ticketTypeNames[selectedTicket.ticketTypeId]
                : null;
              return (
                <XStack justifyContent="space-between" alignItems="center">
                  <Text variant="body" tone="muted">
                    {String(t("transfer.ticket"))}
                  </Text>
                  <YStack alignItems="flex-end">
                    {confirmTypeName && (
                      <Text variant="body" weight="bold">
                        {confirmTypeName}
                      </Text>
                    )}
                    <Text
                      variant={confirmTypeName ? "bodySmall" : "code"}
                      tone={confirmTypeName ? "muted" : undefined}
                      fontSize={confirmTypeName ? undefined : "$2"}
                    >
                      {selectedTicket?.code ?? "—"}
                    </Text>
                  </YStack>
                </XStack>
              );
            })()}
            <XStack justifyContent="space-between">
              <Text variant="body" tone="muted">
                {String(t("transfer.recipient"))}
              </Text>
              <Text variant="body" weight="bold">
                {selection.kind === "user"
                  ? (selection.recipient.displayName ??
                    selection.recipient.email)
                  : selection.email}
              </Text>
            </XStack>
            {selection.kind === "email" && (
              <XStack justifyContent="space-between">
                <Text variant="body" tone="muted">
                  {String(t("transfer.method"))}
                </Text>
                <Text variant="bodySmall" color="$accent">
                  {String(t("transfer.emailInvitation"))}
                </Text>
              </XStack>
            )}
          </YStack>

          {transferError && (
            <Text variant="bodySmall" color="$red10">
              {formatErrorMessage(transferError, t)}
            </Text>
          )}

          {!showConfirm ? (
            <Button
              variant="primary"
              size="$3"
              onPress={() => setShowConfirm(true)}
              data-testid="transfer-review-btn"
            >
              {selection.kind === "email" ? (
                <Mail size={16} aria-hidden />
              ) : (
                <Send size={16} aria-hidden />
              )}
              {selection.kind === "email"
                ? String(t("transfer.reviewInvitation"))
                : String(t("transfer.reviewTransfer"))}
            </Button>
          ) : (
            <YStack gap="$3">
              <Card
                padding="$3"
                borderRadius={0}
                borderColor="$orange6"
                borderWidth={2}
                backgroundColor="$orange2"
              >
                <Text variant="bodySmall" textAlign="center">
                  {selection.kind === "email"
                    ? String(t("transfer.emailConfirmWarning"))
                    : String(t("transfer.directConfirmWarning"))}
                </Text>
              </Card>
              <XStack gap="$2">
                <Button
                  flex={1}
                  variant="primary"
                  size="$3"
                  onPress={handleTransfer}
                  disabled={isTransferring}
                  data-testid="transfer-confirm-btn"
                >
                  {isTransferring
                    ? String(t("transfer.sending"))
                    : selection.kind === "email"
                      ? String(t("transfer.sendInvitation"))
                      : String(t("transfer.confirmTransfer"))}
                </Button>
                <Button
                  variant="ghost"
                  size="$3"
                  onPress={() => setShowConfirm(false)}
                  disabled={isTransferring}
                >
                  {String(t("common.cancel"))}
                </Button>
              </XStack>
            </YStack>
          )}
        </Card>
      )}
    </YStack>
  );
};
