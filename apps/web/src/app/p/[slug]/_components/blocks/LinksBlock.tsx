"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import { getSafeExternalHref } from "./safe-block-url";
import styles from "./block-primitives.module.css";

type LinkItem = {
  label: string;
  url: string;
  icon?: string;
};

type LinksData = {
  links?: LinkItem[];
  heading?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders a list of external links (social, website, etc.).
 * `block.data` should contain `{ links: [{ label, url, icon? }], heading? }`.
 */
export function LinksBlock({ block }: Props) {
  const data = block.data as LinksData | undefined;
  if (!data) return null;
  const links = data?.links
    ?.map((link) => ({ ...link, url: getSafeExternalHref(link.url) }))
    .filter((link): link is LinkItem => Boolean(link.url));
  const heading = data?.heading ?? "Links";

  if (!links || links.length === 0) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <ul className={styles.linkList}>
        {links.map((link, i) => (
          <li key={`${link.url}-${i}`}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.linkRow}
            >
              {link.icon && (
                <span style={{ fontSize: "1.125rem", lineHeight: 1 }}>
                  {link.icon}
                </span>
              )}
              <span style={{ flex: 1 }}>{link.label}</span>
              <span className={`${styles.muted} ${styles.bodySmall}`}>
                &#8599;
              </span>
            </a>
          </li>
        ))}
      </ul>
    </BlockSection>
  );
}
