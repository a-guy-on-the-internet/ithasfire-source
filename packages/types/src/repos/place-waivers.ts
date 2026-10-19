export interface PlaceWaiverRecord {
  id: string;
  placeId: string;
  title: string;
  content: string;
  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlaceWaiverInput {
  placeId: string;
  title: string;
  content: string;
}

export interface UpdatePlaceWaiverInput {
  id: string;
  title?: string;
  content?: string;
  isActive?: boolean;
}

export interface ListPlaceWaiversInput {
  placeId: string;
  /** If true, only return active waivers. */
  activeOnly?: boolean;
}
