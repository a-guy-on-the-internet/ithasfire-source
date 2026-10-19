import { describe, expect, it, vi } from "vitest";
import { dispatchFollowNotifications, FOLLOW_DELIVERY_MAX_ATTEMPTS } from "../dispatch-follow-notifications";
import { enqueueEventFollowers } from "../enqueue-event-followers";

// Counts how deep we are inside the PUBLIC location projection, so a test can
// prove raw coordinates are read there and nowhere else.
const projection = vi.hoisted(() => ({ depth: 0, calls: 0 }));
vi.mock("../../../lib/location/project-public-event-location", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/location/project-public-event-location")>();
  return {
    ...actual,
    projectPublicEventLocation: (...args: Parameters<typeof actual.projectPublicEventLocation>) => {
      projection.depth++; projection.calls++;
      try { return actual.projectPublicEventLocation(...args); } finally { projection.depth--; }
    },
  };
});

const now = new Date("2026-09-23T12:00:00Z");
function fixture() {
  const event: Record<string, unknown> = {id:"event", status:"PUBLISHED",visibility:"PUBLIC",gateType:"NONE",startsAt:new Date("2026-10-01"),title:"A show",slug:"a/show",timezone:"UTC",orgId:"org",humanId:null,placeId:null,lat:0,lng:0,locationMode:"EXACT",stewardship:"OWNED",venueConfirmedAt:null,venueConfirmationWithdrawnAt:null,venueConfirmedPlaceId:null};
  const page = {id:"page",ownerType:"ORGANIZATION",ownerId:"org",visibility:"PUBLIC",allowFollows:true,displayName:"An org",slug:"org"};
  const follow = {id:"follow",createdAt:new Date("2026-09-01"),notifyNewEvents:true,notifyNearby:false,radiusKm:100};
  const delivery = {id:"delivery",noticeId:"notice",entityPageId:"page",eventId:"event",humanId:"human",followId:"follow",createdAt:now,leaseToken:"token",inAppDone:false,emailDone:false,pushDone:false,attempts:0};
  const ledger = {
    enqueue:vi.fn(), expandAudience:vi.fn(async():Promise<any>=>null), claim:vi.fn().mockResolvedValueOnce(delivery).mockResolvedValue(null),
    renew:vi.fn(async()=>true),settleChannel:vi.fn(async()=>true),finish:vi.fn(),retry:vi.fn(),
    followerHomeCandidates:vi.fn(async():Promise<any[]>=>[]), purgeStartedBefore:vi.fn(),
  };
  const eventHumans = {listByEvent:vi.fn(async()=>[{humanId:"performer",role:"PERFORMER"}])};
  const repos = {entityEventNotices:ledger,events:{getById:vi.fn(async()=>event)},entityPages:{getByOwner:vi.fn(async()=>page)},eventHumans,places:{getById:vi.fn()},follows:{getFollow:vi.fn(async()=>follow)}};
  const notify = vi.fn(async()=>({ok:true,inApp:{status:"persisted"},email:{status:"sent"},push:{status:"sent"}}));
  const deps = {repos,notify,clock:{now:()=>now},appBaseUrl:"https://ithasfire.com",reportError:vi.fn()} as any;
  return {deps,event,page,follow,delivery,ledger,notify,repos};
}
/** Page per owner, so assertions can read which owners were enqueued. */
function pagePerOwner(f: ReturnType<typeof fixture>) {
  f.repos.entityPages.getByOwner.mockImplementation(async (type: string, id: string) => ({...f.page, id:`${type}:${id}`, ownerId:id, ownerType:type}));
}
const enqueuedPages = (f: ReturnType<typeof fixture>) => f.ledger.enqueue.mock.calls.map(x => x[0].entityPageId);
const GATED = [["PASSWORD"],["APPLICATION"],[undefined],[null],["SOMETHING_NEW"]] as const;

