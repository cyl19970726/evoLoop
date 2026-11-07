import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/064_session_compaction.sql", import.meta.url), "utf8")); };
