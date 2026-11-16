import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/113_task_delivery_dispatch_guard.sql", import.meta.url), "utf8")); };
export const down = false;
