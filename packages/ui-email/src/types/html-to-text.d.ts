declare module "html-to-text" {
  type AnchorOptions = {
    ignoreHref?: boolean;
    noAnchorUrl?: boolean;
  };

  type SelectorConfig = {
    selector: string;
    /** Name of a built-in or `formatters` entry. */
    format?: string;
    opts?: AnchorOptions;
    options?: AnchorOptions;
  };

  /** The parsed element a formatter receives (the subset used here). */
  export type DomNode = {
    attribs?: Record<string, string | undefined>;
    children?: DomNode[];
  };

  export type RecursiveCallback = (
    nodes: DomNode[] | undefined,
    builder: BlockTextBuilder,
  ) => void;

  /** The text builder a formatter writes to (the subset used here). */
  export type BlockTextBuilder = {
    addInline: (str: string, options?: { noWordTransform?: boolean }) => void;
    pushWordTransform: (transform: (str: string) => string) => void;
    popWordTransform: () => void;
  };

  export type FormatCallback = (
    elem: DomNode,
    walk: RecursiveCallback,
    builder: BlockTextBuilder,
    formatOptions: Record<string, unknown>,
  ) => void;

  export type HtmlToTextOptions = {
    selectors?: SelectorConfig[];
    formatters?: Record<string, FormatCallback>;
    wordwrap?: number | false;
  };

  export function htmlToText(html: string, options?: HtmlToTextOptions): string;
}
