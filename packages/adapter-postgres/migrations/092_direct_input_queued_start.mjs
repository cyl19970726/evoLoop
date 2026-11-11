import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/092_direct_input_queued_start.sql", import.meta.url), "utf8")); };
export const down = false;
