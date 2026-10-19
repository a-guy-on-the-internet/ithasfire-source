/**
 * Payee names for the freeze copy ("Saving tells A, B and C"). Pure, so
 * callers outside the deals barrel can import it without the components.
 */

/** Locale-correct "a, b and c"; falls back to commas if Intl throws. */
export function joinNames(names: readonly string[], locale: string): string {
  if (names.length <= 1) return names[0] ?? "";
  try {
    return new Intl.ListFormat(locale || "en", {
      style: "long",
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** Unique, non-empty, in first-seen order. */
export function uniqueNames(names: readonly (string | null | undefined)[]) {
  const out: string[] = [];
  for (const n of names) {
    const name = n?.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Someone a frozen change's notice could reach, as the page knows them. */
export type TellCandidate = {
  kind: "org" | "human" | null;
  /** The org's or human's id; absent when only the name is known. */
  id?: string | null;
  name: string | null | undefined;
};

/** Whoever is making the change, as far as the page knows them. */
export type TellActor = { humanId: string | null; name: string | null } | null;

/**
 * Who a frozen change tells, by name (FR-006): everyone on the deal before
 * or after it (payees, cost creditors, resale-share recipients), less the
 * person making it, whom the server skips. A group stays: its other members
 * are told. Without an id (a resale recipient) the actor is matched by name.
 */
export function namesToTell(
  candidates: readonly TellCandidate[],
  actor: TellActor,
): string[] {
  const isActor = (c: TellCandidate) => {
    if (!actor || c.kind !== "human") return false;
    if (c.id) return !!actor.humanId && c.id === actor.humanId;
    return !!actor.name && c.name?.trim() === actor.name.trim();
  };
  return uniqueNames(candidates.filter((c) => !isActor(c)).map((c) => c.name));
}
