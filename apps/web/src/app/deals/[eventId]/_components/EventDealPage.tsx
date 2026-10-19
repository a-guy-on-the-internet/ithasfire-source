"use client";

import { Button, DateTime, NextLinkAnchor, Spinner, useLocale } from "@th/ui";
import { Info, Lock } from "lucide-react";

import {
  DealChanges,
  DealSummary,
  type DealTarget,
} from "@/components/deals";
import { useDealChangesFirstPage } from "@/components/deals/DealChanges";
import { useDealWords } from "@/components/deals/use-deal-words";
import styles from "@/components/deals/deals.module.css";
import { getAppErrorCode } from "@/lib/app-error";
import { trpc } from "@/trpc";

type Outcome = "SIGNED_OUT" | "NOT_ALLOWED" | "NOT_FOUND" | "ERROR";

function outcomeOf(error: unknown): Outcome {
  const code = getAppErrorCode(error);
  const trpcCode = (error as { data?: { code?: unknown } } | null)?.data?.code;
  // The session ran out on an open page (the route gate covers a fresh load).
  if (
    code === "UNAUTHORIZED" ||
    code === "UNAUTHENTICATED" ||
    trpcCode === "UNAUTHORIZED"
  )
    return "SIGNED_OUT";
  if (code === "INSUFFICIENT_ROLE" || code === "FORBIDDEN") return "NOT_ALLOWED";
  if (
    code === "EVENT_NOT_FOUND" ||
    code === "NOT_FOUND" ||
    // A malformed id in the link: there is no such event.
    code === "INVALID_INPUT" ||
    code === "BAD_REQUEST"
  )
    return "NOT_FOUND";
  return "ERROR";
}

/**
 * A payee's view of an event's deal (freeze-the-deal FR-007): the event,
 * whether the deal is frozen, the deal now as far as this reader may see it
 * (`DealSummary`, the existing `getTermsDeal` gate: a payee sees their own
 * line), and every change since it froze.
 */
export function EventDealPage({ eventId }: { eventId: string }) {
  const { t } = useDealWords();
  const locale = useLocale();
  const read = useDealChangesFirstPage(eventId);
  const target: DealTarget = { kind: "EVENT", eventId };
  // Same key and options as DealSummary's read: one request, one cache.
  // Says whether this reader sees the whole deal or only their own line.
  const terms = trpc.deals.getTermsDeal.useQuery(
    { target },
    { retry: false, meta: { silent: true }, enabled: !!read.data },
  );
  const testId = "deal-page";

  if (read.isLoading) {
    return (
      <div className={styles.actions} aria-busy data-testid={`${testId}-loading`}>
        <Spinner size="sm" />
        <span className={styles.hint}>{t("deals.page.loading")}</span>
      </div>
    );
  }

  if (read.error || !read.data) {
    const outcome = outcomeOf(read.error);
    if (outcome === "SIGNED_OUT") {
      const back = `/deals/${encodeURIComponent(eventId)}`;
      return (
        <div
          className={styles.block}
          role="status"
          data-testid={`${testId}-signed-out`}
        >
          <h1 className={styles.blockTitle}>{t("deals.page.signInTitle")}</h1>
          <div>
            <NextLinkAnchor
              className={styles.link}
              href={`/sign-in?redirect=${encodeURIComponent(back)}`}
              data-testid={`${testId}-sign-in`}
            >
              {t("deals.page.signIn")}
            </NextLinkAnchor>
          </div>
        </div>
      );
    }
    return (
      <div
        className={`${styles.block} ${outcome === "ERROR" ? styles.blockDanger : ""}`}
        role="status"
        data-testid={`${testId}-${outcome === "NOT_ALLOWED" ? "not-allowed" : outcome === "NOT_FOUND" ? "not-found" : "error"}`}
      >
        <h1 className={styles.blockTitle}>
          {t(
            outcome === "NOT_ALLOWED"
              ? "deals.page.notAllowedTitle"
              : outcome === "NOT_FOUND"
                ? "deals.page.notFoundTitle"
                : "deals.page.failedTitle",
          )}
        </h1>
        <p className={styles.blockBody}>
          {t(
            outcome === "NOT_ALLOWED"
              ? "deals.page.notAllowedBody"
              : outcome === "NOT_FOUND"
                ? "deals.page.notFoundBody"
                : "deals.page.failedBody",
          )}
        </p>
        {outcome === "ERROR" ? (
          <div>
            <Button
              variant="secondary"
              size="$3"
              onPress={() => void read.refetch()}
              disabled={read.isFetching}
              testID={`${testId}-retry`}
            >
              {t("deals.retry")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const { event } = read.data;
  const timeZone = event.timezone ?? "UTC";
  const frozenDate = event.dealFrozenAt
    ? DateTime.format(event.dealFrozenAt, "date", { timeZone, locale })
    : null;

  return (
    <div className={styles.root} data-testid={testId}>
      <div className={styles.presets}>
        <span className={styles.kicker}>{t("deals.page.kicker")}</span>
        <h1 className={styles.title}>{event.title}</h1>
        {event.startsAt ? (
          <p className={styles.lede}>
            {DateTime.format(event.startsAt, "dateLong", {
              timeZone,
              locale,
            })}
          </p>
        ) : null}
      </div>

      {frozenDate && event.dealFrozenAt ? (
        <div
          className={styles.frozenBand}
          data-testid={`${testId}-frozen`}
        >
          <div className={styles.frozenBandText}>
            <Lock size={20} strokeWidth={2} aria-hidden />
            <div className={styles.frozenBandWords}>
              <span className={styles.overline}>
                {event.frozenBy
                  ? event.frozenBy.name
                    ? t("deals.freeze.frozenSinceBy", {
                        date: frozenDate,
                        name: event.frozenBy.name,
                      })
                    : t("deals.freeze.frozenSince", { date: frozenDate })
                  : t("deals.freeze.frozenSinceAuto", { date: frozenDate })}
              </span>
              <span className={styles.frozenBandBody}>
                {t("deals.page.frozenBody")}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <p className={styles.notice} data-testid={`${testId}-not-frozen`}>
          <Info size={16} strokeWidth={2} aria-hidden />
          <span>{t("deals.page.notFrozen")}</span>
        </p>
      )}

      {/* Drawn only when the summary has something to show (DealSummary
          draws its label then): a payee a change took off sees no deal. */}
      <div className={styles.presets}>
        <DealSummary
          target={target}
          testIdBase={testId}
          label={
            <>
              <h2 id={`${testId}-now`} className={styles.pageSectionTitle}>
                {t("deals.page.nowTitle")}
              </h2>
              {terms.data && terms.data.visibility !== "FULL" ? (
                <p className={styles.hint} data-testid={`${testId}-now-hint`}>
                  {t("deals.page.nowHint")}
                </p>
              ) : null}
            </>
          }
        />
      </div>

      {read.data.items.length > 0 ? (
        <DealChanges first={read.data} testIdBase={testId} headingLevel={2} />
      ) : event.dealFrozenAt ? (
        <p className={styles.hint} data-testid={`${testId}-no-changes`}>
          {t("deals.page.noChanges")}
        </p>
      ) : null}
    </div>
  );
}
