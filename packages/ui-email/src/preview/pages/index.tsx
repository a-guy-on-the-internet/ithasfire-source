import { type ReactElement } from "react";

export type TemplateDescriptor = {
  id: string;
  subjectExample: string;
};

export type PreviewPageProps = {
  templates: TemplateDescriptor[];
  selectedTemplate?: string;
  htmlPreview?: string;
  textPreview?: string;
  propsJson?: string;
  error?: string;
};

export const PreviewPage = ({
  templates,
  selectedTemplate,
  htmlPreview,
  textPreview,
  propsJson,
  error,
}: PreviewPageProps): ReactElement => {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Email preview</title>
        <style>{pageStyles}</style>
      </head>
      <body>
        <main>
          <aside>
            <h1>Templates</h1>
            <ul>
              {templates.map((template) => (
                <li
                  key={template.id}
                  data-active={template.id === selectedTemplate}
                >
                  <a href={`/?templateId=${encodeURIComponent(template.id)}`}>
                    {template.id}
                  </a>
                  <p>{template.subjectExample}</p>
                </li>
              ))}
            </ul>
          </aside>
          <section className="content">
            <form method="get" className="props-form">
              <input
                type="hidden"
                name="templateId"
                value={selectedTemplate ?? ""}
              />
              <label htmlFor="props">Props (JSON)</label>
              <textarea
                name="props"
                id="props"
                rows={12}
                defaultValue={propsJson ?? ""}
              />
              <button type="submit">Render</button>
            </form>
            {error ? <p className="error">{error}</p> : null}
            <div className="preview-grid">
              <div>
                <h2>HTML</h2>
                <iframe title="HTML preview" srcDoc={htmlPreview ?? ""} />
              </div>
              <div>
                <h2>Plain text</h2>
                <pre>{textPreview ?? ""}</pre>
              </div>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
};

const pageStyles = `
body {
	margin: 0;
	font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
	background: #f8fafc;
	color: #0b0b0b;
}
main {
	display: grid;
	grid-template-columns: 280px 1fr;
	height: 100vh;
}
aside {
	background: #111111;
	color: white;
	padding: 24px;
	overflow-y: auto;
}
aside h1 {
	font-size: 18px;
	margin-top: 0;
}
aside ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 16px;
}
aside li {
	padding: 12px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.08);
}
aside li[data-active="true"] {
	outline: 2px solid #0EA5E9;
}
aside a {
	color: #fff;
	text-decoration: none;
	font-weight: 600;
}
aside p {
	margin: 8px 0 0;
	font-size: 13px;
	opacity: 0.85;
}
.content {
	padding: 24px;
	overflow: auto;
}
.props-form {
	display: grid;
	gap: 8px;
	margin-bottom: 24px;
	max-width: 640px;
}
.props-form textarea {
	width: 100%;
	font-family: 'Fira Code', monospace;
	font-size: 13px;
	padding: 12px;
	border-radius: 8px;
	border: 1px solid #E5E7EB;
	resize: vertical;
}
.props-form button {
	justify-self: flex-start;
	padding: 10px 18px;
	border-radius: 8px;
	border: none;
	background: #0EA5E9;
	color: #fff;
	font-weight: 600;
	cursor: pointer;
}
.preview-grid {
	display: grid;
	gap: 24px;
	grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}
.preview-grid iframe {
	width: 100%;
	height: 480px;
	border: 1px solid #E5E7EB;
	border-radius: 12px;
	background: white;
}
.preview-grid pre {
	background: white;
	border-radius: 12px;
	border: 1px solid #E5E7EB;
	padding: 16px;
	white-space: pre-wrap;
	word-break: break-word;
	min-height: 480px;
}
.error {
	color: #DC2626;
	background: #FEE2E2;
	padding: 12px 16px;
	border-radius: 8px;
	max-width: 640px;
}
`;
