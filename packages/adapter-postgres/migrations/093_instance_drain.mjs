import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/093_instance_drain.sql", import.meta.url), "utf8")); };
export const down = false;
