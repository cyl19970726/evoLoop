import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/050_session_message_preflight.sql", import.meta.url), "utf8")); };
export const down = false;
