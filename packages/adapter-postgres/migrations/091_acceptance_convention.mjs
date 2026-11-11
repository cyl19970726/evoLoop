import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/091_acceptance_convention.sql", import.meta.url), "utf8")); };
export const down = false;
