import { render as renderEmail } from "@react-email/render";
import { htmlToText } from "html-to-text";
import { Eta } from "eta";

import {
  runWithFooterDefaults,
  type EmailFooterDefaults,
} from "./footer-context";
import {
  DEFAULT_LOCALE,
  createTranslator,
  loadMessages,
  type Translator,
} from "@th/locale";

import {
  TEMPLATE_IDS,
  getDefinition,
  sampleInputs,
  schemaFor,
  templateDefinitions,
  type TemplateComponentContext,
  type TemplateDefinition,
  type TemplateId,
  type TemplatePropsMap,
} from "./templates/registry";
import { expandMsoMarkers } from "./templates/components/mso";
import {
  COLON_LINK_FORMAT,
  COLON_LINK_SELECTOR,
  formatColonLink,
} from "./lib/text-link";

export type { TemplateId };
export type TemplateProps<T extends TemplateId> = TemplatePropsMap[T];

export type RenderInput<T extends TemplateId = TemplateId> = {
  templateId: T;
  props: TemplateProps<T>;
  locale?: string;
  /** Platform-level footer defaults (mailing address, contact, brand). */
  footer?: EmailFooterDefaults;
};

export type { EmailFooterDefaults };

export type RenderOutput = {
  subject: string;
  html: string;
  text: string;
};

export type TemplateSummary = {
  id: TemplateId;
  subjectExample: string;
  requiredProps: string[];
  hasTextTemplate: boolean;
};

export type TemplateErrorCode = "template_not_found" | "render_failed";

export class TemplateRenderError extends Error {
  readonly code: TemplateErrorCode;
  readonly details?: unknown;

  constructor(code: TemplateErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "TemplateRenderError";
  }
}

// The text templates in ../text-templates use `{{= it.x }}`, not Eta's
// default `<%= %>`. Without these tags the text part ships the raw template.
const eta = new Eta({
  autoTrim: "slurp",
  useWith: true,
  tags: ["{{", "}}"],
});

const translatorCache = new Map<string, Translator>();

const getTranslator = async (localeInput?: string): Promise<Translator> => {
  const requestedLocale = localeInput ?? DEFAULT_LOCALE;
  const cached = translatorCache.get(requestedLocale);
  if (cached) {
    return cached;
  }

  const messages = await loadMessages(requestedLocale);
  const translator = createTranslator(requestedLocale, messages);

  translatorCache.set(translator.locale, translator);
  if (translator.locale !== requestedLocale) {
    translatorCache.set(requestedLocale, translator);
  }

  return translator;
};

type TemplateHelpers = {
  formatCurrency: (
    cents: number,
    currency?: string,
    options?: Intl.NumberFormatOptions,
  ) => string;
  formatDateISO: (
    iso: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
};

const createHelpers = (translator: Translator): TemplateHelpers => ({
  formatCurrency: (cents: number, currency = "USD", options) =>
    translator.formatCurrency(cents, currency, options),
  formatDateISO: (iso: string | number | Date, options) =>
    translator.formatDate(
      iso,
      options ?? { dateStyle: "long", timeStyle: "short" },
    ),
});

export async function render<T extends TemplateId>(
  input: RenderInput<T>,
): Promise<RenderOutput> {
  const definition = getDefinition(input.templateId);
  if (!definition) {
    throw new TemplateRenderError(
      "template_not_found",
      `Email template '${input.templateId}' is not registered`,
    );
  }

  const schema = schemaFor(input.templateId);
  let validatedProps: TemplateProps<T>;
  try {
    validatedProps = schema.parse(input.props);
  } catch (error) {
    throw new TemplateRenderError(
      "render_failed",
      `Template '${input.templateId}' props failed validation`,
      error,
    );
  }

  const translator = await getTranslator(input.locale);
  const context: TemplateComponentContext = {
    translator,
    locale: translator.locale,
  };
  const helpers = createHelpers(translator);

  try {
    const subject = resolveSubject(definition, validatedProps, context);
    const html = await renderHtml(
      definition,
      validatedProps,
      context,
      input.footer,
    );
    const text = await renderText(
      definition,
      validatedProps,
      html,
      context,
      helpers,
    );
    return { subject, html, text };
  } catch (error) {
    throw new TemplateRenderError(
      "render_failed",
      `Failed to render template '${input.templateId}'`,
      error,
    );
  }
}

const renderHtml = async <T extends TemplateId>(
  definition: TemplateDefinition<T>,
  props: TemplateProps<T>,
  context: TemplateComponentContext,
  footer?: EmailFooterDefaults,
) => {
  if (definition.component) {
    const element = definition.component(props, context);
    const html = await (footer
      ? runWithFooterDefaults(footer, () => renderEmail(element))
      : renderEmail(element));
    return expandMsoMarkers(html);
  }
  if (definition.htmlFallback) {
    return definition.htmlFallback(props);
  }
  return "";
};

const renderText = async <T extends TemplateId>(
  definition: TemplateDefinition<T>,
  props: TemplateProps<T>,
  derivedHtml: string,
  context: TemplateComponentContext,
  helpers: TemplateHelpers,
) => {
  if (definition.textTemplate) {
    const result = eta.renderString(definition.textTemplate, {
      ...props,
      ...helpers,
      locale: context.locale,
      t: context.translator.t,
      translator: context.translator,
    });
    if (typeof result === "string") {
      return result.trim();
    }
    return "";
  }
  return htmlToText(derivedHtml, {
    selectors: [
      { selector: "a", options: { ignoreHref: false } },
      // More specific than `a`, so it wins for links that opt in.
      { selector: COLON_LINK_SELECTOR, format: COLON_LINK_FORMAT },
    ],
    formatters: { [COLON_LINK_FORMAT]: formatColonLink },
    wordwrap: false,
  });
};

export function listTemplates(): TemplateSummary[] {
  return TEMPLATE_IDS.map((id) => {
    const definition = templateDefinitions[id];
    const sample = sampleInputs[id];
    return {
      id,
      subjectExample: definition.subjectTemplate
        ? interpolate(definition.subjectTemplate, sample)
        : "",
      requiredProps: [...definition.requiredProps],
      hasTextTemplate: Boolean(definition.textTemplate),
    };
  });
}

export function sampleInputFor<T extends TemplateId>(
  templateId: T,
): TemplateProps<T> {
  const sample = sampleInputs[templateId];
  if (!sample) {
    throw new TemplateRenderError(
      "template_not_found",
      `Template '${templateId}' is not registered`,
    );
  }
  return structuredClone(sample);
}

const interpolate = (template: string, data: Record<string, unknown>) => {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, path: string) => {
    const value = path.split(".").reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined) {
        return undefined;
      }
      if (typeof acc === "object" && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, data);
    if (value === undefined || value === null) {
      return "";
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(value);
  });
};

const resolveSubject = <T extends TemplateId>(
  definition: TemplateDefinition<T>,
  props: TemplateProps<T>,
  context: TemplateComponentContext,
) => {
  if (definition.getSubject) {
    return definition.getSubject(props, context);
  }
  if (definition.subjectTemplate) {
    return interpolate(definition.subjectTemplate, props);
  }
  throw new TemplateRenderError(
    "render_failed",
    `Template '${definition.id}' is missing subject definition`,
  );
};
