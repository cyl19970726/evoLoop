import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/101_stage_phase_key.sql", import.meta.url), "utf8")); };
export const down = false;
