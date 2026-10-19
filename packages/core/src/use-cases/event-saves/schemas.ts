import { z } from "zod";
import { eventStatusSchema, eventVisibilitySchema } from "@th/schema";

const actorHumanIdSchema = z.string().trim().min(1);
const eventIdSchema = z.string().uuid();
const cursorSchema = z.string().trim().min(1).nullable();

/** Batch saved-state is bounded to one page of visible cards (NFR-001). */
export const SAVED_STATE_MAX_EVENT_IDS = 50;

export const saveEventInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    eventId: eventIdSchema,
  })
  .strict();

export const saveEventOutputSchema = z
  .object({
    saveId: z.string(),
    alreadySaved: z.boolean(),
  })
  .strict();

export const unsaveEventInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    eventId: eventIdSchema,
  })
  .strict();

export const unsaveEventOutputSchema = z
  .object({
    success: z.boolean(),
  })
  .strict();

export const savedEventsScopeSchema = z.enum(["upcoming", "past"]);

const savedEventItemSchema = z
  .object({
    saveId: z.string(),
    savedAt: z.date(),
    event: z
      .object({
        id: z.string(),
        slug: z.string().nullable(),
        title: z.string(),
        startsAt: z.date(),
        endsAt: z.date().nullable(),
        timezone: z.string(),
        status: eventStatusSchema,
        visibility: eventVisibilitySchema,
        heroImageId: z.string().nullable(),
        heroImageUrl: z.string().nullable(),
        addressText: z.string().nullable(),
        locationLabel: z.string().nullable(),
        placeId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const listSavedEventsInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    scope: savedEventsScopeSchema,
    cursor: cursorSchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const listSavedEventsOutputSchema = z
  .object({
    items: z.array(savedEventItemSchema),
    nextCursor: cursorSchema,
  })
  .strict();

export const getSavedStateInputSchema = z
  .object({
    actorHumanId: actorHumanIdSchema,
    eventIds: z
      .array(eventIdSchema)
      .min(1)
      .max(SAVED_STATE_MAX_EVENT_IDS),
  })
  .strict();

export const getSavedStateOutputSchema = z
  .object({
    saved: z.record(z.string(), z.boolean()),
  })
  .strict();