describe("dispatchFollowNotifications",()=>{
  it("settles each channel with no preference-forcing override or SMS",async()=>{
    const f=fixture(); const result=await dispatchFollowNotifications(f.deps,{});
    expect(result.delivered).toBe(1);expect(f.notify).toHaveBeenCalledTimes(3);
    expect(f.notify.mock.calls[0][0].channels.inApp).toBeUndefined();
    expect(f.notify.mock.calls[1][0].channels.email).toBeUndefined();
    expect(f.notify.mock.calls[2][0].channels.push).toBeUndefined();
    expect(f.notify.mock.calls[0][0].channels.sms.enabled).toBe(false);
    expect(f.ledger.settleChannel).toHaveBeenCalledTimes(3);
  });
  it("retries failed email but durably settles successful channels",async()=>{
    const f=fixture();f.notify.mockResolvedValue({ok:true,inApp:{status:"persisted"},email:{status:"failed",reason:"port_error"},push:{status:"sent"}} as any);
    expect((await dispatchFollowNotifications(f.deps,{})).failed).toBe(1);
    expect(f.ledger.settleChannel.mock.calls.map(x=>x[2])).toEqual(["in_app","push"]);
    expect(f.ledger.retry).toHaveBeenCalledOnce();expect(f.ledger.finish).not.toHaveBeenCalled();expect(f.deps.reportError).toHaveBeenCalledOnce();
    f.delivery.inAppDone=true;f.delivery.pushDone=true;f.delivery.attempts=1;
    f.ledger.claim.mockResolvedValueOnce(f.delivery);f.notify.mockClear();
    await dispatchFollowNotifications(f.deps,{});
    expect(f.notify).toHaveBeenCalledOnce();expect(f.notify.mock.calls[0][0].idempotencyKey).toBe("follow:delivery:email");
  });
  it("respects terminal preference skips",async()=>{
    const f=fixture();f.notify.mockResolvedValue({ok:true,inApp:{status:"skipped",reason:"channel_disabled"},email:{status:"skipped",reason:"channel_disabled"},push:{status:"skipped",reason:"no_devices"}} as any);
    expect((await dispatchFollowNotifications(f.deps,{})).delivered).toBe(1);
    expect(f.ledger.settleChannel.mock.calls.map(x=>x[2])).toEqual(["in_app","email","push"]);
    expect(f.ledger.retry).not.toHaveBeenCalled();
  });
  it("settles an unconfigured port as final and reports it once per run, not per delivery",async()=>{
    const f=fixture();
    const other={...f.delivery,id:"delivery-2",humanId:"human-2"};
    f.ledger.claim.mockReset().mockResolvedValueOnce(f.delivery).mockResolvedValueOnce(other).mockResolvedValue(null);
    f.notify.mockResolvedValue({ok:true,inApp:{status:"persisted"},email:{status:"skipped",reason:"port_unavailable"},push:{status:"sent"}} as any);
    const result=await dispatchFollowNotifications(f.deps,{});
    expect(result).toMatchObject({processed:2,delivered:2,failed:0});
    expect(f.ledger.retry).not.toHaveBeenCalled();
    expect(f.ledger.settleChannel.mock.calls.filter(x=>x[2]==="email")).toHaveLength(2);
    expect(f.ledger.finish).toHaveBeenCalledTimes(2);
    expect(f.deps.reportError).toHaveBeenCalledOnce();
    expect(f.deps.reportError.mock.calls[0][1].extra).toMatchObject({channel:"email",reason:"port_unavailable",deliveries:2});
  });
  it.each(["muted","unfollowed","refollowed","newFollower","privateEvent","past","privatePage","disabledPage","removedEntity"])("skips %s",async scenario=>{
    const f=fixture();
    if(scenario==="muted")f.follow.notifyNewEvents=false;
    if(scenario==="unfollowed")f.repos.follows.getFollow.mockResolvedValue(null as any);
    if(scenario==="refollowed")f.follow.id="replacement";
    if(scenario==="newFollower")f.follow.createdAt=new Date(now.getTime()+1);
    if(scenario==="privateEvent")f.event.visibility="PRIVATE";
    if(scenario==="past")f.event.startsAt=now;
    if(scenario==="privatePage")f.page.visibility="PRIVATE";
    if(scenario==="disabledPage")f.page.allowFollows=false;
    if(scenario==="removedEntity")f.event.orgId=null;
    expect((await dispatchFollowNotifications(f.deps,{})).skipped).toBe(1);expect(f.notify).not.toHaveBeenCalled();
  });
  it.each(GATED)("never sends for a gated event (gateType %s), failing closed",async gateType=>{
    const f=fixture();
    if(gateType===undefined) delete f.event.gateType; else f.event.gateType=gateType;
    expect((await dispatchFollowNotifications(f.deps,{})).skipped).toBe(1);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.ledger.finish).toHaveBeenCalledOnce();
  });
  it("stops if the event becomes gated between channels",async()=>{
    const f=fixture();f.notify.mockImplementation(async()=>{f.event.gateType="PASSWORD";return {ok:true,inApp:{status:"persisted"}} as any;});
    await dispatchFollowNotifications(f.deps,{});expect(f.notify).toHaveBeenCalledOnce();
  });
  it("never notifies a lineup act's followers",async()=>{
    const f=fixture();f.delivery.entityPageId="HUMAN:performer";
    f.repos.entityPages.getByOwner.mockImplementation(async (type: string, id: string) => ({...f.page, id:`${type}:${id}`, ownerId:id, ownerType:type}));
    expect((await dispatchFollowNotifications(f.deps,{})).skipped).toBe(1);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.repos.eventHumans.listByEvent).not.toHaveBeenCalled();
  });
  it("rechecks unfollow before each channel",async()=>{
    const f=fixture();f.notify.mockImplementation(async()=>{f.follow.notifyNewEvents=false;return {ok:true,inApp:{status:"persisted"}} as any;});
    await dispatchFollowNotifications(f.deps,{});expect(f.notify).toHaveBeenCalledOnce();
  });
  it("does not send after losing the lease",async()=>{
    const f=fixture();f.ledger.renew.mockResolvedValue(false);await dispatchFollowNotifications(f.deps,{});expect(f.notify).not.toHaveBeenCalled();expect(f.deps.reportError).toHaveBeenCalled();
  });
  it("contains sender and reporter failures",async()=>{
    const f=fixture();f.notify.mockRejectedValue(new Error("offline"));f.deps.reportError.mockImplementation(()=>{throw Error("reporter");});
    expect((await dispatchFollowNotifications(f.deps,{})).failed).toBe(1);expect(f.ledger.retry).toHaveBeenCalledOnce();
  });
  it("bounds a full audience run",async()=>{
    const f=fixture();f.ledger.claim.mockReset().mockResolvedValue(f.delivery);
    expect((await dispatchFollowNotifications(f.deps,{batchLimit:2})).processed).toBe(2);expect(f.ledger.claim).toHaveBeenCalledTimes(2);
  });
});

