import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/055_pre_turn_continuation.sql", import.meta.url), "utf8")); };
