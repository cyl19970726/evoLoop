import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/112_usage_cost_scope.sql", import.meta.url), "utf8")); };
export const down = false;