describe("enqueueEventFollowers",()=>{
  it("enqueues the owning org and the event's own human owner",async()=>{
    const f=fixture();f.event.humanId="owner-human";pagePerOwner(f);
    await enqueueEventFollowers(f.repos as any,f.event as any,now);
    expect(enqueuedPages(f)).toEqual(["ORGANIZATION:org","HUMAN:owner-human"]);
    expect(f.ledger.enqueue.mock.calls[0][0]).toEqual({entityPageId:"ORGANIZATION:org",eventId:"event",at:now});
  });
  it("never enqueues lineup acts",async()=>{
    const f=fixture();pagePerOwner(f);
    await enqueueEventFollowers(f.repos as any,f.event as any,now);
    expect(enqueuedPages(f)).not.toContain("HUMAN:performer");
    expect(f.repos.eventHumans.listByEvent).not.toHaveBeenCalled();
  });
  it.each(["DRAFT","CANCELLED"])("never enqueues %s",async status=>{
    const f=fixture();f.event.status=status;await enqueueEventFollowers(f.repos as any,f.event as any,now);expect(f.ledger.enqueue).not.toHaveBeenCalled();
  });
  it.each(GATED)("never enqueues a gated event (gateType %s), failing closed",async gateType=>{
    const f=fixture();
    if(gateType===undefined) delete f.event.gateType; else f.event.gateType=gateType;
    await enqueueEventFollowers(f.repos as any,f.event as any,now);
    expect(f.ledger.enqueue).not.toHaveBeenCalled();
  });
  it("never enqueues a non-public or already-started event",async()=>{
    for (const patch of [{visibility:"PRIVATE"},{visibility:"UNLISTED"},{startsAt:now}]) {
      const f=fixture();Object.assign(f.event,patch);
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(f.ledger.enqueue).not.toHaveBeenCalled();
    }
  });

  describe("venue page: only when the venue itself vouched",()=>{
    const PLACE={id:"place",locationMode:"EXACT",orgIdsWithAccess:[] as string[],humanIdsWithAccess:[] as string[],acceptsCommunityListings:false};
    function withPlace(eventPatch: Record<string, unknown>, placePatch: Record<string, unknown> = {}) {
      const f=fixture();pagePerOwner(f);
      Object.assign(f.event,{placeId:"place"},eventPatch);
      f.repos.places.getById.mockResolvedValue({...PLACE,...placePatch});
      return f;
    }
    it("owner arm: the venue's own show enqueues the venue page",async()=>{
      const f=withPlace({},{orgIdsWithAccess:["org"]});
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(enqueuedPages(f)).toContain("PLACE:place");
    });
    it("stamp arm: an explicit venue confirmation enqueues the venue page",async()=>{
      const f=withPlace({venueConfirmedAt:new Date("2026-09-20"),venueConfirmedPlaceId:"place"});
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(enqueuedPages(f)).toContain("PLACE:place");
    });
    it("community arm: blanket consent to ownerless listings does NOT enqueue the venue",async()=>{
      const f=withPlace({stewardship:"COMMUNITY"},{acceptsCommunityListings:true});
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(enqueuedPages(f)).not.toContain("PLACE:place");
      expect(f.repos.entityPages.getByOwner).not.toHaveBeenCalledWith("PLACE","place");
    });
    it("no arm: an unconfirmed venue is not enqueued",async()=>{
      const f=withPlace({});
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(enqueuedPages(f)).toEqual(["ORGANIZATION:org"]);
    });
    it("a withdrawn stamp does not enqueue the venue",async()=>{
      const f=withPlace({venueConfirmedAt:new Date("2026-09-20"),venueConfirmedPlaceId:"place",venueConfirmationWithdrawnAt:new Date("2026-09-21")});
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(enqueuedPages(f)).not.toContain("PLACE:place");
    });
    it("a private-address venue is not enqueued even when it vouched",async()=>{
      const f=withPlace({},{orgIdsWithAccess:["org"],locationMode:"OBSCURED"});
      await enqueueEventFollowers(f.repos as any,f.event as any,now);
      expect(enqueuedPages(f)).not.toContain("PLACE:place");
    });
    it("onlyPlace enqueues the venue page alone",async()=>{
      const f=withPlace({venueConfirmedAt:new Date("2026-09-20"),venueConfirmedPlaceId:"place"});
      await enqueueEventFollowers(f.repos as any,f.event as any,now,{onlyPlace:true});
      expect(enqueuedPages(f)).toEqual(["PLACE:place"]);
    });
    it("the drain drops a community-arm venue notice",async()=>{
      const f=withPlace({stewardship:"COMMUNITY"},{acceptsCommunityListings:true});
      f.delivery.entityPageId="PLACE:place";
      expect((await dispatchFollowNotifications(f.deps,{})).skipped).toBe(1);
      expect(f.notify).not.toHaveBeenCalled();
    });
  });
});

