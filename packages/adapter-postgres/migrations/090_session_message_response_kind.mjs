import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/090_session_message_response_kind.sql", import.meta.url), "utf8")); };
export const down = false;
