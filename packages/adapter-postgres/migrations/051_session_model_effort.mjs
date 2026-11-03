import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/051_session_model_effort.sql", import.meta.url), "utf8")); };
