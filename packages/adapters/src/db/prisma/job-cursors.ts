import { Prisma } from "@prisma/client";

import type { JobCursorsRepo } from "@th/ports/repos/job-cursors";

import type { PrismaClientOrTx } from "./types";

export function makeJobCursorsRepo(p: PrismaClientOrTx): JobCursorsRepo {
  return {
    async get(jobName: string): Promise<unknown | null> {
      const row = await p.jobState.findUnique({
        where: { jobName },
        select: { cursor: true },
      });
      return row?.cursor ?? null;
    },

    async set(jobName: string, cursor: unknown | null): Promise<void> {
      // Clearing a nullable Json column needs Prisma's `DbNull` sentinel — a
      // plain `null` is not in `NullableJsonNullValueInput` and Prisma rejects
      // it at RUNTIME with a validation error. That matters more here than it
      // looks: clearing is how a completed pass wraps the scan back to the
      // start, so a throw on this path would park the cursor mid-table forever
      // and silently strand every row ordering before it.
      const value =
        cursor === null || cursor === undefined
          ? Prisma.DbNull
          : (cursor as Prisma.InputJsonValue);

      // Upsert touches ONLY `cursor`. `enabled` is the job kill switch, owned
      // by the run tracker — clobbering it here would silently re-enable a job
      // an operator had turned off.
      await p.jobState.upsert({
        where: { jobName },
        create: { jobName, ...(cursor == null ? {} : { cursor: value }) },
        update: { cursor: value },
      });
    },
  };
}
