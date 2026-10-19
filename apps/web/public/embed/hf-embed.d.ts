declare namespace HF {
  const version: string;

  interface WidgetOptions {
    embedId: string;
    container: string | Element;
    /**
     * Which widget the embed renders. "tickets" (default) is the event /
     * checkout widget; "booking" renders the place's "Request to book" form
     * (modal trigger defaults to "Request to book"). Requires an embed
     * created for the matching subject type.
     */
    widget?: "tickets" | "booking";
    mode?: "inline" | "modal";
    /**
     * Which events an organization/human widget renders.
     * - "own" (default) — events the organization/person CREATED.
     * - "venues" — published events at places they OWN, whoever booked them.
     * - "all" — the union of both, deduped.
     *
     * Ignored for event/place subjects. Omitting it keeps the "own" default.
     */
    scope?: "own" | "venues" | "all";
    height?: number | "auto";
    theme?: {
      brandColor?: string;
      bg?: string;
      fontColor?: string;
      accentColor?: string;
    };
    /**
     * Label for the modal trigger button (`mode: "modal"` only).
     * Defaults to "Get Tickets", or "Request to book" when
     * `widget: "booking"`.
     */
    triggerText?: string;
    promoCode?: string;
    onReady?: (data: { embedId: string }) => void;
    onNavigate?: (data: { screen: string }) => void;
    onOrderComplete?: (data: {
      orderId: string;
      totalCents: number;
      currency: string;
    }) => void;
    onCartUpdate?: (data: {
      items: Array<{ ticketTypeId: string; qty: number }>;
    }) => void;
    onError?: (error: Error) => void;
  }

  interface WidgetHandle {
    destroy(): void;
  }

  function createWidget(options: WidgetOptions): WidgetHandle;
}
