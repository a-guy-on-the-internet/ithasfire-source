export interface TagRecord {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export interface EventTagRecord {
  id: string;
  eventId: string;
  tagId: string;
  sortOrder: number;
  createdAt: Date;
}

export interface EventTagWithTag extends EventTagRecord {
  tag: TagRecord;
}
