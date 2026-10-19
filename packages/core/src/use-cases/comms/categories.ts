import { z } from "zod";

import type { NotificationPreferenceCategory } from "@th/ports/repos/notification-preferences";
import { fail } from "@th/errors";

export const notificationCategoryKeys = [
  "transactional",
  "announcements",
  "reminders",
  "marketing",
  "organizerMessages",
  "billsYoureOn",
] as const satisfies ReadonlyArray<NotificationPreferenceCategory>;

export const notificationCategorySchema = z.enum(notificationCategoryKeys);

export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export type NotificationCategoryConfig = {
  metricsTag: string;
  description: string;
  inAppDefaultEnabled: boolean;
  pushDefaultEnabled: boolean;
  emailDefaultEnabled: boolean;
  smsDefaultEnabled: boolean;
  /**
   * Whether this category may ever go out by SMS. Our sending number is a
   * registered US number (10DLC or toll-free; one number in both variables
   * is the expected setup), registered for passcodes and for notifications
   * about things the person signed up for, so only `transactional` texts.
   * `reminders` is excluded because no reminder notification builds an SMS
   * body (the RSVP reminder is in-app/push/email only), so an SMS switch
   * would promise a text that never comes. Add it back together with a
   * reminder that builds an SMS body. Volunteer shift reminder texts do not
   * depend on this: they go through send-volunteer-shift-reminders.ts under
   * the signup's own consent.
   * Every other category is never texted, whatever the stored preference or
   * a caller's channel override says.
   */
  smsAllowed: boolean;
};

const notificationCategoryConfigMap: Record<
  NotificationCategory,
  NotificationCategoryConfig
> = {
  transactional: {
    metricsTag: "transactional",
    description:
      "Critical updates tied to purchases, tickets, or account security.",
    inAppDefaultEnabled: true,
    pushDefaultEnabled: true,
    emailDefaultEnabled: true,
    smsDefaultEnabled: false,
    smsAllowed: true,
  },
  announcements: {
    metricsTag: "announcements",
    description: "Product and platform announcements from Ithas Fire.",
    inAppDefaultEnabled: true,
    pushDefaultEnabled: true,
    emailDefaultEnabled: true,
    smsDefaultEnabled: false,
    smsAllowed: false,
  },
  /**
   * Ahead-of-time nudges about something the human already said yes to — the
   * 24h-before community RSVP reminder today. Deliberately NOT folded into
   * `transactional`: a person who wants their RSVP confirmation but not a
   * day-before nudge has to be able to say so, and the settings UI renders one
   * row per category. Defaults match the house pattern (in-app/push/email ON,
   * SMS strictly opt-in) — a reminder is wanted by default; that is why the
   * feature exists.
   */
  reminders: {
    metricsTag: "reminders",
    description:
      "Day-before reminders for events you RSVP'd to.",
    inAppDefaultEnabled: true,
    pushDefaultEnabled: true,
    emailDefaultEnabled: true,
    smsDefaultEnabled: false,
    smsAllowed: false,
  },
  marketing: {
    metricsTag: "marketing",
    description:
      "Promotional content like offers, featured events, or campaigns.",
    inAppDefaultEnabled: true,
    pushDefaultEnabled: false,
    emailDefaultEnabled: true,
    smsDefaultEnabled: false,
    smsAllowed: false,
  },
  organizerMessages: {
    metricsTag: "organizer_messages",
    description:
      "Messages from event hosts and organizers to attendees or followers.",
    inAppDefaultEnabled: true,
    pushDefaultEnabled: true,
    emailDefaultEnabled: true,
    smsDefaultEnabled: false,
    smsAllowed: false,
  },
  /**
   * "Bills you're on" (lineup-booking-requests v3, L8 / FR-012). What an act
   * hears about a booking request's bill AFTER it was invited: taken off the
   * bill, the request isn't going ahead. NOT transactional — an act can mute
   * it per channel. The invite (the consent ask) and the lineup consent
   * notice stay transactional and are never routed here. House defaults:
   * in-app/push/email ON, SMS strictly opt-in.
   */
  billsYoureOn: {
    metricsTag: "bills_youre_on",
    description:
      "Updates about booking requests you're on the bill for, after you've been invited.",
    inAppDefaultEnabled: true,
    pushDefaultEnabled: true,
    emailDefaultEnabled: true,
    smsDefaultEnabled: false,
    smsAllowed: false,
  },
};

