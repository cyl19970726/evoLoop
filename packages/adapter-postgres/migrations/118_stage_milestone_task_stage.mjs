import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/118_stage_milestone_task_stage.sql", import.meta.url), "utf8")); };
export const down = false;
