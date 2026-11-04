import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/052_session_identity.sql", import.meta.url), "utf8")); };
