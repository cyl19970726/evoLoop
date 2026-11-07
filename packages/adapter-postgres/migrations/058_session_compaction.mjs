import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/058_session_compaction.sql", import.meta.url), "utf8")); };
