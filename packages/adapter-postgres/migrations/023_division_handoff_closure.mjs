import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/023_division_handoff_closure.sql", import.meta.url), "utf8")); };
export const down = false;