describe("expansion throughput",()=>{
  const step=(inserted:number,closedReason:string|null=null)=>({noticeId:`n${Math.random()}`,inserted,closedReason});
  it("keeps expanding notices in one run until none is left, zero-follower notices included",async()=>{
    const f=fixture();
    f.ledger.expandAudience.mockResolvedValueOnce(step(3)).mockResolvedValueOnce(step(0)).mockResolvedValueOnce(step(2)).mockResolvedValue(null);
    const result=await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.expandAudience).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({expanded:5,noticesExpanded:3});
    expect(f.ledger.expandAudience.mock.calls[0][0]).toEqual({limit:500,now});
  });
  it("stops when the run's follower budget is spent",async()=>{
    const f=fixture();
    f.ledger.expandAudience.mockResolvedValueOnce(step(4)).mockResolvedValueOnce(step(3)).mockResolvedValue(step(9));
    await dispatchFollowNotifications(f.deps,{expandBudget:7});
    expect(f.ledger.expandAudience).toHaveBeenCalledTimes(2);
    expect(f.ledger.expandAudience.mock.calls.map(c=>c[0].limit)).toEqual([7,3]);
  });
  it("reports notices closed because their event started ONCE per run, with the count",async()=>{
    const f=fixture();
    f.ledger.expandAudience.mockResolvedValueOnce(step(0,"EVENT_STARTED")).mockResolvedValueOnce(step(0,"EVENT_STARTED")).mockResolvedValueOnce(step(0,"EVENT_GONE")).mockResolvedValue(null);
    const result=await dispatchFollowNotifications(f.deps,{});
    expect(result.noticesClosed).toBe(3);
    const extras=f.deps.reportError.mock.calls.map((c:any)=>c[1].extra);
    expect(extras).toEqual(expect.arrayContaining([{reason:"EVENT_STARTED",notices:2},{reason:"EVENT_GONE",notices:1}]));
    expect(extras).toHaveLength(2);
  });
  it("bounds the delivery loop by wall clock",async()=>{
    const f=fixture(); let t=now.getTime();
    f.deps.clock={now:()=>new Date(t+=40_000)};
    f.ledger.claim.mockReset().mockImplementation(async()=>({...f.delivery}));
    const result=await dispatchFollowNotifications(f.deps,{timeBudgetMs:120_000});
    expect(result.processed).toBeLessThan(3);
  });
});

