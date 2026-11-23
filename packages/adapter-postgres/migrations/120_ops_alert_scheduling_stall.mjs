import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/120_ops_alert_scheduling_stall.sql", import.meta.url), "utf8")); };
export const down = false;
