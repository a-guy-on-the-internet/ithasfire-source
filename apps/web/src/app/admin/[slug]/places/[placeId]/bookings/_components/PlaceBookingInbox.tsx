"use client";

import { useParams } from "next/navigation";

import { BookingInbox } from "@/components/bookings/BookingInbox";

/**
 * The place route's binding of the shared venue-side inbox: reads the route
 * params and mounts `BookingInbox` in its `place` scope, which adds the page
 * header, the "Accept booking requests" switch and the website-embed section
 * around the same list the org workspace renders.
 */
export function PlaceBookingInbox() {
  const { slug, placeId } = useParams<{ slug: string; placeId: string }>();
  return <BookingInbox scope={{ kind: "place", placeId }} slug={slug} />;
}
