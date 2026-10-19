import type { LayoutColumnRatio, LayoutSectionStyle } from "@th/schema";

export type RenderedEventPageBlock =
  | {
      type: "richText";
      id: string;
      html: string;
    }
  | {
      type: "image";
      // Block instance id (stable within the editor).
      blockId: string;
      // References `EventImage.id`.
      id: string;
      alt?: string;
    }
  | {
      type: "spacer";
      id: string;
      size: "sm" | "md" | "lg";
    }
  | {
      type: "cta";
      id: string;
      label: string;
      href: string;
      variant: "primary" | "secondary";
    }
  | {
      type: "unknown";
      // Preserve the original discriminator so clients can show a debug chip.
      originalType: string;
      // Best-effort id.
      id: string;
      raw: unknown;
    };

export type RenderedEventPageColumn = {
  blocks: RenderedEventPageBlock[];
};

export type RenderedEventPageSection = {
  id: string;
  kind: "section";
  style: LayoutSectionStyle;
  layout:
    | {
        type: "singleColumn";
        columns: [RenderedEventPageColumn];
      }
    | {
        type: "twoColumn";
        ratio: LayoutColumnRatio;
        columns: [RenderedEventPageColumn, RenderedEventPageColumn];
      };
};

export type RenderedEventPage = {
  version: 1;
  sections: RenderedEventPageSection[];
};
