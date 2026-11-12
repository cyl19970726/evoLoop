import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/099_run_actual_model.sql", import.meta.url), "utf8")); };
export const down = false;
