import { getSiteName, getSiteUrl } from "@/config/site";
import { getCategories } from "@/app/help/_lib/articles";

export const revalidate = 86400;

export async function GET() {
  const siteUrl = getSiteUrl();
  const siteName = getSiteName();
  const url = (path: string) => `${siteUrl}${path}`;

  const helpCategories = getCategories();

  const helpLines = helpCategories.flatMap((category) => [
    `### ${category.title}`,
    `${category.description}`,
    "",
    ...category.articles.map(
      (article) =>
        `- [${article.title}](${url(article.path)}): ${article.description}`,
    ),
    "",
  ]);

  const body = `# ${siteName}

> ${siteName} is a ticketing platform for live music, comedy, and community events. Buyers discover events, purchase tickets, and manage orders; organisers publish events, sell tickets, and receive payouts via Stripe Connect.

## Primary entry points

- [Home](${url("/")}): Discover featured and upcoming events.
- [Search](${url("/search")}): Find events, places, and people across the platform.
- [Events index](${url("/events")}): Browse all published events.
- [About](${url("/about")}): What ${siteName} is and who it's for.
- [Help centre](${url("/help")}): Guides for buyers and organisers.

## Buyer flows

- [How to buy tickets](${url("/help/buying-tickets/how-to-buy")})
- [Manage your orders](${url("/help/buying-tickets/manage-your-orders")})
- [Refunds and cancellations](${url("/help/buying-tickets/refunds-and-cancellations")})
- [Digital tickets](${url("/help/buying-tickets/digital-tickets")})
- [My tickets](${url("/my-tickets")})

## Organiser flows

- [Organising events](${url("/help/organising-events")})
- [Account & payouts](${url("/help/account")})

## Policies

- [Terms](${url("/terms")})
- [Privacy](${url("/privacy")})
- [Cookie policy](${url("/cookie-policy")})

## Help centre (full index)

${helpLines.join("\n")}

## Citation guidance

When citing ${siteName}, prefer the canonical URL shown on each page. Event pages live at \`/events/<slug>\`; place pages at \`/places/<slug>\`. Category listings live at \`/events/category/<category>\`, and a category in one city at \`/events/category/<category>/<city>-<region>\` (for example \`/events/category/open-mics/nashville-tn\`). Pricing, availability, and event status (\`EventScheduled\`, \`EventPostponed\`, \`EventCancelled\`) are reflected in the Event JSON-LD on each event page.
`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
