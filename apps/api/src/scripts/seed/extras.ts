import type { PrismaClient } from "@prisma/client";
import { DEMO_IDS } from "./ids.js";

/**
 * Enriches the dev-login user with profile extras, notifications,
 * saved locations, and event-human links so every major UI surface
 * has data when you log in locally.
 */
export const seedDevLoginExtras = async (
  prisma: PrismaClient,
  seededEvents: Array<{
    id: string;
    slug: string;
    title: string;
    status: string;
    regionCode: string;
  }>,
) => {
  const devHumanId = DEMO_IDS.devUser;
  console.log(
    "Seeding dev-login extras (profile, notifications, saved locations, event links)...",
  );

  // -- EntityPage (replaces old Profile + ProfileTheme + ProfileModules) ----
  const entityPage = await prisma.entityPage.upsert({
    where: { ownerType_ownerId: { ownerType: "HUMAN", ownerId: devHumanId } },
    update: {},
    create: {
      ownerType: "HUMAN",
      ownerId: devHumanId,
      slug: "dev-user",
      displayName: "Dev User",
      visibility: "PUBLIC",
    },
  });

  await prisma.pageTheme.upsert({
    where: { pageId: entityPage.id },
    update: {},
    create: {
      pageId: entityPage.id,
      colorPrimary: "#6366f1", // indigo-500
      colorBg: "#0f172a", // slate-900
      colorText: "#f1f5f9", // slate-100
      fontKey: "inter",
      layoutKey: "default",
    },
  });

  // -- PageBlocks (replaces ProfileModules) --------------------------------
  const pageBlocks = [
    {
      kind: "about",
      orderIndex: 0,
      data: {
        text: "Event organizer, developer, and live music enthusiast. Testing all the things.",
      },
    },
    {
      kind: "links",
      orderIndex: 1,
      data: {
        items: [
          { label: "GitHub", url: "https://github.com/ithasfire" },
          { label: "Twitter", url: "https://twitter.com/ithasfire" },
        ],
      },
    },
    {
      kind: "shows",
      orderIndex: 2,
      data: { limit: 5 },
    },
  ];

  for (const [i, block] of pageBlocks.entries()) {
    const blockId = `00000000-0000-4000-8000-d005a0${i.toString(16).padStart(6, "0")}`;
    await prisma.pageBlock.upsert({
      where: { id: blockId },
      update: { data: block.data, orderIndex: block.orderIndex },
      create: {
        id: blockId,
        pageId: entityPage.id,
        kind: block.kind,
        orderIndex: block.orderIndex,
        data: block.data,
      },
    });
  }
  console.log(`  Entity page + theme + ${pageBlocks.length} page blocks`);

  // -- SavedLocations ------------------------------------------------------
  const savedLocations = [
    {
      name: "HQ Office",
      address: "123 Main St, San Francisco, CA 94105",
      countryCode: "US",
      region: "CA",
      locality: "San Francisco",
      postalCode: "94105",
      lat: 37.7922,
      lng: -122.3968,
      ownerType: "ORGANIZATION" as const,
      ownerId: DEMO_IDS.org,
    },
    {
      name: "Austin Warehouse",
      address: "500 E 6th St, Austin, TX 78701",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.2673,
      lng: -97.7388,
      ownerType: "ORGANIZATION" as const,
      ownerId: DEMO_IDS.org2,
    },
    {
      name: "Mission District Popup",
      address: "3100 24th St, San Francisco, CA 94110",
      countryCode: "US",
      region: "CA",
      locality: "San Francisco",
      postalCode: "94110",
      lat: 37.7524,
      lng: -122.4183,
      ownerType: "ORGANIZATION" as const,
      ownerId: DEMO_IDS.org3,
    },
  ];

  for (const [i, loc] of savedLocations.entries()) {
    const locId = `00000000-0000-4000-8000-d005b0${i.toString(16).padStart(6, "0")}`;
    await prisma.savedLocation.upsert({
      where: { id: locId },
      update: { name: loc.name, address: loc.address },
      create: {
        id: locId,
        ...loc,
      },
    });
  }
  console.log(`  ${savedLocations.length} saved locations`);

  // -- Notifications -------------------------------------------------------
  const now = new Date();
  const notifications: Array<{
    title: string | null;
    body: string;
    kind: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
    tags: string[];
    actionLabel?: string;
    actionHref?: string;
    daysAgo: number;
  }> = [
    {
      title: "Welcome to Ithas Fire",
      body: "Your account is set up and ready to go. Start exploring events or create your own.",
      kind: "INFO",
      tags: ["onboarding"],
      actionLabel: "Browse events",
      actionHref: "/events",
      daysAgo: 14,
    },
    {
      title: "New order received",
      body: "Olivia Thompson purchased 2 tickets to your event.",
      kind: "SUCCESS",
      tags: ["order", "organizer"],
      daysAgo: 7,
    },
    {
      title: "Payout scheduled",
      body: "A $125.00 payout for South Congress Art Pop-up has been scheduled. Funds should arrive in 2-3 business days.",
      kind: "SUCCESS",
      tags: ["payout", "organizer"],
      daysAgo: 5,
    },
    {
      title: null,
      body: "Your event 'SOMA Warehouse Rave' is coming up in 3 days. Make sure everything is ready!",
      kind: "WARNING",
      tags: ["reminder", "organizer"],
      actionLabel: "View event",
      actionHref: "/admin/bay-area-festivals/events",
      daysAgo: 2,
    },
    {
      title: "Ticket transfer received",
      body: "You received a ticket to Brooklyn Warehouse Showcase from Liam Nguyen.",
      kind: "INFO",
      tags: ["transfer", "attendee"],
      actionLabel: "View ticket",
      actionHref: "/my-tickets",
      daysAgo: 1,
    },
    {
      title: "Refund processed",
      body: "Your refund of $35.00 for 1 item has been processed. It may take 5-10 business days to appear on your statement.",
      kind: "INFO",
      tags: ["refund", "attendee"],
      daysAgo: 0,
    },
  ];

  for (const [i, notif] of notifications.entries()) {
    const notifId = `00000000-0000-4000-8000-d005c0${i.toString(16).padStart(6, "0")}`;
    const createdAt = new Date(
      now.getTime() - notif.daysAgo * 24 * 60 * 60 * 1000,
    );
    await prisma.notification.upsert({
      where: { id: notifId },
      update: {},
      create: {
        id: notifId,
        humanId: devHumanId,
        title: notif.title,
        body: notif.body,
        kind: notif.kind,
        tags: notif.tags,
        actionLabel: notif.actionLabel ?? null,
        actionHref: notif.actionHref ?? null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
  console.log(`  ${notifications.length} notifications`);

  // -- NotificationDigestSubscription --------------------------------------
  const digestSubs = [
    { digestType: "ORGANIZER_WEEKLY" as const, subscribed: true },
    { digestType: "ATTENDEE_FEEDBACK" as const, subscribed: true },
  ];

  for (const [i, sub] of digestSubs.entries()) {
    const subId = `00000000-0000-4000-8000-d005d0${i.toString(16).padStart(6, "0")}`;
    await prisma.notificationDigestSubscription.upsert({
      where: { id: subId },
      update: { subscribed: sub.subscribed },
      create: {
        id: subId,
        humanId: devHumanId,
        digestType: sub.digestType,
        subscribed: sub.subscribed,
      },
    });
  }
  console.log(`  ${digestSubs.length} digest subscriptions`);

  // -- EventHuman (link dev user as HOST on a few events) ------------------
  const hostEvents = seededEvents
    .filter((e) => e.status === "PUBLISHED")
    .slice(0, 4);

  for (const evt of hostEvents) {
    await prisma.eventHuman.upsert({
      where: { eventId_humanId: { eventId: evt.id, humanId: devHumanId } },
      update: { role: "HOST", sortOrder: 0 },
      create: {
        eventId: evt.id,
        humanId: devHumanId,
        role: "HOST",
        sortOrder: 0,
      },
    });
  }
  console.log(`  Linked as HOST on ${hostEvents.length} events`);

  // -- Embed widget for the Demo Org on localhost --------------------------
  await prisma.embed.upsert({
    where: { id: DEMO_IDS.embedDemoOrg },
    update: { domain: "localhost", status: "ACTIVE" },
    create: {
      id: DEMO_IDS.embedDemoOrg,
      subjectType: "organization",
      subjectId: DEMO_IDS.org,
      domain: "localhost",
      status: "ACTIVE",
      createdBy: devHumanId,
    },
  });
  console.log(`  Embed widget for Demo Org (id: ${DEMO_IDS.embedDemoOrg})`);
};
