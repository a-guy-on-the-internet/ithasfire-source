"use client";

import { Text, useLocale, useTranslations } from "@th/ui";

import {
  INVITE_ROLE_KEYS,
  ORDINAL_KEYS,
  billIndex,
  formatPreferredDate,
  mergeBill,
  positionLabel,
  type ActInvite,
  type BillRow,
  type InviteIdentity,
  type InviteRole,
} from "../_lib/invite-view";
import styles from "./act-invite.module.css";
import { InlineLink } from "./InlineLink";

// ─────────────────────────────────────────────────────────────────────────────
// The letter half of board I1: the facts (from, place, dates, your spot) and
// "The bill so far". Read-only; the answer block lives in InviteAnswer.
// ─────────────────────────────────────────────────────────────────────────────

type Translate = ReturnType<typeof useTranslations>;

function roleText(
  t: Translate,
  role: InviteRole,
  customRoleLabel: string | null,
): string {
  if (role === "OTHER" && customRoleLabel) return customRoleLabel;
  return String(t(INVITE_ROLE_KEYS[role]));
}

/** "Headlining" or "2nd" (no total, ever: positions are dense per viewer). */
function positionText(t: Translate, sortOrder: number, locale: string): string {
  const label = positionLabel(sortOrder, locale);
  if (label.kind === "headline") {
    return String(t("bookingActInvite.headlining"));
  }
  return String(t(ORDINAL_KEYS[label.category], { n: label.n }));
}

function joinDot(parts: string[]): string {
  return parts.join(" · ");
}

// ── Facts ────────────────────────────────────────────────────────────────────

export function InviteFacts({
  invite,
  identity,
}: {
  invite: ActInvite;
  identity: InviteIdentity;
}) {
  const t = useTranslations();
  const locale = useLocale();

  // Same fallbacks as the heading, so a nameless sender or place reads the
  // same word everywhere on the page.
  const senderName =
    invite.sender.displayName ??
    String(t("bookingActInvite.senderFallback"));
  const placeName =
    invite.venue.name ?? String(t("bookingActInvite.placeFallback"));
  const placeHref = invite.venue.pageSlug
    ? `/p/${encodeURIComponent(invite.venue.pageSlug)}`
    : null;

  return (
    <dl className={styles.facts} data-testid="act-invite-facts">
      <dt>
        <Text variant="overline" tone="muted">
          {String(t("bookingActInvite.fromLabel"))}
        </Text>
      </dt>
      <dd>
        <Text variant="body" weight="bold">
          {invite.sender.href ? (
            <InlineLink href={invite.sender.href} weight="bold">
              {senderName}
            </InlineLink>
          ) : (
            senderName
          )}
        </Text>
      </dd>

      <dt>
        <Text variant="overline" tone="muted">
          {String(t("bookingActInvite.placeLabel"))}
        </Text>
      </dt>
      <dd>
        <Text variant="body" weight="bold">
          {placeHref ? (
            <InlineLink href={placeHref} weight="bold">
              {placeName}
            </InlineLink>
          ) : (
            placeName
          )}
        </Text>
      </dd>

      <dt>
        <Text variant="overline" tone="muted">
          {String(t("bookingActInvite.datesLabel"))}
        </Text>
      </dt>
      <dd>
        {invite.preferredDates.length > 0 ? (
          <ul className={styles.dateList}>
            {invite.preferredDates.map((raw, index) => (
              <li key={`${raw}-${index}`}>
                <Text variant="body" weight="bold">
                  {formatPreferredDate(raw, locale)}
                </Text>
              </li>
            ))}
          </ul>
        ) : (
          <Text variant="body" tone="muted">
            {String(t("bookingActInvite.noDates"))}
          </Text>
        )}
      </dd>

      <dt>
        <Text variant="overline" tone="muted">
          {String(t("bookingActInvite.spotLabel"))}
        </Text>
      </dt>
      <dd>
        <Text variant="body" weight="bold" data-testid="act-invite-spot">
          {joinDot([
            positionText(t, identity.myAct.sortOrder, locale),
            roleText(t, identity.myAct.role, identity.myAct.customRoleLabel),
          ])}
        </Text>
      </dd>
    </dl>
  );
}

// ── The bill so far ──────────────────────────────────────────────────────────

function BillItem({ row }: { row: BillRow }) {
  const t = useTranslations();
  const name = row.displayName ?? String(t("bookingActInvite.unnamed"));

  const meta: string[] = [];
  if (row.sortOrder === 0) meta.push(String(t("bookingActInvite.headlining")));
  meta.push(roleText(t, row.role, row.customRoleLabel));
  if (row.byName) meta.push(String(t("bookingActInvite.byName")));
  if (row.passed) meta.push(String(t("bookingActInvite.passedTag")));

  return (
    <li
      className={`${styles.billRow} ${row.mine ? styles.billRowMine : ""}`}
      data-testid={row.mine ? "act-invite-bill-row-mine" : "act-invite-bill-row"}
    >
      <Text variant="overline" tone="muted" aria-hidden>
        {billIndex(row.sortOrder)}
      </Text>
      <div className={styles.billBody}>
        <div className={styles.billName}>
          <Text variant="body" weight="bold" className={styles.wrap}>
            {row.href ? (
              <InlineLink href={row.href} tone="name" weight="bold">
                {name}
              </InlineLink>
            ) : (
              name
            )}
          </Text>
          {row.mine && (
            <Text variant="overline" className={styles.tag}>
              {String(t("bookingActInvite.youTag"))}
            </Text>
          )}
        </div>
        <Text variant="overline" tone="muted" className={styles.wrap}>
          {joinDot(meta)}
        </Text>
      </div>
    </li>
  );
}

export function InviteBill({ invite }: { invite: ActInvite }) {
  const t = useTranslations();
  const rows = mergeBill(invite);
  const headingId = `act-invite-bill-${invite.bookingRequestId}`;

  return (
    <section aria-labelledby={headingId} className={styles.billSection}>
      <Text variant="h6" tag="h2" id={headingId} weight="bold">
        {String(t("bookingActInvite.billHeading"))}
      </Text>
      <ol className={styles.bill}>
        {rows.map((row) => (
          <BillItem key={row.key} row={row} />
        ))}
      </ol>
    </section>
  );
}
