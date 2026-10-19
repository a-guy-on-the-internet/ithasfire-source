"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import {
  BlockSection,
  BlockHeading,
  BlockBodyText,
  BlockPillLink,
} from "./block-primitives";
import { getSafeExternalHref } from "./safe-block-url";
import styles from "./block-primitives.module.css";

type RiderData = {
  heading?: string;
  content?: string;
  requirements?: string[];
  downloadUrl?: string;
};

type Props = {
  block: PageBlockRecord;
};

/**
 * Renders a technical rider for an artist's EPK.
 */
export function RiderBlock({ block }: Props) {
  const data = block.data as RiderData | undefined;
  if (!data) return null;
  const heading = data?.heading ?? "Technical Rider";
  const downloadHref = getSafeExternalHref(data?.downloadUrl);

  if (
    !data?.content &&
    (!data?.requirements || data.requirements.length === 0) &&
    !downloadHref
  ) {
    return null;
  }

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      {data.content && (
        <div style={{ marginBottom: "0.75rem" }}>
          <BlockBodyText className={styles.bodyDefault}>
            {data.content}
          </BlockBodyText>
        </div>
      )}
      {data.requirements && data.requirements.length > 0 && (
        <ul
          style={{
            listStyle: "disc",
            paddingLeft: "1.25rem",
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {data.requirements.map((req, i) => (
            <li
              key={i}
              className={styles.bodyDefault}
              style={{ lineHeight: 1.5, opacity: 0.85 }}
            >
              {req}
            </li>
          ))}
        </ul>
      )}
      {downloadHref && (
        <div style={{ marginTop: "0.75rem" }}>
          <BlockPillLink href={downloadHref} external>
            Download full rider &#8595;
          </BlockPillLink>
        </div>
      )}
    </BlockSection>
  );
}
