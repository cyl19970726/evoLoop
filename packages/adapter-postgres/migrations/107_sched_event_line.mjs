import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/107_sched_event_line.sql", import.meta.url), "utf8")); };
export const down = false;
