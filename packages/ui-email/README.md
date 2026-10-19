# @th/ui-email

Toolkit for rendering Ithas Fire transactional emails in both HTML and plaintext formats.

## Features

- React Email components with inlined styles for rich HTML output.
- Plaintext output: templates that ship an Eta text template (`src/text-templates/*.eta`) render it; every other template's text is derived from its HTML with `html-to-text`.
- Single `render()` API returning `{ subject, html, text }` for adapters.
- Runtime validation of template props and template metadata lookup.
- Local preview server to explore templates with sample data.

## Getting started

```bash
pnpm -F @th/ui-email dev
```

Alternatively, from the repository root you can run the convenience script:

```bash
pnpm email:preview
```

Navigate to <http://localhost:3004> (override with `UI_EMAIL_PREVIEW_PORT`) to browse templates. Use the JSON editor to tweak props and see HTML and text outputs live.

## Usage

```ts
import { render } from "@th/ui-email";

const { subject, html, text } = await render({
  templateId: "ticket.issued",
  props: {
    eventTitle: "Indie Fest 2025",
    eventDateISO: "2025-10-12T18:00:00.000Z",
    venueName: "Harbor Pavilion",
    tickets: [{ code: "TH-001", qrUrl: "https://example.com/qr/TH-001" }],
    orderId: "ORD-123",
    manageUrl: "https://tickets.example.com/orders/ORD-123",
    supportUrl: "https://tickets.example.com/support",
  },
});
```

`render` also takes an optional `locale` (resolved through `@th/locale`) and `footer` (platform footer defaults: mailing address, contact, brand).

## Commands

- `pnpm -F @th/ui-email build` – bundle ESM + CJS outputs.
- `pnpm -F @th/ui-email test` – run Vitest unit tests.
- `pnpm -F @th/ui-email dev` – start the preview playground.
- `pnpm email:preview` – convenience root-level script to start the preview server.
- `pnpm -F @th/ui-email lint` – ESLint plus `lint:colors`, the email colour gate (`scripts/check-email-colors.mjs`). Email colours must come from `src/theme/tokens.ts`; email cannot use `var()` theming.
- `pnpm -F @th/ui-email email:export` and `storybook:samples` – export a rendered email / regenerate Storybook sample data (`scripts/`).

## Template catalogue

Call `listTemplates()` to inspect available template identifiers, required props, and example subjects.
