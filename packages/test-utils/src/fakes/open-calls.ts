import { randomUUID } from "node:crypto";

import type { Repos } from "@th/ports/repos";
import type { EventDateRecord } from "@th/ports/repos/event-dates";
import type { AttachEventHumanInput, EventHumanRecord } from "@th/ports/repos/event-humans";
import type {
  EventSeriesOccurrenceRecord,
  EventSeriesOccurrenceStatus,
  EventSeriesRecord,
} from "@th/ports/repos/event-series";
import type {
  ApplicationMessageAuthorSide,
  ApplicationMessageRecord,
  ApplicationNoteRecord,
  ApplicationSubmissionStatus,
  ApplicationVoteValue,
  ListOpenCallReviewCardsInput,
  OpenCallReviewCardRecord,
  OpenCallTraceCounts,
  CreateOpenCallSubmissionInput,
  EventApplicationQuestionRecord,
  EventApplicationQuestionSnapshotEntry,
  MyOpenCallApplicationRecord,
  OpenCallDateChoiceTarget,
  OpenCallPeerRecord,
  OpenCallSubmissionRecord,
  OpenCallLineupAct,
  UpdateOpenCallSubmissionInput,
  EventRecord,
  OpenCallAnchor,
  OpenCallFormRecord,
  OpenCallPoster,
  PosterOpenCallRecord,
  UpsertEventApplicationQuestionInput,
  UpsertOpenCallFormInput,
} from "@th/ports/repos/events";

/**
 * In-memory world for the open-call use cases
 * (packages/core/src/use-cases/events/open-calls). One shared state backs
 * events, series + occurrences, event dates, open-call forms (and ATTEND
 * forms, so purpose isolation can be asserted), questions, submissions,
 * org memberships, places, lineup rows and the audit log.
 *
 * The open-call repo methods mirror the Prisma adapter's contract: PERFORM
 * only (an ATTEND form is invisible to them), one form per (anchor,
 * purpose), the close sweep flips PENDING only. Locks are recorded in
 * `world.locks` (the real serialisation is covered by the adapter's
 * testcontainer test).
 *
 * `tx(fn)` runs `fn` against the same repos with no rollback.
 */

export const OC_ORG_ID = "10000000-0000-4000-8000-0000000000a1";
export const OC_OTHER_ORG_ID = "10000000-0000-4000-8000-0000000000a2";
export const OC_EDITOR_ID = "30000000-0000-4000-8000-0000000000b1";
export const OC_STRANGER_ID = "30000000-0000-4000-8000-0000000000b2";
export const OC_VIEWER_ID = "30000000-0000-4000-8000-0000000000b3";
export const OC_EVENT_ID = "20000000-0000-4000-8000-0000000000c1";
export const OC_SERIES_ID = "40000000-0000-4000-8000-0000000000d1";
export const OC_PLACE_ID = "50000000-0000-4000-8000-0000000000e1";
export const OC_NOW = new Date("2026-10-05T12:00:00.000Z");

const DAY = 24 * 60 * 60 * 1000;

export function makeOpenCallEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: OC_EVENT_ID,
    orgId: OC_ORG_ID,
    humanId: null,
    title: "Basement Show",
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date(OC_NOW.getTime() + 10 * DAY),
    endsAt: new Date(OC_NOW.getTime() + 10 * DAY + 3 * 60 * 60 * 1000),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    categorySeoType: null,
    placeName: null,
    addressText: "12 Elm St, Minneapolis, MN 55401",
    lat: 44.98,
    lng: -93.27,
    locality: "Minneapolis",
    region: "MN",
    countryCode: "US",
    postalCode: "55401",
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    ...overrides,
  } as unknown as EventRecord;
}

export function makeOpenCallSeries(
  overrides: Partial<EventSeriesRecord> = {},
): EventSeriesRecord {
  return {
    id: OC_SERIES_ID,
    ownerScope: "ORGANIZATION",
    ownerId: OC_ORG_ID,
    name: "Tuesday Open Stage",
    description: null,
    active: true,
    timezone: "America/Chicago",
    schedule: { kind: "FIXED_DATES", dates: [] },
    templateId: null,
    defaults: null,
    createdByHumanId: OC_EDITOR_ID,
    updatedByHumanId: null,
    createdAt: OC_NOW,
    updatedAt: OC_NOW,
    archivedAt: null,
    ...overrides,
  };
}

type FormRow = Omit<OpenCallFormRecord, "purpose"> & {
  purpose: "ATTEND" | "PERFORM";
};

export interface FakeSubmission {
  id: string;
  formId: string;
  eventId: string | null;
  humanId: string | null;
  status: ApplicationSubmissionStatus;
  reviewedAt: Date | null;
  answers: Record<string, unknown>;
  // Open-call application fields (step 4); defaults in addSubmission.
  applyingAsOrgId: string | null;
  guestName: string | null;
  guestUrl: string | null;
  contactEmail: string | null;
  /** Optional so older fixtures keep compiling; undefined reads as null. */
  contactLocale?: string | null;
  isPrivate: boolean;
  openedAt: Date | null;
  statusTokenHash: string | null;
  droppedOutAt: Date | null;
  /** Step 6: FR-019 removal stamp, FR-018 note, and who decided. */
  removedFromLineupAt?: Date | null;
  decisionReason?: string | null;
  reviewerHumanId?: string | null;
  questionsSnapshot: Record<string, EventApplicationQuestionSnapshotEntry>;
  dateChoices: OpenCallDateChoiceTarget[];
  createdAt: Date;
}

/** Statuses the one-open-application partial unique indexes cover. */
const OPEN_APPLICATION_STATUSES: ApplicationSubmissionStatus[] = [
  "PENDING",
  "APPROVED",
  "WAITLISTED",
];

export type OpenCallWorld = ReturnType<typeof createOpenCallWorld>;

/**
 * The adapter's applicant-identity key (listOpenCallPeers): org row -> the
 * org, self row -> the human, guest row -> lower(contactEmail). Null only
 * when SQL's key is NULL (a guest row with no email); "" stays "guest:".
 */
function peerKeyOf(x: FakeSubmission): string | null {
  if (x.applyingAsOrgId !== null) return `org:${x.applyingAsOrgId}`;
  if (x.humanId !== null) return `human:${x.humanId}`;
  return x.contactEmail !== null ? `guest:${x.contactEmail.toLowerCase()}` : null;
}

/** createdAt DESC, id DESC: JS code-point order = the adapter's COLLATE "C". */
function isLaterRow(a: FakeSubmission, b: FakeSubmission): boolean {
  return a.createdAt.getTime() !== b.createdAt.getTime()
    ? a.createdAt.getTime() > b.createdAt.getTime()
    : a.id > b.id;
}

