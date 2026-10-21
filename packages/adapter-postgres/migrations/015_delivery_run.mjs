import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/015_delivery_run.sql", import.meta.url), "utf8")); };
export const down = false;
