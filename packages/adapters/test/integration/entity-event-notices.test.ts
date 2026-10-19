import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { startPostgresContainer, type PostgresTestContainer } from "@th/test-utils/testcontainers";
import { makeEntityEventNoticesRepo } from "../../src/db/prisma/entity-event-notices";

const MIGRATIONS = ["20260930200000_entity_follow_notifications", "20261001210000_entity_follow_delivery_per_event"];

// A disposable database, never DATABASE_URL. Apply the actual additive
// migrations and the minimal audience/event source tables; unrelated
// historical migrations cannot mask a regression in the outbox SQL under test.
describe("entity event outbox SQL",()=>{
  let container: PostgresTestContainer;
  let pool: Pool;
  let prisma: PrismaClient;
  let migrated: Array<{id: string; eventId: string}> = [];
  const now = new Date("2026-09-23T12:00:00Z");
  const future = new Date("2026-10-23T12:00:00Z");
  beforeAll(async()=>{
    container=await startPostgresContainer();
    pool=new Pool({connectionString:container.databaseUrl});
    const sql=async(m:string)=>pool.query(await readFile(new URL(`../../../db/prisma/migrations/${m}/migration.sql`,import.meta.url),"utf8"));
    await sql(MIGRATIONS[0]!);
    // Rows written under the first migration: one follower reached twice for
    // one event through two followed pages, the second copy already sent.
    await pool.query(`INSERT INTO "EntityEventNotice" ("id","entityPageId","eventId") VALUES ('n1','A','X'),('n2','B','X')`);
    await pool.query(`INSERT INTO "EntityEventDelivery" ("id","noticeId","humanId","followId","emailDone") VALUES ('d1','n1','h','f1',false),('d2','n2','h','f2',true),('d3','n1','h2','f3',false)`);
    await sql(MIGRATIONS[1]!);
    migrated=(await pool.query(`SELECT "id","eventId" FROM "EntityEventDelivery" ORDER BY "id"`)).rows;
    await pool.query(`DELETE FROM "EntityEventNotice"`);
    await pool.query('CREATE TABLE "EntityFollow" ("id" TEXT PRIMARY KEY, "entityPageId" TEXT NOT NULL, "followerHumanId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL)');
    await pool.query('CREATE TABLE "Event" ("id" TEXT PRIMARY KEY, "startsAt" TIMESTAMP(3) NOT NULL)');
    await pool.query('INSERT INTO "Event" VALUES (\'event\', $1), (\'rollback\', $1), (\'other\', $1), (\'started\', $2)',[future.toISOString(), new Date(now.getTime()-1000).toISOString()]);
    prisma=new PrismaClient({adapter:new PrismaPg(pool)});
  },120_000);
  afterAll(async()=>{await prisma?.$disconnect();await pool?.end();await container?.stop();});
  it("the dedupe migration backfills eventId and keeps the copy that already sent",()=>{
    expect(migrated).toEqual([{id:"d2",eventId:"X"},{id:"d3",eventId:"X"}]);
  });
  it("rolls back enqueue with its parent transaction, dedupes republish, pages >100 with a cutoff",async()=>{
    await expect(prisma.$transaction(async tx=>{await makeEntityEventNoticesRepo(tx).enqueue({entityPageId:"page",eventId:"rollback",at:now});throw Error("rollback");})).rejects.toThrow("rollback");
    expect(await prisma.entityEventNotice.count()).toBe(0);
    const repo=makeEntityEventNoticesRepo(prisma);
    await repo.enqueue({entityPageId:"page",eventId:"event",at:now});
    await repo.enqueue({entityPageId:"page",eventId:"event",at:now});
    expect(await prisma.entityEventNotice.count()).toBe(1);
    await pool.query('INSERT INTO "EntityFollow" SELECT \'f\' || lpad(n::text,4,\'0\'), \'page\', \'h\' || n, $1 FROM generate_series(1,205) n',[new Date(now.getTime()-1000).toISOString()]);
    await pool.query('INSERT INTO "EntityFollow" VALUES (\'late\',\'page\',\'late-human\',$1)',[new Date(now.getTime()+1000).toISOString()]);
    expect((await repo.expandAudience({limit:100,now}))?.inserted).toBe(100);
    expect((await repo.expandAudience({limit:100,now}))?.inserted).toBe(100);
    expect(await repo.expandAudience({limit:100,now})).toMatchObject({inserted:5,closedReason:null});
    expect(await repo.expandAudience({limit:100,now})).toBeNull();
    expect(await prisma.entityEventDelivery.count()).toBe(205);
    expect(await prisma.entityEventDelivery.count({where:{humanId:"late-human"}})).toBe(0);
  });
  it("one delivery per (event, follower) across followed pages",async()=>{
    const repo=makeEntityEventNoticesRepo(prisma);
    // h1..h3 also follow a second page announcing the same event; h-only is new.
    await pool.query('INSERT INTO "EntityFollow" VALUES (\'g1\',\'venue\',\'h1\',$1),(\'g2\',\'venue\',\'h2\',$1),(\'g3\',\'venue\',\'h3\',$1),(\'g4\',\'venue\',\'h-only\',$1)',[new Date(now.getTime()-1000).toISOString()]);
    await repo.enqueue({entityPageId:"venue",eventId:"event",at:now});
    expect(await repo.expandAudience({limit:100,now})).toMatchObject({inserted:1});
    expect(await prisma.entityEventDelivery.count({where:{eventId:"event",humanId:"h1"}})).toBe(1);
    expect(await prisma.entityEventDelivery.count({where:{eventId:"event",humanId:"h-only"}})).toBe(1);
    expect(await repo.expandAudience({limit:100,now})).toBeNull();
  });
  it("closes a notice whose event already started, with a reason and no deliveries",async()=>{
    const repo=makeEntityEventNoticesRepo(prisma);
    await repo.enqueue({entityPageId:"page",eventId:"started",at:now});
    await repo.enqueue({entityPageId:"page",eventId:"vanished",at:now});
    const steps=[await repo.expandAudience({limit:100,now}),await repo.expandAudience({limit:100,now})];
    expect(steps.map(s=>s?.closedReason).sort()).toEqual(["EVENT_GONE","EVENT_STARTED"]);
    expect(steps.every(s=>s?.inserted===0)).toBe(true);
    expect(await prisma.entityEventDelivery.count({where:{eventId:{in:["started","vanished"]}}})).toBe(0);
    expect(await repo.expandAudience({limit:100,now})).toBeNull();
  });
  it("concurrent claims differ, reclaim preserves channel progress and rejects stale tokens",async()=>{
    const repo=makeEntityEventNoticesRepo(prisma);
    // Defaults are actual DB time; move due timestamps into the deterministic clock.
    await prisma.entityEventDelivery.updateMany({data:{nextAttemptAt:now}});
    const leaseUntil=new Date(now.getTime()+60_000);
    const [a,b]=await Promise.all([repo.claim({now,leaseUntil,token:"A"}),repo.claim({now,leaseUntil,token:"B"})]);
    expect(a).toBeTruthy();expect(b).toBeTruthy();expect(a!.id).not.toBe(b!.id);
    expect(await repo.settleChannel(a!.id,"A","in_app",now)).toBe(true);
    expect(await repo.settleChannel(a!.id,"wrong","email",now)).toBe(false);
    // Isolate A so reclaim deterministically picks it.
    await prisma.entityEventDelivery.updateMany({where:{id:{not:a!.id}},data:{finishedAt:now}});
    const later=new Date(leaseUntil.getTime()+1);
    const reclaimed=await repo.claim({now:later,leaseUntil:new Date(later.getTime()+60_000),token:"C"});
    expect(reclaimed?.id).toBe(a!.id);expect(reclaimed?.inAppDone).toBe(true);
    expect(await repo.renew(a!.id,"A",later,new Date(later.getTime()+60_000))).toBe(false);
    expect(await repo.settleChannel(a!.id,"A","email",later)).toBe(false);
    await repo.finish(a!.id,"A",later,"DELIVERED");
    expect((await prisma.entityEventDelivery.findUniqueOrThrow({where:{id:a!.id}})).finishedAt).toBeNull();
    await repo.retry(a!.id,"C",new Date(later.getTime()+120_000),later);
    expect(await repo.claim({now:later,leaseUntil:new Date(later.getTime()+60_000),token:"D"})).toBeNull();
    const retryTime=new Date(later.getTime()+120_000);
    const retry=await repo.claim({now:retryTime,leaseUntil:new Date(retryTime.getTime()+60_000),token:"D"});
    expect(retry?.attempts).toBe(1);expect(retry?.inAppDone).toBe(true);
    expect(await repo.settleChannel(a!.id,"D","email",retryTime)).toBe(true);
    expect(await repo.settleChannel(a!.id,"D","push",retryTime)).toBe(true);
    await repo.finish(a!.id,"D",retryTime,"DEAD_LETTER");
    expect((await prisma.entityEventDelivery.findUniqueOrThrow({where:{id:a!.id}})).finishReason).toBe("DEAD_LETTER");
    expect(await repo.claim({now:retryTime,leaseUntil:new Date(retryTime.getTime()+60_000),token:"E"})).toBeNull();
  });
  it("purges notices and deliveries by EVENT start (or a gone event), never a future event's",async()=>{
    const repo=makeEntityEventNoticesRepo(prisma);
    const before=await prisma.entityEventDelivery.count({where:{eventId:"event"}});
    expect(before).toBeGreaterThan(0);
    const {notices}=await repo.purgeStartedBefore(now);
    expect(notices).toBe(2); // "started" (started before now) and "vanished" (event gone)
    expect(await prisma.entityEventNotice.count({where:{eventId:{in:["started","vanished"]}}})).toBe(0);
    expect(await prisma.entityEventDelivery.count({where:{eventId:"event"}})).toBe(before);
  });
});