export function createOpenCallWorld(opts: { now?: Date } = {}) {
  const now = opts.now ?? OC_NOW;
  const events = new Map<string, EventRecord>();
  const series = new Map<string, EventSeriesRecord>();
  const occurrences: EventSeriesOccurrenceRecord[] = [];
  const eventDates: EventDateRecord[] = [];
  const forms: FormRow[] = [];
  const questions: EventApplicationQuestionRecord[] = [];
  const submissions: FakeSubmission[] = [];
  const memberships = new Map<string, string>([
    [`${OC_ORG_ID}:${OC_EDITOR_ID}`, "ADMIN"],
    [`${OC_ORG_ID}:${OC_VIEWER_ID}`, "VIEWER"],
  ]);
  const places = new Map<string, Record<string, unknown>>();
  const lineup: EventHumanRecord[] = [];
  const bannedOwnerIds = new Set<string>();
  /** HumanDelegate rows: `${principalId}:${delegateId}` -> role (step 5). */
  const delegations = new Map<string, string>();
  // Organizer-side review state (step 5).
  const votes: Array<{ submissionId: string; humanId: string; vote: ApplicationVoteValue; at: Date }> = [];
  const notes: ApplicationNoteRecord[] = [];
  const messages: ApplicationMessageRecord[] = [];
  /** Every review-queue read, so tests can assert what core asked for. */
  const reviewQueries: ListOpenCallReviewCardsInput[] = [];
  /** PUBLIC entity pages by owner id (humans and orgs), for the peer list. */
  const publicPages = new Map<string, { slug: string; avatarUrl: string | null; displayName: string | null }>();
  const audit: Array<{ entity: string; entityId?: string | null; action: string; data?: unknown }> = [];
  const locks: Array<{ kind: string; id: string }> = [];
  let publicIdCounter = 0;

  const toOpenCall = (row: FormRow): OpenCallFormRecord => ({
    ...row,
    purpose: "PERFORM",
  });
  const findForm = (anchor: OpenCallAnchor, purpose: "ATTEND" | "PERFORM") =>
    forms.find(
      (f) =>
        f.purpose === purpose &&
        (anchor.kind === "event"
          ? f.eventId === anchor.eventId
          : f.seriesId === anchor.seriesId),
    );
  const performById = (formId: string) =>
    forms.find((f) => f.id === formId && f.purpose === "PERFORM");
  // Mirrors the adapter's LATER_SAME_IDENTITY_SQL: no later row of the same
  // identity on the same form. A row with no key (guest without email) has
  // no other rows to lose to.
  const isLatestSubmission = (s: FakeSubmission) => {
    const key = peerKeyOf(s);
    if (key === null) return true;
    return !submissions.some(
      (n) => n !== s && n.formId === s.formId && peerKeyOf(n) === key && isLaterRow(n, s),
    );
  };
  const LIVE: EventSeriesOccurrenceStatus[] = ["PLANNED", "GENERATED", "PUBLISHED"];
  const ENDED = new Set(["CANCELLED", "ARCHIVED", "COMPLETED"]);

  const choiceStartsAt = (c: OpenCallDateChoiceTarget): Date => {
    const at = c.occurrenceId
      ? occurrences.find((o) => o.id === c.occurrenceId)?.startsAt
      : eventDates.find((d) => d.id === c.eventDateId)?.startsAt;
    if (!at) throw new Error("date choice target missing");
    return at;
  };
  const toSubmissionRecord = (s: FakeSubmission): OpenCallSubmissionRecord => ({
    id: s.id,
    formId: s.formId,
    eventId: s.eventId,
    humanId: s.humanId,
    applyingAsOrgId: s.applyingAsOrgId,
    guestName: s.guestName,
    guestUrl: s.guestUrl,
    contactEmail: s.contactEmail,
    contactLocale: s.contactLocale ?? null,
    status: s.status,
    answers: s.answers,
    questionsSnapshot: s.questionsSnapshot,
    isPrivate: s.isPrivate,
    openedAt: s.openedAt,
    statusTokenHash: s.statusTokenHash,
    droppedOutAt: s.droppedOutAt,
    removedFromLineupAt: s.removedFromLineupAt ?? null,
    decisionReason: s.decisionReason ?? null,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
    dateChoices: s.dateChoices
      .map((c) => ({
        eventId: null,
        occurrenceId: c.occurrenceId ?? null,
        eventDateId: c.eventDateId ?? null,
        startsAt: choiceStartsAt(c),
      }))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
  });
  // Trust traces (step 5), mirroring the adapter's loadTraceCounts SQL:
  // a night = an ended SCHEDULED date (or the event itself when it has no
  // date rows) of a PUBLIC, PUBLISHED / COMPLETED event.
  const TRACK = new Set(["PUBLISHED", "COMPLETED"]);
  const nightsOf = (e: EventRecord, at: Date): number => {
    if (!TRACK.has(e.status) || e.visibility !== "PUBLIC") return 0;
    const rows = eventDates.filter((d) => d.eventId === e.id);
    if (rows.length > 0) {
      return rows.filter(
        (d) => d.status === "SCHEDULED" && (d.endsAt ?? d.startsAt).getTime() <= at.getTime(),
      ).length;
    }
    return e.endsAt.getTime() <= at.getTime() ? 1 : 0;
  };
  const herePlacesOf = (form: FormRow): Set<string> => {
    const out = new Set<string>();
    if (form.eventId) {
      const placeId = events.get(form.eventId)?.placeId;
      if (placeId) out.add(placeId);
    } else if (form.seriesId) {
      for (const o of occurrences) {
        if (o.seriesId !== form.seriesId || !o.eventId) continue;
        const placeId = events.get(o.eventId)?.placeId;
        if (placeId) out.add(placeId);
      }
    }
    return out;
  };
  // A person organises their own personal event, and an event of an org
  // where they hold an organiser role ONLY when they are on its lineup
  // (self-booking); an org organises its own events. Mirrors the adapter.
  const organises = (
    ent: { kind: "human" | "org"; id: string },
    e: EventRecord,
    input: { lineupRoles: readonly string[]; organiserOrgRoles: readonly string[] },
  ) => {
    if (ent.kind === "org") return e.orgId === ent.id;
    if (e.orgId === null) return e.humanId === ent.id;
    const role = memberships.get(`${e.orgId}:${ent.id}`);
    if (role === undefined || !input.organiserOrgRoles.includes(role)) return false;
    return lineup.some(
      (r) => r.eventId === e.id && r.humanId === ent.id && input.lineupRoles.includes(r.role),
    );
  };
  const traceCountsOf = (
    ent: { kind: "human" | "org"; id: string },
    here: Set<string>,
    input: { now: Date; lineupRoles: readonly string[]; organiserOrgRoles: readonly string[] },
  ): OpenCallTraceCounts => {
    let played = 0;
    let playedHere = 0;
    for (const r of lineup) {
      const mine = ent.kind === "human" ? r.humanId === ent.id : r.orgId === ent.id;
      if (!mine || !input.lineupRoles.includes(r.role)) continue;
      const e = events.get(r.eventId);
      if (!e || organises(ent, e, input)) continue;
      const n = nightsOf(e, input.now);
      played += n;
      if (e.placeId && here.has(e.placeId)) playedHere += n;
    }
    let ran = 0;
    for (const e of events.values()) {
      if (organises(ent, e, input)) ran += nightsOf(e, input.now);
    }
    return { playedNights: played, playedHereNights: playedHere, ranNights: ran };
  };
  const peerQueries: Array<{
    formId: string;
    viewer: { humanId: string | null; applyingAsOrgId: string | null; contactEmail: string | null };
    limit: number;
  }> = [];

  const eventApplications = {
    async getOpenCall(anchor: OpenCallAnchor) {
      const row = findForm(anchor, "PERFORM");
      return row ? toOpenCall(row) : null;
    },
    async getOpenCallById(formId: string) {
      const row = performById(formId);
      return row ? toOpenCall(row) : null;
    },
    async getOpenCallByPublicId(publicId: string) {
      const row = forms.find((f) => f.publicId === publicId && f.purpose === "PERFORM");
      if (!row) return null;
      const owner = row.eventId
        ? (events.get(row.eventId)?.orgId ?? events.get(row.eventId)?.humanId)
        : series.get(row.seriesId ?? "")?.ownerId;
      return { ...toOpenCall(row), ownerBanned: owner ? bannedOwnerIds.has(owner) : false };
    },
    async upsertOpenCall(input: UpsertOpenCallFormInput) {
      const existing = findForm(input.anchor, "PERFORM");
      const has = (k: keyof UpsertOpenCallFormInput) =>
        Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
      if (existing) {
        for (const k of [
          "introText",
          "defaults",
          "opensAt",
          "closesAt",
          "maxSubmissions",
          "payKind",
          "payDetails",
        ] as const) {
          if (has(k)) (existing as Record<string, unknown>)[k] = input[k] ?? null;
        }
        existing.updatedByHumanId = input.updatedByHumanId;
        existing.updatedAt = now;
        return toOpenCall(existing);
      }
      publicIdCounter += 1;
      const row: FormRow = {
        id: randomUUID(),
        purpose: "PERFORM",
        eventId: input.anchor.kind === "event" ? input.anchor.eventId : null,
        seriesId: input.anchor.kind === "series" ? input.anchor.seriesId : null,
        publicId: `call${String(publicIdCounter).padStart(6, "0")}`,
        introText: input.introText ?? null,
        defaults: input.defaults ?? {
          includeName: false,
          includeReason: false,
          includeSocialLinks: false,
        },
        opensAt: input.opensAt ?? null,
        closesAt: input.closesAt ?? null,
        maxSubmissions: input.maxSubmissions ?? null,
        autoApprove: false,
        payKind: input.payKind ?? null,
        payDetails: input.payDetails ?? null,
        closedAt: null,
        closedByHumanId: null,
        postedAt: null,
        postedByHumanId: null,
        updatedByHumanId: input.updatedByHumanId,
        createdAt: now,
        updatedAt: now,
      };
      forms.push(row);
      return toOpenCall(row);
    },
    async lockSeriesOpenCalls(seriesId: string) {
      locks.push({ kind: "series_advisory", id: seriesId });
    },
    async listUpcomingEventOpenCallsInSeries(input: { seriesId: string; startsAfter: Date }) {
      return forms
        .filter((f) => f.purpose === "PERFORM" && f.eventId)
        .flatMap((f) => {
          const event = events.get(f.eventId!);
          const occ = occurrences.find((o) => o.eventId === f.eventId);
          if (
            !event ||
            !occ ||
            occ.seriesId !== input.seriesId ||
            occ.status === "DETACHED" ||
            ENDED.has(event.status) ||
            event.startsAt.getTime() <= input.startsAfter.getTime()
          ) {
            return [];
          }
          return [
            {
              formId: f.id,
              eventId: event.id,
              eventTitle: event.title,
              eventStartsAt: event.startsAt,
            },
          ];
        });
    },
    async lockOpenCallForClose(formId: string) {
      locks.push({ kind: "form_for_update", id: formId });
      const row = performById(formId);
      return row ? toOpenCall(row) : null;
    },
    async lockOpenCallForSubmit(formId: string) {
      locks.push({ kind: "form_for_share", id: formId });
      const row = performById(formId);
      return row ? toOpenCall(row) : null;
    },
    async lockOpenCallForCappedSubmit(formId: string) {
      locks.push({ kind: "form_for_no_key_update", id: formId });
      const row = performById(formId);
      return row ? toOpenCall(row) : null;
    },
    async setOpenCallPosted(input: {
      formId: string;
      postedAt: Date;
      postedByHumanId: string;
    }) {
      const row = performById(input.formId);
      if (!row) throw new Error("open call not found");
      row.postedAt = input.postedAt;
      row.postedByHumanId = input.postedByHumanId;
      return toOpenCall(row);
    },
    async deleteOpenCallDraft(formId: string) {
      const index = forms.findIndex(
        (f) =>
          f.id === formId &&
          f.purpose === "PERFORM" &&
          f.postedAt === null &&
          !submissions.some((s) => s.formId === formId),
      );
      if (index === -1) return false;
      forms.splice(index, 1);
      // Mirror the DB cascade: the call's questions go with it.
      for (let i = questions.length - 1; i >= 0; i -= 1) {
        if (questions[i]!.formId === formId) questions.splice(i, 1);
      }
      return true;
    },
    async setOpenCallClosed(input: {
      formId: string;
      closedAt: Date | null;
      closedByHumanId: string | null;
    }) {
      const row = performById(input.formId);
      if (!row) throw new Error("open call not found");
      row.closedAt = input.closedAt;
      row.closedByHumanId = input.closedByHumanId;
      return toOpenCall(row);
    },
    async rejectPendingOpenCallSubmissions(input: { formId: string; reviewedAt: Date }) {
      const ids: string[] = [];
      for (const s of submissions) {
        if (s.formId === input.formId && s.status === "PENDING") {
          s.status = "REJECTED";
          s.reviewedAt = input.reviewedAt;
          ids.push(s.id);
        }
      }
      return { ids };
    },
    async countSubmissionsByForm(input: {
      formId: string;
      statuses?: ApplicationSubmissionStatus[];
    }) {
      return submissions.filter(
        (s) =>
          s.formId === input.formId &&
          (!input.statuses || input.statuses.includes(s.status)),
      ).length;
    },
    async listOpenCallsByPoster(input: { poster: OpenCallPoster; now: Date; limit: number }) {
      const ownerId = input.poster.kind === "org" ? input.poster.orgId : input.poster.humanId;
      if (bannedOwnerIds.has(ownerId)) return [];
      const cards: PosterOpenCallRecord[] = [];
      for (const f of forms) {
        if (f.purpose !== "PERFORM" || f.closedAt || !f.postedAt) continue;
        if (f.eventId) {
          const e = events.get(f.eventId);
          if (!e) continue;
          const owned =
            input.poster.kind === "org"
              ? e.orgId === input.poster.orgId
              : e.humanId === input.poster.humanId && e.orgId === null;
          if (
            !owned ||
            e.visibility !== "PUBLIC" ||
            ENDED.has(e.status) ||
            e.startsAt.getTime() <= input.now.getTime()
          ) {
            continue;
          }
          cards.push({
            formId: f.id,
            publicId: f.publicId,
            anchor: { kind: "event", eventId: e.id },
            title: e.title,
            payKind: f.payKind,
            closesAt: f.closesAt,
            nextStartsAt: e.startsAt,
            timezone: e.timezone,
          });
        } else if (f.seriesId) {
          const s = series.get(f.seriesId);
          if (!s || s.archivedAt) continue;
          const owned =
            input.poster.kind === "org"
              ? s.ownerScope === "ORGANIZATION" && s.ownerId === input.poster.orgId
              : s.ownerScope === "HUMAN" && s.ownerId === input.poster.humanId;
          const next = occurrences
            .filter(
              (o) =>
                o.seriesId === s.id &&
                LIVE.includes(o.status) &&
                o.startsAt.getTime() > input.now.getTime(),
            )
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
          if (!owned || !next) continue;
          cards.push({
            formId: f.id,
            publicId: f.publicId,
            anchor: { kind: "series", seriesId: s.id },
            title: s.name,
            payKind: f.payKind,
            closesAt: f.closesAt,
            nextStartsAt: next.startsAt,
            timezone: s.timezone,
          });
        }
      }
      return cards
        .sort((a, b) => a.nextStartsAt.getTime() - b.nextStartsAt.getTime())
        .slice(0, input.limit);
    },
    // ── Open-call applications (step 4) ─────────────────────────────────
    async createOpenCallSubmission(input: CreateOpenCallSubmissionInput) {
      if (!performById(input.formId)) throw new Error("not an open call");
      // The three partial unique indexes (owner ruling Q42): org rows by
      // org, self rows by human, guest rows by lower(email).
      const clash = submissions.find(
        (s) =>
          s.formId === input.formId &&
          OPEN_APPLICATION_STATUSES.includes(s.status) &&
          (input.applyingAsOrgId
            ? s.applyingAsOrgId === input.applyingAsOrgId
            : input.humanId
              ? s.humanId === input.humanId && s.applyingAsOrgId === null
              : s.humanId === null &&
                s.contactEmail !== null &&
                s.contactEmail.toLowerCase() === input.contactEmail?.toLowerCase()),
      );
      if (clash) {
        throw { code: "duplicate_open_application", message: "duplicate_open_application" };
      }
      if (submissions.some((s) => s.statusTokenHash === input.statusTokenHash)) {
        throw new Error("statusTokenHash unique violation");
      }
      if (submissions.some((s) => s.id === input.id)) {
        throw new Error("EventApplicationSubmission id unique violation");
      }
      const keys = input.dateChoices.map((c) => c.occurrenceId ?? c.eventDateId);
      if (new Set(keys).size !== keys.length) {
        throw new Error("OpenCallDateChoice unique violation");
      }
      const s: FakeSubmission = {
        id: input.id,
        formId: input.formId,
        eventId: input.eventId,
        humanId: input.humanId,
        status: "PENDING",
        reviewedAt: null,
        answers: input.answers,
        applyingAsOrgId: input.applyingAsOrgId,
        guestName: input.guestName,
        guestUrl: input.guestUrl,
        contactEmail: input.contactEmail,
        contactLocale: input.contactLocale,
        isPrivate: input.isPrivate,
        openedAt: null,
        statusTokenHash: input.statusTokenHash,
        droppedOutAt: null,
        questionsSnapshot: input.questionsSnapshot,
        dateChoices: [...input.dateChoices],
        createdAt: input.submittedAt,
      };
      submissions.push(s);
      return toSubmissionRecord(s);
    },
    async getOpenCallSubmissionById(submissionId: string) {
      const s = submissions.find((x) => x.id === submissionId && performById(x.formId));
      return s ? toSubmissionRecord(s) : null;
    },
    async getOpenCallSubmissionByTokenHash(hash: string) {
      const s = submissions.find((x) => x.statusTokenHash === hash && performById(x.formId));
      return s ? toSubmissionRecord(s) : null;
    },
    async updateOpenCallSubmission(input: UpdateOpenCallSubmissionInput) {
      const s = submissions.find(
        (x) =>
          x.id === input.submissionId &&
          x.formId === input.formId &&
          x.status === "PENDING" &&
          x.openedAt === null,
      );
      if (!s) return null;
      s.answers = input.answers;
      s.questionsSnapshot = input.questionsSnapshot;
      s.isPrivate = input.isPrivate;
      s.dateChoices = [...input.dateChoices];
      return toSubmissionRecord(s);
    },
    async withdrawPendingOpenCallSubmission(input: { submissionId: string; formId: string }) {
      const s = submissions.find(
        (x) => x.id === input.submissionId && x.formId === input.formId && x.status === "PENDING",
      );
      if (!s) return false;
      s.status = "WITHDRAWN";
      return true;
    },
    async setOpenCallSubmissionPrivacy(input: {
      submissionId: string;
      formId: string;
      isPrivate: boolean;
    }) {
      const s = submissions.find(
        (x) =>
          x.id === input.submissionId &&
          x.formId === input.formId &&
          x.status !== "WITHDRAWN" &&
          isLatestSubmission(x),
      );
      if (!s) return null;
      const wasPrivate = s.isPrivate;
      s.isPrivate = input.isPrivate;
      return { record: toSubmissionRecord(s), wasPrivate };
    },
    async isLatestOpenCallSubmission(input: { submissionId: string; formId: string }) {
      const s = submissions.find(
        (x) => x.id === input.submissionId && x.formId === input.formId && performById(x.formId),
      );
      return s ? isLatestSubmission(s) : false;
    },
    async listOpenCallPeers(input: {
      formId: string;
      viewer: { humanId: string | null; applyingAsOrgId: string | null; contactEmail: string | null };
      limit: number;
    }) {
      peerQueries.push(input);
      const keyOf = peerKeyOf;
      const viewerKeys = new Set<string>();
      if (input.viewer.humanId) viewerKeys.add(`human:${input.viewer.humanId}`);
      if (input.viewer.applyingAsOrgId) viewerKeys.add(`org:${input.viewer.applyingAsOrgId}`);
      if (!input.viewer.humanId && input.viewer.contactEmail) {
        viewerKeys.add(`guest:${input.viewer.contactEmail.toLowerCase()}`);
      }
      // Mirrors the adapter: per identity, the first row (over ALL rows)
      // orders the list and the LATEST row (createdAt DESC, id DESC) decides
      // privacy: private or WITHDRAWN hides the identity outright. Viewer and
      // ban filters apply to that latest row.
      const isLater = isLaterRow;
      const groups = new Map<string, { key: string; first: Date; latest: FakeSubmission }>();
      for (const x of submissions) {
        const key = keyOf(x);
        if (!key || x.formId !== input.formId || !performById(x.formId)) continue;
        const g = groups.get(key);
        if (!g) groups.set(key, { key, first: x.createdAt, latest: x });
        else {
          if (x.createdAt < g.first) g.first = x.createdAt;
          if (isLater(x, g.latest)) g.latest = x;
        }
      }
      const listed = [...groups.values()].filter(
        ({ key, latest: x }) =>
          !x.isPrivate &&
          x.status !== "WITHDRAWN" &&
          !viewerKeys.has(key) &&
          !(x.humanId !== null && bannedOwnerIds.has(x.humanId)) &&
          !(x.applyingAsOrgId !== null && bannedOwnerIds.has(x.applyingAsOrgId)),
      );
      const peers: OpenCallPeerRecord[] = [];
      for (const { latest: s } of listed
        .sort((a, b) => a.first.getTime() - b.first.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, input.limit)) {
        if (s.applyingAsOrgId) {
          const page = publicPages.get(s.applyingAsOrgId);
          peers.push({
            kind: "org",
            name: `Org ${s.applyingAsOrgId.slice(-2)}`,
            photoUrl: page?.avatarUrl ?? null,
            pageSlug: page?.slug ?? null,
            url: null,
          });
        } else if (s.humanId) {
          const page = publicPages.get(s.humanId);
          peers.push({
            kind: "human",
            name: page?.displayName ?? `Human ${s.humanId.slice(-2)}`,
            photoUrl: page?.avatarUrl ?? null,
            pageSlug: page?.slug ?? null,
            url: null,
          });
        } else if (s.guestName) {
          peers.push({ kind: "guest", name: s.guestName, photoUrl: null, pageSlug: null, url: s.guestUrl });
        }
      }
      return peers;
    },
    async listOpenCallSubmissionsByHuman(input: {
      humanId: string;
      orgIds: readonly string[];
      limit: number;
    }) {
      const out: MyOpenCallApplicationRecord[] = [];
      for (const s of submissions
        .filter((x) =>
          x.applyingAsOrgId
            ? input.orgIds.includes(x.applyingAsOrgId)
            : x.humanId === input.humanId,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
        const f = performById(s.formId);
        if (!f) continue;
        const title = f.eventId
          ? events.get(f.eventId)?.title
          : series.get(f.seriesId ?? "")?.name;
        if (!title) continue;
        out.push({
          submissionId: s.id,
          publicId: f.publicId,
          anchor: f.eventId
            ? { kind: "event", eventId: f.eventId }
            : { kind: "series", seriesId: f.seriesId! },
          title,
          status: s.status,
          applyingAsOrgId: s.applyingAsOrgId,
          applyingAsOrgName: s.applyingAsOrgId ? `Org ${s.applyingAsOrgId.slice(-2)}` : null,
          createdAt: s.createdAt,
        });
      }
      return out.slice(0, input.limit);
    },
    // ── Organizer-side review (step 5) — mirrors event-applications-open-call-review.ts ──
    async listOpenCallReviewCards(input: ListOpenCallReviewCardsInput) {
      reviewQueries.push(input);
      const form = performById(input.formId);
      if (!form) return { items: [] as OpenCallReviewCardRecord[], nextCursor: null };
      let rows = submissions.filter((x) => x.formId === input.formId);
      if (input.onlySubmissionId) {
        rows = rows.filter((x) => x.id === input.onlySubmissionId);
      } else {
        const st = input.filter.statuses;
        rows = rows.filter((x) =>
          st && st.length > 0 ? st.includes(x.status) : x.status !== "WITHDRAWN",
        );
        const dateId = input.filter.dateId;
        if (dateId) {
          rows = rows.filter((x) =>
            x.dateChoices.some((c) => c.occurrenceId === dateId || c.eventDateId === dateId),
          );
        }
        const my = input.filter.myVote;
        const hasMine = (x: FakeSubmission, v?: ApplicationVoteValue) =>
          votes.some(
            (row) =>
              row.submissionId === x.id &&
              row.humanId === input.viewerHumanId &&
              (v === undefined || row.vote === v),
          );
        if (my === "NONE") rows = rows.filter((x) => !hasMine(x));
        else if (my) rows = rows.filter((x) => hasMine(x, my));
        const after = input.cursor
          ? submissions.find((x) => x.id === input.cursor && x.formId === input.formId)
          : undefined;
        if (after) rows = rows.filter((x) => isLaterRow(x, after));
      }
      // createdAt ASC, id ASC (code-point = COLLATE "C").
      rows.sort((a, b) => (isLaterRow(a, b) ? 1 : isLaterRow(b, a) ? -1 : 0));
      const take = Math.max(1, Math.min(input.limit, 100));
      const page = rows.slice(0, take);
      const nextCursor =
        !input.onlySubmissionId && rows.length > take ? (page.at(-1)?.id ?? null) : null;
      const here = herePlacesOf(form);
      const items: OpenCallReviewCardRecord[] = page.map((x) => {
        const tally = { yes: 0, maybe: 0, no: 0 };
        for (const v of votes.filter((row) => row.submissionId === x.id)) {
          if (v.vote === "YES") tally.yes += 1;
          else if (v.vote === "MAYBE") tally.maybe += 1;
          else tally.no += 1;
        }
        let displayName: string | null = x.guestName;
        let photoUrl: string | null = null;
        let pageSlug: string | null = null;
        let traces: OpenCallTraceCounts | null = null;
        if (x.applyingAsOrgId) {
          const pg = publicPages.get(x.applyingAsOrgId);
          displayName = `Org ${x.applyingAsOrgId.slice(-2)}`;
          photoUrl = pg?.avatarUrl ?? null;
          pageSlug = pg?.slug ?? null;
          traces = traceCountsOf({ kind: "org", id: x.applyingAsOrgId }, here, input);
        } else if (x.humanId) {
          const pg = publicPages.get(x.humanId);
          displayName = pg?.displayName ?? `Human ${x.humanId.slice(-2)}`;
          photoUrl = pg?.avatarUrl ?? null;
          pageSlug = pg?.slug ?? null;
          traces = traceCountsOf({ kind: "human", id: x.humanId }, here, input);
        }
        // The queue card carries no answers, snapshot, email or token hash.
        const {
          answers: _answers,
          questionsSnapshot: _questionsSnapshot,
          contactEmail: _contactEmail,
          statusTokenHash: _statusTokenHash,
          ...cardSubmission
        } = toSubmissionRecord(x);
        return {
          submission: cardSubmission,
          displayName,
          photoUrl,
          pageSlug,
          votes: tally,
          myVote:
            votes.find((v) => v.submissionId === x.id && v.humanId === input.viewerHumanId)
              ?.vote ?? null,
          noteCount: notes.filter((n) => n.submissionId === x.id).length,
          unreadForOrganizer: messages.filter(
            (m) => m.submissionId === x.id && m.authorSide === "APPLICANT" && m.readAt === null,
          ).length,
          traces,
        };
      });
      return { items, nextCursor };
    },
    async markOpenCallSubmissionOpened(input: {
      submissionId: string;
      formId: string;
      openedAt: Date;
    }) {
      const x = submissions.find(
        (row) => row.id === input.submissionId && row.formId === input.formId,
      );
      if (!x || x.openedAt !== null) return false;
      x.openedAt = input.openedAt;
      return true;
    },
    // ── Deciding (step 6) ── mirrors event-applications-open-call-decisions.ts
    async lockOpenCallSubmission(input: { submissionId: string; formId: string }) {
      locks.push({ kind: "submission_for_update", id: input.submissionId });
      const x = submissions.find(
        (row) =>
          row.id === input.submissionId && row.formId === input.formId && performById(row.formId),
      );
      return x ? toSubmissionRecord(x) : null;
    },
    async approveOpenCallSubmission(input: {
      submissionId: string;
      formId: string;
      reviewerHumanId: string;
      reviewedAt: Date;
    }) {
      const x = submissions.find(
        (row) =>
          row.id === input.submissionId &&
          row.formId === input.formId &&
          (row.status === "PENDING" || row.status === "WAITLISTED"),
      );
      if (!x) return false;
      x.status = "APPROVED";
      x.reviewerHumanId = input.reviewerHumanId;
      x.reviewedAt = input.reviewedAt;
      return true;
    },
    async rejectOpenCallSubmission(input: {
      submissionId: string;
      formId: string;
      reviewerHumanId: string;
      reviewedAt: Date;
      decisionReason: string | null;
    }) {
      const x = submissions.find(
        (row) =>
          row.id === input.submissionId &&
          row.formId === input.formId &&
          (row.status === "PENDING" || row.status === "WAITLISTED"),
      );
      if (!x) return false;
      x.status = "REJECTED";
      x.reviewerHumanId = input.reviewerHumanId;
      x.reviewedAt = input.reviewedAt;
      x.decisionReason = input.decisionReason;
      return true;
    },
    async markOpenCallSubmissionDroppedOut(input: {
      submissionId: string;
      formId: string;
      droppedOutAt: Date;
    }) {
      const x = submissions.find(
        (row) =>
          row.id === input.submissionId && row.formId === input.formId && row.status === "APPROVED",
      );
      if (!x) return false;
      x.status = "WITHDRAWN";
      x.droppedOutAt = input.droppedOutAt;
      return true;
    },
    async markOpenCallSubmissionRemovedFromLineup(input: {
      submissionId: string;
      formId: string;
      removedAt: Date;
    }) {
      const x = submissions.find(
        (row) =>
          row.id === input.submissionId &&
          row.formId === input.formId &&
          row.status === "APPROVED" &&
          (row.removedFromLineupAt ?? null) === null,
      );
      if (!x) return false;
      x.removedFromLineupAt = input.removedAt;
      return true;
    },
    async lockOpenCallSubmissionsByAct(input: { formId: string; act: OpenCallLineupAct }) {
      if (!performById(input.formId)) return [];
      const act = input.act;
      // ANY status; guests by name only (the adapter's superset); id order.
      const rows = submissions
        .filter(
          (x) =>
            x.formId === input.formId &&
            (act.kind === "human"
              ? x.humanId === act.humanId && x.applyingAsOrgId === null
              : act.kind === "org"
                ? x.applyingAsOrgId === act.orgId
                : x.humanId === null &&
                  x.applyingAsOrgId === null &&
                  x.guestName !== null &&
                  act.name.trim().length > 0 &&
                  x.guestName.trim().toLowerCase() === act.name.trim().toLowerCase()),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const x of rows) locks.push({ kind: "submission_for_update", id: x.id });
      return rows.map(toSubmissionRecord);
    },
    async setApplicationVote(input: {
      submissionId: string;
      humanId: string;
      vote: ApplicationVoteValue | null;
      at: Date;
    }) {
      const i = votes.findIndex(
        (v) => v.submissionId === input.submissionId && v.humanId === input.humanId,
      );
      if (input.vote === null) {
        if (i !== -1) votes.splice(i, 1);
        return;
      }
      if (i !== -1) {
        votes[i] = { ...votes[i]!, vote: input.vote, at: input.at };
      } else {
        votes.push({
          submissionId: input.submissionId,
          humanId: input.humanId,
          vote: input.vote,
          at: input.at,
        });
      }
    },
    async getApplicationVoteSummary(input: { submissionId: string; viewerHumanId: string }) {
      const tally = { yes: 0, maybe: 0, no: 0 };
      for (const v of votes.filter((row) => row.submissionId === input.submissionId)) {
        if (v.vote === "YES") tally.yes += 1;
        else if (v.vote === "MAYBE") tally.maybe += 1;
        else tally.no += 1;
      }
      return {
        votes: tally,
        myVote:
          votes.find(
            (v) => v.submissionId === input.submissionId && v.humanId === input.viewerHumanId,
          )?.vote ?? null,
      };
    },
    async createApplicationNote(input: {
      submissionId: string;
      authorHumanId: string;
      body: string;
      createdAt: Date;
    }) {
      const row: ApplicationNoteRecord = {
        id: randomUUID(),
        submissionId: input.submissionId,
        authorHumanId: input.authorHumanId,
        authorName: `Human ${input.authorHumanId.slice(-2)}`,
        body: input.body,
        createdAt: input.createdAt,
      };
      notes.push(row);
      return row;
    },
    async listApplicationNotes(input: { submissionId: string; limit: number }) {
      return notes
        .filter((n) => n.submissionId === input.submissionId)
        // (createdAt, id), like the adapter.
        .sort((a, b) =>
          a.createdAt.getTime() !== b.createdAt.getTime()
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
        )
        .slice(0, input.limit);
    },
    async createApplicationMessage(input: {
      submissionId: string;
      authorSide: ApplicationMessageAuthorSide;
      authorHumanId: string | null;
      body: string;
      createdAt: Date;
    }) {
      const row: ApplicationMessageRecord = {
        id: randomUUID(),
        submissionId: input.submissionId,
        authorSide: input.authorSide,
        authorHumanId: input.authorHumanId,
        body: input.body,
        readAt: null,
        createdAt: input.createdAt,
      };
      messages.push(row);
      return row;
    },
    async listApplicationMessages(input: {
      submissionId: string;
      cursor: string | null;
      limit: number;
    }) {
      const later = (a: ApplicationMessageRecord, b: ApplicationMessageRecord) =>
        a.createdAt.getTime() !== b.createdAt.getTime()
          ? a.createdAt.getTime() > b.createdAt.getTime()
          : a.id > b.id;
      let rows = messages
        .filter((m) => m.submissionId === input.submissionId)
        .sort((a, b) => (later(a, b) ? 1 : later(b, a) ? -1 : 0));
      const after = input.cursor
        ? rows.find((m) => m.id === input.cursor)
        : undefined;
      if (after) rows = rows.filter((m) => later(m, after));
      const take = Math.max(1, Math.min(input.limit, 100));
      const items = rows.slice(0, take).map((m) => ({ ...m }));
      return { items, nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null };
    },
    async markApplicationMessagesRead(input: {
      submissionId: string;
      readerSide: ApplicationMessageAuthorSide;
      upToCreatedAt: Date;
      readAt: Date;
    }) {
      let n = 0;
      for (const m of messages) {
        if (
          m.submissionId === input.submissionId &&
          m.authorSide !== input.readerSide &&
          m.readAt === null &&
          m.createdAt.getTime() <= input.upToCreatedAt.getTime()
        ) {
          m.readAt = input.readAt;
          n += 1;
        }
      }
      return n;
    },
    async listQuestions(formId: string) {
      return questions
        .filter((q) => q.formId === formId)
        .sort((a, b) => a.order - b.order);
    },
    async upsertQuestion(input: UpsertEventApplicationQuestionInput) {
      const row: EventApplicationQuestionRecord = {
        id: randomUUID(),
        formId: input.formId,
        type: input.type,
        label: input.label,
        description: input.description ?? null,
        options: input.options ?? null,
        isRequired: input.isRequired ?? false,
        order: input.order ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      questions.push(row);
      return row;
    },
    // ── Sweep + reconcile (step 8), mirroring the adapter's SQL ──────────
    async listOpenCallSweepDue(input: { now: Date; limit: number }) {
      /** Not called off: the adapter's per-choice `live` expression. */
      const choiceLive = (c: OpenCallDateChoiceTarget): boolean => {
        if (c.eventDateId) {
          return eventDates.find((d) => d.id === c.eventDateId)?.status === "SCHEDULED";
        }
        const o = occurrences.find((x) => x.id === c.occurrenceId);
        if (!o || !LIVE.includes(o.status)) return false;
        return !o.eventId || events.get(o.eventId)?.status !== "CANCELLED";
      };
      const out: Array<{
        submissionId: string;
        formId: string;
        eventId: string | null;
        seriesId: string | null;
        title: string;
        verdict: "backstop" | "pulled";
        createdAt: Date;
      }> = [];
      for (const s of submissions) {
        if (s.status !== "PENDING") continue;
        const form = performById(s.formId);
        if (!form) continue;
        const event = form.eventId ? events.get(form.eventId) : undefined;
        const ser = form.seriesId ? series.get(form.seriesId) : undefined;
        let lastLive: Date | null = null;
        if (s.dateChoices.length > 0) {
          for (const c of s.dateChoices) {
            if (!choiceLive(c)) continue;
            const at = choiceStartsAt(c);
            if (lastLive === null || at.getTime() > lastLive.getTime()) lastLive = at;
          }
        } else if (form.eventId && event) {
          const rows = eventDates.filter((d) => d.eventId === form.eventId);
          if (rows.length === 0) {
            lastLive = event.startsAt;
          } else {
            const after = rows
              .filter((d) => d.status === "SCHEDULED" && d.startsAt.getTime() > s.createdAt.getTime())
              .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
            lastLive = after[0]?.startsAt ?? null;
          }
        }
        let verdict: "backstop" | "pulled" | null;
        if (event && event.status === "CANCELLED") verdict = "pulled";
        else if (lastLive === null) verdict = "pulled";
        else if (lastLive.getTime() <= input.now.getTime()) verdict = "backstop";
        else if (
          (event && (event.status === "ARCHIVED" || event.status === "COMPLETED")) ||
          (ser && ser.archivedAt !== null)
        ) {
          verdict = "pulled";
        } else verdict = null;
        if (!verdict) continue;
        out.push({
          submissionId: s.id,
          formId: s.formId,
          eventId: form.eventId,
          seriesId: form.seriesId,
          title: event?.title ?? ser?.name ?? "",
          verdict,
          createdAt: s.createdAt,
        });
      }
      return out
        .sort((a, b) =>
          a.createdAt.getTime() !== b.createdAt.getTime()
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : a.submissionId < b.submissionId
              ? -1
              : 1,
        )
        .slice(0, input.limit);
    },
    async settlePendingOpenCallSubmissions(input: {
      submissionIds: string[];
      status: "REJECTED" | "EXPIRED";
      reviewedAt: Date;
    }) {
      const ids: string[] = [];
      for (const id of input.submissionIds) {
        const s = submissions.find((x) => x.id === id);
        if (!s || s.status !== "PENDING" || !performById(s.formId)) continue;
        s.status = input.status;
        s.reviewedAt = input.reviewedAt;
        ids.push(s.id);
      }
      return { ids };
    },
    async expireUndecidedOpenCallSubmissions(input: { formId: string; reviewedAt: Date }) {
      const ids: string[] = [];
      for (const s of submissions) {
        if (s.formId !== input.formId || (s.status !== "PENDING" && s.status !== "WAITLISTED")) continue;
        s.status = "EXPIRED";
        s.reviewedAt = input.reviewedAt;
        ids.push(s.id);
      }
      return { ids };
    },
    async listOpenCallSubmissionsByFormStatus(input: {
      formId: string;
      statuses: Array<"REJECTED" | "EXPIRED">;
      afterId: string | null;
      limit: number;
    }) {
      if (!performById(input.formId)) return [];
      return submissions
        .filter(
          (s) =>
            s.formId === input.formId &&
            (input.statuses as ApplicationSubmissionStatus[]).includes(s.status) &&
            (!input.afterId || s.id > input.afterId),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, input.limit)
        .map((s) => ({ submissionId: s.id, status: s.status as "REJECTED" | "EXPIRED" }));
    },
    async listOpenCallNoticeReconcileRows(input: {
      kind: "not-this-time" | "pulled" | "received";
      since: Date;
      until: Date;
      after: { at: Date; submissionId: string } | null;
      limit: number;
    }) {
      const statuses: ApplicationSubmissionStatus[] =
        input.kind === "not-this-time"
          ? ["REJECTED"]
          : input.kind === "pulled"
            ? ["EXPIRED"]
            : ["PENDING", "WAITLISTED"];
      const atOf = (s: FakeSubmission) => (input.kind === "received" ? s.createdAt : s.reviewedAt);
      const rows = submissions
        .filter((s) => {
          const at = atOf(s);
          if (!statuses.includes(s.status) || !at || !performById(s.formId)) return false;
          if (at.getTime() < input.since.getTime() || at.getTime() > input.until.getTime()) return false;
          if (!input.after) return true;
          return (
            at.getTime() > input.after.at.getTime() ||
            (at.getTime() === input.after.at.getTime() && s.id > input.after.submissionId)
          );
        })
        .sort((a, b) => {
          const d = atOf(a)!.getTime() - atOf(b)!.getTime();
          return d !== 0 ? d : a.id < b.id ? -1 : 1;
        })
        .slice(0, input.limit);
      return rows.map((s) => {
        const form = performById(s.formId)!;
        return {
          submissionId: s.id,
          formId: s.formId,
          eventId: form.eventId,
          seriesId: form.seriesId,
          title:
            (form.eventId ? events.get(form.eventId)?.title : series.get(form.seriesId ?? "")?.name) ?? "",
          at: atOf(s)!,
        };
      });
    },
  };

  const repos = {
    events: {
      async getById(id: string) {
        const e = events.get(id);
        return e ? { ...e } : null;
      },
      async findManyByIds(ids: string[]) {
        return ids.flatMap((id) => {
          const e = events.get(id);
          return e ? [{ ...e }] : [];
        });
      },
    },
    series: {
      async getById(id: string) {
        const s = series.get(id);
        return s ? { ...s } : null;
      },
    },
    seriesOccurrences: {
      async getById(id: string) {
        return occurrences.find((o) => o.id === id) ?? null;
      },
      async getCalendarInfoForEventIds(eventIds: string[]) {
        return occurrences
          .filter((o) => o.eventId && eventIds.includes(o.eventId))
          .map((o) => ({
            eventId: o.eventId!,
            seriesId: o.seriesId,
            seriesName: series.get(o.seriesId)?.name ?? "",
            occurrenceId: o.id,
          }));
      },
      async listBySeriesAndStatuses(
        seriesId: string,
        statuses: EventSeriesOccurrenceStatus[],
        afterDate: Date,
      ) {
        return occurrences
          .filter(
            (o) =>
              o.seriesId === seriesId &&
              statuses.includes(o.status) &&
              o.startsAt.getTime() > afterDate.getTime(),
          )
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      },
    },
    eventDates: {
      async listByEvent(input: { eventId: string; statuses?: string[] }) {
        return eventDates.filter(
          (d) =>
            d.eventId === input.eventId &&
            (!input.statuses || input.statuses.includes(d.status)),
        );
      },
    },
    eventApplications,
    authz: {
      async getOrgMembership(input: { orgId: string; humanId: string }) {
        const role = memberships.get(`${input.orgId}:${input.humanId}`);
        return role ? { orgId: input.orgId, humanId: input.humanId, role } : null;
      },
      async listOrgMembershipsByHumanId(input: { humanId: string; roles?: readonly string[] }) {
        const out: Array<{ orgId: string; humanId: string; role: string }> = [];
        for (const [key, role] of memberships) {
          const [orgId, humanId] = key.split(":");
          if (humanId !== input.humanId || !orgId) continue;
          if (input.roles && !input.roles.includes(role)) continue;
          out.push({ orgId, humanId, role });
        }
        return out;
      },
      async getHumanDelegation(input: { principalId: string; delegateId: string }) {
        const role = delegations.get(`${input.principalId}:${input.delegateId}`);
        return role ? { orgId: input.principalId, humanId: input.delegateId, role } : null;
      },
    },
    bans: {
      async findBannedOwners(input: { humanIds: string[]; orgIds: string[] }) {
        return {
          humanIds: input.humanIds.filter((id) => bannedOwnerIds.has(id)),
          orgIds: input.orgIds.filter((id) => bannedOwnerIds.has(id)),
        };
      },
    },
    organizations: {
      async getById(id: string) {
        return { id, name: `Org ${id.slice(-2)}`, slug: `org-${id.slice(-2)}` };
      },
      // Step 7 (notice recipients): members from the `memberships` map,
      // paged like the adapter.
      async listMembers(input: { orgId: string; limit: number; offset: number }) {
        const all = [...memberships.entries()]
          .filter(([key]) => key.startsWith(`${input.orgId}:`))
          .map(([key, role]) => ({ humanId: key.slice(input.orgId.length + 1), role }));
        return { items: all.slice(input.offset, input.offset + input.limit), total: all.length };
      },
    },
    humans: {
      async getById(id: string) {
        return { id, name: `Human ${id.slice(-2)}`, status: "ACTIVE" };
      },
      async getByIds(ids: string[]) {
        return ids.map((id) => ({ id, name: `Human ${id.slice(-2)}` }));
      },
      // Step 7: no username, so admin slugs fall back to `@<id>`.
      async getByIdWithIdentity(id: string) {
        return {
          human: { id, name: `Human ${id.slice(-2)}`, status: "ACTIVE" },
          identity: { email: null, emailVerified: false, username: null },
        };
      },
    },
    // Step 7 (notice recipients): delegates from the `delegations` map.
    humanDelegates: {
      async listDelegates(input: { principalId: string; limit: number; offset: number }) {
        const all = [...delegations.entries()]
          .filter(([key]) => key.startsWith(`${input.principalId}:`))
          .map(([key, role]) => ({
            humanId: key.slice(input.principalId.length + 1),
            name: null,
            email: null,
            role,
            joinedAt: now,
          }));
        return { items: all.slice(input.offset, input.offset + input.limit), total: all.length };
      },
    },
    places: {
      async getById(id: string) {
        return places.get(id) ?? null;
      },
    },
    eventHumans: {
      async listByEvent(eventId: string) {
        return lineup
          .filter((r) => r.eventId === eventId)
          .sort((a, b) => a.sortOrder - b.sortOrder);
      },
      async getById(id: string) {
        return lineup.find((r) => r.id === id) ?? null;
      },
      async getByEventAndHuman(input: { eventId: string; humanId: string }) {
        return lineup.find((r) => r.eventId === input.eventId && r.humanId === input.humanId) ?? null;
      },
      // Mirrors the adapter: (event, human) and (event, org) are idempotent
      // upserts that return the EXISTING row; free-text rows always insert.
      async attach(input: AttachEventHumanInput) {
        if (input.humanId && input.orgId) {
          throw { code: "invalid_input", message: "event_human_person_and_group" };
        }
        const existing = input.humanId
          ? lineup.find((r) => r.eventId === input.eventId && r.humanId === input.humanId)
          : input.orgId
            ? lineup.find((r) => r.eventId === input.eventId && r.orgId === input.orgId)
            : undefined;
        if (existing) return existing;
        const row: EventHumanRecord = {
          id: input.id ?? randomUUID(),
          eventId: input.eventId,
          humanId: input.humanId ?? null,
          orgId: input.orgId ?? null,
          externalName: input.externalName ?? null,
          externalUrl: input.externalUrl ?? null,
          role: input.role,
          customRoleLabel: input.customRoleLabel ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
          profileSlug: null,
          humanDisplayName: null,
        };
        lineup.push(row);
        return row;
      },
      async detach(id: string) {
        const i = lineup.findIndex((r) => r.id === id);
        if (i < 0) throw new Error("EventHuman not found (P2025)");
        lineup.splice(i, 1);
      },
    },
    entityPages: {
      async getByOwners() {
        return [];
      },
      async getByOwner() {
        return null;
      },
      async listBlocksByPageIds() {
        return [];
      },
    },
    audit: {
      async log(entry: { entity: string; entityId?: string | null; action: string; data?: unknown }) {
        audit.push(entry);
      },
    },
  };

  const fullRepos = {
    ...repos,
    tx: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fullRepos),
  } as unknown as Repos;

  // ── Builders ──────────────────────────────────────────────────────────
  const addEvent = (overrides: Partial<EventRecord> = {}) => {
    const e = makeOpenCallEvent(overrides);
    events.set(e.id, e);
    return e;
  };
  const addSeries = (overrides: Partial<EventSeriesRecord> = {}) => {
    const s = makeOpenCallSeries(overrides);
    series.set(s.id, s);
    return s;
  };
  const addOccurrence = (input: {
    seriesId?: string;
    startsAt: Date;
    eventId?: string | null;
    status?: EventSeriesOccurrenceStatus;
  }) => {
    const o: EventSeriesOccurrenceRecord = {
      id: randomUUID(),
      seriesId: input.seriesId ?? OC_SERIES_ID,
      ordinal: occurrences.length + 1,
      startsAt: input.startsAt,
      endsAt: null,
      status: input.status ?? (input.eventId ? "GENERATED" : "PLANNED"),
      eventId: input.eventId ?? null,
      overrides: null,
      createdAt: now,
      updatedAt: now,
    };
    occurrences.push(o);
    return o;
  };
  const addForm = (row: Partial<FormRow> & Pick<FormRow, "purpose">) => {
    publicIdCounter += 1;
    const form: FormRow = {
      id: randomUUID(),
      eventId: null,
      seriesId: null,
      publicId: `form${String(publicIdCounter).padStart(6, "0")}`,
      introText: null,
      defaults: { includeName: false, includeReason: false, includeSocialLinks: false },
      opensAt: null,
      closesAt: null,
      maxSubmissions: null,
      autoApprove: false,
      payKind: row.purpose === "PERFORM" ? "UNPAID" : null,
      payDetails: null,
      closedAt: null,
      closedByHumanId: null,
      // A seeded PERFORM form is a POSTED call unless the test says
      // otherwise (`postedAt: null` for a draft); ATTEND forms are never posted.
      postedAt: row.purpose === "PERFORM" ? now : null,
      postedByHumanId: row.purpose === "PERFORM" ? OC_EDITOR_ID : null,
      updatedByHumanId: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    };
    forms.push(form);
    return form;
  };
  const addSubmission = (
    formId: string,
    status: ApplicationSubmissionStatus,
    extra: Partial<FakeSubmission> = {},
  ) => {
    const s: FakeSubmission = {
      id: randomUUID(),
      formId,
      eventId: forms.find((f) => f.id === formId)?.eventId ?? null,
      humanId: randomUUID(),
      status,
      reviewedAt: null,
      answers: { q: "private answer text" },
      applyingAsOrgId: null,
      guestName: null,
      guestUrl: null,
      contactEmail: null,
      isPrivate: false,
      openedAt: null,
      statusTokenHash: null,
      droppedOutAt: null,
      questionsSnapshot: {},
      dateChoices: [],
      createdAt: now,
      ...extra,
    };
    submissions.push(s);
    return s;
  };

  return {
    now,
    repos: fullRepos,
    events,
    series,
    occurrences,
    eventDates,
    forms,
    questions,
    submissions,
    memberships,
    places,
    lineup,
    bannedOwnerIds,
    delegations,
    votes,
    notes,
    messages,
    reviewQueries,
    publicPages,
    peerQueries,
    audit,
    locks,
    addEvent,
    addSeries,
    addOccurrence,
    addForm,
    addSubmission,
    clock: { now: () => now },
  };
}
