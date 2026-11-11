import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/072_preflight_failure_no_gate.sql", import.meta.url), "utf8")); };
export const down = false;
