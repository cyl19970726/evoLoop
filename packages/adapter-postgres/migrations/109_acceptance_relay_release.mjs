import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/109_acceptance_relay_release.sql", import.meta.url), "utf8")); };
export const down = false;
