/**
 * `<input type="datetime-local">` readings resolved in a STATED zone, for
 * forms outside the event builder (volunteer asks).
 *
 * The two conversions are the event builder's own (DST-exact, pinned in
 * `event-builder-helpers.dst.test.ts`); they are re-exported here so shared
 * components do not import from a route folder.
 */
export {
  isKnownTimeZone,
  toDateTimeLocalValue,
  toIsoInTimeZone,
} from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";

/** The browser's zone, or UTC when the runtime cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The runtime's canonical spelling of `zone`, or null when it is not a zone
 * the runtime knows. ICU builds disagree on aliases ("Asia/Calcutta" vs
 * "Asia/Kolkata"), so two zone names are compared only after both pass
 * through this.
 */
export function canonicalTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/**
 * The zone list for a zone `<select>`, with `selected` guaranteed to be one of
 * its values. When the runtime lists `selected` under another alias, the
 * listed alias is returned as `value` so the select shows it as chosen.
 */
export function timeZoneOptions(selected: string): {
  options: string[];
  value: string;
} {
  let listed: string[] = [];
  try {
    listed = Intl.supportedValuesOf("timeZone");
  } catch {
    listed = [];
  }
  if (listed.includes(selected)) return { options: listed, value: selected };
  const target = canonicalTimeZone(selected);
  const alias = target
    ? listed.find((zone) => canonicalTimeZone(zone) === target)
    : undefined;
  if (alias) return { options: listed, value: alias };
  return { options: [selected, ...listed], value: selected };
}
