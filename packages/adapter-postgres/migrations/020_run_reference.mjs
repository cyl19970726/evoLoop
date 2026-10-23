import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/020_run_reference.sql", import.meta.url), "utf8")); };
export const down = false;
