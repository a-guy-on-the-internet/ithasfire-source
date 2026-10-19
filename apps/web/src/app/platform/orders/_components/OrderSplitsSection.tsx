"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { XStack, YStack } from "tamagui";
import { Badge, Text, useTranslations } from "@th/ui";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { truncateId, truncateProviderId } from "@/lib/format";
import { MoneyText } from "../../_components/MoneyText";
import { MonoText, SectionDivider, SectionHeader } from "./detail-parts";

// ─────────────────────────────────────────────────────────────────────────────
// "Who got paid what" for one order — READ ONLY.
//
// `splits.listForOrder` is ADMIN-gated, but `/platform/orders` is reachable by
// ADMIN, SUPPORT and DEVELOPER. So the query is gated on the actor's real
// roles before it is fired: a SUPPORT reader would otherwise be handed a 403
// and an error state for a page they are perfectly entitled to be on. The
// server gate remains the real boundary — this only stops the UI manufacturing
// an alarm out of a normal, expected refusal.
// ─────────────────────────────────────────────────────────────────────────────

/** Amounts and ids must never break mid-token inside a narrow column. */
const NOWRAP = { whiteSpace: "nowrap" } as const;

type SplitRow =
  inferRouterOutputs<AppRouter>["splits"]["listForOrder"]["splits"][number];

/**
 * Derived from the router, never re-declared. A hand-written twin keeps
 * compiling through a server-side field rename (`subjectType` -> `subjectKind`)
 * while `nameFor`/`kindFor` silently return null for every row — every payee
 * degrades to a bare truncated id and nothing goes red.
 *
 * `NonNullable` rather than the declared shape because the two are in flux:
 * the output schema declares `payee` non-nullable while the mapper can emit
 * null, so the null branch below has to stay renderable whichever way that
 * lands.
 */
type SplitPayee = NonNullable<SplitRow["payee"]>;

export interface OrderSplitsSectionProps {
  orderId: string;
  /** ISO 4217 from the order — splits carry no currency of their own. */
  currency: string;
  /**
   * Identities already on the order row. A split carries only a payee's
   * subject TYPE and ID, so without these every row would read as a bare
   * uuid; when the subject is this order's own org (or buyer) we can name it
   * for free. Matched by exact id, so a name can never land on the wrong row.
   */
  orgId: string | null;
  orgName: string | null;
  buyerHumanId: string;
  buyerName: string | null;
}

