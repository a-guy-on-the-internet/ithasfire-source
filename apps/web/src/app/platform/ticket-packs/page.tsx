import { TicketPackCatalogueView } from "./_components/TicketPackCatalogueView";

/**
 * `/platform/ticket-packs` — the staff ticket-type catalogue
 * (ticket-type-packs spec FR-012).
 *
 * Every `platform.ticketPacks.*` procedure is STAFF_TECH-gated inside its
 * use case AND second-factor-gated wholesale by living under `platform.*`
 * (guard.ts), so this route's real boundary is the server; the nav entry's
 * `rbac: STAFF_TECH` only keeps a REVIEWER or SUPPORT member from being
 * shown a door that would 403.
 */
export default function PlatformTicketPacksPage() {
  return <TicketPackCatalogueView />;
}
