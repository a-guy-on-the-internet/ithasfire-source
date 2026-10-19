"use client";

import { useMemo } from "react";
import { Spinner, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { BlockEmpty } from "./blocks/block-primitives";
import blockStyles from "./blocks/block-primitives.module.css";
import styles from "./place-entity.module.css";

type EventSummary = {
  eventId: string;
  slug: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  status: string;
  timezone: string | null;
  primaryImageUrl: string | null;
  priceLabel: string | null;
  city: string | null;
  region: string | null;
};

type Props = {
  placeId: string;
};

// Five years is well beyond any real listing horizon; wide enough that the
// window never excludes a genuine upcoming/past show.
const FIVE_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 5;

function formatDate(d: Date, tz: string | null): string {
  try {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: tz ?? undefined,
    });
  } catch {
    return d.toLocaleDateString();
  }
}

function formatTime(d: Date, tz: string | null): string {
  try {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz ?? undefined,
    });
  } catch {
    return "";
  }
}

function eventHref(ev: EventSummary): string {
  return ev.slug ? `/events/${ev.slug}` : `/events/${ev.eventId}`;
}

function EventRow({ ev }: { ev: EventSummary }) {
  // Editorial listing: a mono date/time rail on the left, the title (Montserrat)
  // and an optional mono price on the right.
  const day = formatDate(ev.startsAt, ev.timezone);
  const time = formatTime(ev.startsAt, ev.timezone);

  return (
    <li>
      <a href={eventHref(ev)} className={styles.eventRowLink}>
        <span className={styles.eventDate}>
          <span className={styles.eventDateDay}>{day}</span>
          {time && <span className={styles.eventDateTime}>{time}</span>}
        </span>
        <span className={styles.eventBody}>
          <span className={styles.eventTitle}>{ev.title}</span>
          {ev.priceLabel && (
            <span className={styles.eventPrice}>{ev.priceLabel}</span>
          )}
        </span>
      </a>
    </li>
  );
}

/**
 * Events-first section for the venue template's main column.
 *
 * Fetches upcoming shows for this venue. When there are none, it falls back to
 * the venue's past shows plus a browse-all link, so the section is never a dead
 * end. Owns the events surface for the template, which is why PlaceEntityLayout
 * suppresses any `upcoming_events` block. (The primary Follow CTA lives in the
 * page hero, so this section deliberately does not repeat it.)
 */
export function PlaceEventsSection({ placeId }: Props) {
  const t = useTranslations();

  // Freeze the query window once per venue so the React Query cache key is
  // stable — a fresh `new Date()` every render would thrash the cache.
  const win = useMemo(() => {
    const now = new Date();
    return {
      now,
      future: new Date(now.getTime() + FIVE_YEARS_MS),
      past: new Date(now.getTime() - FIVE_YEARS_MS),
    };
  }, []);

  const upcoming = trpc.places.listPlaceEvents.useQuery({
    placeId,
    timeWindow: { from: win.now, to: win.future },
    status: "upcoming",
    limit: 8,
  });

  const upcomingEvents = (upcoming.data?.events ?? []) as EventSummary[];
  const hasUpcoming = upcomingEvents.length > 0;
  const showPast = upcoming.isSuccess && !hasUpcoming;

  const past = trpc.places.listPlaceEvents.useQuery(
    {
      placeId,
      timeWindow: { from: win.past, to: win.now },
      status: "past",
      limit: 5,
    },
    { enabled: showPast },
  );
  const pastEvents = (past.data?.events ?? []) as EventSummary[];

  return (
    <section className={styles.eventsSection}>
      <h2 className={styles.sectionHeading}>{t("places.upcomingEvents")}</h2>

      {upcoming.isLoading ? (
        <div className={styles.eventsLoading} aria-busy="true">
          <Spinner size="sm" />
          <span className={`${blockStyles.bodySmall} ${blockStyles.muted}`}>
            {t("places.eventsLoading")}
          </span>
        </div>
      ) : upcoming.isError ? (
        <div className={styles.eventsError} role="alert">
          <p className={styles.eventsErrorText}>{t("places.eventsError")}</p>
          <button
            type="button"
            className={styles.eventsRetry}
            onClick={() => void upcoming.refetch()}
          >
            {t("places.retry")}
          </button>
        </div>
      ) : hasUpcoming ? (
        <ul className={styles.eventList}>
          {upcomingEvents.map((ev) => (
            <EventRow key={ev.eventId} ev={ev} />
          ))}
        </ul>
      ) : (
        <div className={styles.eventsEmpty}>
          <BlockEmpty>{t("places.noUpcomingEvents")}</BlockEmpty>

          <div className={styles.eventsActions}>
            <a href="/events" className={styles.browseLink}>
              {t("places.browseEvents")}
              <span aria-hidden>&#8599;</span>
            </a>
          </div>

          {past.isLoading ? (
            <div className={styles.eventsLoading} aria-busy="true">
              <Spinner size="sm" />
            </div>
          ) : pastEvents.length > 0 ? (
            <div className={styles.eventsPastGroup}>
              <h3 className={styles.eventsPastHeading}>
                {t("places.pastShows")}
              </h3>
              <ul className={styles.eventList}>
                {pastEvents.map((ev) => (
                  <EventRow key={ev.eventId} ev={ev} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
