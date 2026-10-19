import { NextResponse, type NextRequest } from "next/server";

import {
  render,
  type EmailFooterDefaults,
  type TemplateProps,
} from "@th/ui-email";

/**
 * POST /api/admin/email-preview
 *
 * Accepts `EventDetailsProps` (the `event.details` template payload) plus an
 * optional `footer` (platform mailing address / contact / brand) and returns
 * the rendered HTML string so the admin event-builder can display a faithful
 * email preview — including the exact CAN-SPAM footer recipients will see.
 *
 * This route intentionally has no auth guard — it only renders static HTML
 * from the provided props, never reads or mutates data. The admin layout
 * itself is already gated.
 */
export async function POST(request: NextRequest) {
  try {
    const { footer, ...props } = (await request.json()) as TemplateProps<"event.details"> & {
      footer?: EmailFooterDefaults;
    };

    const { html } = await render({
      templateId: "event.details",
      props,
      footer,
    });

    return NextResponse.json({ html });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to render email preview";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
