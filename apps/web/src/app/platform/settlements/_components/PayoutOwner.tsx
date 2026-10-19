"use client";

import { useEffect, useMemo, useState } from "react";
import { YStack } from "tamagui";
import { NextLinkAnchor, Text, useTranslations } from "@th/ui";

import { truncateId } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits for the two payout sections on /platform/settlements ("Payouts
// owed" and "Payouts sent"). Both answer "to whom", both need the same zone
// for their dates, and having them disagree on either would be a bug a reader
// could not see.
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutOwnerRef {
  /** Null when the Payee row is missing or the identity lookup degraded. */
  subjectType: "ORGANIZATION" | "HUMAN" | null;
  subjectId: string | null;
  ownerLabel: string | null;
  ownerSlug: string | null;
  /** Always present — the last resort when nothing else resolved. */
  payeeId: string;
}

/**
 * Where "Payee" links. Organisations have an admin surface at
 * `/admin/<slug>`; humans have none, so the link is the platform humans list
 * pre-filtered by name — the same target the dispute desk and the sibling
 * "Payees in debt" section use. Null = render as plain text.
 */
export function payoutOwnerHref(row: PayoutOwnerRef): string | null {
  if (row.subjectType === "ORGANIZATION") {
    return row.ownerSlug ? `/admin/${encodeURIComponent(row.ownerSlug)}` : null;
  }
  if (row.subjectType === "HUMAN") {
    const name = row.ownerLabel?.trim();
    return name ? `/platform/humans?q=${encodeURIComponent(name)}` : null;
  }
  return null;
}

/**
 * Never blank. Falls back through display name → subject id → payee id, so a
 * degraded identity lookup still leaves a row a human can act on rather than
 * an anonymous amount.
 */
export function payoutOwnerName(row: PayoutOwnerRef): string {
  return (
    row.ownerLabel?.trim() ||
    (row.subjectId ? truncateId(row.subjectId) : truncateId(row.payeeId))
  );
}

export function PayoutOwnerCell({
  row,
  currency,
}: {
  row: PayoutOwnerRef;
  currency: string;
}) {
  const t = useTranslations();
  const href = payoutOwnerHref(row);
  const name = payoutOwnerName(row);
  const kind =
    row.subjectType === "ORGANIZATION"
      ? String(t("admin.pstPayoutKindOrg"))
      : row.subjectType === "HUMAN"
        ? String(t("admin.pstPayoutKindHuman"))
        : null;

  return (
    <YStack minWidth={0}>
      {href ? (
        <NextLinkAnchor
          href={href}
          aria-label={`${name}, ${currency.toUpperCase()}`}
        >
          <Text variant="bodySmall" weight="bold" color="$accentText">
            {name}
          </Text>
        </NextLinkAnchor>
      ) : (
        <Text variant="bodySmall" weight="bold">
          {name}
        </Text>
      )}
      {kind && (
        <Text variant="caption" tone="muted">
          {kind}
        </Text>
      )}
    </YStack>
  );
}

/**
 * The zone every date in these sections renders in.
 *
 * `<DateTime>` requires an explicit `timeZone` by design — an EVENT happens
 * where it happens, and converting it to the reader's zone produces a time
 * that is correct and useless. A PAYOUT has no venue: it is money leaving a
 * platform Stripe balance, and the only zone that means anything to the staff
 * member reading it is their own. So this resolves the reader's IANA zone,
 * which is also what the rest of this page has always rendered in via
 * `fmtDateShort` — the difference is that here the choice is explicit and
 * stated on screen (`pstPaidTimeZoneNote`) instead of implied.
 *
 * RESOLVED AFTER MOUNT, not during render, and that is the whole point of the
 * `resolved` flag. `Intl.DateTimeFormat().resolvedOptions().timeZone` returns
 * the SERVER's zone during the SSR pass and the BROWSER's afterwards, so any
 * markup derived from it mismatches on hydration for every reader outside the
 * server's zone. In local dev both are the same machine, which is exactly why
 * driving the page here cannot catch it — in production the server is UTC and
 * the reader is not.
 *
 * Callers render zone-dependent text only when `resolved` is true. The
 * pre-mount `timeZone` is a deterministic "UTC" so the server and the first
 * client render agree; no row is visible at that point anyway, since every
 * row on this page arrives from a client-side tRPC query.
 */
export function usePlatformTimeZone(): {
  timeZone: string;
  resolved: boolean;
} {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    try {
      setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setZone("UTC");
    }
  }, []);
  return useMemo(
    () => ({ timeZone: zone ?? "UTC", resolved: zone !== null }),
    [zone],
  );
}