describe("attempt cap and dead-letter",()=>{
  const failingEmail=(f:ReturnType<typeof fixture>)=>f.notify.mockResolvedValue({ok:true,inApp:{status:"persisted"},email:{status:"failed",reason:"port_error"},push:{status:"sent"}} as any);
  it("reports the FIRST failure with {channel, reason, attempts}",async()=>{
    const f=fixture();failingEmail(f);
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.retry).toHaveBeenCalledOnce();
    expect(f.deps.reportError).toHaveBeenCalledOnce();
    expect(f.deps.reportError.mock.calls[0][1].extra).toMatchObject({channel:"email",reason:"port_error",attempts:1});
  });
  it("does not report the retries in between",async()=>{
    const f=fixture();failingEmail(f);f.delivery.attempts=3;
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.retry).toHaveBeenCalledOnce();
    expect(f.deps.reportError).not.toHaveBeenCalled();
  });
  it(`dead-letters on attempt ${FOLLOW_DELIVERY_MAX_ATTEMPTS}: finished with a reason, reported, not retried`,async()=>{
    const f=fixture();failingEmail(f);f.delivery.attempts=FOLLOW_DELIVERY_MAX_ATTEMPTS-1;
    const result=await dispatchFollowNotifications(f.deps,{});
    expect(result.deadLettered).toBe(1);
    expect(f.ledger.retry).not.toHaveBeenCalled();
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"DEAD_LETTER");
    expect(f.deps.reportError.mock.calls[0][1].extra).toMatchObject({channel:"email",reason:"port_error",attempts:FOLLOW_DELIVERY_MAX_ATTEMPTS});
  });
  it("dead-letters a delivery that keeps throwing, too",async()=>{
    const f=fixture();f.notify.mockRejectedValue(new Error("offline"));f.delivery.attempts=FOLLOW_DELIVERY_MAX_ATTEMPTS-1;
    expect((await dispatchFollowNotifications(f.deps,{})).deadLettered).toBe(1);
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"DEAD_LETTER");
  });
});

describe("naming and finish reasons",()=>{
  it("a venue page announces under Place.name, never the frozen page displayName",async()=>{
    const f=fixture();
    Object.assign(f.event,{placeId:"place"});
    f.page.ownerType="PLACE";f.page.ownerId="place";f.page.displayName="Old page name";
    f.repos.places.getById.mockResolvedValue({id:"place",name:"The Real Venue",locationMode:"EXACT",orgIdsWithAccess:["org"],humanIdsWithAccess:[],acceptsCommunityListings:false});
    await dispatchFollowNotifications(f.deps,{});
    expect(f.notify.mock.calls[0][0].payload.entityName).toBe("The Real Venue");
  });
  it("records the finish reason of a skip",async()=>{
    const f=fixture();f.follow.notifyNewEvents=false;
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"MUTED");
  });
});

