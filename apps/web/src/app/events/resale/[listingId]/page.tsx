import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Resale Checkout",
};

type ResaleCheckoutPageParams = {
  params: Promise<{
    listingId: string;
  }>;
};

export default async function ResaleCheckoutPage({
  params,
}: ResaleCheckoutPageParams) {
  const { listingId } = await params;

  // Dynamically import the client component to keep this page as thin as
  // possible. All data loading happens client-side via tRPC hooks because
  // checkout pages are not indexable and the buyer must be authenticated.
  const { ResaleCheckout } = await import("./_components/ResaleCheckout");

  return <ResaleCheckout listingId={listingId} />;
}
