/**
 * Type-safe nav params for both stacks.
 *
 * The signed-out stack only renders SignIn; magic-link callbacks dispatch
 * back into the app via the `ithasfire://auth-callback` deep link, which
 * Better Auth handles before this stack ever sees it.
 *
 * The tab navigator owns Discover (with a nested EventDetail), Tickets (with a
 * nested OrderDetail → TicketQr), Profile, and Settings.
 */

import type { NavigatorScreenParams } from "@react-navigation/native";

export type SignedOutStackParamList = {
  SignIn: undefined;
};

export type DiscoverStackParamList = {
  DiscoverList: undefined;
  // `title` is a display hint for the nav header while the detail loads;
  // the screen replaces it with the canonical title once data arrives.
  EventDetail: { eventSlug: string; eventId?: string; title?: string };
  // Native GA checkout (selection step). `eventSlug` must be the CANONICAL
  // slug (EventDetail resolves redirects before navigating here); `title`
  // is the same header display hint as EventDetail.
  Checkout: { eventId: string; eventSlug: string; title?: string };
};

export type TicketsStackParamList = {
  TicketsList: undefined;
  // `eventName` is a header display hint while the order loads; the screen
  // replaces it with the canonical name once data arrives. Mirrors the
  // `title` hint on the Discover stack.
  OrderDetail: { orderId: string; eventName?: string };
  // The scannable pass. `ticketId` selects which ticket on the order opens
  // first — the screen still pages across all of them.
  TicketQr: { orderId: string; ticketId: string; eventName?: string };
};

export type SignedInTabParamList = {
  Discover: undefined;
  // Nested so a push notification or universal link can target the pass
  // directly, e.g. navigate("Tickets", { screen: "TicketQr", params: {...} }).
  Tickets: NavigatorScreenParams<TicketsStackParamList> | undefined;
  Profile: undefined;
  Settings: undefined;
};
