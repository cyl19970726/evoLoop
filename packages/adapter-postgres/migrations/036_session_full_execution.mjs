import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/036_session_full_execution.sql", import.meta.url), "utf8")); };
export const down = false;
