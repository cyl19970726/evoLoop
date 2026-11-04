import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/054_task_attention.sql", import.meta.url), "utf8")); };
