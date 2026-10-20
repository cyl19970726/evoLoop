import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/012_task_content.sql", import.meta.url), "utf8")); };
export const down = false;
