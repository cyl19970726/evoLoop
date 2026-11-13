import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/103_precondition_mark_change.sql", import.meta.url), "utf8")); };
export const down = false;
