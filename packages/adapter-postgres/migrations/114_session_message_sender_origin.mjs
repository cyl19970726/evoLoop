import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/114_session_message_sender_origin.sql", import.meta.url), "utf8")); };
export const down = false;
