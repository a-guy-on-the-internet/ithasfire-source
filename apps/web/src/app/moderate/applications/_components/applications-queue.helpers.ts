/** The applicant fields the queue row needs (from moderatorApplications.list). */
export interface ApplicantRef {
  applicantHumanId: string;
  applicantName: string | null;
}

/**
 * Where the applicant's name links: the platform humans list filtered by
 * name, the same target the payouts, dispute and invite-pause desks use
 * (humans have no staff detail page). No name → no link.
 */
export function applicantHumansHref(applicant: ApplicantRef): string | null {
  const name = applicant.applicantName?.trim();
  return name ? `/platform/humans?q=${encodeURIComponent(name)}` : null;
}

/**
 * The row label. A deleted applicant reads as `deletedLabel`; an applicant
 * with no name set falls back to the short id so the row still has a handle.
 */
export function applicantLabel(
  applicant: ApplicantRef,
  isDangling: boolean,
  deletedLabel: string,
): string {
  if (isDangling) return deletedLabel;
  return (
    applicant.applicantName?.trim() || applicant.applicantHumanId.slice(0, 8)
  );
}
