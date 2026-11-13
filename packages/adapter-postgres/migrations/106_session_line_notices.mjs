import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/106_session_line_notices.sql", import.meta.url), "utf8")); };
export const down = false;
