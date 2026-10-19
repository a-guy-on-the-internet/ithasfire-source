"use client";

import { useEffect, useId, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { Button, DateTime, Spinner, useLocale } from "@th/ui";

import { trpc } from "@/trpc";

import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// "Changes since it froze" (freeze-the-deal FR-007 / FR-010, board History):
// every frozen change, newest first, each line before (struck) → after, in
// the change notice's own words (`deals.listDealChanges` returns them per
// line, in the reader's language). The last item is the freeze itself.
//
// Pages by cursor with one query per page rather than `useInfiniteQuery`,
// whose added `direction` key the strict input would refuse.
// ─────────────────────────────────────────────────────────────────────────────

export type DealChangesPage =
  inferRouterOutputs<AppRouter>["deals"]["listDealChanges"];
type DealChangeItem = DealChangesPage["items"][number];

/** The reader's catalog language, as the core copy knows it. */
export function changesLocale(locale: string): "en" | "es" {
  return locale.toLowerCase().startsWith("es") ? "es" : "en";
}

/** The first page's query: the editor and this list share its cache. */
export function useDealChangesFirstPage(eventId: string | null) {
  const locale = changesLocale(useLocale());
  return trpc.deals.listDealChanges.useQuery(
    { eventId: eventId ?? "", locale },
    {
      enabled: !!eventId,
      retry: false,
      meta: { silent: true },
    },
  );
}

/**
 * The list itself. `first` is the first page (already read by the host);
 * older pages load on demand. Renders nothing until the deal has frozen.
 */
export function DealChanges({
  first,
  testIdBase,
  headingLevel = 4,
}: {
  first: DealChangesPage;
  testIdBase: string;
  headingLevel?: 2 | 4;
}) {
  const { t } = useDealWords();
  const titleId = useId();
  const testId = `${testIdBase}-changes`;
  const [cursors, setCursors] = useState<string[]>([]);
  const [last, setLast] = useState<DealChangesPage | null>(null);
  // Pressing "Show older changes" again after a page failed asks it again.
  const [retry, setRetry] = useState(0);
  const timeZone = first.event.timezone ?? "UTC";
  const frozenAt = first.event.dealFrozenAt;
  if (!frozenAt) return null;

  const nextCursor = (last ?? first).nextCursor;
  const Heading = headingLevel === 2 ? "h2" : "h4";

  return (
    <section
      className={styles.changes}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <Heading
        id={titleId}
        className={headingLevel === 2 ? styles.pageSectionTitle : styles.sectionTitle}
      >
        {t("deals.history.title")}
      </Heading>
      <p className={styles.hint}>{t("deals.history.hint")}</p>
      <ol className={styles.changeList}>
        {first.items.map((item) => (
          <ChangeItem
            key={item.id}
            item={item}
            timeZone={timeZone}
            testId={testId}
          />
        ))}
        {cursors.map((cursor) => (
          <OlderPage
            key={cursor}
            eventId={first.eventId}
            cursor={cursor}
            timeZone={timeZone}
            testId={testId}
            onLoaded={setLast}
            retry={cursor === nextCursor ? retry : 0}
          />
        ))}
        {nextCursor ? null : (
          <FrozenItem
            frozenAt={frozenAt}
            frozenBy={first.event.frozenBy}
            timeZone={timeZone}
            testId={testId}
          />
        )}
      </ol>
      {nextCursor ? (
        <div>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => {
              if (cursors.includes(nextCursor)) setRetry((n) => n + 1);
              else {
                setRetry(0);
                setCursors((c) => [...c, nextCursor]);
              }
            }}
            testID={`${testId}-older`}
          >
            {t("deals.history.older")}
          </Button>
        </div>
      ) : null}
      <p className={styles.hint}>{t("deals.history.resaleNote")}</p>
    </section>
  );
}

function OlderPage({
  eventId,
  cursor,
  timeZone,
  testId,
  onLoaded,
  retry,
}: {
  eventId: string;
  cursor: string;
  timeZone: string;
  testId: string;
  onLoaded: (page: DealChangesPage) => void;
  /** Bumped to ask a failed page again. */
  retry: number;
}) {
  const { t } = useDealWords();
  const locale = changesLocale(useLocale());
  const page = trpc.deals.listDealChanges.useQuery(
    { eventId, cursor, locale },
    { retry: false, meta: { silent: true } },
  );
  useEffect(() => {
    if (page.data) onLoaded(page.data);
  }, [page.data, onLoaded]);
  const { refetch } = page;
  useEffect(() => {
    if (retry > 0) void refetch();
  }, [retry, refetch]);
  if (page.isLoading) {
    return (
      <li className={styles.changeItem} aria-busy>
        <span className={styles.actions}>
          <Spinner size="sm" />
          <span className={styles.hint}>{t("deals.history.loading")}</span>
        </span>
      </li>
    );
  }
  if (!page.data) {
    return (
      <li className={styles.changeItem} role="status">
        <span className={`${styles.hint} ${styles.dangerText}`}>
          {t("deals.history.failed")}
        </span>
      </li>
    );
  }
  return (
    <>
      {page.data.items.map((item) => (
        <ChangeItem key={item.id} item={item} timeZone={timeZone} testId={testId} />
      ))}
    </>
  );
}

function ChangeItem({
  item,
  timeZone,
  testId,
}: {
  item: DealChangeItem;
  timeZone: string;
  testId: string;
}) {
  const { t } = useDealWords();
  const locale = useLocale();
  const when = DateTime.format(item.createdAt, "datetime", { timeZone, locale });
  const who = item.actor?.name ?? t("deals.history.someone");
  return (
    <li className={styles.changeItem} data-testid={`${testId}-item`}>
      <span className={styles.overline}>
        {t("deals.history.by", { when, name: who })}
      </span>
      {item.lines.length === 0 ? (
        <p className={styles.blockBody}>{t("deals.history.noLines")}</p>
      ) : (
        <dl className={styles.changeLines}>
          {item.lines.map((line, i) => (
            <div key={i} className={styles.changeLine}>
              <dt className={styles.changeSubject}>{line.text.subject}</dt>
              <dd className={styles.changeValues}>
                <s className={styles.was}>
                  <span className={styles.srOnly}>
                    {t("deals.history.before")}{" "}
                  </span>
                  {line.text.before}
                </s>{" "}
                <span aria-hidden>→</span>{" "}
                <span>
                  <span className={styles.srOnly}>
                    {t("deals.history.after")}{" "}
                  </span>
                  {line.text.after}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function FrozenItem({
  frozenAt,
  frozenBy,
  timeZone,
  testId,
}: {
  frozenAt: Date;
  frozenBy: DealChangesPage["event"]["frozenBy"];
  timeZone: string;
  testId: string;
}) {
  const { t } = useDealWords();
  const locale = useLocale();
  const when = DateTime.format(frozenAt, "datetime", { timeZone, locale });
  return (
    <li
      className={`${styles.changeItem} ${styles.changeItemFrozen}`}
      data-testid={`${testId}-frozen`}
    >
      <span className={`${styles.overline} ${styles.overlineMuted}`}>
        {frozenBy
          ? t("deals.history.frozenBy", {
              when,
              name: frozenBy.name ?? t("deals.history.someone"),
            })
          : t("deals.history.frozenAuto", { when })}
      </span>
    </li>
  );
}
