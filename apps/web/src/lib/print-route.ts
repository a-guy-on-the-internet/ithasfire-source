/**
 * THE PRINT LAYER's routing predicate — one definition, two consumers.
 *
 * A route whose last segment is `print` is a printable DOCUMENT
 * (`/my-tickets/[orderId]/print`, and the hours statement / volunteer badge to
 * come), not an app page. A suffix match rather than a prefix list because
 * print routes are leaves of otherwise-ordinary route families; a prefix list
 * cannot express them.
 *
 * Consumers:
 *  - `AppChrome` — documents render bare (no navbar, footer, contextual action
 *    bar, cookie banner, analytics), the same posture `/embed/*` takes.
 *  - `UniverseDust` — the root-layout backdrop <canvas> unmounts rather than
 *    being hidden by a global `canvas { display: none }` print rule, which
 *    would outlive the route (Next does not unload route stylesheets on
 *    client-side navigation).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY NOTE — READ BEFORE ADDING A `…/print` ROUTE
 * ─────────────────────────────────────────────────────────────────────────
 * `AppChrome`'s bypass branch returns BEFORE `AppAuthGate`, so every route
 * this predicate matches also skips the client-side auth gate. That gate was
 * never an authorization boundary (see `private-route-gate.ts` for the same
 * argument at the middleware layer) — the real enforcement is server-side, and
 * the ticket sheet's two reads are `authedProcedure` scoped on
 * `ctx.actorHumanId`, so an unauthenticated caller gets ORDER_NOT_FOUND rather
 * than a document.
 *
 * That is a property of the DATA LAYER, not of this predicate. A future
 * `…/print` route that renders anything from an unauthenticated or unscoped
 * read would leak it to an anonymous visitor with no gate in front. Every
 * document on this layer must fetch through an ownership-checked procedure.
 */
export const isPrintDocumentRoute = (pathname: string | null): boolean =>
  !!pathname && (pathname === "/print" || pathname.endsWith("/print"));
