import type {
  CreateSavedLocationInput,
  SavedLocationOwnerType,
  SavedLocationRecord,
  SavedLocationsRepo,
} from "@th/ports/repos/saved-locations";

import { encodeGeohash } from "@th/core/lib/geo/geohash";
import type { PrismaClientOrTx } from "./types";

const SAVED_LOCATION_SELECT = {
  id: true,
  name: true,
  address: true,
  countryCode: true,
  region: true,
  locality: true,
  postalCode: true,
  lat: true,
  lng: true,
  timezone: true,
  ownerType: true,
  ownerId: true,
  usageCount: true,
  admissionTaxRateBps: true,
  taxRateFetchedAt: true,
  taxRateSource: true,
} as const;

function mapRecord(row: {
  id: string;
  name: string;
  address: string | null;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  ownerType: string;
  ownerId: string;
  usageCount: number;
  admissionTaxRateBps: number | null;
  taxRateFetchedAt: Date | null;
  taxRateSource: string | null;
}): SavedLocationRecord {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    countryCode: row.countryCode,
    region: row.region,
    locality: row.locality,
    postalCode: row.postalCode,
    lat: row.lat,
    lng: row.lng,
    timezone: row.timezone,
    ownerType: row.ownerType as SavedLocationOwnerType,
    ownerId: row.ownerId,
    usageCount: row.usageCount,
    admissionTaxRateBps: row.admissionTaxRateBps,
    taxRateFetchedAt: row.taxRateFetchedAt,
    taxRateSource: row.taxRateSource,
  };
}

function buildAddressHash(address: string): string {
  return address.trim().toLowerCase();
}

export function makeSavedLocationsRepo(
  p: PrismaClientOrTx,
): SavedLocationsRepo {
  return {
    async getById(id) {
      const row = await p.savedLocation.findUnique({
        where: { id },
        select: SAVED_LOCATION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async getByIds(ids) {
      const unique = [...new Set(ids)];
      const result = new Map<string, SavedLocationRecord>();
      if (unique.length === 0) return result;
      // Same select and mapping as `getById`.
      const rows = await p.savedLocation.findMany({
        where: { id: { in: unique } },
        select: SAVED_LOCATION_SELECT,
      });
      for (const row of rows) result.set(row.id, mapRecord(row));
      return result;
    },

    async getAccessibleByOrg({ id, orgId }) {
      const location = await p.savedLocation.findUnique({
        where: { id },
        select: SAVED_LOCATION_SELECT,
      });

      if (!location) return null;

      const ownerType = location.ownerType as SavedLocationOwnerType;

      let accessible = false;
      if (ownerType === "ORGANIZATION") {
        accessible = location.ownerId === orgId;
      } else {
        const membership = await p.orgMember.findUnique({
          where: {
            orgId_humanId: { orgId, humanId: location.ownerId },
          },
          select: { id: true },
        });
        accessible = Boolean(membership);
      }

      if (!accessible) return null;

      return mapRecord(location);
    },

    async getAccessibleByHuman({ id, humanId }) {
      const location = await p.savedLocation.findUnique({
        where: { id },
        select: SAVED_LOCATION_SELECT,
      });

      if (!location) return null;

      const ownerType = location.ownerType as SavedLocationOwnerType;
      if (ownerType !== "HUMAN" || location.ownerId !== humanId) {
        return null;
      }

      return mapRecord(location);
    },

    async incrementUsage(id) {
      await p.savedLocation.update({
        where: { id },
        data: { usageCount: { increment: 1 } },
      });
    },

    async create(input: CreateSavedLocationInput) {
      const addressHash = input.address
        ? buildAddressHash(input.address)
        : null;

      const created = await p.savedLocation.create({
        data: {
          name: input.name,
          address: input.address,
          countryCode: input.countryCode ?? null,
          region: input.region ?? null,
          locality: input.locality ?? null,
          postalCode: input.postalCode ?? null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          timezone: input.timezone ?? null,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          usageCount: 1,
          addressHash,
          geohash6:
            input.lat != null && input.lng != null
              ? encodeGeohash(input.lat, input.lng, 6)
              : null,
          geohash8:
            input.lat != null && input.lng != null
              ? encodeGeohash(input.lat, input.lng, 8)
              : null,
        },
        select: SAVED_LOCATION_SELECT,
      });

      return mapRecord(created);
    },

    async findByOwnerAndAddress({ ownerType, ownerId, address }) {
      const addressHash = buildAddressHash(address);

      const location = await p.savedLocation.findUnique({
        where: {
          saved_location_owner_address: { ownerType, ownerId, addressHash },
        },
        select: SAVED_LOCATION_SELECT,
      });

      if (!location) return null;

      return mapRecord(location);
    },

    async updateTaxRate({
      id,
      admissionTaxRateBps,
      taxRateSource,
      taxRateFetchedAt,
    }) {
      await p.savedLocation.update({
        where: { id },
        data: { admissionTaxRateBps, taxRateSource, taxRateFetchedAt },
      });
    },

    async fillTaxRateIfUnset({
      id,
      expectedPostalCode,
      expectedCountryCode,
      admissionTaxRateBps,
      taxRateSource,
      taxRateFetchedAt,
    }) {
      // Compare-and-set (port doc): only an EMPTY cache, and only while the
      // row still has the address the rate was looked up for.
      const { count } = await p.savedLocation.updateMany({
        where: {
          id,
          admissionTaxRateBps: null,
          postalCode: expectedPostalCode,
          countryCode: expectedCountryCode,
        },
        data: { admissionTaxRateBps, taxRateSource, taxRateFetchedAt },
      });
      return count > 0;
    },
  };
}
