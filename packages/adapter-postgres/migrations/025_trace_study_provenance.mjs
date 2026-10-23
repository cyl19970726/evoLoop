import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/025_trace_study_provenance.sql", import.meta.url), "utf8")); };
export const down = false;