export function getNotificationCategoryConfig(
  category: NotificationCategory,
): NotificationCategoryConfig {
  return notificationCategoryConfigMap[category];
}

/** True only for the categories that may ever be sent by SMS. */
export function isSmsAllowedForCategory(
  category: NotificationCategory,
): boolean {
  return notificationCategoryConfigMap[category].smsAllowed;
}

/** The categories that may be sent by SMS, in `notificationCategoryKeys` order. */
export const smsEligibleCategories: ReadonlyArray<NotificationCategory> =
  notificationCategoryKeys.filter((key) => isSmsAllowedForCategory(key));

/**
 * The categories an SMS preference delta tries to turn ON that may never be
 * texted. Turning one OFF is always accepted (it changes nothing that sends).
 */
export function smsIneligibleEnables(
  smsDelta: Partial<Record<NotificationCategory, boolean>> | undefined,
): NotificationCategory[] {
  if (!smsDelta) return [];
  return notificationCategoryKeys.filter(
    (key) => smsDelta[key] === true && !isSmsAllowedForCategory(key),
  );
}

/**
 * The SMS channel snapshot with every never-texted category forced to
 * `false`. A stored `true` for one of them (an opt-in from before
 * `smsAllowed`) must not read as consent: shown as on it would invite the
 * person to believe they get those texts, and if the category ever became
 * eligible it would revive without fresh consent. Applied wherever SMS
 * preferences are read for display or returned.
 */
export function maskSmsIneligible<
  T extends Record<NotificationCategory, boolean>,
>(sms: T): T {
  const masked = { ...sms };
  for (const key of notificationCategoryKeys) {
    if (!isSmsAllowedForCategory(key)) {
      (masked as Record<NotificationCategory, boolean>)[key] = false;
    }
  }
  return masked;
}

/** {@link maskSmsIneligible} over a whole preference snapshot (sms only). */
export function maskSmsIneligibleSnapshot<
  S extends { sms?: Record<NotificationCategory, boolean> },
>(snapshot: S): S {
  if (!snapshot.sms) return snapshot;
  return { ...snapshot, sms: maskSmsIneligible(snapshot.sms) };
}

/**
 * An SMS preference delta with every never-texted category set to `false`,
 * so any SMS write also clears a stale stored opt-in: stored, shown and sent
 * then agree. Turning one ON is refused before this (see
 * {@link smsIneligibleEnables}).
 */
export function withSmsIneligibleCleared(
  smsDelta: Partial<Record<NotificationCategory, boolean>>,
): Partial<Record<NotificationCategory, boolean>> {
  const cleared = { ...smsDelta };
  for (const key of notificationCategoryKeys) {
    if (!isSmsAllowedForCategory(key)) cleared[key] = false;
  }
  return cleared;
}

export function isNotificationCategory(
  value: unknown,
): value is NotificationPreferenceCategory {
  return (
    typeof value === "string" &&
    (notificationCategoryKeys as readonly string[]).includes(value)
  );
}

export function ensureNotificationCategory(
  value: unknown,
): NotificationPreferenceCategory {
  if (isNotificationCategory(value)) {
    return value;
  }

  throw fail("UNKNOWN_NOTIFICATION_CATEGORY");
}

export function categoryMetricsTag(category: NotificationCategory): string {
  return notificationCategoryConfigMap[category].metricsTag;
}
