export interface OrgStatsRecord {
  id: string;
  orgId: string;
  totalEventsOrganized: number;
  totalTicketsSold: number;
  totalVenues: number;
  avgTicketsPerEvent: number | null;
  topPlaceIds: string[] | null;
  topArtistHumanIds: string[] | null;
  uniqueAttendees: number;
  repeatAttendees: number;
  attributionSummary:
    | { eventId: string; attributed: number; walkIn: number }[]
    | null;
  topGenres: string[] | null;
  followerCount: number;
  last90DayTickets: number;
  last90DayEvents: number;
  computedAt: Date;
}
