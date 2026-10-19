import Fastify from "fastify";
import { renderToStaticMarkup } from "react-dom/server";

import {
  listTemplates,
  render,
  sampleInputFor,
  type TemplateId,
  type TemplateProps,
} from "../index";
import { PreviewPage, type PreviewPageProps } from "./pages/index";

const app = Fastify({ logger: true });

app.get("/", async (request, reply) => {
  const templates = listTemplates();
  type TemplateEntry = (typeof templates)[number];
  const query = request.query as { templateId?: string; props?: string };
  const requestedId = query.templateId;
  const knownTemplate = requestedId
    ? templates.find((template: TemplateEntry) => template.id === requestedId)
    : templates[0];
  const templateId = knownTemplate?.id;

  if (!templateId) {
    return reply
      .type("text/html")
      .send(renderPage({ templates, propsJson: "{}" }));
  }

  let propsJson = query.props;
  let parsedProps:
    | TemplateProps<TemplateId>
    | Record<string, unknown>
    | undefined;

  if (propsJson) {
    try {
      parsedProps = JSON.parse(propsJson) as typeof parsedProps;
    } catch (err) {
      let fallbackProps = "{}";
      app.log.warn({ err }, "Invalid props payload provided to preview server");
      try {
        fallbackProps = JSON.stringify(sampleInputFor(templateId), null, 2);
      } catch (templateErr) {
        app.log.error({ templateErr }, "Invalid template supplied to preview");
        return reply.type("text/html").send(
          renderPage({
            templates,
            error: `Unknown template: ${templateId}`,
            propsJson: "{}",
          }),
        );
      }
      return reply.type("text/html").send(
        renderPage({
          templates,
          selectedTemplate: templateId,
          htmlPreview: "",
          textPreview: "",
          propsJson: fallbackProps,
          error: "Props must be valid JSON.",
        }),
      );
    }
  }

  if (!parsedProps) {
    try {
      parsedProps = sampleInputFor(templateId);
      propsJson = JSON.stringify(parsedProps, null, 2);
    } catch (err) {
      app.log.error({ err }, "Unknown template supplied to preview");
      return reply.type("text/html").send(
        renderPage({
          templates,
          error: `Unknown template: ${templateId}`,
          propsJson: "{}",
        }),
      );
    }
  }

  let htmlPreview = "";
  let textPreview = "";
  let error: string | undefined;

  try {
    const typedProps = parsedProps as TemplateProps<typeof templateId>;
    const result = await render({ templateId, props: typedProps });
    htmlPreview = result.html;
    textPreview = result.text;
  } catch (err) {
    app.log.error({ err }, "Failed to render template");
    error = err instanceof Error ? err.message : "Failed to render template.";
  }

  return reply.type("text/html").send(
    renderPage({
      templates,
      selectedTemplate: templateId,
      htmlPreview,
      textPreview,
      propsJson,
      error,
    }),
  );
});

const port = Number(process.env.UI_EMAIL_PREVIEW_PORT ?? 3004);

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`Preview server ready on http://localhost:${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

const renderPage = (props: PreviewPageProps) => {
  return `<!doctype html>${renderToStaticMarkup(<PreviewPage {...props} />)}`;
};