export function OrderSplitsSection({
  orderId,
  currency,
  orgId,
  orgName,
  buyerHumanId,
  buyerName,
}: OrderSplitsSectionProps) {
  const t = useTranslations();

  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const isAdmin = (staffAccessQuery.data?.roles ?? []).some(
    (role) => role === "ADMIN",
  );

  const splitsQuery = trpc.splits.listForOrder.useQuery(
    { orderId },
    {
      // The whole point: never fired for SUPPORT/DEVELOPER.
      enabled: isAdmin,
      staleTime: 30_000,
      retry: false,
      // Deliberately NOT `meta: { silent: true }`: once the actor is known to
      // be ADMIN a failure here is a real one, and the global handler's toast
      // and Sentry report are both wanted. The inline message below says
      // WHICH section failed; the toast says that something did.
    },
  );

  const headingId = `order-splits-heading-${orderId}`;
  const splits = splitsQuery.data?.splits ?? [];

  const nameFor = (payee: SplitPayee | null): string | null => {
    if (!payee) return null;
    if (payee.subjectType === "ORGANIZATION" && payee.subjectId === orgId) {
      return orgName?.trim() || null;
    }
    if (payee.subjectType === "HUMAN" && payee.subjectId === buyerHumanId) {
      return buyerName?.trim() || null;
    }
    return null;
  };

  const kindFor = (payee: SplitPayee | null): string | null => {
    if (!payee) return null;
    if (payee.subjectType === "ORGANIZATION")
      return String(t("admin.pstPayoutKindOrg"));
    if (payee.subjectType === "HUMAN")
      return String(t("admin.pstPayoutKindHuman"));
    return payee.subjectType;
  };

  return (
    <>
      <SectionDivider />
      <YStack gap="$2" tag="section" aria-labelledby={headingId}>
        <SectionHeader id={headingId}>
          {splitsQuery.data
            ? `${String(t("admin.plSplits"))} (${splits.length})`
            : String(t("admin.plSplits"))}
        </SectionHeader>

        {staffAccessQuery.isLoading || (isAdmin && splitsQuery.isLoading) ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.plSplitsLoading"))}
          </Text>
        ) : !isAdmin ? (
          // Quiet, not an error: a SUPPORT reader is legitimately here and the
          // absence of the table is a rule, not a failure. Saying so beats a
          // silently missing section, which reads as "this order has none".
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.plSplitsAdminOnly"))}
          </Text>
        ) : splitsQuery.isError ? (
          <Text variant="bodySmall" tone="error" role="alert">
            {/* The translator is not optional here: without it
                `formatErrorMessage` never consults the `errors.*` catalog and
                a coded failure renders hardcoded English beside a Spanish
                page — diagnosed only by a console.warn, which Sentry does not
                capture. */}
            {`${String(t("admin.plSplitsError"))} ${formatErrorMessage(
              splitsQuery.error,
              t,
            )}`}
          </Text>
        ) : splits.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.plSplitsEmpty"))}
          </Text>
        ) : (
          <>
            <YStack
              borderWidth={2}
              borderColor="$borderColor"
              borderRadius={0}
              overflow="hidden"
            >
              {/* Column heads — the mono label idiom, same as the section
                  headers above them. */}
              <XStack
                paddingHorizontal="$2"
                paddingVertical="$2"
                backgroundColor="$backgroundHover"
                gap="$2"
              >
                <Text variant="overline" tone="muted" style={{ flex: 1 }}>
                  {String(t("admin.plSplitsPayee"))}
                </Text>
                <Text
                  variant="overline"
                  tone="muted"
                  style={{ textAlign: "right" }}
                >
                  {String(t("admin.plSplitsAmount"))}
                </Text>
              </XStack>

              {splits.map((split) => {
                const payee: SplitPayee | null = split.payee ?? null;
                const name = nameFor(payee);
                const kind = kindFor(payee);
                const subjectId = payee?.subjectId ?? null;

                return (
                  <XStack
                    key={split.id}
                    paddingHorizontal="$2"
                    paddingVertical="$2"
                    borderTopWidth={1}
                    borderTopColor="$borderColor"
                    gap="$2"
                    alignItems="flex-start"
                  >
                    {/* minWidth 0 is what lets the name ellipse instead of
                        shoving the amount off the panel at 320px. */}
                    <YStack style={{ flex: 1, minWidth: 0 }} gap="$1">
                      {/* Never blank: name → kind → the payee id, which the
                          split always carries even when the payee row itself
                          did not resolve. */}
                      <Text variant="bodySmall" weight="bold" ellipse>
                        {name ?? kind ?? truncateId(split.payeeId)}
                      </Text>
                      <XStack gap="$2" alignItems="center" flexWrap="wrap">
                        {name && kind && (
                          <Text variant="caption" tone="muted">
                            {kind}
                          </Text>
                        )}
                        {subjectId && (
                          <MonoText size={10}>
                            {truncateId(subjectId)}
                          </MonoText>
                        )}
                        {payee?.stripeAccountId && (
                          <MonoText size={10}>
                            {truncateProviderId(payee.stripeAccountId)}
                          </MonoText>
                        )}
                      </XStack>
                    </YStack>

                    <YStack
                      alignItems="flex-end"
                      gap="$1"
                      style={{ flexShrink: 0 }}
                    >
                      <MoneyText
                        cents={split.amountCents}
                        currency={currency}
                        variant="bodySmall"
                        weight="bold"
                        style={NOWRAP}
                      />
                      {/* Only the exception is badged. A "payouts on" chip on
                          every row would be noise and eat the support budget. */}
                      {payee && !payee.payoutsEnabled && (
                        <Badge tone="warning" size="sm">
                          {String(t("admin.plSplitsPayoutsOff"))}
                        </Badge>
                      )}
                    </YStack>
                  </XStack>
                );
              })}
            </YStack>

            <XStack
              justifyContent="space-between"
              alignItems="baseline"
              gap="$2"
              paddingTop="$1"
              borderTopWidth={1}
              borderTopColor="$borderColor"
            >
              <Text variant="caption" weight="bold">
                {String(t("admin.plSplitsTotal"))}
              </Text>
              <MoneyText
                cents={splitsQuery.data?.totalCents ?? 0}
                currency={currency}
                variant="bodySmall"
                weight="bold"
                style={NOWRAP}
              />
            </XStack>
          </>
        )}
      </YStack>
    </>
  );
}
