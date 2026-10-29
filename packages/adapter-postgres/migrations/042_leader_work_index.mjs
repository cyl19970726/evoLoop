import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/042_leader_work_index.sql", import.meta.url), "utf8")); };
export const down = false;
