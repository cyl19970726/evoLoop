import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/057_task_timing.sql", import.meta.url), "utf8")); };
