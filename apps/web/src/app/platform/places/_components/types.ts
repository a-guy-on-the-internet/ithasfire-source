export type PlaceVerificationStatus =
  | "UNVERIFIED"
  | "VERIFIED"
  | "PENDING"
  | "REJECTED";

export type PlaceStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";

export type VerificationFilter =
  | "all"
  | "pending"
  | "unverified"
  | "verified"
  | "rejected";

export interface PlatformPlaceRow {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  capacity: number | null;
  status: PlaceStatus;
  verificationStatus: PlaceVerificationStatus;
  ownerCount: number;
  listedInDirectory: boolean;
  /** Site-relative public page path (`/places/{slug}`), null without a linkable page. */
  publicPath: string | null;
}

/** The table's lifecycle filter: `?status=`. Absent means "active". */
export type PlaceStatusFilter = "active" | "archived" | "all";
