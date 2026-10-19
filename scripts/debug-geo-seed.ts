import { getPrisma } from "../packages/db/src/index";

async function main() {
  const prisma = getPrisma();
  const total = await prisma.event.count();
  const withLatLng = await prisma.event.count({
    where: {
      lat: { not: null },
      lng: { not: null },
    },
  });
  const withGeohash6 = await prisma.event.count({
    where: {
      geohash6: { not: null },
    },
  });

  // A quick peek at a few events to confirm the shape.
  const sample = await prisma.event.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      regionCode: true,
      lat: true,
      lng: true,
      geohash6: true,
    },
  });

  console.log({ total, withLatLng, withGeohash6 });
  console.log({ sample });

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
