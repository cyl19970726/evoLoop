import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/018_runtime_session_close.sql", import.meta.url), "utf8")); };
export const down = false;
