import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/031_session_messages.sql", import.meta.url), "utf8")); };
export const down = false;