describe("near you: decided only on PUBLIC exact points",()=>{
  // An event row is EXACT at (0,0). Points are degrees of longitude on the
  // equator: 0.5° ≈ 56 km, 2° ≈ 222 km.
  const RAW_KEYS=new Set(["lat","lng","latitude","longitude","savedLocation","addressText","formattedAddress","addressLine1","addressLine2","postalCode"]);
  function tripwire<T extends object>(target:T, outside:string[]):T {
    return new Proxy(target,{get(obj,key,receiver){
      if(typeof key==="string"&&RAW_KEYS.has(key)&&projection.depth===0) outside.push(key);
      return Reflect.get(obj,key,receiver);
    }});
  }
  const candidateEvent=(id:string,lng:number,extra:Record<string,unknown>={})=>({id,orgId:"o",humanId:null,placeId:null,gateType:"NONE",locationMode:"EXACT",locationRadiusMeters:null,locationLabel:null,addressText:"1 Main St",lat:0,lng,locality:null,region:null,countryCode:"US",postalCode:null,...extra});
  const withheldVenue=(lng:number)=>({id:"house",locationMode:"OBSCURED",locationRadiusMeters:null,locationLabel:null,formattedAddress:"A house",addressLine1:"A house",addressLine2:null,city:null,region:null,postalCode:null,countryCode:"US",lat:0,lng});
  function nearby(candidates:any[], radiusKm:number|null=100){
    const f=fixture(); const outside:string[]=[];
    f.follow.notifyNearby=true; f.follow.radiusKm=radiusKm as any;
    f.repos.events.getById.mockResolvedValue(tripwire(f.event,outside));
    f.ledger.followerHomeCandidates.mockResolvedValue(candidates.map(c=>({event:tripwire(c.event,outside),place:c.place?tripwire(c.place,outside):null})));
    projection.calls=0;
    return {f,outside};
  }
  it("reads raw coordinates ONLY inside the public projection",async()=>{
    const {f,outside}=nearby([{event:candidateEvent("past",0.5),place:null}]);
    expect((await dispatchFollowNotifications(f.deps,{})).delivered).toBe(1);
    expect(outside).toEqual([]);
    expect(projection.calls).toBeGreaterThan(0);
  });
  it("delivers inside the radius and skips outside it, with a reason",async()=>{
    const inside=nearby([{event:candidateEvent("past",0.5),place:null}],100);
    expect((await dispatchFollowNotifications(inside.f.deps,{})).delivered).toBe(1);
    const far=nearby([{event:candidateEvent("past",2),place:null}],100);
    expect((await dispatchFollowNotifications(far.f.deps,{})).skipped).toBe(1);
    expect(far.f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"NEARBY_OUTSIDE_RADIUS");
    expect(far.f.notify).not.toHaveBeenCalled();
  });
  it("a WITHHELD venue on the latest order is never a home; an earlier public event is used",async()=>{
    // The house is 0.1° away (inside 100 km); the earlier public event is 2° away.
    const {f,outside}=nearby([
      {event:candidateEvent("latest",0.1,{placeId:"house"}),place:withheldVenue(0.1)},
      {event:candidateEvent("earlier",2),place:null},
    ]);
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"NEARBY_OUTSIDE_RADIUS");
    expect(f.notify).not.toHaveBeenCalled();
    expect(outside).toEqual([]);
  });
  it("a WITHHELD venue alone yields no home: fails closed with a reason",async()=>{
    const {f}=nearby([{event:candidateEvent("latest",0.1,{placeId:"house"}),place:withheldVenue(0.1)}]);
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"NEARBY_NO_PUBLIC_HOME");
    expect(f.notify).not.toHaveBeenCalled();
  });
  it.each([
    ["an OBSCURED event",{locationMode:"OBSCURED"}],
    ["a gated event",{gateType:"PASSWORD"}],
  ])("%s is never a home",async(_l,extra)=>{
    const {f}=nearby([{event:candidateEvent("past",0.5,extra),place:null}]);
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"NEARBY_NO_PUBLIC_HOME");
  });
  it("an OBSCURED announced event gets no distance decision at all",async()=>{
    const {f}=nearby([{event:candidateEvent("past",0.1),place:null}]);
    f.event.locationMode="OBSCURED";
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"NEARBY_EVENT_NOT_PUBLIC");
    expect(f.ledger.followerHomeCandidates).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });
  it("an announced event at a withheld venue gets no distance decision",async()=>{
    const {f}=nearby([{event:candidateEvent("past",0.1),place:null}]);
    Object.assign(f.event,{placeId:"house"});
    f.repos.places.getById.mockResolvedValue({...withheldVenue(0),orgIdsWithAccess:[],humanIdsWithAccess:[],acceptsCommunityListings:false});
    await dispatchFollowNotifications(f.deps,{});
    expect(f.ledger.finish).toHaveBeenCalledWith("delivery","token",now,"NEARBY_EVENT_NOT_PUBLIC");
  });
  it("a follow without nearby never looks up a home",async()=>{
    const f=fixture();
    expect((await dispatchFollowNotifications(f.deps,{})).delivered).toBe(1);
    expect(f.ledger.followerHomeCandidates).not.toHaveBeenCalled();
  });
  it("defaults the radius to 100 km",async()=>{
    const inside=nearby([{event:candidateEvent("past",0.5),place:null}],null);
    expect((await dispatchFollowNotifications(inside.f.deps,{})).delivered).toBe(1);
    const far=nearby([{event:candidateEvent("past",1),place:null}],null);
    expect((await dispatchFollowNotifications(far.f.deps,{})).skipped).toBe(1);
  });
});
