"use client";

import { NextLinkAnchor } from "@th/ui";
import { Info } from "lucide-react";

import {
  billInOrder,
  billIndexLabel,
  billTagOf,
  type BillItem,
  type BillTag,
} from "./bill-model";
import { DealTag, type DealTagTone } from "./ClauseRow";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

const ROLE_KEYS: Record<BillItem["role"], string> = {
  PERFORMER: "admin.ebLineupRolePerformer",
  HOST: "admin.ebLineupRoleHost",
  DJ: "admin.ebLineupRoleDj",
  INSTRUCTOR: "admin.ebLineupRoleInstructor",
  SPEAKER: "admin.ebLineupRoleSpeaker",
  VENDOR: "admin.ebLineupRoleVendor",
  VOLUNTEER: "admin.ebLineupRoleVolunteer",
  OTHER: "admin.ebLineupRoleOther",
};

const TAG: Record<BillTag, { key: string; tone: DealTagTone }> = {
  joined: { key: "deals.bill.joined", tone: "agreed" },
  invited: { key: "deals.bill.invited", tone: "warning" },
  byName: { key: "deals.bill.byName", tone: "neutral" },
  passed: { key: "deals.bill.passed", tone: "neutral" },
};

/**
 * The bill on the agreement page (board A1): the originating request's acts,
 * read-only, right above the deal, so it is clear why an act is offered as a
 * payee. Acts join or pass on their own invite; nothing here changes them.
 * Renders nothing when the request had no bill.
 */
export function BillSection({
  bill,
  unavailable,
  testIdBase,
}: {
  bill: readonly BillItem[];
  /** The bill read failed (the agreement read degraded it to `[]`). */
  unavailable: boolean;
  testIdBase: string;
}) {
  const { t } = useDealWords();
  const testId = `${testIdBase}-bill`;
  if (!unavailable && bill.length === 0) return null;
  const titleId = `${testId}-title`;

  return (
    <section
      className={`${styles.root} ${styles.presets}`}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionHeadText}>
          <h3 id={titleId} className={styles.sectionTitle}>
            {t("deals.bill.title")}
          </h3>
          <p className={styles.hint}>{t("deals.bill.hint")}</p>
        </div>
      </div>
      {unavailable ? (
        <p className={styles.notice} role="status">
          <Info size={16} strokeWidth={2} aria-hidden />
          <span>{t("deals.bill.unavailable")}</span>
        </p>
      ) : (
        <ol className={styles.list}>
          {billInOrder(bill).map((item, position) => {
            const tag = TAG[billTagOf(item)];
            const role =
              item.role === "OTHER" && item.customRoleLabel
                ? item.customRoleLabel
                : t(ROLE_KEYS[item.role]);
            const name = item.displayName ?? t("deals.bill.unnamed");
            return (
              <li
                key={item.id}
                className={styles.billRow}
                data-testid={`${testId}-${position}`}
              >
                <span className={styles.billIndex} aria-hidden>
                  {billIndexLabel(position)}
                </span>
                <div className={styles.who}>
                  <span className={styles.whoName}>
                    {item.href ? (
                      <NextLinkAnchor
                        href={item.href}
                        className={styles.plainLink}
                      >
                        {name}
                      </NextLinkAnchor>
                    ) : (
                      name
                    )}
                  </span>
                  <span className={styles.whoMeta}>
                    {position === 0
                      ? `${role} · ${t("deals.bill.headlining")}`
                      : role}
                  </span>
                </div>
                <div className={styles.rowSide}>
                  <DealTag tone={tag.tone}>{t(tag.key)}</DealTag>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
