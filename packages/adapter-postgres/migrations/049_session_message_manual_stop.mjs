import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/049_session_message_manual_stop.sql", import.meta.url), "utf8")); };
export const down = false;
