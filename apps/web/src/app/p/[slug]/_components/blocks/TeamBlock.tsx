"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { Avatar } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import { getSafeExternalHref } from "./safe-block-url";
import styles from "./block-primitives.module.css";

type TeamMember = {
  name: string;
  role?: string;
  avatarUrl?: string;
};

type TeamData = {
  heading?: string;
  members?: TeamMember[];
};

type Props = {
  block: PageBlockRecord;
};

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0))
    .join("")
    .toUpperCase();
}

/**
 * Renders public team members for an organization.
 * Uses `@th/ui` Avatar for member photos / initials fallback.
 */
export function TeamBlock({ block }: Props) {
  const data = block.data as TeamData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Team";
  const members = data?.members;

  if (!members || members.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.gridAutoFillSm}>
        {members.map((member, i) => {
          const avatarUrl = getSafeExternalHref(member.avatarUrl);

          return (
            <div key={i} className={styles.teamMember}>
              <Avatar
                size="md"
                src={avatarUrl}
                alt={member.name}
                initials={getInitials(member.name)}
                style={{ margin: "0 auto 0.5rem" }}
              />
              <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>
                {member.name}
              </div>
              {member.role && (
                <div className={`${styles.bodySmall} ${styles.muted}`}>
                  {member.role}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </BlockSection>
  );
}
