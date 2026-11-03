import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/048_session_message_interrupt.sql", import.meta.url), "utf8")); };
export const down = false;
