import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/108_schedule_direct_dispatch.sql", import.meta.url), "utf8")); };
export const down = false;
