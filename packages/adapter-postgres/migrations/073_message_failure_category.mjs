import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/073_message_failure_category.sql", import.meta.url), "utf8")); };
export const down = false;
