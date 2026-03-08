import type PgBoss from "pg-boss";
import { JobType } from "./types.js";
import type { JobData } from "./types.js";

export function registerJobHandlers(boss: PgBoss): void {
  for (const jobType of Object.values(JobType)) {
    boss.work<JobData>(jobType, async (jobs) => {
      for (const job of jobs) {
        console.log(`[worker] processing ${jobType} job=${job.id}`);
        // Job handlers will be implemented per-domain in later phases
      }
    });
  }
}

export { JobType } from "./types.js";
export type { JobData } from "./types.js";
